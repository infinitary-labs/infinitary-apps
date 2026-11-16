import type { DropTaskReview } from "@shared/cards";
import type { TASK_CARD_VIA } from "@shared/provenance";
import type { Reasoning } from "@shared/reasoning";
import {
  DROP_BEFORE_START,
  DROP_REVIEW_STALE,
  dropIneligibleRefusal,
  dropMissingRefusal,
  dropReviewKeys,
  NO_LONGER_WANTED,
  sameDropReview,
} from "@shared/recordDrop";
import type { WorkShape } from "@shared/routingPolicy";
import {
  backlogActivity,
  CAPTAIN_STOP_ACTIVITY,
  captainStopRefusal,
  leftBacklogActivity,
  QUEUE_POLICY,
  QUEUED_ACTIVITY,
  queueClosedRefusal,
  queueMissingRefusal,
  queuePartsRefusal,
  queueStartedBacklogRefusal,
  queueStartedRefusal,
  UNQUEUED_ACTIVITY,
} from "@shared/taskQueue";
import { isUnstartedWork } from "@shared/tasks";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskGate, TaskRecord } from "../storage/taskRecords";
import { TaskGraphRefusal } from "./taskGraph";
import { TaskService } from "./taskService";
import { keyOrId, type TaskWriter } from "./taskWriter";

/** The record's status line when a start whose outcome is unknown goes back to the queue. */
export const UNCONFIRMED_START_RETURNED = "returned to the queue - the start was not confirmed";
/** The same line for a start a quit cut short, found at the next launch. */
const UNFINISHED_START_RETURNED = "returned to the queue - the start did not finish";

/**
 * How a start that began no crewmate ends (INF-3307's audit, row 4), which
 * `TaskStarts.returnStart` writes in one place. Every outcome leaves the
 * task open and never started, so its record offers Drop task:
 * - `retry`: the outcome is unknown, not a failure, and whatever started it
 *   tries again; its line reaches Activity only with `feed`, as one a quit
 *   cut short does.
 * - `held`: it waits behind a gate, such as a sign-in, that clears it.
 * - `failed`: Could not start, back in the backlog for your word. With
 *   `feed`, Activity says so with its reason: the queue's own start, which
 *   nobody asked for (the captain kept that line); whoever asked hears it
 *   from the reply instead.
 */
export type StartReturn =
  | { kind: "retry"; text: string; feed?: true }
  | { kind: "held"; gate: TaskGate }
  | { kind: "failed"; reason: string; feed?: true };

export type DispatchInput = {
  workspace: {
    repoDir: string;
    worktreeDir: string;
    branch: string;
    /**
     * Its working copy is on the computer that runs work its record names,
     * with none on this Mac (docs/helper.md, "Its working copies"): present
     * all the same, until that computer retires it.
     */
    elsewhere?: boolean;
  };
  accountId: string | null;
  assignee: string;
  model?: { provider: string; id: string } | undefined;
  /** The reasoning the session opened at on that model, when it says (FI3-439). */
  reasoning?: Reasoning | undefined;
  actor?: TaskEventActor;
};

/**
 * Starting work: leaving the backlog, the start attempts the board reads,
 * claiming a row for dispatch and what its crewmate runs on, and returning a
 * start that did not finish to the queue. Reached as `tasks.starts`.
 */
export class TaskStarts {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {
    this.releaseUnstartedDispatches();
  }

  /** Whether another task of the project saved this branch, closed ones too (`nameTaskBranch`). */
  branchSavedByAnother(repoId: string | null, branch: string, taskId: string): boolean {
    return this.writer.store.holdsBranch(repoId, branch, taskId);
  }

  startAgainRefusal(id: string): string | undefined {
    const record = this.tasks.get(id);
    if (!record) return "This task could not be found.";
    const key = keyOrId(record);
    if (record.kind !== "work" || record.status !== "dropped")
      return `${key} is not dropped work. Only dropped work starts again.`;
    const replacement = this.tasks.graph.replacementOf(id);
    if (replacement) return `${replacement} already replaces ${key}. Open that task instead.`;
    if (this.tasks.graph.children(id).length)
      return `${key} has parts. Start a part again instead.`;
    return undefined;
  }

