import { boardWithoutClosed } from "@shared/boardWithoutClosed";
import type { Card } from "@shared/cards";
import {
  type CrewPicture,
  type CrewResultText,
  type CrewTranscript,
  emptyTranscript,
} from "@shared/crewTranscript";
import type { FmEvent } from "@shared/events";
import { foldForSearch } from "@shared/searchText";
import {
  BOARD_DELTA_TRIGGER,
  BOARD_RECENT_MS,
  diffTaskBoards,
  type ProjectView,
  type TaskBoard,
  type TaskBoardRead,
  type TaskDetail,
  type TaskStatus,
  type TaskView,
} from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import type { TaskEvent } from "../storage/taskEventStore";
import { oldestFirst, type TaskRecord } from "../storage/taskRecords";
import { type BoardCache, type BoardReads, rebuild, rebuildParts, refresh } from "./boardCache";
import { isProvenanceOnly, taskDetailOf } from "./taskDetail";
import { taskFeedLine } from "./taskFeed";
import type { TaskProtocolOptions } from "./taskProtocolOptions";
import { TaskService } from "./taskService";
import {
  graphFor,
  type LiveFacts,
  projectViews,
  replaced,
  reviewBuilderOf,
  tiersOf,
  viewOf,
} from "./taskView";
import type { TaskChange } from "./taskWriter";

export type { TaskProtocolOptions } from "./taskProtocolOptions";
export { withMoves } from "./taskView";

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
 * from nothing (`taskProtocol.cache.test.ts` pins it after every shape of write).
 *
 * The board is the LIVE set (open, active, closed within BOARD_RECENT_MS,
 * and the parents of those) plus every pinned task whatever its age, which
 * brings no old parent along (INF-3127); other history stays in the
 * database and is read one task at a time (design section 9.1).
 *
 * Above the measured trigger (P5, design section 9.1: a snapshot over
 * 256 KB or a live set over 500 rows) the push becomes `inf:tasks:delta`:
 * the snapshot is still brought up to date after the commit, but only its
 * difference from the last push crosses, on the same `seq`. The delta is
 * a DIFF of two snapshots, never a replay of the writer's bookkeeping, so
 * a derived change (a blocker closing, a card leaving the stack) travels
 * exactly as a written one does and applying it reproduces the fresh
 * snapshot by construction (`taskProtocol.push.test.ts`). The first push after
 * a purge, and the first push ever, are snapshots: a delta needs a base.
 *
 * Its parts live beside it: what the host hands it (`taskProtocolOptions.ts`),
 * a row's view, the graph it reads and the project index (`taskView.ts`),
 * the row cache (`boardCache.ts`) and one record's detail (`taskDetail.ts`).
 */

/** Coalescing window for the board push, matching the card broadcast. */
export const BOARD_PUSH_COALESCE_MS = 40;

/** Most closed tasks a typed search returns. */
const SEARCH_LIMIT = 50;

export type BoardPushMode = "snapshot" | "delta";

function onNextTurn(run: () => void): () => void {
  const handle = setImmediate(run);
  return () => clearImmediate(handle);
}

