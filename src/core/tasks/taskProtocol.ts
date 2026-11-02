import { type Card, isReadyDecision } from "@shared/cards";
import { cardWords } from "@shared/cardWords";
import {
  type CrewPicture,
  type CrewResultText,
  type CrewTranscript,
  emptyTranscript,
} from "@shared/crewTranscript";
import type { FmEvent } from "@shared/events";
import type { ValidationEvidence } from "@shared/liveValidation";
import { liveValidationSummary } from "@shared/liveValidationSummary";
import type { ModelChoice } from "@shared/modelChoice";
import type { ModelReason } from "@shared/modelReason";
import { providerLabel, type Slot, slotSchema } from "@shared/modelSlots";
import { plainProblem, typedFailureOf } from "@shared/plainProblem";
import { isAllowanceProvider, servedProviderOf } from "@shared/quota";
import { type Reasoning, reasoningSchema } from "@shared/reasoning";
import type { RepoDelivery } from "@shared/repos";
import { captainActionResult } from "@shared/requiredActions";
import { foldForSearch } from "@shared/searchText";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import { type TaskHold, taskHoldWords } from "@shared/taskHold";
import { cardMerges, taskMovesOf } from "@shared/taskMoves";
import { planItemsSchema, type TaskPlan, type TaskPlanItem } from "@shared/taskPlan";
import { effectiveTaskPolicies, type PolicyRepo, type TaskRunsOn } from "@shared/taskPolicies";
import {
  BOARD_DELTA_TRIGGER,
  BOARD_RECENT_MS,
  diffTaskBoards,
  isUnstartedWork,
  type ProjectView,
  sortBoardLinks,
  sortBoardTasks,
  type TaskActionLine,
  type TaskBoard,
  type TaskCardRow,
  type TaskDetail,
  type TaskEventView,
  type TaskLinkView,
  type TaskPlace,
  type TaskStatus,
  type TaskView,
} from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import type { CoreEventSink } from "../events";
import type { ProjectRecord } from "../storage/projectStore";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskLink } from "../storage/taskLinkStore";
import { oldestFirst, type TaskRecord } from "../storage/taskStore";
import { standingDependencyWaits } from "./dependencyWaits";
import { holdingWaits, waitsSince } from "./holdingWaits";
import { queueWaitOf } from "./queueWait";
import { type ConcernedEventView, condenseActivity, reportHeadline } from "./recordActivity";
import { taskFeedLine } from "./taskFeed";
import { type TaskChange, TaskService } from "./taskService";
import type { TaskTimeline } from "./taskTimeline";
import { type TaskWaitFacts, taskWaitsOf } from "./taskWaits";

/**
 * The task protocol's core side (task-system design section 9, P3): the
 * board, one record's detail, the project index, and the emitter that
 * turns TaskService's committed changes into pushes.
 *
 * Every view is built from SQLite and live host facts at read time - flags
 * derived, never stored (principle 4). The emitter listens on
 * `TaskService.onChange`, which fires after the commit: each inserted
 * timeline event becomes a `task_event` FmEvent (its text authored as the
 * feed line, `src/core/tasks/taskFeed.ts`), each touched row a
 * `task_changed`, and the board is pushed on `inf:tasks` once per
 * coalescing window, like `inf:cards`. A client that misses a push resyncs
 * from `inf:tasks:board`; `seq` tells it which is newer.
 *
 * The board keeps what its last build read (`BoardCache`; INF-2078, the row
 * cache): one change rebuilds only the rows it reached - the rows the
 * writer touched, the rows at the other ends of their edges, their parents,
 * the active rows whose standing waits name them, and any row whose card
 * facts moved - and every other row keeps the view it had, so a change
 * costs the rows it reached, not the board. A rebuilt row is still derived
 * from SQLite and the live host facts at that read; a kept row's view is
 * the same object, which is how `diffTaskBoards` knows it did not move. A
 * host fact that moved with no row written (`TaskChange.presentation`) has
 * every row's live facts read again, and the rows they moved on rebuilt; a
 * purge or an import rebuilds everything. The cached board equals a build
 * from nothing (`taskProtocol.test.ts` pins it after every shape of write).
 *
 * The board is the LIVE set (open, active, closed within BOARD_RECENT_MS,
 * and the parents of those); history stays in the database and is read one
 * task at a time (design section 9.1).
 *
 * Above the measured trigger (P5, design section 9.1: a snapshot over
 * 256 KB or a live set over 500 rows) the push becomes `inf:tasks:delta`:
 * the snapshot is still brought up to date after the commit, but only its
 * difference from the last push crosses, on the same `seq`. The delta is
 * a DIFF of two snapshots, never a replay of the writer's bookkeeping, so
 * a derived change (a blocker closing, a card leaving the stack) travels
 * exactly as a written one does and applying it reproduces the fresh
 * snapshot by construction (`taskProtocol.test.ts`). The first push after
 * a purge, and the first push ever, are snapshots: a delta needs a base.
 */

/**
 * The outcome as the record reads it. An answer given on a card is kept as
 * that card's body - a standalone note's question (`FileQuestionInput`), or
 * the body a revised note recorded (`recordAnswer`) - and the record paints
 * text, so it reads the card's words (FI3-904); its Cards row keeps the card.
 */
function readableOutcome(record: TaskRecord, timeline: readonly TaskEvent[]): string | null {
  const outcome = record.outcome;
  if (!outcome) return outcome;
  const onCard = timeline.some(
    (event) =>
      (event.kind === "answered" && event.data?.body === outcome) ||
      (record.kind === "question" && event.kind === "card_raised"),
  );
  return onCard ? cardWords(outcome) : outcome;
}

function reviewBuilderOf(record: TaskRecord): string | null {
  return record.shape?.kind === "review" && record.shape.kind_source === "host:review"
    ? record.parentId
    : null;
}

/** The ids of the cards a timeline names, raised or resolved: a Firstmate decision's card has no task id of its own. */
function cardIdsOf(timeline: readonly TaskEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of timeline) {
    if ((event.kind === "card_raised" || event.kind === "card_resolved") && event.ref)
      ids.add(event.ref);
  }
  return [...ids];
}

/** Coalescing window for the board push, matching the card broadcast. */
export const BOARD_PUSH_COALESCE_MS = 40;

/** Most closed tasks a typed search returns. */
const SEARCH_LIMIT = 50;

/** How the board reaches clients on one push. */
export type BoardPushMode = "snapshot" | "delta";