  /** Copy the specification and move outstanding waits in one transaction. */
  startAgain(
    id: string,
    input: {
      id: string;
      shape: WorkShape;
      actor: "captain" | "firstmate";
      via?: typeof TASK_CARD_VIA;
      panel?: string;
    },
  ): TaskRecord {
    return this.writer.write(() => {
      const refusal = this.startAgainRefusal(id);
      if (refusal) throw new TaskGraphRefusal(refusal);
      const old = this.writer.mustGet(id);
      const parent = old.parentId ? this.tasks.get(old.parentId) : undefined;
      const fresh = this.tasks.create({
        id: input.id,
        kind: "work",
        title: old.title,
        goal: old.goal,
        intent: old.intent,
        prompt: old.prompt,
        repoId: old.repoId,
        projectId: old.projectId,
        priority: old.priority,
        ...(parent && !TaskService.isClosed(parent) ? { parentId: parent.id } : {}),
        shape: input.shape,
        startPolicy: "on-request",
        actor: input.actor,
      });
      // The link moves the outstanding waits with it (`moveWaits`).
      this.tasks.graph.link(id, fresh.id, "replaced-by", input.actor);
      this.tasks.note(id, `Started again as ${fresh.key}.`, {
        actor: input.actor,
        news: true,
        data: {
          startAgain: fresh.key,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
        },
      });
      return fresh;
    })();
  }

  /**
   * The captain's drop of never-started work, as the one drop writes it
   * (`TaskDrop`, INF-3169's piece 4). Refuses a row that has started and a
   * review that no longer matches. Its open parts stay planned: it does not
   * touch descendants, links, or dependents. One transaction.
   */
  dropUnstarted(
    id: string,
    input: {
      actor: TaskEventActor;
      review: DropTaskReview;
      reason?: string;
      via?: typeof TASK_CARD_VIA;
      /** The panel the captain dropped it from, by its title. */
      panel?: string;
    },
  ): { ok: true } | { ok: false; text: string } {
    const run = this.writer.write((): { ok: true } | { ok: false; text: string } => {
      const record = this.writer.store.get(id);
      if (!record) return { ok: false, text: dropMissingRefusal(id) };
      const key = keyOrId(record);
      if (!isUnstartedWork(record) || record.worktreeDir || record.assignee != null) {
        return { ok: false, text: dropIneligibleRefusal(key) };
      }
      const effects = this.tasks.dropEffects(id);
      if (!sameDropReview(dropReviewKeys(effects), input.review)) {
        return { ok: false, text: DROP_REVIEW_STALE };
      }
      this.tasks.close(id, {
        status: "dropped",
        reason: "cancelled",
        actor: input.actor,
        text: `dropped - ${input.reason ?? NO_LONGER_WANTED}`,
        data: {
          [DROP_BEFORE_START]: true,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
        },
        feed: false,
      });
      return { ok: true };
    });
    return run();
  }