/** The tasks whose cards are minimized: the board shows them however old. */
function minimizedOf(cards: readonly Card[]): Set<string> {
  const minimized = new Set<string>();
  for (const card of cards) if (card.minimized && card.taskId) minimized.add(card.taskId);
  return minimized;
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
  /**
   * A board from nothing on its way to a push, a part per turn (`warm`):
   * its parts and the records the parts so far hold.
   */
  private warming: Warming | undefined;
  private readonly nextTurn: (run: () => void) => () => void;
  /** What the row cache reads from this protocol (`boardCache.ts`). */
  private readonly reads: BoardReads;

  constructor(private readonly options: TaskProtocolOptions) {
    this.now = options.now ?? (() => Date.now());
    this.coalesceMs = options.coalesceMs ?? BOARD_PUSH_COALESCE_MS;
    this.deltaTrigger = options.deltaTrigger ?? BOARD_DELTA_TRIGGER;
    this.nextTurn = options.nextTurn ?? onNextTurn;
    this.reads = {
      options,
      touched: this.touched,
      recheckFacts: () => this.recheckFacts,
      liveFacts: (record) => this.liveFacts(record),
    };
    // Read without composing a record: every task, at each start.
    for (const [id, status] of options.tasks.statuses()) this.statuses.set(id, status);
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
    this.warming?.cancel();
    this.warming = undefined;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
  }

  board(read?: TaskBoardRead): TaskBoard {
    if (read?.closed === false) {
      const cardTasks = new Set<string>();
      for (const card of this.options.cards.snapshot()) if (card.taskId) cardTasks.add(card.taskId);
      return boardWithoutClosed(this.board(), cardTasks);
    }
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
    const minimized = minimizedOf(cards);
    const base = this.warming
      ? this.warmed(this.warming)
      : this.rebuildAll
        ? undefined
        : this.cache;
    const cache = base
      ? refresh(this.reads, base, cutoff, minimized, cards)
      : rebuild(this.reads, cutoff, minimized, cards);
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
      projects: projectViews(
        this.options,
        rows,
        now,
        (record) =>
          cache.views.get(record.id)?.view ??
          viewOf(this.options, record, cache.graph, new Map(), this.liveFacts(record)),
      ),
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
   * `SEARCH_LIMIT`; card and report text is never searched. The record
   * process finds the matches when the host has one (`searchClosed`), so a
   * burst of lookups never walks the closed history on the main thread.
   */
  async search(text: string): Promise<TaskView[]> {
    if (!foldForSearch(text.trim())) return [];
    const input = { text, recentFrom: this.now() - BOARD_RECENT_MS, limit: SEARCH_LIMIT };
    const { ids } = this.options.searchClosed
      ? await this.options.searchClosed(input)
      : this.options.tasks.searchClosed(input);
    return this.foundViews(ids);
  }

  /** The views of the rows a search found, in its order; whole rows are read only for these. */
  private foundViews(ids: readonly string[]): TaskView[] {
    if (ids.length === 0) return [];
    const rows = new Map(this.options.tasks.getMany(ids).map((row) => [row.id, row]));
    const found = ids.flatMap((id) => rows.get(id) ?? []);
    // Closed rows wait on nothing, so the graph around them is all a view reads.
    const graph = graphFor(this.options, found);
    const tiers = tiersOf(this.options, found);
    return found.map((record) =>
      viewOf(this.options, record, graph, tiers, this.liveFacts(record)),
    );
  }

  /**
   * The tasks with exactly these keys, live or closed at any age, in one
   * read of the key index: the window's lookup of the keys it draws, never
   * a search of the closed history per key (INF-3896).
   */
  byKeys(keys: readonly string[]): TaskView[] {
    const found = this.options.tasks.getManyByKey(keys);
    if (found.length === 0) return [];
    const graph = graphFor(this.options, found);
    const tiers = tiersOf(this.options, found);
    return found.map((record) =>
      viewOf(this.options, record, graph, tiers, this.liveFacts(record)),
    );
  }

  /** One record in full, for its record card (`taskDetail.ts`). */
  detail(id: string): TaskDetail {
    return taskDetailOf(this.options, id, (record) => this.liveFacts(record));
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
      broadcastEvent(taskEventOf(record, { ...event, text: tasks.capture.eventReceipt(event) }));
    }
    const tiers = tiersOf(
      this.options,
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
        ...(replaced(record)
          ? { replacedBy: this.options.tasks.graph.replacementOf(record.id) }
          : {}),
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
    if (change.reset) {
      this.rebuildAll = true;
      this.warming?.cancel();
      this.warming = undefined;
    }
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
      if (this.options.step) this.options.step("board-push", () => this.push());
      else this.push();
    }, this.coalesceMs);
  }

  private push(): void {
    // A board from nothing pushes when its last part is in.
    if (this.warming) return;
    if (!this.cache || this.rebuildAll) {
      this.warm();
      return;
    }
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

  // ---- the row cache (INF-2078; boardCache.ts) ----------------------------

  /**
   * Build the board from nothing a part per turn, then push it (INF-3453).
   * A push from nothing - the first, or the one after rows vanished
   * wholesale - reads every row the board shows, and on a long record's
   * week that one stretch held the main thread past the freeze line; the
   * main thread takes its other work between the parts. What is written
   * meanwhile is touched as ever, so the pushed board brings those rows up
   * to date as any later read does, and a read that cannot wait finishes
   * the parts at once (`warmed`).
   */
  private warm(): void {
    const cards = this.options.cards.snapshot();
    const parts = rebuildParts(this.reads, this.now() - BOARD_RECENT_MS, minimizedOf(cards), cards);
    const warming: Warming = { parts, held: new Map(), cancel: () => {} };
    this.warming = warming;
    this.rebuildAll = false;
    this.recheckFacts = false;
    this.touched.clear();
    const step = () => {
      if (this.warming !== warming) return;
      let part: IteratorResult<ReadonlyMap<string, TaskRecord>, BoardCache>;
      try {
        part = this.options.tasks.readProjection(() => {
          const outer = this.readingFacts;
          this.readingFacts = new Map();
          try {
            return parts.next();
          } finally {
            this.readingFacts = outer;
          }
        }, [...warming.held.values()]);
      } catch (error) {
        this.warming = undefined;
        this.rebuildAll = true;
        throw error;
      }
      if (!part.done) {
        warming.held = part.value;
        warming.cancel = this.nextTurn(step);
        return;
      }
      this.warming = undefined;
      this.cache = part.value;
      if (this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = undefined;
      }
      if (this.pushHolds > 0) {
        this.pushQueued = true;
        return;
      }
      this.pushQueued = false;
      this.push();
    };
    warming.cancel = this.nextTurn(step);
  }

  /** The parts of a board from nothing still to run, run now; its push follows. */
  private warmed(warming: Warming): BoardCache {
    warming.cancel();
    this.warming = undefined;
    this.rebuildAll = true;
    this.schedulePush();
    return this.options.tasks.readProjection(() => {
      for (;;) {
        const part = warming.parts.next();
        if (part.done) return part.value;
      }
    }, [...warming.held.values()]);
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
          this.options.startAttempt?.(record.id) ??
          this.options.tasks.starts.startAttemptOf(record.id),
      }),
      [record],
    );
    this.readingFacts?.set(record.id, facts);
    return facts;
  }
}

/** A board from nothing on its way to a push (`TaskProtocol.warm`). */
type Warming = {
  parts: Generator<ReadonlyMap<string, TaskRecord>, BoardCache, void>;
  /** The records the parts so far read. */
  held: ReadonlyMap<string, TaskRecord>;
  /** Calls off the turn the next part waits for. */
  cancel: () => void;
};

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
    ...(line?.said ? { said: line.said } : {}),
  };
}