export type TaskProtocolOptions = {
  tasks: TaskService;
  timeline?: Pick<TaskTimeline, "history">;
  validationEvidence?: (taskId: string, evidence: ValidationEvidence[]) => ValidationEvidence[];
  /** Repo facts the views denormalize; absent repos read as none. */
  repos: {
    get(
      id: string,
    ): ({ name: string; delivery: RepoDelivery; autonomy: boolean } & PolicyRepo) | undefined;
  };
  /** The open card stack: which decision card a task waits on. */
  cards: {
    listOpen(): Card[];
    snapshot(): Card[];
    /** Every card a task showed, newest first (the record's Cards row); `extraIds` are ones its timeline names. */
    forTask?(taskId: string, extraIds: readonly string[]): TaskCardRow[];
  };
  /** Live host presentation, independent of the persisted turn activity. */
  workPosture?: (record: TaskRecord) => WorkPosture;
  /** Shared posture-owner facts, not another per-row owner lookup. */
  waitFacts?: (record: TaskRecord) => TaskWaitFacts;
  /** The task's own browser on this Mac, as the captain reads it (docs/task-browser.md). */
  browser?: (taskId: string) => TaskBrowserFact | undefined;
  /**
   * What the task's crewmate did, oldest first, read from its kept session
   * at each read (`CrewActions`; docs/task-record.md, "A crewmate's actions").
   */
  actions?: (record: TaskRecord) => readonly TaskActionLine[];
  /** The last sentence the task's crewmate wrote, read the same way (`CrewActions.said`). */
  said?: (record: TaskRecord) => TaskActionLine | null;
  /**
   * The crewmate's sessions as its Crewmate tab reads them, at each read
   * (`CrewTranscripts`; docs/task-card-tabs.md, "The Crewmate tab").
   */
  transcript?: {
    of(record: TaskRecord, events: readonly TaskEvent[], closed: boolean): CrewTranscript;
    result(record: TaskRecord, ref: string): CrewResultText | null;
    picture(record: TaskRecord, ref: string): CrewPicture | null;
  };
  /** Deliver the focusable stack before any board shortcuts to it. */
  beforePush?: () => void;
  /**
   * The slot each work task's crewmate is served on (`TaskView.tier`),
   * read for the rows a view shows; absent means every tier reads null.
   */
  tiers?: (taskIds: readonly string[]) => ReadonlyMap<string, Slot>;
  /**
   * A model (`provider/id`) by the name the captain knows it ("GPT-6 Sol"),
   * through the one model-name lookup (`ModelSlots.nameOf`); the record
   * falls back to the bare id.
   */
  modelLabel?: (model: string) => string | undefined;
  /** Why a task's crewmate runs on its model (`TaskDetail.modelReason`); absent when unknown. */
  modelReason?: (record: TaskRecord) => ModelReason | undefined;
  /** How it got that model (`TaskDetail.modelChoice`); absent when the decision saved no comparison. */
  modelChoice?: (record: TaskRecord) => ModelChoice | undefined;
  /** Where a task runs (`TaskDetail.runsOn`); absent when no other computer could run it. */
  runsOn?: (record: TaskRecord) => TaskRunsOn | undefined;
  /**
   * Where a task runs in words, and whether that computer is out of reach
   * (`TaskView.place`); absent for a task this Mac runs.
   */
  place?: (record: TaskRecord) => TaskPlace | undefined;
  /**
   * Whether started work may move to another computer, and the move that
   * stands (`TaskView.movable`, `TaskView.computerMove`; docs/helper.md,
   * "Moving a started task").
   */
  computerMove?: (record: TaskRecord) => Pick<TaskView, "movable" | "computerMove">;
  /** An accepted start the board should show before the row is claimed. */
  startAttempt?: (taskId: string) => { phase: "preparing" | "checking"; since: number } | undefined;
  /** The event seam every FmEvent crosses (feed persistence, Observe, clients). */
  broadcastEvent: (event: FmEvent) => void;
  /** The push seam for the board snapshot. */
  emit: CoreEventSink;
  now?: () => number;
  coalesceMs?: number;
  /** The live-set size above which pushes are deltas; the design's trigger by default. */
  deltaTrigger?: { rows: number; bytes: number };
};

/**
 * A live work row with the moves it allows now, by the task record's own
 * rule (src/shared/taskMoves.ts); any other row carries none.
 */
export function withMoves(view: TaskView): TaskView {
  const moves = taskMovesOf(view);
  return moves ? { ...view, moves } : view;
}

export class TaskProtocol {
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly deltaTrigger: { rows: number; bytes: number };
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pushHolds = 0;
  private pushQueued = false;
  private readonly detach: () => void;
  /** The board as last pushed: the base a delta applies to. */
  private lastPushed: TaskBoard | undefined;
  /** Rows vanished since the last push: the next push is a snapshot. */
  private rebase = false;
  private disposed = false;
  /** Each live row's posture and place as last published, so a move in either republishes it. */
  private readonly postures = new Map<string, string>();
  private publishing:
    | { seq: number; records: readonly TaskRecord[]; facts: ReadonlyMap<string, LiveFacts> }
    | undefined;
  /** Facts this presentation publication just read, for its sequenced board update. */
  private pendingFacts: { seq: number; values: ReadonlyMap<string, LiveFacts> } | undefined;
  private readingFacts: Map<string, LiveFacts> | undefined;
  /** Each record's status as last emitted, so task_changed can say what it moved from. */
  private readonly statuses = new Map<string, TaskStatus>();
  /** What the last board was built from; absent until the first read. */
  private cache: BoardCache | undefined;
  /**
   * The rows written or removed since the cache was last brought up to
   * date, each as its last write left it (a removed row has none): the
   * record `onChange` read to say what changed, kept so the next read can
   * rule out a row closed outside the board's window without reading it.
   */
  private readonly touched = new Map<string, TaskRecord | undefined>();
  /** The next read builds the board from nothing: the first read, or rows vanished wholesale. */
  private rebuildAll = true;
  /** A host fact moved with no row written: the next read reads every row's live facts again. */
  private recheckFacts = false;

  constructor(private readonly options: TaskProtocolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.coalesceMs = options.coalesceMs ?? BOARD_PUSH_COALESCE_MS;
    this.deltaTrigger = options.deltaTrigger ?? BOARD_DELTA_TRIGGER;
    for (const record of options.tasks.list()) this.statuses.set(record.id, record.status);
    this.detach = options.tasks.onChange((change) => this.onChange(change));
  }

  /**
   * Non-record facts changed: publish one sequenced change only when posture or place
   * changes (a computer going out of reach writes no record), and answer whether any
   * moved. Only live rows are read: a long record is mostly closed rows, and a row's
   * posture moves on closing only with the write that closed it, which publishes it -
   * so a row leaving the live set is a move, not a write. `read` sees each
   * live row's posture as this pass read it, so a count can share the pass.
   */
  refreshPresentation(
    read?: (record: TaskRecord, posture: WorkPosture | undefined) => void,
  ): boolean {
    return this.options.tasks.readProjection(() => this.readPresentation(read));
  }

  private readPresentation(
    read?: (record: TaskRecord, posture: WorkPosture | undefined) => void,
  ): boolean {
    if (this.disposed) return false;
    const seq = this.options.tasks.boardSeq();
    const records = this.presentationRecords();
    return this.options.tasks.readProjection(
      () => this.readPresentationRows(records, seq, read),
      records,
    );
  }

  /** The board already owns these records; pending changes replace or remove them before a push. */
  private presentationRecords(): TaskRecord[] {
    const cache = this.cache;
    if (!cache || this.rebuildAll) return this.options.tasks.listLive();
    const live = new Map<string, TaskRecord>();
    const keep = (id: string, record: TaskRecord | undefined) => {
      if (record && (record.status === "open" || record.status === "active")) live.set(id, record);
      else live.delete(id);
    };
    for (const id of cache.shown) keep(id, cache.records.get(id));
    for (const [id, record] of this.touched) keep(id, record);
    return oldestFirst([...live.values()]);
  }

  private readPresentationRows(
    records: readonly TaskRecord[],
    seq: number,
    read?: (record: TaskRecord, posture: WorkPosture | undefined) => void,
  ): boolean {
    const changed: string[] = [];
    const live = new Set<string>();
    const facts = new Map<string, LiveFacts>();
    for (const record of records) {
      live.add(record.id);
      const current = this.liveFacts(record);
      facts.set(record.id, current);
      const workPosture = current.posture;
      read?.(record, workPosture);
      const posture = JSON.stringify([
        workPosture,
        current.place,
        current.computerMove,
        current.waits,
      ]);
      if (this.postures.get(record.id) === posture) continue;
      this.postures.set(record.id, posture);
      changed.push(record.id);
    }
    let left = false;
    for (const id of this.postures.keys()) {
      if (live.has(id)) continue;
      this.postures.delete(id);
      left = true;
    }
    if (changed.length) {
      // A callback may have written a task. Borrow only the unchanged snapshot.
      const unchanged = this.options.tasks.boardSeq() === seq;
      const previous = this.publishing;
      this.publishing = unchanged ? { seq: seq + 1, records, facts } : undefined;
      try {
        this.options.tasks.refreshPresentation(changed);
      } finally {
        this.publishing = previous;
      }
    }
    return changed.length > 0 || left;
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
  }

  // ---- reads --------------------------------------------------------------

  board(): TaskBoard {
    return this.options.tasks.readProjection(() => {
      const outer = this.readingFacts;
      const pending = this.pendingFacts;
      this.readingFacts = new Map(
        pending?.seq === this.options.tasks.boardSeq() ? pending.values : undefined,
      );
      try {
        return this.buildBoard();
      } finally {
        this.readingFacts = outer;
        if (this.pendingFacts === pending) this.pendingFacts = undefined;
      }
    });
  }

  private buildBoard(): TaskBoard {
    const now = this.now();
    const cutoff = now - BOARD_RECENT_MS;
    const cards = this.options.cards.snapshot();
    const minimized = new Set<string>();
    for (const card of cards) if (card.minimized && card.taskId) minimized.add(card.taskId);
    const cache =
      this.cache && !this.rebuildAll
        ? this.refresh(this.cache, cutoff, minimized, cards)
        : this.rebuild(cutoff, minimized, cards);
    this.cache = cache;
    this.rebuildAll = false;
    this.recheckFacts = false;
    this.touched.clear();
    const rows: TaskRecord[] = [];
    for (const id of cache.shown) {
      const record = cache.records.get(id);
      if (record) rows.push(record);
    }
    // Canonical order (the shared rule), so a client's applied delta and
    // this snapshot are equal as arrays.
    return {
      seq: this.options.tasks.boardSeq(),
      at: now,
      // The shown rows hold every row a count reads: live work and work
      // done within the window.
      projects: this.projectViews(rows, cache.graph, now, {
        get: (id) => cache.views.get(id)?.view,
      }),
      tasks: cache.tasks,
      links: cache.linkViews,
    };
  }