  /**
   * The task board's queue and unqueue (src/shared/taskQueue.ts): never-
   * started work starts by itself when ready, or waits for the captain's
   * word again. Work that has started, a parent whose parts do the work, and
   * closed or missing rows are refused as text and nothing is written. The
   * start policy is the one field it writes - blockers, holds, priority,
   * order, project and parent stay - with one timeline entry in the
   * captain's words. `changed` is false when the row already had it.
   *
   * Started work goes back to the backlog as well (INF-2062): its running
   * work records when (`backlogSince`) and its idle ladder starts over, so
   * nothing the host sends wakes it until Start (`leaveBacklog`). Its
   * working copy, conversation, change and jobs stay. Stopping its turn is
   * the caller's (`HostOps.moveToBacklog`). Queue it on started work
   * is refused: only Start picks it up again.
   */
  setQueued(
    id: string,
    op: keyof typeof QUEUE_POLICY,
    input: {
      actor: TaskEventActor;
      via?: typeof TASK_CARD_VIA;
      panel?: string;
      /** One sentence on why started work went back to the backlog. */
      reason?: string;
    },
  ): { ok: true; changed: boolean } | { ok: false; text: string } {
    const run = this.writer.write(
      (): { ok: true; changed: boolean } | { ok: false; text: string } => {
        const record = this.writer.store.get(id);
        if (!record) return { ok: false, text: queueMissingRefusal(id) };
        const key = keyOrId(record);
        if (record.kind === "work" && record.status === "active") {
          if (op === "queue-task") return { ok: false, text: queueStartedBacklogRefusal(key) };
          if (record.backlogSince != null) return { ok: true, changed: false };
          const at = this.writer.now();
          this.writer.patch(id, {
            backlogSince: at,
            recoveryRung: 0,
            recoveryCount: 0,
            recoveryAt: null,
            updatedAt: at,
          });
          this.writer.addEvent({
            taskId: id,
            at,
            actor: input.actor,
            kind: "note",
            text: backlogActivity(
              input.actor === "captain" ? "captain" : "firstmate",
              input.reason,
            ),
            data: {
              backlog: "entered",
              ...(input.reason ? { reason: input.reason } : {}),
              ...(input.via ? { via: input.via } : {}),
              ...(input.panel ? { panel: input.panel } : {}),
              news: true,
            },
            feed: false,
          });
          return { ok: true, changed: true };
        }
        if (record.kind !== "work" || record.status !== "open") {
          return { ok: false, text: queueClosedRefusal(key) };
        }
        if (!isUnstartedWork(record) || record.worktreeDir || record.assignee != null) {
          return { ok: false, text: queueStartedRefusal(key) };
        }
        if (this.tasks.graph.children(id).length > 0)
          return { ok: false, text: queuePartsRefusal(key) };
        const startPolicy = QUEUE_POLICY[op];
        if (record.startPolicy === startPolicy) return { ok: true, changed: false };
        const at = this.writer.now();
        this.writer.patch(id, {
          startPolicy,
          ...(record.startNotice ? { startNotice: null } : {}),
          updatedAt: at,
        });
        this.writer.addEvent({
          taskId: id,
          at,
          actor: input.actor,
          kind: "note",
          text: op === "queue-task" ? QUEUED_ACTIVITY : UNQUEUED_ACTIVITY,
          data: {
            startPolicy,
            ...(input.via ? { via: input.via } : {}),
            ...(input.panel ? { panel: input.panel } : {}),
            news: true,
          },
          feed: false,
        });
        return { ok: true, changed: true };
      },
    );
    return run();
  }

