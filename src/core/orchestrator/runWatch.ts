import type { CheckRepairLedger } from "@shared/checkRepair";
import type { RunChecks } from "@shared/tasks";
import {
  allowanceResetOf,
  ForgeError,
  type WorkflowJobLine,
  type WorkflowJobList,
  type WorkflowRun,
} from "../forge";
import type { InboxStore } from "../storage/inboxStore";
import type { RunWatch, RunWatchReading, TaskDelivery } from "../storage/taskRecords";
import type { ChangeEvidenceUpdate } from "../tasks/taskDeliveries";
import { TaskService } from "../tasks/taskService";
import { observeRunFailures } from "./checkRepair";
import type { RunBatchFacts } from "./deliveryWakes";
import type { TypedWake } from "./wakes";

export const RUN_WATCH_BOUND_MS = 3 * 60 * 60_000;
export const RUN_WATCH_LIMIT = 5;
export const RUN_WATCH_TICK_MS = 60_000;

export type RunReading = { run: WorkflowRun; list: WorkflowJobList };

export function runFinished(run: WorkflowRun): boolean {
  return run.status === "completed" || run.conclusion !== null;
}

/** Hosts normalize terminal job conclusions; GitLab exposes allowed failures explicitly. */
export function failedRunJobs(list: WorkflowJobList): WorkflowJobLine[] {
  return list.jobs.filter(
    (job) =>
      !job.allowedToFail &&
      ["failure", "failed", "timed_out", "startup_failure", "action_required"].includes(
        job.conclusion ?? "",
      ),
  );
}

/** A run's state for the checks cell: running until it ends, then by its conclusion. */
function runChecksState(run: WorkflowRun): RunChecks["state"] {
  if (!runFinished(run)) return "running";
  const conclusion = run.conclusion ?? run.status;
  if (conclusion === "success" || conclusion === "skipped") return "passed";
  if (conclusion === "cancelled" || conclusion === "canceled") return "cancelled";
  return "failed";
}

/** Job states on both hosts that mean a machine has taken the job. */
const STARTED_JOB_STATES = new Set(["in_progress", "running"]);

/**
 * What a read of an unfinished run shows on the merge card's strip: its
 * version and page, and whether a machine runs any of its jobs now or every
 * unfinished job still waits for one - a run whose first jobs finished
 * while the rest wait reads as queued. The state keeps the time the app's
 * reads first saw it, so a long wait shows how long. None once the run
 * finished.
 */
export function watchReadingOf(
  watch: RunWatch | undefined,
  { run, list }: RunReading,
  now: number,
): RunWatchReading | undefined {
  if (runFinished(run)) return undefined;
  const state = list.jobs.some((job) => STARTED_JOB_STATES.has(job.status)) ? "running" : "queued";
  const kept = watch?.reading;
  const since = kept && kept.state === state && kept.head === run.headSha ? kept.since : now;
  return { head: run.headSha, url: run.url, state, since, at: now };
}

/**
 * A watched run's reading for the checks cell (INF-594): the same run's
 * newer reading replaces the one shown, and so does a run the host started
 * at or after it; an older run leaves the newer one shown, and gives none.
 */
export function runChecksOf(
  delivery: TaskDelivery | null | undefined,
  run: WorkflowRun,
  at: number,
): RunChecks | undefined {
  const shown = delivery?.runChecks;
  if (
    shown &&
    shown.runId !== run.id &&
    (run.startedAt === undefined || (shown.startedAt ?? 0) > run.startedAt)
  )
    return undefined;
  return {
    runId: run.id,
    name: run.name,
    state: runChecksState(run),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    at,
  };
}

/** Keeps a watched run's reading on the task for the checks cell (`runChecksOf`). */
export function recordRunChecks(
  tasks: Pick<TaskService, "get"> & {
    delivery: Pick<TaskService["delivery"], "recordChangeEvidence">;
  },
  taskId: string,
  run: WorkflowRun,
  at: number,
): void {
  const runChecks = runChecksOf(tasks.get(taskId)?.delivery, run, at);
  if (runChecks) tasks.delivery.recordChangeEvidence(taskId, { runChecks });
}