  /**
   * Which carrier the next push takes for this board: a delta once the
   * live set is over the trigger and a base exists, else the snapshot.
   * Measured on the snapshot itself - rows, then serialized size.
   */
  pushModeFor(board: TaskBoard): BoardPushMode {
    if (!this.lastPushed || this.rebase) return "snapshot";
    if (board.tasks.length > this.deltaTrigger.rows) return "delta";
    return Buffer.byteLength(JSON.stringify(board)) > this.deltaTrigger.bytes
      ? "delta"
      : "snapshot";
  }

  /**
   * Closed work the panel does not list - dropped work of any age, any work
   * closed before the board's window, and a question, decision or operation
   * closed within it (the panel lists only work as landed) - whose key, title or goal holds
   * the typed text (FI3-579 piece 3). Empty text finds nothing, so nothing
   * earlier is ever listed unasked. Newest closed first, at most
   * `SEARCH_LIMIT`; card and report text is never searched.
   */
  search(text: string): TaskView[] {
    const needle = foldForSearch(text.trim());
    if (!needle) return [];
    const { tasks } = this.options;
    const cutoff = this.now() - BOARD_RECENT_MS;
    // The match reads only the searched fields; whole rows only for what it found.
    const matched = tasks
      .listClosedSearchFields()
      .filter(
        (record) =>
          (record.status === "dropped" ||
            record.kind !== "work" ||
            (record.closedAt ?? 0) < cutoff) &&
          [record.key, record.title, record.goal ?? ""].some((field) =>
            foldForSearch(field).includes(needle),
          ),
      )
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, SEARCH_LIMIT);
    if (matched.length === 0) return [];
    const rows = new Map(tasks.getMany(matched.map((row) => row.id)).map((row) => [row.id, row]));
    const found = matched.flatMap((row) => rows.get(row.id) ?? []);
    // Closed rows wait on nothing, so the graph around them is all a view reads.
    const graph = this.graphFor(found);
    const tiers = this.tiersOf(found);
    return found.map((record) => this.viewOf(record, graph, tiers));
  }

  detail(id: string): TaskDetail {
    const { tasks } = this.options;
    const record = tasks.get(id);
    if (!record) throw new Error(`Unknown task "${id}".`);
    // The graph around the record and the rows it names - those its
    // concerning events were written by or name, those its standing waits
    // name, and the task of the card its gate names - never the whole
    // history (INF-939).
    const concerning = tasks.concerning(id);
    const named = new Set<string>();
    for (const event of concerning) {
      named.add(event.taskId);
      if (event.via) named.add(event.via);
    }
    for (const wait of standingDependencyWaits(tasks, record.delivery)) named.add(wait.task.id);
    const gateRef = record.gate?.kind === "captain" ? record.gate.ref : undefined;
    const gateTask = gateRef
      ? this.options.cards.snapshot().find((card) => card.id === gateRef)?.taskId
      : undefined;
    if (gateTask) named.add(gateTask);
    named.delete(id);
    const graph = this.graphFor([record, ...tasks.getMany([...named])]);
    const view = this.viewOf(record, graph, this.tiersOf([record]));
    const origin = crewFilingOrigin(record, graph);
    const timeline = tasks.timeline(id);
    const why = timeline.find((event) => typeof event.data?.why === "string")?.data?.why;
    const events: TaskEventView[] = timeline
      .filter((event) => !isProvenanceOnly(event))
      .map((event) => ({
        id: event.id,
        at: event.at,
        actor: event.actor,
        kind: event.kind,
        // A receipt reads as the brief it served, not its stored references.
        text: event.kind === "briefed" ? tasks.servedBrief(event) : event.text,
        data: event.data,
        ref: event.ref,
        feed: event.feed,
      }));
    // One read names each model once: the lookup reads the Settings rows.
    const names = new Map<string, string>();
    const modelLabel = (model: string) => {
      let name = names.get(model);
      if (name === undefined) {
        name = this.options.modelLabel?.(model) ?? model.slice(model.indexOf("/") + 1);
        names.set(model, name);
      }
      return name;
    };
    const modelReason = this.options.modelReason?.(record);
    const modelChoice = this.options.modelChoice?.(record);
    const runsOn = this.options.runsOn?.(record);
    const reasoning = reasoningOf(record, timeline);
    const browser = this.options.browser?.(id);
    const hold = holdOf(record);
    const cards = this.options.cards.forTask?.(id, cardIdsOf(timeline)) ?? [];
    const cardTitle = (cardId: string) => cards.find((card) => card.id === cardId)?.title;
    // Other tasks' events that concern this one, each naming the task that
    // wrote it (docs/task-record.md, "Whom an event concerns").
    // A row the graph does not hold, such as a replacement a closing names,
    // is read once on its own.
    const elsewhere = new Map<string, TaskRecord | undefined>();
    const rowOf = (taskId: string) => {
      const row = graph.byId.get(taskId);
      if (row || elsewhere.has(taskId)) return row ?? elsewhere.get(taskId);
      const read = tasks.get(taskId);
      elsewhere.set(taskId, read);
      return read;
    };
    const keyOf = (taskId: string) => {
      const row = rowOf(taskId);
      return row ? row.key || row.id : undefined;
    };
    const concerned = concerning.flatMap((event): ConcernedEventView[] => {
      const from = rowOf(event.taskId);
      if (!from) return [];
      const change =
        from.delivery?.changeLabel ??
        (from.delivery?.prNumber ? `#${from.delivery.prNumber}` : undefined);
      const changeUrl = from.delivery?.prUrl;
      const via = event.via ? keyOf(event.via) : undefined;
      return [
        {
          id: event.id,
          at: event.at,
          actor: event.actor,
          kind: event.kind,
          text: event.text,
          data: event.data,
          ref: event.ref,
          feed: event.feed,
          from: {
            id: from.id,
            key: from.key || from.id,
            ...(change ? { change } : {}),
            ...(changeUrl ? { changeUrl } : {}),
          },
          relation: event.relation,
          ...(via ? { via } : {}),
        },
      ];
    });
    const proof = liveValidationSummary(
      record.delivery?.liveValidation,
      record.delivery?.headSha ?? record.delivery?.validationHead,
      Boolean(record.delivery?.prUrl || record.delivery?.changeLabel),
    );
    if (proof && this.options.validationEvidence) {
      for (const row of proof.rows)
        row.evidence = this.options.validationEvidence(id, row.evidence);
    }
    return {
      ...view,
      ...(origin
        ? {
            filing: {
              why: typeof why === "string" ? why : "",
              originKey: origin.key || origin.id,
              verdict: record.verdict ?? null,
            },
          }
        : {}),
      intent: record.intent,
      liveValidation: proof,
      // The rigor the host derived at dispatch (delivery rigor phase 2), off
      // the shape it was stamped on; null on a row dispatched before it.
      policies: effectiveTaskPolicies(
        record,
        record.repoId ? this.options.repos.get(record.repoId) : undefined,
      ),
      ...(runsOn ? { runsOn } : {}),
      ...(record.placement ? { placement: record.placement.snapshot } : {}),
      rigor: record.shape?.rigor ?? null,
      // What the host derived the task DELIVERS (Task B); null on a row
      // shaped before the axis existed, which shipped as a change.
      deliverable: record.shape?.deliverable ?? null,
      // The basis as the record names it, its verdict derived now.
      basis: tasks.basisOf(record),
      skippedPlanBecause: record.shape?.skipped_plan_because ?? null,
      brief: record.prompt,
      outcome: readableOutcome(record, timeline),
      modelLabel: record.model ? modelLabel(record.model) : null,
      ...(modelReason ? { modelReason } : {}),
      ...(modelChoice ? { modelChoice } : {}),
      ...(reasoning ? { reasoning } : {}),
      cards,
      events,
      ...(this.options.timeline ? { timeline: this.options.timeline.history(id) } : {}),
      activityLog: condenseActivity(events, modelLabel, {
        cardTitle,
        concerned,
        keyOf,
        actions: this.options.actions?.(record) ?? [],
      }),
      said: this.options.said?.(record) ?? null,
      plan: planOf(timeline),
      closing: closingOf(record, events, tasks.carriedOn(id)),
      problem: problemOf(events),
      ...(hold ? { hold: taskHoldWords(hold) } : {}),
      asks: tasks.asksFor(id).map((ask) => ({
        id: ask.id,
        at: ask.at,
        text: ask.text,
        images: ask.images.length,
        attachedVia: ask.attachedVia,
        turnState: ask.turnState,
      })),
      ...(isUnstartedWork(record) ? { dropEffects: tasks.dropEffects(id) } : {}),
      ...(browser ? { browser } : {}),
    };
  }

  /**
   * The task's crewmate's session as its Crewmate tab reads it: an empty
   * transcript for a task no crewmate ran, or where nothing reads sessions.
   */
  crewmate(id: string): CrewTranscript {
    const { tasks } = this.options;
    const record = tasks.get(id);
    if (!record) throw new Error(`Unknown task "${id}".`);
    return (
      this.options.transcript?.of(record, tasks.timeline(id), TaskService.isClosed(record)) ??
      emptyTranscript(id)
    );
  }

  /** One call's whole result in the task's crewmate's session; null when it is gone. */
  crewmateResult(id: string, ref: string): CrewResultText | null {
    const record = this.options.tasks.get(id);
    if (!record) throw new Error(`Unknown task "${id}".`);
    return this.options.transcript?.result(record, ref) ?? null;
  }

  /** One picture a call's result holds in the task's crewmate's session; null when it is gone. */
  crewmatePicture(id: string, ref: string): CrewPicture | null {
    const record = this.options.tasks.get(id);
    if (!record) throw new Error(`Unknown task "${id}".`);
    return this.options.transcript?.picture(record, ref) ?? null;
  }

  projects(): ProjectView[] {
    // The board already owns the live/recent rows and their current counts.
    // Reading them here must not rebuild every view for the projects subscriber.
    return this.board().projects;
  }

  // ---- the emitter --------------------------------------------------------

  private onChange(change: TaskChange): void {
    const publication =
      change.republish &&
      this.publishing?.seq === change.seq &&
      change.seq === this.options.tasks.boardSeq()
        ? this.publishing
        : undefined;
    this.options.tasks.readProjection(
      () => this.readChange(change, publication?.facts),
      publication?.records ?? [],
    );
  }

  private readChange(change: TaskChange, facts?: ReadonlyMap<string, LiveFacts>): void {
    const { tasks, broadcastEvent } = this.options;
    // Reuse only our own sequenced publication, never a nested publication
    // or task write from another owner during the same notification.
    this.pendingFacts = facts ? { seq: change.seq, values: facts } : undefined;
    const records = new Map<string, TaskRecord | undefined>();
    const recordOf = (taskId: string) => {
      if (!records.has(taskId)) records.set(taskId, tasks.get(taskId));
      return records.get(taskId);
    };
    for (const event of change.events) {
      if (isProvenanceOnly(event)) continue;
      const record = recordOf(event.taskId);
      if (!record) continue;
      broadcastEvent(taskEventOf(record, event));
    }
    const tiers = this.tiersOf(
      change.taskIds.flatMap((taskId) => {
        const record = recordOf(taskId);
        return record ? [record] : [];
      }),
    );
    for (const taskId of change.taskIds) {
      const record = recordOf(taskId);
      if (!record) continue;
      const from = this.statuses.get(taskId) ?? null;
      this.statuses.set(taskId, record.status);
      broadcastEvent({
        type: "task_changed",
        taskId,
        key: record.key,
        kind: record.kind,
        status: record.status,
        from,
        activity: record.activity,
        workPosture: facts?.has(taskId)
          ? facts.get(taskId)?.posture
          : this.options.workPosture?.(record),
        ...(record.kind === "work"
          ? {
              tier: tiers.get(taskId) ?? null,
              reviewOf: reviewBuilderOf(record),
              executionDeviceId: record.deviceId,
            }
          : {}),
        closedReason: record.closedReason,
        ...(replaced(record) ? { replacedBy: this.options.tasks.replacementOf(record.id) } : {}),
        seq: change.seq,
      });
    }
    for (const taskId of change.removed) {
      this.statuses.delete(taskId);
      this.postures.delete(taskId);
    }
    if (change.reset) {
      this.statuses.clear();
      this.postures.clear();
    }
    if (change.reset || change.removed.length > 0) this.rebase = true;
    for (const id of change.taskIds) this.touched.set(id, recordOf(id));
    for (const id of change.removed) this.touched.set(id, undefined);
    if (change.reset) this.rebuildAll = true;
    if (change.presentation) this.recheckFacts = true;
    this.schedulePush();
  }

  /** Keep one board update for changes spread over a housekeeping sweep's turns. */
  holdPushes(): () => void {
    this.pushHolds += 1;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pushHolds -= 1;
      if (this.pushHolds === 0 && this.pushQueued) this.schedulePush();
    };
  }

  private schedulePush(): void {
    if (this.disposed) return;
    this.pushQueued = true;
    if (this.pushHolds > 0 || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.pushQueued = false;
      this.push();
    }, this.coalesceMs);
  }

  private push(): void {
    this.options.beforePush?.();
    const board = this.board();
    const base = this.lastPushed;
    if (this.pushModeFor(board) === "delta" && base) {
      this.options.emit("inf:tasks:delta", diffTaskBoards(base, board));
    } else {
      this.options.emit("inf:tasks", board);
    }
    this.lastPushed = board;
    this.rebase = false;
  }

  // ---- the row cache (INF-2078) --------------------------------------------

  /**
   * The board from nothing: the first read, and the read after rows
   * vanished wholesale. Only the rows the board shows are read: the live
   * set, the last week's closed work and any minimized card's task. A long
   * record is mostly closed rows from before that, and a crew event pushes
   * the board, so reading them all stalled the main process (INF-703).
   */
  private rebuild(
    cutoff: number,
    minimized: ReadonlySet<string>,
    cards: readonly Card[],
  ): BoardCache {
    const { tasks } = this.options;
    const records = new Map<string, TaskRecord>();
    for (const record of tasks.listLiveOrClosedSince(cutoff)) records.set(record.id, record);
    for (const record of tasks.getMany([...minimized].filter((id) => !records.has(id))))
      records.set(record.id, record);
    const shown = this.shownOf(records, cutoff, minimized);
    const ids = [...shown];
    const links = new Map<string, TaskLink>();
    for (const link of tasks.linksTouching(ids)) links.set(edgeKey(link), link);
    this.readEnds(records, shown, links);
    const childCounts = tasks.childCounts(ids);
    const rows = ids.map((id) => records.get(id) as TaskRecord);
    // What replaced each dropped row, read for all of them at once; one at
    // a time, each read its task's whole timeline (INF-2070).
    const replacedBy = tasks.replacementsOf(rows.filter(replaced).map((record) => record.id));
    const graph = this.graphOf(
      [...records.values()],
      [...links.values()],
      replacedBy,
      childCounts,
      cards,
    );
    const tiers = this.tiersOf(rows);
    const views = new Map<string, CachedView>();
    for (const record of rows) views.set(record.id, this.cachedView(record, graph, tiers));
    return {
      records,
      shown,
      links,
      childCounts,
      replacedBy,
      graph,
      views,
      tasks: sortBoardTasks([...views.values()].map((cached) => cached.view)),
      ...this.linkViewsOf(links, shown),
    };
  }

  /**
   * The board brought up to date with the rows written since the last
   * read. It rebuilds the rows a change reached: the touched rows, the rows
   * that entered the board, the shown rows at the other ends of a touched
   * row's edges (its blockers, what it blocks, its origin, its
   * replacement), a touched row's parents (their counts and parts), the
   * active rows whose standing waits name a touched row, and any row whose
   * card facts moved. After a host fact moved with no row written, every
   * row's live facts are read again and the rows they moved on are rebuilt
   * too. Every other row keeps its view, and a touched row closed before
   * the board's window that no shown row holds is ruled out from the
   * record its write left, with no read.
   */
  private refresh(
    cache: BoardCache,
    cutoff: number,
    minimized: ReadonlySet<string>,
    cards: readonly Card[],
  ): BoardCache {
    const { tasks } = this.options;
    const { records, links } = cache;
    // The touched rows the board can reach: those in hand (shown, or at the
    // other end of a shown row's edge) and those their last write left
    // live, closed within the window or minimized. A row closed before the
    // window that no shown row holds stays off the board whatever was
    // written to it, so the record its write left rules it out and it is
    // never read: closed history written since the last read costs the
    // update nothing (the scale check, INF-2061).
    const reaches = (record: TaskRecord) =>
      !TaskService.isClosed(record) || (record.closedAt ?? 0) >= cutoff || minimized.has(record.id);
    const touched = [...this.touched]
      .filter(([id, written]) => records.has(id) || (written !== undefined && reaches(written)))
      .map(([id]) => id);
    // The touched rows as they stand now; a row the writer deleted leaves.
    const before = new Map<string, TaskRecord | undefined>();
    const fresh = new Map(tasks.getMany(touched).map((record) => [record.id, record]));
    for (const id of touched) {
      before.set(id, records.get(id));
      const record = fresh.get(id);
      if (record) records.set(id, record);
      else records.delete(id);
    }
    for (const record of tasks.getMany([...minimized].filter((id) => !records.has(id))))
      records.set(record.id, record);
    const shown = this.shownOf(records, cutoff, minimized);
    const entered = [...shown].filter((id) => !cache.shown.has(id));
    const left = [...cache.shown].filter((id) => !shown.has(id));
    // The parents to count and rebuild: the parents a touched row had or
    // has (a row ruled out above included: its parent counts it), the
    // entered rows, and the parents of the rows that entered or left,
    // since a parent's start wait reads the parts in hand.
    const parents = new Set<string>(entered);
    for (const id of [...entered, ...left]) {
      const parentId = records.get(id)?.parentId;
      if (parentId) parents.add(parentId);
    }
    for (const [id, written] of this.touched) {
      const was = before.get(id)?.parentId;
      const is = (records.get(id) ?? written)?.parentId;
      if (was) parents.add(was);
      if (is) parents.add(is);
    }
    // The edges around the touched and entered rows, read again, and the
    // rows at the other ends of a touched row's edges, before and after.
    const reread = new Set([...touched, ...entered]);
    const neighbors = new Set<string>();
    const around = (link: TaskLink) => {
      if (!this.touched.has(link.fromId) && !this.touched.has(link.toId)) return;
      neighbors.add(link.fromId);
      neighbors.add(link.toId);
    };
    for (const [key, link] of links) {
      if (!reread.has(link.fromId) && !reread.has(link.toId)) continue;
      links.delete(key);
      around(link);
    }
    for (const link of tasks.linksTouching([...reread])) {
      links.set(edgeKey(link), link);
      around(link);
    }
    for (const [key, link] of links)
      if (!shown.has(link.fromId) && !shown.has(link.toId)) links.delete(key);
    this.readEnds(records, shown, links);
    const counted = [...parents].filter((id) => shown.has(id));
    const counts = tasks.childCounts(counted);
    for (const id of counted) {
      const count = counts.get(id);
      if (count) cache.childCounts.set(id, count);
      else cache.childCounts.delete(id);
    }
    for (const id of left) cache.childCounts.delete(id);
    const rebuild = new Set<string>(counted);
    for (const id of touched) if (shown.has(id)) rebuild.add(id);
    for (const id of neighbors) if (shown.has(id)) rebuild.add(id);
    if (touched.length > 0) {
      for (const id of shown) {
        const record = records.get(id);
        const diagnoses = record?.delivery?.ciRepair?.diagnoses;
        if (record?.status !== "active" || !diagnoses) continue;
        if (diagnoses.some((d) => d.dependencyTask && this.touched.has(d.dependencyTask)))
          rebuild.add(id);
      }
    }
    // What replaced the rebuilt dropped rows.
    const replacedIds = [...rebuild].filter((id) => replaced(records.get(id) as TaskRecord));
    const replacements = tasks.replacementsOf(replacedIds);
    for (const id of replacedIds) {
      const replacement = replacements.get(id);
      if (replacement) cache.replacedBy.set(id, replacement);
      else cache.replacedBy.delete(id);
    }
    for (const id of left) cache.replacedBy.delete(id);
    const graph = this.graphOf(
      [...records.values()],
      [...links.values()],
      cache.replacedBy,
      cache.childCounts,
      cards,
    );
    // The kept rows whose card facts moved, or whose live facts moved after a host fact did.
    for (const id of shown) {
      if (rebuild.has(id)) continue;
      const cached = cache.views.get(id);
      const record = records.get(id) as TaskRecord;
      if (
        !cached ||
        cached.cards !== cardFactsOf(record, graph) ||
        (this.recheckFacts && cached.facts !== factsKey(this.liveFacts(record)))
      )
        rebuild.add(id);
    }
    for (const id of left) cache.views.delete(id);
    const rebuilt = [...rebuild].map((id) => records.get(id) as TaskRecord);
    const tiers = this.tiersOf(rebuilt);
    for (const record of rebuilt) cache.views.set(record.id, this.cachedView(record, graph, tiers));
    // The rows in order: a changed membership sorts again; otherwise each
    // rebuilt view takes its row's place, and a board nothing reached
    // keeps its array.
    let rows = cache.tasks;
    if (entered.length > 0 || left.length > 0)
      rows = sortBoardTasks([...cache.views.values()].map((cached) => cached.view));
    else if (rebuild.size > 0)
      rows = cache.tasks.map((view) => cache.views.get(view.id)?.view ?? view);
    return { ...cache, shown, graph, tasks: rows, ...this.linkViewsOf(links, shown, cache) };
  }

  /**
   * The rows the board shows, from the records in hand: the live set, the
   * week's closed work and any minimized card's task, and the parents of
   * each of those, however old, so a child is never orphaned on the board.
   * A parent not in hand is read; the walk is bounded by the hierarchy cap.
   */
  private shownOf(
    records: Map<string, TaskRecord>,
    cutoff: number,
    minimized: ReadonlySet<string>,
  ): Set<string> {
    const shown = new Set<string>();
    for (const record of records.values()) {
      if (
        !TaskService.isClosed(record) ||
        (record.closedAt ?? 0) >= cutoff ||
        minimized.has(record.id)
      )
        shown.add(record.id);
    }
    for (const id of [...shown]) {
      let parentId = records.get(id)?.parentId;
      let depth = 0;
      while (parentId && !shown.has(parentId) && depth < 64) {
        let parent = records.get(parentId);
        if (!parent) {
          parent = this.options.tasks.get(parentId);
          if (!parent) break;
          records.set(parent.id, parent);
        }
        shown.add(parent.id);
        parentId = parent.parentId;
        depth += 1;
      }
    }
    return shown;
  }

  /**
   * The rows at the other ends of the shown rows' edges, read when not in
   * hand (a view reads its blockers and its origin); a row no edge or row
   * needs leaves.
   */
  private readEnds(
    records: Map<string, TaskRecord>,
    shown: ReadonlySet<string>,
    links: ReadonlyMap<string, TaskLink>,
  ): void {
    const ends = new Set<string>();
    for (const link of links.values()) {
      if (!shown.has(link.fromId)) ends.add(link.fromId);
      if (!shown.has(link.toId)) ends.add(link.toId);
    }
    for (const record of this.options.tasks.getMany([...ends].filter((id) => !records.has(id))))
      records.set(record.id, record);
    for (const id of [...records.keys()]) if (!shown.has(id) && !ends.has(id)) records.delete(id);
  }

  private cachedView(
    record: TaskRecord,
    graph: Graph,
    tiers: ReadonlyMap<string, Slot>,
  ): CachedView {
    const facts = this.liveFacts(record);
    return {
      view: this.viewOf(record, graph, tiers, facts),
      facts: factsKey(facts),
      cards: cardFactsOf(record, graph),
    };
  }

  /** The host's own facts a view reads, which no write of the row reports. */
  private liveFacts(record: TaskRecord): LiveFacts {
    const known = this.readingFacts?.get(record.id);
    if (known) return known;
    const facts = this.options.tasks.readProjection(
      () => ({
        repo: record.repoId ? this.options.repos.get(record.repoId) : undefined,
        posture: this.options.workPosture?.(record),
        waits: this.options.waitFacts?.(record),
        place: this.options.place?.(record),
        computerMove: record.kind === "work" ? this.options.computerMove?.(record) : undefined,
        startAttempt:
          this.options.startAttempt?.(record.id) ?? this.options.tasks.startAttemptOf(record.id),
      }),
      [record],
    );
    this.readingFacts?.set(record.id, facts);
    return facts;
  }

  /** The edges across shown rows in canonical order; the last array while the set is the same. */
  private linkViewsOf(
    links: ReadonlyMap<string, TaskLink>,
    shown: ReadonlySet<string>,
    previous?: Pick<BoardCache, "linkViews" | "linkKeys">,
  ): Pick<BoardCache, "linkViews" | "linkKeys"> {
    const linkKeys = new Set<string>();
    const views: TaskLinkView[] = [];
    for (const [key, link] of links) {
      if (!shown.has(link.fromId) || !shown.has(link.toId)) continue;
      linkKeys.add(key);
      views.push({ fromId: link.fromId, toId: link.toId, type: link.type });
    }
    if (
      previous &&
      previous.linkKeys.size === linkKeys.size &&
      [...linkKeys].every((key) => previous.linkKeys.has(key))
    )
      return { linkViews: previous.linkViews, linkKeys: previous.linkKeys };
    return { linkViews: sortBoardLinks(views), linkKeys };
  }

  // ---- view building ------------------------------------------------------

  /**
   * The graph around these rows, read from them alone: the edges touching
   * them, the rows at those edges' other ends, and each row's child counts.
   * Holds every fact `viewOf` reads for these rows while they include the
   * whole live set (a gate, a ready decision and a standing wait name live
   * work), or the rows' own standing waits (`detail`) or none (closed rows).
   */
  private graphFor(
    rows: readonly TaskRecord[],
    cards: readonly Card[] = this.options.cards.snapshot(),
  ): Graph {
    const { tasks } = this.options;
    const ids = rows.map((record) => record.id);
    const known = new Set(ids);
    const links = tasks.linksTouching(ids);
    const ends = new Set<string>();
    for (const link of links) {
      if (!known.has(link.fromId)) ends.add(link.fromId);
      if (!known.has(link.toId)) ends.add(link.toId);
    }
    const all = [...rows, ...tasks.getMany([...ends])];
    // What replaced each dropped row, read for all of them at once; one at
    // a time, each read its task's whole timeline (INF-2070).
    const replacedBy = tasks.replacementsOf(rows.filter(replaced).map((record) => record.id));
    return this.graphOf(all, links, replacedBy, tasks.childCounts(ids), cards);
  }

  private graphOf(
    all: readonly TaskRecord[],
    links: TaskLink[],
    replacedBy: Map<string, string>,
    childCounts: Map<string, { total: number; closed: number }> | undefined,
    cards: readonly Card[],
  ): Graph {
    // The graph owns these current records, including the other tasks a posture reads.
    this.options.tasks.readProjection(() => undefined, all);
    const byId = new Map(all.map((record) => [record.id, record]));
    // Each row's children among these rows, in their order: the parts a
    // start wait reads, found once rather than by a walk of every row per view.
    const parts = new Map<string, TaskRecord[]>();
    for (const record of all) if (record.parentId) push(parts, record.parentId, record);
    const linksInto = new Map<string, TaskLink[]>();
    const blockersOf = new Map<string, TaskRecord[]>();
    const blockingOf = new Map<string, TaskRecord[]>();
    const mergeHolds = new Set<string>();
    for (const link of links) {
      const incoming = linksInto.get(link.toId);
      if (incoming) incoming.push(link);
      else linksInto.set(link.toId, [link]);
      if (link.type !== "blocks") continue;
      const from = byId.get(link.fromId);
      const to = byId.get(link.toId);
      if (!from || !to) continue;
      push(blockersOf, link.toId, from);
      push(blockingOf, link.fromId, to);
      if (link.holdsMerge) mergeHolds.add(`${link.toId}\0${link.fromId}`);
    }
    const children = childCounts ?? new Map<string, { total: number; closed: number }>();
    if (!childCounts) {
      for (const record of all) {
        if (!record.parentId) continue;
        const entry = children.get(record.parentId) ?? { total: 0, closed: 0 };
        entry.total += 1;
        if (TaskService.isClosed(record)) entry.closed += 1;
        children.set(record.parentId, entry);
      }
    }
    // Each task's first crewmate-filed discovered-from edge, read once per view build.
    const filedFrom = new Map<string, TaskLink>();
    for (const link of links) {
      if (link.type !== "discovered-from" || link.actor !== "crewmate") continue;
      if (!filedFrom.has(link.fromId)) filedFrom.set(link.fromId, link);
    }
    const decisionCards = new Map<string, Card>();
    const gateTasks = new Map<string, TaskRecord[]>();
    for (const record of all) {
      if (TaskService.isClosed(record) || record.gate?.kind !== "captain" || !record.gate.ref)
        continue;
      push(gateTasks, record.gate.ref, record);
    }
    const durableDecisions = new Set<string>();
    const openCardIds = new Set<string>();
    for (const card of this.options.cards.listOpen()) {
      openCardIds.add(card.id);
      if (card.actions.length > 0 && card.taskId) durableDecisions.add(card.taskId);
    }
    // Snapshot is already in stage priority/newest order. Hidden siblings
    // never mask a reachable ready choice.
    for (const card of cards) {
      if (!isReadyDecision(card)) continue;
      const direct = card.taskId ? byId.get(card.taskId) : undefined;
      if (card.taskId && (!direct || TaskService.isClosed(direct))) continue;
      for (const task of [...(direct ? [direct] : []), ...(gateTasks.get(card.id) ?? [])]) {
        if (!decisionCards.has(task.id)) decisionCards.set(task.id, card);
      }
    }
    return {
      byId,
      parts,
      links,
      linksInto,
      blockersOf,
      blockingOf,
      mergeHolds,
      children,
      filedFrom,
      decisionCards,
      durableDecisions,
      openCardIds,
      replacedBy,
    };
  }

  /** The served slot of each work row among these (a crewmate only exists for work). */
  private tiersOf(records: readonly TaskRecord[]): ReadonlyMap<string, Slot> {
    const ids = records.filter((record) => record.kind === "work").map((record) => record.id);
    return ids.length > 0 && this.options.tiers ? this.options.tiers(ids) : new Map();
  }

  private viewOf(
    record: TaskRecord,
    graph: Graph,
    tiers: ReadonlyMap<string, Slot> = new Map(),
    facts: LiveFacts = this.liveFacts(record),
  ): TaskView {
    const blockers = graph.blockersOf.get(record.id) ?? [];
    const waiting = blockers.filter((blocker) => !TaskService.blockerCleared(blocker));
    const liveBlockers = blockers.filter(TaskService.blockerHoldsClose);
    const { repo, posture, place, startAttempt, computerMove } = facts;
    const baseline = TaskService.isClosed(record)
      ? []
      : standingDependencyWaits(graph.byId, record.delivery, this.options.tasks);
    // Blocked by names only the waits that hold the task now, by the one
    // rule the tasks reader shares (./holdingWaits.ts, INF-999). Dropped
    // edges remain in the graph and still gate STARTING, but closed work is
    // never presented as something still underway.
    const holding = holdingWaits({
      record,
      blockers,
      holdsMerge: (blocker) => graph.mergeHolds.has(`${record.id}\0${blocker.id}`),
      tasks: graph.byId,
      idleOnWaits: posture?.state === "idle" && posture.reason === "dependency",
      baseline,
    });
    const blockedSince = waitsSince({
      record,
      holding,
      links: graph.linksInto.get(record.id) ?? [],
      tasks: graph.byId,
      baseline,
    });
    const startHolding =
      record.status === "open" && waiting.length !== holding.length ? waiting : holding;
    const waitSince =
      startHolding === holding
        ? blockedSince
        : waitsSince({
            record,
            holding: startHolding,
            links: graph.linksInto.get(record.id) ?? [],
            tasks: graph.byId,
            baseline,
          });
    const open = record.status === "open";
    // An active row shows the blockers that still hold its CLOSE - a
    // marked edge, what a `blocks_me` follow-up files against the task a
    // crewmate is holding (TaskService.flagsOf). A recorded wait keeps its
    // place in blockedBy and draws the arrow, and holds no close. A dropped
    // blocker holds no close, so it is no dead wait there either.
    const holdingClose = liveBlockers.filter((blocker) =>
      graph.mergeHolds.has(`${record.id}\0${blocker.id}`),
    );
    const blocked = open
      ? waiting.length > 0
      : record.status === "active" && holdingClose.length > 0;
    // A gate holds an active row as it holds an open one (TaskService.flagsOf).
    const held = (open || record.status === "active") && record.gate !== null;
    const deadBlocker = open && waiting.some((blocker) => blocker.status === "dropped");
    // The decision card the captain must answer: one raised on this task,
    // or the card its captain gate names - a decision row's own card, a
    // host card's operation row, or the card holding a crewmate's task.
    const gateCard =
      record.gate?.kind === "captain" && record.gate.ref && graph.openCardIds.has(record.gate.ref)
        ? record.gate.ref
        : null;
    const waitingCard = TaskService.isClosed(record)
      ? undefined
      : graph.decisionCards.get(record.id);
    const waitingCardId = waitingCard?.id ?? null;
    // A declaration remains an operational hold, not proof that a ready
    // decision is available to the captain (FI3-702).
    const captainWait = record.status === "active" && Boolean(record.delivery?.captainWait);
    const needsYou =
      !TaskService.isClosed(record) &&
      (waitingCardId !== null ||
        captainWait ||
        graph.durableDecisions.has(record.id) ||
        gateCard !== null ||
        (open && record.gate?.kind === "captain") ||
        deadBlocker);
    // The private closure snapshot is served through Details' policies,
    // not added to the board's published delivery contract.
    const delivery = record.delivery ? { ...record.delivery } : null;
    if (delivery) delete delivery.closedPolicies;
    return withMoves({
      id: record.id,
      key: record.key,
      projectId: record.projectId,
      parentId: record.parentId,
      ...(record.kind === "work"
        ? { reviewOf: reviewBuilderOf(record), executionDeviceId: record.deviceId }
        : {}),
      ...(record.shape?.program ? { program: true as const } : {}),
      ...(place ? { place } : {}),
      ...computerMove,
      kind: record.kind,
      title: record.title,
      goal: record.goal,
      priority: record.priority,
      status: record.status,
      activity: record.activity,
      workPosture: posture,
      waits: taskWaitsOf({
        record,
        holding: startHolding,
        since: waitSince,
        posture,
        facts: facts.waits,
        decision:
          waitingCardId !== null || gateCard !== null || graph.durableDecisions.has(record.id),
      }),
      closedReason: record.closedReason,
      ...(replaced(record) ? { replacedBy: graph.replacedBy.get(record.id) } : {}),
      startPolicy: record.startPolicy,
      queueWait: startAttempt
        ? undefined
        : queueWaitOf(
            record,
            blockers,
            graph.linksInto.get(record.id) ?? [],
            graph.parts.get(record.id) ?? [],
          ),
      flags: {
        blocked,
        held,
        needsYou,
        ready: open && record.kind === "work" && !blocked && !held,
      },
      blockedBy: holding.map((blocker) => blocker.key || blocker.id),
      ...(Object.keys(blockedSince).length > 0 ? { blockedSince } : {}),
      blocks: (graph.blockingOf.get(record.id) ?? []).map((blocked) => blocked.key || blocked.id),
      children: graph.children.get(record.id) ?? { total: 0, closed: 0 },
      assignee: record.assignee,
      model: record.model,
      tier: tiers.get(record.id) ?? null,
      repo: repo ? { name: repo.name, branch: record.branch } : null,
      delivery,
      // A summary stored before reports skipped their Intent section reads
      // again from the report (the popup audit, A2).
      outcomeSummary: record.outcome
        ? reportHeadline(record.outcome, record.outcomeSummary)
        : record.outcomeSummary,
      waitingCardId,
      ...(record.delivery?.captainAction
        ? {
            requiredAction: {
              cardId: record.delivery.captainAction.cardId,
              state: record.delivery.captainAction.state,
              result: captainActionResult(record.delivery.captainAction),
            },
          }
        : {}),
      ...(cardMerges(waitingCard) ? { waitingCardMerges: true as const } : {}),
      ...(captainWait ? { captainWait } : {}),
      ...startMarksOf(record, startAttempt),
      ...(record.status === "active" && record.backlogSince != null
        ? { backlogSince: record.backlogSince }
        : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      closedAt: record.closedAt,
      ...filingMarks(record, graph),
    });
  }

  /** Each project's counts; `viewed` holds views already built for this read, by id. */
  private projectViews(
    all: readonly TaskRecord[],
    graph: Graph,
    now: number,
    viewed: { get(id: string): TaskView | undefined } = new Map(),
  ): ProjectView[] {
    const cutoff = now - BOARD_RECENT_MS;
    const counts = new Map<string, ProjectView["counts"]>();
    for (const record of all) {
      const entry = counts.get(record.projectId) ?? {
        needsYou: 0,
        waitingOnYou: 0,
        open: 0,
        active: 0,
        doneRecent: 0,
      };
      counts.set(record.projectId, entry);
      if (record.status === "open") entry.open += 1;
      else if (record.status === "active") entry.active += 1;
      else if (record.status === "done" && (record.closedAt ?? 0) >= cutoff) entry.doneRecent += 1;
      // Closed work never needs the captain or waits on him (viewOf), so only
      // live rows are viewed: a long record is mostly closed rows.
      if (TaskService.isClosed(record)) continue;
      const view = viewed.get(record.id) ?? this.viewOf(record, graph);
      if (view.flags.needsYou) entry.needsYou += 1;
      if (view.waitingCardId || (view.requiredAction && view.status === "open"))
        entry.waitingOnYou += 1;
    }
    // Scratch first, then repo projects oldest first: a stable order a
    // panel can rely on (the store orders by creation, where Scratch and a
    // repo registered in the same millisecond would tie).
    return this.options.tasks.projects
      .list()
      .sort(
        (a, b) =>
          Number(b.kind === "scratch") - Number(a.kind === "scratch") ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )
      .map((project) => this.projectView(project, counts));
  }

  private projectView(
    project: ProjectRecord,
    counts: Map<string, ProjectView["counts"]>,
  ): ProjectView {
    const repo = project.repoId ? this.options.repos.get(project.repoId) : undefined;
    return {
      id: project.id,
      key: project.key,
      name: project.name,
      repo: repo
        ? { name: repo.name, delivery: repo.delivery, autonomy: repo.autonomy, kind: repo.kind }
        : null,
      archived: project.archivedAt !== null,
      counts: counts.get(project.id) ?? {
        needsYou: 0,
        waitingOnYou: 0,
        open: 0,
        active: 0,
        doneRecent: 0,
      },
    };
  }
}