  /**
   * Start on a started task in the backlog (INF-2062): it leaves the
   * backlog, its idle clock starts now, and the caller delivers what waited
   * on its lane. False when it was not in the backlog.
   */
  leaveBacklog(
    id: string,
    input: { actor: TaskEventActor; via?: typeof TASK_CARD_VIA; panel?: string },
  ): boolean {
    const run = this.writer.write((): boolean => {
      const record = this.writer.store.get(id);
      if (record?.status !== "active" || record.backlogSince == null) return false;
      const at = this.writer.now();
      this.writer.patch(id, { backlogSince: null, idleSince: at, updatedAt: at });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor,
        kind: "note",
        text: leftBacklogActivity(input.actor === "captain" ? "captain" : "firstmate"),
        data: {
          backlog: "left",
          waited: at - record.backlogSince,
          ...(input.via ? { via: input.via } : {}),
          ...(input.panel ? { panel: input.panel } : {}),
          news: true,
        },
        feed: false,
      });
      return true;
    });
    return run();
  }

  /**
   * The first mate's word that the captain asked for this task to wait
   * (INF-3846 piece 2, `update_task` `captain_stop`): one line on its
   * timeline, so the next-move check reads it as stopped by the captain
   * until it starts again. Only a task that waits for a start takes it -
   * open on request, or started and in the backlog; anything else is
   * refused as text and nothing is written. A task already stopped that
   * way is left as it is.
   */
  declareCaptainStop(
    id: string,
    actor: TaskEventActor,
  ): { ok: true; changed: boolean } | { ok: false; text: string } {
    const run = this.writer.write(
      (): { ok: true; changed: boolean } | { ok: false; text: string } => {
        const record = this.writer.store.get(id);
        if (!record) return { ok: false, text: queueMissingRefusal(id) };
        const waits =
          record.kind === "work" &&
          ((record.status === "open" && record.startPolicy === "on-request") ||
            (record.status === "active" && record.backlogSince != null));
        if (!waits) return { ok: false, text: captainStopRefusal(keyOrId(record)) };
        if (this.stoppedByCaptain(record)) return { ok: true, changed: false };
        const at = this.writer.now();
        this.writer.patch(id, { updatedAt: at });
        this.writer.addEvent({
          taskId: id,
          at,
          actor,
          kind: "note",
          text: CAPTAIN_STOP_ACTIVITY,
          data: { captainStop: true },
          feed: false,
        });
        return { ok: true, changed: true };
      },
    );
    return run();
  }

  /** When the newest line that stopped or started this task was written, if any. */
  latestStopAt(id: string): number | undefined {
    return this.writer.events.latestStopLine(id)?.at;
  }

  /**
   * Whether the captain stopped this task (INF-3846 piece 2): it waits for a
   * start - open on request, or started and in the backlog - and the newest
   * line that stopped or started it is the captain's own move to the
   * backlog, or the first mate's declaration that the captain asked for it
   * (`declareCaptainStop`). A started task's line counts only from its
   * current stay in the backlog.
   */
  stoppedByCaptain(record: TaskRecord): boolean {
    if (record.kind !== "work") return false;
    const open = record.status === "open" && record.startPolicy === "on-request";
    const parked = record.status === "active" && record.backlogSince != null;
    if (!open && !parked) return false;
    const line = this.writer.events.latestStopLine(record.id);
    if (!line) return false;
    if (parked && line.at < (record.backlogSince ?? 0)) return false;
    if (line.data?.captainStop === true) return true;
    // A later line that sets the start policy, whoever wrote it, ends an
    // earlier stop: only the captain's own move to on-request is one.
    const changes = line.data?.changes as { startPolicy?: unknown } | undefined;
    const policy = line.data?.startPolicy ?? changes?.startPolicy;
    return (
      line.actor === "captain" && (line.data?.backlog === "entered" || policy === "on-request")
    );
  }

  /**
   * A crewmate takes the task: workspace, account, assignee, model. Shared
   * by an immediate commission and the ready sweep's dispatch.
   */
  /**
   * Take an open work row out of the ready query before any await on the
   * start path. Returns false when another caller already claimed it or
   * the row is not open work. `dispatch` later fills workspace facts;
   * `returnStart` ends a start that began no crewmate.
   */
  /**
   * Accepted starts that have not been claimed yet. The board reads this so
   * both surfaces leave Backlog before classification and routing finish.
   * Lost on restart: the row is still open, which is not a confirmed failure.
   */
  private readonly startAttempts = new Map<
    string,
    { phase: "preparing" | "checking"; since: number }
  >();

  startAttemptOf(id: string): { phase: "preparing" | "checking"; since: number } | undefined {
    return this.startAttempts.get(id);
  }

  startAttemptIds(): readonly string[] {
    return [...this.startAttempts.keys()];
  }

  /** Publish a start before the first slow step. Clears a previous failure notice. */
  beginStartAttempt(id: string): boolean {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (record?.status !== "open" || record.kind !== "work") return false;
      const at = this.writer.now();
      this.startAttempts.set(id, { phase: "preparing", since: at });
      if (record.startNotice) this.writer.patch(id, { startNotice: null, updatedAt: at });
      else this.writer.touch(id);
      return true;
    });
    return run();
  }

  /**
   * A start begun behind the first mate's answer on a backlog task queues it
   * (INF-3060): a quit before the start finishes leaves it for the next
   * launch's sweep, as it leaves a spawn. A failure puts it back in the
   * backlog (`returnStart`), and a start puts it back
   * on request (`keepOnRequest`).
   */
  queueForStart(id: string): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (record?.status !== "open" || record.startPolicy !== "on-request") return;
      this.writer.patch(id, { startPolicy: "when-ready", updatedAt: this.writer.now() });
    });
    run();
  }

  /**
   * A backlog task that `queueForStart` queued has started: it goes back on
   * request, as a started backlog task always stayed, so nothing starts it
   * again on its own if it later waits.
   */
  keepOnRequest(id: string): void {
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      if (record?.status !== "active" || record.startPolicy !== "when-ready") return;
      this.writer.patch(id, { startPolicy: "on-request", updatedAt: this.writer.now() });
    });
    run();
  }

  /** The attempt is claimed, refused, or no longer the thing the board should preview. */
  clearStartAttempt(id: string): void {
    if (!this.startAttempts.has(id)) return;
    const run = this.writer.write(() => {
      this.startAttempts.delete(id);
      this.writer.touch(id);
    });
    run();
  }

  /** Contact was lost after the attempt was accepted. Not a confirmed failure. */
  markStartChecking(id: string): void {
    const run = this.writer.write(() => {
      const since = this.startAttempts.get(id)?.since ?? this.writer.now();
      this.startAttempts.set(id, { phase: "checking", since });
      this.writer.touch(id);
    });
    run();
  }

  /**
   * A program began running in the host's runner (INF-799). It stays open,
   * since no crewmate holds it, and its first run is one event on its
   * timeline - never startedAt, which says a crewmate started and draws the
   * Crewmate tab - so a Start on request reads as started and the sweep
   * runs it again after a quit.
   */
  markProgramStarted(id: string): void {
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      if (this.programStarted(id)) return;
      const at = this.writer.now();
      this.writer.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        text: "program started",
        data: { programStarted: true, journal: true },
      });
    });
    run();
  }

  /** Whether the host's runner has run this program task (markProgramStarted). */
  programStarted(id: string): boolean {
    return this.tasks.timeline(id).some((event) => event.data?.programStarted === true);
  }

  /**
   * A start that began no crewmate goes back to open, never started, as its
   * outcome says (`StartReturn`); a closed task stays closed. An unknown
   * outcome returns only a claimed row that holds no conversation and, on
   * this Mac, no working copy: anything else began. One that failed or waits
   * behind a gate also gives up the working copy its start named.
   */
  returnStart(id: string, outcome: StartReturn): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.store.get(id);
      this.startAttempts.delete(id);
      if (!record || record.status === "done" || record.status === "dropped") return;
      if (outcome.kind === "retry" && !beganNothing(record)) return;
      const unclaimed =
        outcome.kind === "failed"
          ? { gate: null, startNotice: JSON.stringify({ reason: outcome.reason }) }
          : outcome.kind === "held"
            ? { gate: outcome.gate }
            : {};
      this.writer.patch(id, {
        status: "open",
        activity: null,
        assignee: null,
        model: null,
        startedAt: null,
        ...(outcome.kind === "retry"
          ? {}
          : { repoDir: "", worktreeDir: "", branch: "", workspaceState: "none" as const }),
        ...unclaimed,
        ...(outcome.kind === "failed" ? { startPolicy: "on-request" as const } : {}),
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: "host",
        kind: "status",
        ...(outcome.kind === "retry"
          ? { text: outcome.text, feed: outcome.feed ?? false }
          : outcome.kind === "held"
            ? {
                text: `returned to the queue${outcome.gate.reason ? ` - ${outcome.gate.reason}` : ""}`,
                data: { gate: outcome.gate },
              }
            : {
                text: `could not start - ${outcome.reason}`,
                // Back on request: the next-move check reads it as a new stay.
                data: { startNotice: { reason: outcome.reason }, startPolicy: "on-request" },
                feed: outcome.feed ?? false,
              }),
      });
    });
    run();
  }

  claimForDispatch(
    id: string,
    from?: typeof TASK_CARD_VIA,
    panel?: string,
    options: { spawned?: true } = {},
  ): boolean {
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      if (record.status !== "open" || record.kind !== "work") return false;
      const at = this.writer.now();
      this.writer.patch(id, {
        status: "active",
        activity: "starting",
        gate: null,
        startedAt: record.startedAt ?? at,
        updatedAt: at,
      });
      // A task spawned just now (INF-3060) shows Starting on its tile and
      // records no starting line, as a spawn never has.
      if (options.spawned) return true;
      // The captain's Start on the task card is his, and says where it came from.
      this.writer.addEvent({
        taskId: id,
        at,
        actor: from ? "captain" : "host",
        kind: "status",
        text: "starting",
        ...(from ? { data: { via: from, ...(panel ? { panel } : {}) } } : {}),
      });
      return true;
    });
    return run();
  }

  dispatch(id: string, input: DispatchInput): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const record = this.writer.mustGet(id);
      const model = input.model ? `${input.model.provider}/${input.model.id}` : null;
      this.writer.patch(id, {
        status: "active",
        activity: "starting",
        closedReason: null,
        closedAt: null,
        gate: null,
        repoDir: input.workspace.repoDir,
        worktreeDir: input.workspace.worktreeDir,
        branch: input.workspace.branch,
        workspaceState:
          input.workspace.worktreeDir || input.workspace.elsewhere ? "present" : "none",
        accountId: input.accountId,
        assignee: input.assignee,
        model,
        startedAt: record.startedAt ?? at,
        updatedAt: at,
      });
      this.writer.addEvent({
        taskId: id,
        at,
        actor: input.actor ?? "host",
        kind: "dispatched",
        text: `${input.assignee} started${model ? ` on ${model}` : ""}`,
        data: {
          assignee: input.assignee,
          model,
          branch: input.workspace.branch,
          ...(model && input.reasoning ? { reasoning: input.reasoning } : {}),
        },
      });
    });
    run();
  }

  /**
   * The model now answering for the task's crewmate, when it is not the one
   * the record names (`CrewSupervisor`, a session's `model_served`): the
   * record names it from here on, and `line`, when given, is the timeline
   * row and feed line that says what moved it.
   */
  recordServedModel(
    id: string,
    model: { provider: string; id: string },
    line?: { text: string; data: Record<string, unknown> },
  ): void {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      this.writer.mustGet(id);
      this.writer.patch(id, { model: `${model.provider}/${model.id}`, updatedAt: at });
      if (line) {
        this.writer.addEvent({
          taskId: id,
          at,
          actor: "host",
          kind: "note",
          text: line.text,
          data: { ...line.data, news: true },
          feed: true,
        });
      }
    });
    run();
  }

  /**
   * A previous process claimed a row and died before `dispatch` wrote a
   * worktree. Put those rows back on the ready query (no captain gate) so
   * the next sweep retries instead of leaving them interrupted and stuck.
   */
  private releaseUnstartedDispatches(): void {
    for (const record of this.writer.store.listByStatus("active"))
      if (record.kind === "work" && beganNothing(record))
        this.returnStart(record.id, { kind: "retry", text: UNFINISHED_START_RETURNED, feed: true });
  }
}

/**
 * A claimed start that has not begun: no conversation was recorded and, on
 * this Mac, no working copy written. A task on a computer that runs work has
 * no working copy here, and one that builds in place has none at all: its
 * start finished once its conversation was recorded.
 */
function beganNothing(record: TaskRecord): boolean {
  return (
    record.status === "active" &&
    !record.sessionFile &&
    (!record.worktreeDir || Boolean(record.deviceId))
  );
}
