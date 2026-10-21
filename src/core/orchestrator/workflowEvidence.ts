import { createHash } from "node:crypto";
import { HERE } from "@shared/deviceNames";
import {
  type DownloadArtifactInput,
  type Forge,
  ForgeError,
  type ForgeRepo,
  type ReadWorkflowInput,
  type WorkflowJobLine,
  type WorkflowJobList,
  type WorkflowRun,
} from "../forge";
import { TaskService } from "../tasks/taskService";
import { ArtifactFolderError, artifactPath, writeArtifact } from "../workspace/artifacts";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  failedRunJobs,
  RUN_WATCH_LIMIT,
  RUN_WATCH_TICK_MS,
  type RunReading,
  recordRunChecks,
  recordRunFailures,
  runFinished,
} from "./runWatch";

/**
 * Writes an artifact into the working copy of a task that runs on another
 * computer, there (`PlacedCopies.writeArtifact`, docs/helper.md "Its
 * working copies"); throws `EEXIST` when a file is already there.
 */
/** Writes an artifact into a task's working copy on another computer; answers the path there. */
export type ArtifactElsewhere = (
  taskId: string,
  deviceId: string,
  artifact: { runId: number; artifactId: number; bytes: Uint8Array },
) => Promise<string>;

/** The short read stops naming jobs past this, and says how many it left out. */
const SHORT_READ_MAX_CHARS = 20_000;

/** Task-scoped, read-only host evidence. It never changes CI state or spends a repair. */
export class WorkflowEvidenceService {
  constructor(
    private readonly options: {
      tasks: TaskService;
      repos: RepoRegistry;
      forgeFor: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
      /** A task on a computer that runs work keeps its working copy there. */
      writeElsewhere?: ArtifactElsewhere;
      now?: () => number;
    },
  ) {}

  /**
   * A run's short read when no job is named, otherwise one job's log lines.
   * github_read still lists runs by version; this read lists that run's jobs.
   */
  async read(taskId: string, input: ReadWorkflowInput): Promise<string> {
    return this.answer(async () => {
      const { workflows } = this.context(taskId);
      const runId = integer(input.runId, "runId");
      if (input.jobId === undefined) {
        const run = await workflows.run(runId);
        const list = await workflows.jobs(runId);
        return `${formatShortRunRead(run, list)}\n${this.observe(taskId, { run, list })}`;
      }
      const jobId = integer(input.jobId, "jobId");
      const offset = integer(input.offset ?? 1, "offset");
      const limit = integer(input.limit ?? 200, "limit", 1, 500);
      const run = await workflows.run(runId);
      const { job, text } = await workflows.jobLog(runId, jobId);
      const lines = text.split(/\r?\n/);
      const selected: string[] = [];
      let chars = 0;
      let clipped = false;
      for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
        const bounded = line.slice(0, 2000);
        if (chars + bounded.length > 20_000) break;
        selected.push(bounded);
        chars += bounded.length;
        clipped ||= bounded.length !== line.length;
      }
      const nextOffset =
        offset - 1 + selected.length < lines.length ? offset + selected.length : null;
      return JSON.stringify(
        {
          run,
          job,
          offset,
          nextOffset,
          totalLines: lines.length,
          longLinesClipped: clipped,
          lines: selected,
        },
        null,
        2,
      );
    });
  }

  /** The supervisor reads through the same project/sign-in context, without gateway calls or CI facts. */
  async readWatched(taskId: string, runId: number): Promise<RunReading> {
    const { workflows } = this.context(taskId);
    return { run: await workflows.run(runId), list: await workflows.jobs(runId) };
  }

  /** An accepted start has an exact run number; arm before the host queues its new attempt. */
  watchStarted(taskId: string, runId: number): string {
    integer(runId, "runId");
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return "The task is closed; no watch was started.";
    const watches = task.delivery?.runWatches ?? [];
    const existing = watches.find((w) => w.runId === runId);
    if (!existing && watches.length >= RUN_WATCH_LIMIT)
      return "The task already watches 5 runs; this run is not watched. No wake will come for it. Read it with read_workflow once a slot is free.";
    const now = (this.options.now ?? Date.now)();
    const watch = existing ?? {
      runId,
      name: `Run ${runId}`,
      attempt: 1,
      since: now,
      nextAt: now + RUN_WATCH_TICK_MS,
      failureSeen: false,
    };
    if (!existing) {
      this.options.tasks.recordDelivery(taskId, { runWatches: [...watches, watch] });
      this.options.tasks.note(taskId, `Started watching ${watch.name} (run ${runId}).`, {
        news: false,
      });
    }
    return `The app watches run ${runId} every minute for up to 3 hours, and wakes you once on its first failed job and once when it ends. End your turn and wait; never sleep or loop on reads.`;
  }

  private observe(taskId: string, { run, list }: RunReading): string {
    const task = this.options.tasks.get(taskId);
    if (!task || TaskService.isClosed(task)) return "The task is closed; no watch was started.";
    recordRunFailures(this.options.tasks, taskId, { run, list });
    const watches = task.delivery?.runWatches ?? [];
    const existing = watches.find((w) => w.runId === run.id);
    const now = (this.options.now ?? Date.now)();
    if (runFinished(run)) {
      if (existing) {
        recordRunChecks(this.options.tasks, taskId, run, now);
        this.options.tasks.recordDelivery(taskId, {
          runWatches: watches.filter((w) => w.runId !== run.id),
        });
        this.options.tasks.note(
          taskId,
          `Stopped watching ${run.name} (run ${run.id}): the crewmate read its outcome.`,
          { news: false },
        );
      }
      return "The run has ended; no wake will come for this reading.";
    }
    if (!existing && watches.length >= RUN_WATCH_LIMIT) {
      return "The task already watches 5 runs; this run is not watched. No wake will come for it until a slot is free and you read it again.";
    }
    recordRunChecks(this.options.tasks, taskId, run, now);
    const watch = {
      ...(existing ?? { since: now }),
      runId: run.id,
      name: run.name,
      attempt: run.attempt,
      nextAt: now + RUN_WATCH_TICK_MS,
      // A crewmate reading the failure itself already knows: suppress that early wake only.
      failureSeen: existing?.failureSeen === true || failedRunJobs(list).length > 0,
    };
    this.options.tasks.recordDelivery(taskId, {
      runWatches: [...watches.filter((w) => w.runId !== run.id), watch],
    });
    if (!existing)
      this.options.tasks.note(taskId, `Started watching ${run.name} (run ${run.id}).`, {
        news: false,
      });
    return "The app watches this run every minute for up to 3 hours, and wakes you once on its first failed job and once when it ends. A failure you already read sends no early wake. End your turn and wait; never sleep or loop on reads.";
  }

  async download(taskId: string, input: DownloadArtifactInput): Promise<string> {
    return this.answer(async () => {
      const { workflows, cwd, deviceId } = this.context(taskId);
      const runId = integer(input.runId, "runId");
      const artifactId = integer(input.artifactId, "artifactId");
      const run = await workflows.run(runId);
      const { artifact, bytes } = await workflows.download(runId, artifactId);
      let relativePath = artifactPath(runId, artifactId);
      try {
        if (deviceId)
          relativePath = await this.elsewhere(taskId, deviceId, { runId, artifactId, bytes });
        else relativePath = await writeArtifact(cwd, runId, artifactId, bytes);
      } catch (caught) {
        if (caught instanceof ArtifactFolderError) throw new ForgeError("refused", caught.message);
        throw caught;
      }
      return JSON.stringify(
        {
          run,
          artifact,
          path: relativePath,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          extracted: false,
        },
        null,
        2,
      );
    });
  }

  /**
   * The task's forge and where its working copy is: this Mac's folder, or
   * the computer that runs work holding it there, when its record names one
   * (docs/helper.md, "Its working copies"); the forge is the project's
   * either way.
   */
  private context(taskId: string) {
    const task = this.options.tasks.get(taskId);
    if (!task) throw new ForgeError("not-found", "The task is no longer available.");
    const repo = task.repoId ? this.options.repos.get(task.repoId) : undefined;
    if (!repo) throw new ForgeError("not-found", "The task's project is no longer registered.");
    const deviceId = task.deviceId ?? undefined;
    if (!task.worktreeDir && !deviceId)
      throw new ForgeError("refused", "The task has no working copy for workflow evidence.");
    const forge = this.options.forgeFor(repo, task.worktreeDir || repo.path);
    if (!forge.workflows)
      throw new ForgeError(
        "unsupported",
        "This project's host has no workflow log or artifact reader.",
      );
    return { workflows: forge.workflows, cwd: task.worktreeDir, deviceId };
  }

  private elsewhere(
    taskId: string,
    deviceId: string,
    artifact: { runId: number; artifactId: number; bytes: Uint8Array },
  ): Promise<string> {
    const write = this.options.writeElsewhere;
    if (!write)
      throw new ForgeError(
        "unsupported",
        `${HERE.This} cannot reach the computer this task runs on.`,
      );
    return write(taskId, deviceId, artifact);
  }

  private async answer(run: () => Promise<string>): Promise<string> {
    try {
      return await run();
    } catch (caught) {
      if (caught instanceof ForgeError)
        return `Cannot read workflow evidence (${caught.failure}): ${caught.message}`;
      if ((caught as NodeJS.ErrnoException).code === "EEXIST")
        return "Cannot download artifact: the destination already exists; it was not overwritten.";
      // File/fetch errors are not a channel for sign-in material or signed URLs.
      return "Cannot read workflow evidence: the working copy or download is unavailable.";
    }
  }
}