/** The host's own facts a view reads, which no write of the row reports. */
type LiveFacts = {
  waits: TaskWaitFacts | undefined;
  repo: ReturnType<TaskProtocolOptions["repos"]["get"]>;
  posture: WorkPosture | undefined;
  place: TaskPlace | undefined;
  computerMove: Pick<TaskView, "movable" | "computerMove"> | undefined;
  startAttempt: { phase: "preparing" | "checking"; since: number } | undefined;
};

/** A shown row's view, with the live facts and card facts it was built from. */
type CachedView = { view: TaskView; facts: string; cards: string };

/**
 * What the last board was built from, kept between reads so one change
 * rebuilds only the rows it reached (INF-2078, the row cache).
 */
type BoardCache = {
  /** Every record the board reads: the shown rows and the rows at the other ends of their edges. */
  records: Map<string, TaskRecord>;
  /** The rows on the board. */
  shown: Set<string>;
  /** The edges touching a shown row, by `edgeKey`. */
  links: Map<string, TaskLink>;
  /** Each shown parent's child counts (`TaskService.childCounts`). */
  childCounts: Map<string, { total: number; closed: number }>;
  /** What replaced each shown dropped or superseded row (`TaskService.replacementsOf`). */
  replacedBy: Map<string, string>;
  /** The graph around the shown rows, as the last read built it. */
  graph: Graph;
  /** Each shown row's view. */
  views: Map<string, CachedView>;
  /** The rows in canonical order, as the last board carried them. */
  tasks: TaskView[];
  /** The edges across shown rows in canonical order, and their keys. */
  linkViews: TaskLinkView[];
  linkKeys: Set<string>;
};