/**
 * Keeps a run's failed jobs on the task's repair ledger (INF-688): a job a
 * reading names failed is an observed failing head/check at the run's
 * version, so its diagnosis and rerun reservation need no pull request.
 */
export function recordRunFailures(
  tasks: Pick<TaskService, "get"> & {
    delivery: Pick<TaskService["delivery"], "recordChangeEvidence">;
  },
  taskId: string,
  reading: RunReading,
): void {
  const ledger = runFailuresOf(tasks.get(taskId)?.delivery, reading);
  if (ledger) tasks.delivery.recordChangeEvidence(taskId, { ciRepair: ledger });
}

/** The repair ledger with a reading's failed jobs on it, or none when it already holds them. */
function runFailuresOf(
  delivery: TaskDelivery | null | undefined,
  { run, list }: RunReading,
): CheckRepairLedger | undefined {
  return observeRunFailures(delivery, run, {
    failed: failedRunJobs(list).map((job) => job.name),
    complete: list.complete,
  });
}

export function runWatchOnce(watch: RunWatch, event: "failure" | "end"): string {
  return `run-watch:${watch.runId}:${watch.since}:${event}`;
}

/** Saved task facts, plain forge reads on the supervisor's tick, and durable named steers. */
export class RunWatcher {
  private readonly reading = new Set<string>();

  constructor(
    private readonly host: {
      tasks: TaskService;
      inbox: Pick<InboxStore, "woken">;
      read(taskId: string, runId: number): Promise<RunReading>;
      steer(taskId: string, wake: TypedWake): Promise<unknown>;
      /**
       * The batch of the captain's approved changes a run checks, when the
       * task is not one of its changes (INF-4574): absent where no batch is read.
       */
      batchOf?: (taskId: string, run: WorkflowRun) => RunBatchFacts | undefined;
    },
  ) {}

  async poll(now: number): Promise<void> {
    await Promise.all(
      this.host.tasks.listLive().flatMap((task) =>
        (task.delivery?.runWatches ?? [])
          .filter((watch) => watch.nextAt <= now)
          .map((watch) =>
            this.pollRun(task.id, watch, now).catch((caught: unknown) => {
              console.warn("[crew] run watch could not read a task:", caught);
            }),
          ),
      ),
    );
  }