/** The run's name, state, version, link and attempt, then one line per job. */
function formatShortRunRead(run: WorkflowRun, list: WorkflowJobList): string {
  const header = [
    run.name,
    `state: ${stateOf(run.status, run.conclusion)}`,
    `version: ${run.headSha}`,
    `attempt: ${run.attempt}`,
    `link: ${run.url}`,
  ];
  const room = SHORT_READ_MAX_CHARS - header.join("\n").length - 1;
  const lines: string[] = [];
  let used = 0;
  for (const job of list.jobs) {
    const line = jobLine(job);
    if (lines.length > 0 && used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [...header, jobsHeader(list, lines.length), ...lines].join("\n");
}

function jobsHeader(list: WorkflowJobList, shown: number): string {
  const known = list.total ?? list.jobs.length;
  const leftOut = known - shown;
  const unknownMore = list.total === null && !list.complete;
  if (leftOut > 0 && unknownMore) return `jobs: ${shown} shown, at least ${leftOut} left out`;
  if (leftOut > 0) return `jobs: ${shown} shown, ${leftOut} left out`;
  if (unknownMore) return `jobs: ${shown} shown, more left out`;
  return `jobs: ${list.jobs.length}`;
}

function jobLine(job: WorkflowJobLine): string {
  const where = job.failedAt ? ` — failed at "${quoted(job.failedAt)}"` : "";
  return `${job.id} ${oneLine(job.name)} — ${stateOf(job.status, job.conclusion)}${where}`;
}

function stateOf(status: string, conclusion: string | null): string {
  if (!conclusion || conclusion === status) return status;
  return `${status}, ${conclusion}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoted(value: string): string {
  return oneLine(value).replace(/"/g, "'").slice(0, 120);
}

function integer(
  value: number | undefined,
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ForgeError("refused", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}