function factsKey(facts: LiveFacts): string {
  return JSON.stringify([
    facts.repo?.name,
    facts.posture,
    facts.waits,
    facts.place,
    facts.computerMove,
    facts.startAttempt,
  ]);
}

/**
 * The card facts a view reads: the decision card it waits on and whether
 * that card merges, a durable decision on it, and whether its gate's card
 * is up. Read from the cards at each read, so a card raised or resolved
 * with no write of the row still rebuilds it.
 */
function cardFactsOf(record: TaskRecord, graph: Graph): string {
  const card = TaskService.isClosed(record) ? undefined : graph.decisionCards.get(record.id);
  const gateUp =
    record.gate?.kind === "captain" && record.gate.ref
      ? graph.openCardIds.has(record.gate.ref)
      : false;
  return `${card?.id ?? ""}\0${card ? cardMerges(card) : false}\0${graph.durableDecisions.has(record.id)}\0${gateUp}`;
}

function edgeKey(link: TaskLink): string {
  return `${link.fromId} ${link.toId} ${link.type}`;
}

type Graph = {
  byId: Map<string, TaskRecord>;
  /** Each row's children among `byId`, in the rows' order: the parts a start wait reads. */
  parts: Map<string, TaskRecord[]>;
  links: TaskLink[];
  /** Row-local edges: wait dates and queue waits never walk the whole board. */
  linksInto: Map<string, TaskLink[]>;
  blockersOf: Map<string, TaskRecord[]>;
  blockingOf: Map<string, TaskRecord[]>;
  /** `${toId}\0${fromId}` for a blocks edge that holds the close. */
  mergeHolds: Set<string>;
  children: Map<string, { total: number; closed: number }>;
  filedFrom: Map<string, TaskLink>;
  decisionCards: Map<string, Card>;
  openCardIds: Set<string>;
  durableDecisions: Set<string>;
  /** What carries each dropped or superseded row's work on (`TaskService.replacementsOf`). */
  replacedBy: Map<string, string>;
};