  private async pollRun(taskId: string, watch: RunWatch, now: number): Promise<void> {
    const key = `${taskId}:${watch.runId}`;
    if (this.reading.has(key)) return;
    this.reading.add(key);
    try {
      if (!this.current(taskId, watch)) return;
      if (this.host.inbox.woken(taskId, runWatchOnce(watch, "end"))) {
        this.clear(taskId, watch);
        return;
      }
      let read: RunReading;
      try {
        read = await this.host.read(taskId, watch.runId);
      } catch (caught) {
        if (!this.current(taskId, watch)) return;
        // A spent allowance is a wait until the host's reset, not a verdict (INF-2149).
        const resetAt = allowanceResetOf(caught);
        const transient =
          !(caught instanceof ForgeError) ||
          caught.failure === "transient" ||
          resetAt !== undefined;
        if (transient && now - watch.since < RUN_WATCH_BOUND_MS) {
          this.update(taskId, watch, {
            ...watch,
            nextAt: Math.max(now + RUN_WATCH_TICK_MS, resetAt ?? 0),
          });
          return;
        }
        await this.end(taskId, watch, {
          kind: "run-watch",
          outcome:
            caught instanceof ForgeError && caught.failure === "not-found" ? "gone" : "unreadable",
          runId: watch.runId,
          name: watch.name,
          problem: caught instanceof ForgeError ? caught.message : "The host did not answer.",
        });
        return;
      }
      // A close or a crewmate read during this request owns the newer facts.
      if (!this.current(taskId, watch)) return;
      // What this read observed: the checks cell at the read's own time and
      // any failed jobs for the repair ledger. An ordinary read saves them
      // with its next read in one write (INF-2220); a read that wakes the
      // crewmate saves them before the wake goes out.
      const delivery = this.host.tasks.get(taskId)?.delivery;
      const runChecks = runChecksOf(delivery, read.run, now);
      const ciRepair = runFailuresOf(delivery, read);
      const observed: ChangeEvidenceUpdate = {
        ...(runChecks ? { runChecks } : {}),
        ...(ciRepair ? { ciRepair } : {}),
      };
      const reading = watchReadingOf(watch, read, now);
      const current: RunWatch = {
        ...watch,
        attempt: read.run.attempt,
        name: read.run.name,
        ...(reading ? { reading } : {}),
      };
      const failed = failedRunJobs(read.list);
      const finished = runFinished(read.run);
      const timedOut = now - watch.since >= RUN_WATCH_BOUND_MS;
      const firstFailure = !watch.failureSeen && failed.length > 0;
      // Read only for a wake: what the app knows of the batch this run checks.
      const batch = finished || firstFailure ? this.host.batchOf?.(taskId, read.run) : undefined;
      const facts = {
        kind: "run-watch" as const,
        runId: read.run.id,
        name: read.run.name,
        attempt: read.run.attempt,
        jobs: failed,
        complete: read.list.complete,
        ...(batch ? { batch } : {}),
      };
      if (finished || timedOut || firstFailure) this.record(taskId, observed);
      if (finished) {
        const conclusion = read.run.conclusion;
        await this.end(taskId, current, {
          ...facts,
          outcome:
            conclusion === "success"
              ? "passed"
              : conclusion === "cancelled" || conclusion === "canceled"
                ? "cancelled"
                : "failed",
          state: conclusion ?? read.run.status,
        });
        return;
      }
      if (timedOut) {
        await this.end(taskId, current, { ...facts, outcome: "timed-out" });
        return;
      }
      if (firstFailure) {
        const once = runWatchOnce(watch, "failure");
        if (!this.host.inbox.woken(taskId, once)) {
          await this.host.steer(taskId, { facts: { ...facts, outcome: "first-failure" }, once });
        }
        // A turn woken above may already have taken its own reading.
        if (!this.current(taskId, watch)) return;
        current.failureSeen = true;
      }
      this.update(
        taskId,
        watch,
        { ...current, nextAt: now + RUN_WATCH_TICK_MS },
        firstFailure ? {} : observed,
      );
    } finally {
      this.reading.delete(key);
    }
  }

  private current(taskId: string, watch: RunWatch): boolean {
    const task = this.host.tasks.get(taskId);
    return (
      !!task &&
      !TaskService.isClosed(task) &&
      task.delivery?.runWatches?.some(
        (w) => w.runId === watch.runId && w.since === watch.since && w.nextAt === watch.nextAt,
      ) === true
    );
  }

  private record(taskId: string, observed: ChangeEvidenceUpdate): void {
    if (Object.keys(observed).length > 0)
      this.host.tasks.delivery.recordChangeEvidence(taskId, observed);
  }

  /** Schedules the watch's next read, with what this read observed in the same write. */
  private update(
    taskId: string,
    watch: RunWatch,
    next: RunWatch,
    observed: ChangeEvidenceUpdate = {},
  ): void {
    if (!this.current(taskId, watch)) return;
    const watches = this.host.tasks.get(taskId)?.delivery?.runWatches ?? [];
    this.host.tasks.delivery.recordChangeEvidence(taskId, {
      ...observed,
      runWatches: watches.map((w) => (w.runId === watch.runId ? next : w)),
    });
  }

  private clear(taskId: string, watch: RunWatch): void {
    if (!this.current(taskId, watch)) return;
    const watches = this.host.tasks.get(taskId)?.delivery?.runWatches ?? [];
    this.host.tasks.delivery.recordChangeEvidence(taskId, {
      runWatches: watches.filter((w) => w.runId !== watch.runId),
    });
    this.host.tasks.note(taskId, `Stopped watching ${watch.name} (run ${watch.runId}).`, {
      news: false,
    });
  }

  private async end(
    taskId: string,
    watch: RunWatch,
    facts: Extract<TypedWake["facts"], { kind: "run-watch" }>,
  ): Promise<void> {
    const once = runWatchOnce(watch, "end");
    if (!this.host.inbox.woken(taskId, once)) {
      this.host.tasks.turns.endIdle(taskId);
      await this.host.steer(taskId, { facts, once });
    }
    this.clear(taskId, watch);
  }
}