/** A row whose view names what replaced it: dropped work, or work superseded. */
function replaced(record: TaskRecord): boolean {
  return record.status === "dropped" || record.closedReason === "superseded";
}

/**
 * The reasoning the crewmate's session opened at (`TaskDetail.reasoning`,
 * FI3-439): what its newest dispatch recorded beside the model, while the
 * record still names that model. A resume keeps its opening level and
 * records no dispatch, so the newest one still holds.
 */
function reasoningOf(record: TaskRecord, timeline: readonly TaskEvent[]): Reasoning | undefined {
  const dispatched = timeline.findLast((event) => event.kind === "dispatched");
  if (!dispatched?.data || !record.model || dispatched.data.model !== record.model)
    return undefined;
  const reasoning = reasoningSchema.safeParse(dispatched.data.reasoning);
  return reasoning.success ? reasoning.data : undefined;
}

/**
 * A `decided` event is capture machinery (R2): it rides the export and the
 * offline readers, never a client surface - the record pane stays the
 * captain's history of the work, not of the agents' bookkeeping.
 */
function isProvenanceOnly(event: TaskEvent): boolean {
  return event.kind === "decided";
}

/** A crewmate-authored discovered-from edge, and the origin it names. */
function crewFilingOrigin(record: TaskRecord, graph: Graph): TaskRecord | undefined {
  const link = graph.filedFrom.get(record.id);
  return link ? graph.byId.get(link.toId) : undefined;
}

function filingMarks(
  record: TaskRecord,
  graph: Graph,
): { foundOn: string; filingNew: boolean } | undefined {
  const origin = crewFilingOrigin(record, graph);
  if (!origin) return undefined;
  return {
    foundOn: origin.key || origin.id,
    filingNew: record.captainOpenedAt == null && !TaskService.isClosed(record),
  };
}

function push(map: Map<string, TaskRecord[]>, key: string, value: TaskRecord): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The wire event for one timeline event: `text` is the feed line when the
 * event is feed-worthy (so a client never authors one), else the timeline
 * line as recorded.
 */
export function taskEventOf(record: TaskRecord, event: TaskEvent): FmEvent {
  const line = taskFeedLine(record, event);
  return {
    type: "task_event",
    taskId: record.id,
    key: record.key,
    kind: event.kind,
    text: line?.text ?? event.text,
    at: event.at,
    feed: line !== null,
  };
}

/**
 * How a closed row closed: its closing event's time, and the words recorded
 * with it beyond the reason's own word - a drop's reason (`dropped - <why>`,
 * as `dropWithChildren` writes it) or a supersede's line. Work carried on
 * reads where its work stands now (INF-1825): carried on by the task at the
 * end of its replacements while that runs, done through it once it is done.
 * Null while open.
 */
function closingOf(
  record: TaskRecord,
  events: readonly TaskEventView[],
  carried?: ReturnType<TaskService["carriedOn"]>,
): TaskDetail["closing"] {
  if (!TaskService.isClosed(record)) return null;
  const close = events.findLast(
    (event) => event.data?.status === record.status && event.data?.reason === record.closedReason,
  );
  const at = close?.at ?? record.closedAt;
  if (at == null) return null;
  if (carried) return { at, note: carriedOnWords(carried) };
  const words = close?.text.replace(/^(?:dropped|superseded) - /, "").trim() ?? "";
  const note = words && words !== record.closedReason ? words : null;
  return { at, note };
}

/** Where the work of a task closed as carried on stands, in the record's words (INF-1825). */
export function carriedOnWords(carried: NonNullable<ReturnType<TaskService["carriedOn"]>>): string {
  if (carried.state === "done") return `Done through ${carried.key}`;
  if (carried.state === "dropped") return `Carried on by ${carried.key}, which was dropped`;
  return `Carried on by ${carried.key}`;
}

/**
 * The newest failure or interruption, as a sentence: a failed turn in the
 * vocabulary's words for its error (never the raw text), an interruption as
 * the stop it was.
 */
function startMarksOf(
  record: TaskRecord,
  attempt: { phase: "preparing" | "checking"; since: number } | undefined,
): Pick<TaskView, "startAttempt" | "startNotice"> {
  const notice = parseStartNotice(record.startNotice);
  return {
    ...(attempt ? { startAttempt: attempt } : {}),
    ...(notice && record.status === "open" ? { startNotice: notice } : {}),
  };
}

function parseStartNotice(raw: string | null | undefined): { reason: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0
      ? { reason: parsed.reason }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a gate holding open work waits on, from the gate and the work's own
 * ask alone (`TaskHold`): a level's gate that is the level the work asked
 * for - a premium ask, or a stronger-model retry's rung - is that ask's
 * wait (`requiresReasoningWait`); any other gate on queued work is one
 * Firstmate set with start_after. The captain's own gate says nothing here.
 */
function holdOf(record: TaskRecord): TaskHold | undefined {
  const gate = record.gate;
  if (record.status !== "open" || !gate) return undefined;
  if (gate.kind === "at-time")
    return gate.until !== undefined ? { kind: "time", until: gate.until } : undefined;
  if (gate.kind !== "quota-reset" || !gate.ref) return undefined;
  if (!gate.ref.startsWith("bucket:")) {
    return isAllowanceProvider(gate.ref)
      ? { kind: "plan", provider: providerLabel(servedProviderOf(gate.ref)) }
      : undefined;
  }
  const level = slotSchema.safeParse(gate.ref.slice("bucket:".length));
  if (!level.success) return undefined;
  const shape = record.shape;
  if (shape?.premium_ask && level.data === "premium") return { kind: "premium" };
  if (shape?.escalation?.floor === level.data)
    return { kind: "retry", level: level.data, from: shape.escalation.from };
  return { kind: "level", level: level.data };
}

function problemOf(events: readonly TaskEventView[]): string | null {
  const last = events.findLast((event) => event.kind === "failed" || event.kind === "interrupted");
  if (!last) return null;
  if (last.kind === "interrupted") return "Its turn was stopped before it finished.";
  const error = typeof last.data?.error === "string" ? last.data.error : last.text;
  const words = plainProblem(error, typedFailureOf(last.data ?? {}));
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/**
 * The task's plan (FI3-734): the newest progress note that carried one,
 * read exactly as the crewmate declared it, each item with `since` - when it
 * first read its state in an unbroken run of notes, found by its label - so
 * a finished item shows when it finished. Null when no note ever carried one.
 */
function planOf(
  timeline: readonly { kind: string; at: number; data: Record<string, unknown> | null }[],
): TaskPlan | null {
  let plan: TaskPlan | null = null;
  for (const event of timeline) {
    // A `compacted` row keeps the newest plan it folded, with when it was written.
    if (event.kind !== "progress" && event.kind !== "compacted") continue;
    const parsed = planItemsSchema.safeParse(event.data?.plan);
    if (!parsed.success) continue;
    const at =
      event.kind === "compacted" && typeof event.data?.planAt === "number"
        ? event.data.planAt
        : event.at;
    const before = new Map<string, TaskPlanItem>();
    for (const item of plan?.items ?? []) before.set(item.label, item);
    const items: TaskPlanItem[] = parsed.data.map((item): TaskPlanItem => {
      const earlier = before.get(item.label);
      return { ...item, since: earlier?.state === item.state ? earlier.since : at };
    });
    plan = { at, items };
  }
  return plan;
}
