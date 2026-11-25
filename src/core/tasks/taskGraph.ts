import type { OpenEffect } from "@shared/cards";
import { isRepairAssessment } from "@shared/checkRepair";
import { fixedHoldWords, overridePasses } from "@shared/holds";
import { taskStatusSchema } from "@shared/tasks";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskLink, TaskLinkType } from "../storage/taskLinkStore";
import type { MergeAuthorization, TaskRecord, TaskStatus } from "../storage/taskRecords";
import type { TaskReference, TaskReferenceKind } from "../storage/taskReferenceStore";
import { baselineStands } from "./dependencyWaits";
import { holdingWaits } from "./holdingWaits";
import { TaskService } from "./taskService";
import { keyOrId, type TaskWriter, withShapeKey } from "./taskWriter";
import { liveWaitCycle, waitCycleWords } from "./waitCycles";

/** A graph rule refused the write; the message is meant for the agent. */
export class TaskGraphRefusal extends Error {
  override readonly name = "TaskGraphRefusal";
}

/** A `blocks` edge into a task, with the blocker it runs from. */
export type BlockingEdge = { link: TaskLink; task: TaskRecord };

/** The statuses a blocker predicate holds for, so a read can ask SQLite for only those rows. */
/**
 * A merge approval that still says the work goes in: standing, or spent by
 * the merge that is closing the task.
 */
const APPROVED_TO_MERGE: ReadonlySet<string> = new Set(["standing", "consumed"]);

function statusesWhere(holds: (blocker: Pick<TaskRecord, "status">) => boolean): TaskStatus[] {
  return taskStatusSchema.options.filter((status) => holds({ status }));
}

export type TaskFlags = {
  /** An uncleared `blocks` edge points at it. */
  blocked: boolean;
  /** A gate (quota-reset, at-time, captain) holds it. */
  held: boolean;
  /** Open, unblocked, unheld work that dispatches when `startPolicy` is when-ready. */
  ready: boolean;
  /** A `blocks` edge from a dropped task: its wait can never end on its own. */
  deadBlocker: boolean;
};

/** A task named by a refusal: enough to reference it, never the whole record. */
export type SettleTaskRef = { id: string; key: string; title: string };

/**
 * One way out of a close refusal (interaction P0, WI-12): a button on the
 * Firstmate's card, or a clause in the refusal prose. `tool` and `args` are
 * exactly what the Firstmate runs to take it - a pointing gesture, never a
 * host mutation of its own.
 */
export type SettleWay = { label: string } & (
  | {
      tool: "settle_task" | "update_task" | "link_tasks" | "app_change";
      args: Record<string, unknown>;
    }
  /**
   * A way the captain takes in Settings: the not-signed-in refusal's sign-in
   * (git integration PR 1.2), an `open` effect the Firstmate carries on its
   * card as it is.
   */
  | { effect: OpenEffect }
  /**
   * A way that is not the Firstmate's to take: a button already in front
   * of the captain, named by the card it sits on and its action id. The
   * autonomy hold has exactly one way out and this is it - the captain's
   * own click on the completion card - so the Firstmate reads a way it
   * cannot run and says nothing further rather than inventing a card
   * beside the one that is already there.
   */
  | { card: { id: string; action: string } }
);

/**
 * Why a close refused, and how to resolve it (interaction P0, WI-12, captain
 * ruling D5′). A refusal is an OUTCOME with ways out, not prose the model
 * must re-derive: the settle wake and the `settle_task` tool result carry
 * this object, and the Firstmate turns `ways` into effect buttons on one
 * card. `text` is the same refusal as one line, for the tool result's
 * content and the feed line.
 *
 * - `children-open`: a parent still has open children (the parent close
 *   rule); its ways start or drop the children, or settle keeping them
 *   planned (`proceed_with_open`), added where the settle mode is known.
 * - `waits-on`: a `blocks_me` promise still stands; its ways land the
 *   blocker or remove the edge - no override, the promise is the crewmate's.
 * - `unlanded-work`: a discard would destroy commits or edits nothing
 *   landed; its ways confirm the discard, or merge/land instead.
 * - `autonomy-off`: the Firstmate tried to merge or land a task whose
 *   effective autonomy is off, so the decision is the captain's; its one
 *   way out is the completion card's own merge button, which he clicks.
 * - `not-signed-in`: the project's host needs the app's sign-in to put the
 *   change in (git integration PR 1.2); its ways are the sign-in and
 *   keeping the project on this Mac (`src/core/forge/signInRefusal.ts`).
 */
export type SettleRefusal = {
  refused: "children-open" | "waits-on" | "unlanded-work" | "autonomy-off" | "not-signed-in";
  task: SettleTaskRef;
  /** The other tasks the refusal names (open children, live blockers). */
  tasks: SettleTaskRef[];
  ways: SettleWay[];
  text: string;
};

function settleRef(record: TaskRecord | undefined, fallbackId: string): SettleTaskRef {
  return {
    id: record?.id ?? fallbackId,
    key: record?.key || fallbackId,
    title: record?.title ?? "",
  };
}

function refName(ref: SettleTaskRef): string {
  return `${ref.key} "${ref.title}"`;
}

const MAX_HIERARCHY_WALK = 64;

/** How an `unlinked` line names the edge that went, read from its `to`. */
const LINK_WORDS: Record<TaskLinkType, string> = {
  blocks: "blocked by",
  "discovered-from": "discovered-from",
  "replaced-by": "replacing",
  related: "related",
};

/**
 * The task graph (design sections 7 to 9): parents and children, the typed
 * links between tasks, the waits a link records, carriers and replacements,
 * and what holds a close. Reached as `tasks.graph`.
 */
/** The approved part a task starts on, and the parts under it that part's branch carries. */
export type ApprovedBase = {
  task: TaskRecord;
  head: string;
  branch: string;
  /** Unmerged parts under `task` its recorded base holds, by id (`TaskGraph.carriedBy`). */
  carried: ReadonlySet<string>;
};

export class TaskGraph {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  /**
   * The started work waiting on this task through any `blocks` link from it
   * (INF-735, INF-3167), in link order, without composing closed waiter
   * records: its report may carry what that work waits for.
   */
  activeWaiters(id: string): TaskRecord[] {
    const known = this.writer.projection?.activeWaiters.get(id);
    if (known) return known;
    const links = this.linksFrom(id).filter((link) => link.type === "blocks");
    const active = new Map(
      this.writer.store
        .getActiveMany(links.map((link) => link.toId))
        .map((record) => [record.id, record]),
    );
    const records = links.flatMap((link) => active.get(link.toId) ?? []);
    this.writer.projection?.activeWaiters.set(id, records);
    return records;
  }

  /** The tasks that must close before this one is ready. */
  blockers(id: string): TaskRecord[] {
    const known = this.writer.projection?.blockers.get(id);
    if (known) return known;
    const links = this.writer.projection
      ? this.linksTo(id).filter((link) => link.type === "blocks")
      : this.writer.links.listTo(id, "blocks");
    const blockers = links.flatMap((link) =>
      [this.writer.store.get(link.fromId)].filter((r): r is TaskRecord => !!r),
    );
    this.writer.projection?.blockers.set(id, blockers);
    return blockers;
  }

  /**
   * The `blocks` edges into a task whose blocker stands in one of these
   * statuses, each with that blocker, in edge order. A blocker in any other
   * status is never read whole: a long record links many closed blockers
   * into live work, and composing each of them on every posture read froze
   * the app (INF-2342, INF-2457).
   */
  private blocksIn(id: string, statuses: readonly TaskStatus[]): BlockingEdge[] {
    const key = JSON.stringify([id, statuses]);
    const known = this.writer.projection?.blocksIn.get(key);
    if (known) return known;
    const links = this.writer.projection
      ? this.linksTo(id).filter((link) => link.type === "blocks")
      : this.writer.links.listTo(id, "blocks");
    const found = new Map(
      this.writer.store
        .getAmong(
          links.map((link) => link.fromId),
          statuses,
        )
        .map((task) => [task.id, task]),
    );
    const edges = links.flatMap((link): BlockingEdge[] => {
      const task = found.get(link.fromId);
      return task ? [{ link, task }] : [];
    });
    this.writer.projection?.blocksIn.set(key, edges);
    return edges;
  }

  /** The `blocks` edges into a task whose blocker is still live work, each with it, in edge order. */
  liveBlocks(id: string): BlockingEdge[] {
    return this.blocksIn(id, statusesWhere(TaskService.blockerHoldsClose));
  }

  /** The tasks waiting on this one. */
  blocking(id: string): TaskRecord[] {
    return this.writer.links
      .listFrom(id, "blocks")
      .flatMap((link) => [this.writer.store.get(link.toId)].filter((r): r is TaskRecord => !!r));
  }

  /**
   * The live work waiting on this task - open or started - in link order,
   * without composing closed waiters (INF-2342, INF-2457).
   */
  liveWaiters(id: string): TaskRecord[] {
    const links = this.linksFrom(id).filter((link) => link.type === "blocks");
    const live = new Map(
      this.writer.store
        .getAmong(
          links.map((link) => link.toId),
          ["open", "active"],
        )
        .map((record) => [record.id, record]),
    );
    return links.flatMap((link) => live.get(link.toId) ?? []);
  }

  /** The earliest start among a parent's done building parts (`TaskRecordStore.earliestDonePartStart`). */
  earliestDonePartStart(parentId: string): number | undefined {
    return this.writer.store.earliestDonePartStart(parentId);
  }

  latestBlockerClose(id: string): number | undefined {
    return this.writer.store.latestBlockerClose(id);
  }

  linksTo(id: string): TaskLink[] {
    const known = this.writer.projection?.linksTo.get(id);
    if (known) return known;
    const links = this.writer.links.listTo(id);
    this.writer.projection?.linksTo.set(id, links);
    return links;
  }

  linksFrom(id: string): TaskLink[] {
    const known = this.writer.projection?.linksFrom.get(id);
    if (known) return known;
    const links = this.writer.links.listFrom(id);
    this.writer.projection?.linksFrom.set(id, links);
    return links;
  }

  /** Every edge in the graph, for a builder that resolves them in one pass. */
  allLinks(): TaskLink[] {
    return this.writer.links.listAll();
  }

  /** Every edge from or to one of these tasks, in `allLinks` order. */
  linksTouching(ids: readonly string[]): TaskLink[] {
    return this.writer.links.listTouching(ids);
  }

  /**
   * Whether a named basis really carries a spec, a plan or a reproduction:
   * it resolves to a task that is done or has reported something. Derived
   * at every read and never stored, so a step planned behind a basis that
   * has not answered yet reads verified the moment the answer lands.
   */
  basisHolds(ref: string): boolean {
    const basis = this.tasks.resolve(ref);
    return basis !== undefined && (basis.status === "done" || Boolean(basis.outcome));
  }

  /** A task's basis as the record names it, with its verdict derived now. */
  basisOf(record: TaskRecord): { ref: string; verified: boolean } | null {
    const basis = this.reference(record.id, "basis");
    if (!basis) return null;
    return { ref: basis.ref, verified: this.basisHolds(basis.ref) };
  }

  /** A task's reference of one kind, as recorded (INF-1296 piece 2). */
  reference(id: string, kind: TaskReferenceKind): TaskReference | undefined {
    return this.writer.references.list(id).find((reference) => reference.kind === kind);
  }

  /**
   * The task a reference names now: what its name resolves to at this read,
   * as every reader of the shape resolves it. `targetId` keeps what the name
   * meant when it was recorded, as provenance; it decides nothing.
   */
  referenceTarget(reference: TaskReference): TaskRecord | undefined {
    return this.tasks.resolve(reference.ref);
  }

  /**
   * Every task built on this one - each whose basis names it, by key or id
   * - open, active, done or dropped, oldest first (INF-976). Several may
   * stand on one basis; which of them covers a request is the reader's
   * judgment, never the host's. The host's delivery machinery (a review,
   * whose basis is its builder) is a part of the task, never work on it.
   */
  builtOn(id: string): TaskRecord[] {
    const record = this.writer.store.get(id);
    if (!record) return [];
    return this.writer.store
      .getMany(this.writer.references.taskIdsNaming("basis", record.id, record.key || null))
      .filter((other) => !TaskService.isDeliveryChild(other));
  }

  /**
   * The review whose verdict a builder's delivery facts carry, read off the
   * parent edge: the newest review child opened at or before the verdict
   * was recorded. A review opened after it has not answered yet, so it
   * never claims the verdict of the one before it.
   */
  verdictReviewOf(builder: TaskRecord): TaskRecord | undefined {
    const reviewedAt = builder.delivery?.reviewedAt;
    if (reviewedAt === undefined) return undefined;
    return this.writer.store
      .listChildren(builder.id)
      .filter(
        (child) =>
          child.shape?.kind === "review" &&
          !isRepairAssessment(child.shape) &&
          child.createdAt <= reviewedAt,
      )
      .at(-1);
  }

  children(id: string): TaskRecord[] {
    return this.writer.store.listChildren(id);
  }

  /** A program's filed parts and its open ones, as two counts (`TaskStore.programPartCounts`). */
  programPartCounts(programId: string): { parts: number; open: number } {
    return this.writer.store.programPartCounts(programId);
  }

  /** Children not yet closed - the ones the parent close rule names. */
  openChildren(id: string): TaskRecord[] {
    return this.writer.store.listLiveChildren(id);
  }

  /** Every descendant, shallowest first. */
  descendants(id: string): TaskRecord[] {
    return this.writer.store.listDescendants(id);
  }

  /** The parent chain, nearest first; stops at a broken or too-deep chain. */
  ancestors(id: string): TaskRecord[] {
    const chain: TaskRecord[] = [];
    let current = this.writer.store.get(id);
    const seen = new Set<string>([id]);
    while (current?.parentId && chain.length < MAX_HIERARCHY_WALK) {
      if (seen.has(current.parentId)) break;
      seen.add(current.parentId);
      const parent = this.writer.store.get(current.parentId);
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /** The follow-ups filed from this task (discovered-from edges pointing at it). */
  discoveredFrom(id: string): TaskRecord[] {
    return this.writer.links
      .listTo(id, "discovered-from")
      .flatMap((link) => [this.writer.store.get(link.fromId)].filter((r): r is TaskRecord => !!r));
  }

  /**
   * The tasks this one was discovered from - its origins. A follow-up is no
   * longer a child of its origin, so this edge is the only thing that says
   * where it came from; the index and the `tasks` query show it, or a
   * detached follow-up would be a row with no story.
   */
  discoveredOrigins(id: string): TaskRecord[] {
    return this.writer.links
      .listFrom(id, "discovered-from")
      .flatMap((link) => [this.writer.store.get(link.toId)].filter((r): r is TaskRecord => !!r));
  }

  /**
   * The tasks a merge of this task filed or set to start from its story's
   * after-merge steps (INF-3846 piece 4), each with when the merge linked it:
   * the discovered-from links the host wrote, which only
   * `TaskDeliveries.activateAfterMergeSteps` writes (`linkMergeStep`). They
   * do the rest of this task's work, so the message it serves covers them,
   * as work that joined it at that link's time.
   */
  continuations(id: string): { id: string; at: number }[] {
    return this.linksTo(id)
      .filter((link) => link.type === "discovered-from" && link.actor === "host")
      .map((link) => ({ id: link.fromId, at: link.createdAt }));
  }

  /** The tasks whose merge filed or started this one, with when: the inverse of `continuations`. */
  continuedFrom(id: string): { id: string; at: number }[] {
    return this.linksFrom(id)
      .filter((link) => link.type === "discovered-from" && link.actor === "host")
      .map((link) => ({ id: link.toId, at: link.createdAt }));
  }

  /**
   * Link a task a merge filed or set to start to that merged task: the
   * host-written discovered-from link `continuations` reads. Its `linked`
   * line saves whether the merge filed the task in the same write (`filed`)
   * or set a task that already existed to start, which `mergesThatFiled`
   * reads, so the order is a fact the merge knew, never two times compared
   * (INF-5647).
   */
  linkMergeStep(taskId: string, mergedId: string, at: number, filed: boolean): boolean {
    return this.insertLink(taskId, mergedId, "discovered-from", "host", at, false, at, { filed });
  }

  /**
   * The tasks whose merge filed this one (`linkMergeStep`), leaving out a
   * merge that set it to start after it was filed: that link is not where
   * its work came from. A link saved before its line said which reads as
   * filed when it was written no later than the task.
   */
  mergesThatFiled(id: string): string[] {
    const filedAt = this.writer.store.get(id)?.createdAt;
    return this.continuedFrom(id).flatMap((from) => {
      const filed =
        this.writer.events.linkFiled(from.id, id, "discovered-from") ??
        (filedAt !== undefined && from.at <= filedAt);
      return filed ? [from.id] : [];
    });
  }

  /** The task that replaced this one, including the older stronger-model lineage. */
  replacementOf(id: string): string | undefined {
    return this.replacementsOf([id]).get(id);
  }

  /**
   * The task that replaced each of these (`replacementOf`), read for all of
   * them at once: their `replaced-by` links, then the stronger-model moves
   * for the rest. A stronger-model move always writes its `escalated` row
   * (`recordEscalation`) before the superseded close repeats `escalated_to`,
   * so that row names the replacement without reading the task's timeline,
   * which grows with its history (INF-2070).
   */
  replacementsOf(ids: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    if (ids.length === 0) return found;
    const wanted = new Set(ids);
    const carriers = new Map<string, string>();
    for (const link of this.writer.links.listTouching(ids)) {
      if (link.type !== "replaced-by" || !wanted.has(link.fromId) || carriers.has(link.fromId))
        continue;
      carriers.set(link.fromId, link.toId);
    }
    const keys = new Map(
      this.writer.store.getMany([...new Set(carriers.values())]).map((row) => [row.id, row.key]),
    );
    let escalated: Map<string, string> | undefined;
    for (const id of ids) {
      const carrier = carriers.get(id);
      if (carrier) {
        found.set(id, keys.get(carrier) || carrier);
        continue;
      }
      escalated ??= this.writer.events.escalatedTo();
      const successor = escalated.get(id);
      if (successor) found.set(id, successor);
    }
    return found;
  }

  /**
   * The task that carries this one's work now (INF-1826): the end of its
   * `replaced-by` links, or the task itself when nothing replaced it.
   */
  carrierOf(id: string): TaskRecord | undefined {
    let record = this.writer.store.get(id);
    const seen = new Set<string>();
    while (record && !seen.has(record.id)) {
      seen.add(record.id);
      const next = this.writer.links.listFrom(record.id, "replaced-by")[0];
      const carrier = next ? this.writer.store.get(next.toId) : undefined;
      if (!carrier) return record;
      record = carrier;
    }
    return record;
  }

  /**
   * Why `carrierId` cannot carry on `id`'s work (INF-1825), or undefined:
   * not the task itself, not a dropped task, which does no work, and not a
   * task under it when its close drops its parts (an unstarted task's drop
   * does). A done close keeps open parts planned, so one of its own parts
   * can carry it on (INF-3169's plan, piece 2: `partsStayOpen`).
   */
  carrierRefusal(
    id: string,
    carrierId: string,
    options: { partsStayOpen?: boolean } = {},
  ): string | undefined {
    const record = this.writer.mustGet(id);
    const carrier = this.writer.mustGet(carrierId);
    const key = keyOrId(record);
    const other = keyOrId(carrier);
    if (carrier.id === record.id) return `Refused: ${key} cannot be replaced by itself.`;
    if (
      !options.partsStayOpen &&
      this.ancestors(carrier.id).some((ancestor) => ancestor.id === record.id)
    )
      return `Refused: ${other} is under ${key}, so closing ${key} would close it too; name a task outside it.`;
    if (carrier.status === "dropped")
      return `Refused: ${other} is dropped itself, so it does not do ${key}'s work.`;
    const named = this.writer.links.listFrom(record.id, "replaced-by")[0];
    const elsewhere =
      named && named.toId !== carrier.id ? this.writer.store.get(named.toId) : undefined;
    if (elsewhere) return `Refused: ${keyOrId(elsewhere)} already carries on ${key}'s work.`;
    return undefined;
  }

  /**
   * Where the work of a task closed as carried on stands (INF-1825): the
   * task at the end of its replacement chain, and whether that task still
   * runs, is done or was dropped. Undefined for any other close.
   */
  carriedOn(id: string): { key: string; state: "running" | "done" | "dropped" } | undefined {
    const record = this.writer.store.get(id);
    if (record?.status !== "done" || record.closedReason !== "superseded") return undefined;
    const carrier = this.carrierOf(id);
    if (!carrier || carrier.id === id) return undefined;
    const state = TaskService.isClosed(carrier) ? carrier.status : "running";
    return { key: keyOrId(carrier), state: state as "running" | "done" | "dropped" };
  }

  /**
   * The attempts a stronger-model move retried as this task, by id: the
   * `escalated_from` side of its `escalated` rows, read without decoding
   * the rest of its timeline.
   */
  escalatedFrom(id: string): string[] {
    return this.writer.events.escalationRefs(id, "escalated_from");
  }

  /** The attempts a stronger-model move retried this task as, by id: the other side of `escalatedFrom`. */
  escalatedTo(id: string): string[] {
    return this.writer.events.escalationRefs(id, "escalated_to");
  }

  /** Predecessors are work to recover, never a spec or a routing discount. */
  replacedPredecessors(id: string): TaskRecord[] {
    return this.writer.links
      .listTo(id, "replaced-by")
      .flatMap((link) =>
        [this.writer.store.get(link.fromId)].filter((row): row is TaskRecord => !!row),
      );
  }

  /**
   * The ready query (design section 7): open, unheld, when-ready work whose
   * every blocker closed successfully, and work whose waits left are the
   * prerequisite it starts at the approval of, now approved to merge, and
   * the parts under it that its recorded base carries (docs/task-graph.md,
   * "A part that starts at approval"). Priority first,
   * then age. The R1 sweep dispatches these.
   */
  listReady(): TaskRecord[] {
    const approved = this.writer.store
      .listAwaitingApproval()
      .filter((record) => this.approvedBase(record) !== undefined);
    const ready = this.writer.store.listReady();
    if (approved.length === 0) return ready;
    return [...ready, ...approved].sort(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt,
    );
  }

  /**
   * The earlier part whose approved merge this task starts on
   * (docs/task-graph.md, "A part that starts at approval"): that
   * prerequisite while it is live work whose merge the captain approved and
   * it has not merged yet, with the approved version and its pushed branch.
   * Every other unfinished wait must be one that part's own recorded base
   * already carries (`carriedBy`). Undefined when no wait is such a part, a
   * wait the task needs merged is unfinished, or the task waits on other
   * unfinished work besides it.
   */
  approvedBase(record: Pick<TaskRecord, "id" | "shape">): ApprovedBase | undefined {
    const base = this.approvedPrerequisite(record);
    if (!base) return undefined;
    const waits = this.blocksIn(
      record.id,
      statusesWhere((blocker) => !TaskService.blockerCleared(blocker)),
    );
    if (!waits.some(({ task }) => task.id === base.task.id)) return undefined;
    if (waits.some(({ task }) => task.id !== base.task.id && !base.carried.has(task.id)))
      return undefined;
    return base;
  }

  /**
   * The wait a task starts at the approval of, while it is live and approved
   * to merge, whatever else the task waits on. Only on batched pull
   * requests, where the batch line holds the later part's merge behind it;
   * elsewhere every wait holds until the merge. The one `start_at_approval`
   * names while it is still an unfinished wait; otherwise each unfinished wait in
   * the task's own project, the one whose recorded base carries the most
   * of the others first. A wait `needs_merge` names never starts it.
   * `among` keeps only that one wait: the part a started task was built on.
   */
  private approvedPrerequisite(
    record: Pick<TaskRecord, "id" | "shape">,
    among?: TaskRecord,
  ): ApprovedBase | undefined {
    const full = this.writer.store.get(record.id);
    if (!full || this.tasks.policiesOf(full)?.delivery.value !== "queue-pr") return undefined;
    const needs = this.needsMerge(record);
    const waits = this.blocksIn(
      record.id,
      statusesWhere((blocker) => !TaskService.blockerCleared(blocker)),
    ).map(({ task }) => task);
    // A start mark chooses only while it names a wait still unfinished; once
    // that work merged or the wait went, the default rule picks among the rest.
    const ref = record.shape?.start_at_approval;
    const resolved = ref ? this.tasks.resolve(ref) : undefined;
    const named = waits.find((task) => task.id === resolved?.id);
    const candidates = (
      named
        ? !among || among.id === named.id
          ? [named]
          : []
        : among
          ? [among]
          : waits.filter((task) => task.repoId === full.repoId)
    ).filter(
      (task) =>
        !needs.has(task.id) &&
        !TaskService.isClosed(task) &&
        task.delivery?.mergeAuthorization !== undefined &&
        TaskGraph.approvedToMerge(task),
    );
    // Each candidate's chain is walked once; a single candidate needs no ranking.
    let best: { task: TaskRecord; carried: Set<string> } | undefined;
    for (const task of candidates) {
      const carried = this.carriedBy(task, needs);
      if (!best || carried.size > best.carried.size) best = { task, carried };
    }
    const authorization = best?.task.delivery?.mergeAuthorization;
    if (!best || !authorization) return undefined;
    return {
      task: best.task,
      head: TaskGraph.newestApproved(authorization),
      branch: authorization.target.branch,
      carried: best.carried,
    };
  }

  /**
   * The unmerged parts under `base` that its own recorded base already
   * holds: the part it was built on, the part that one was built on, and so
   * on down, while each is live and approved to merge. A later part built
   * on `base` carries their work too, and the batch line merges each one
   * ahead of the part above it, so a wait on one of them neither holds that
   * part's start nor its close. A part named in `needs` ends the walk.
   */
  private carriedBy(base: TaskRecord, needs: ReadonlySet<string>): Set<string> {
    const carried = new Set<string>();
    let part = base;
    for (;;) {
      const under = this.unmergedBuiltOn(part)?.task;
      if (!under || under.id === base.id || carried.has(under.id) || needs.has(under.id)) break;
      if (TaskService.isClosed(under) || !TaskGraph.approvedToMerge(under)) break;
      carried.add(under.id);
      part = under;
    }
    return carried;
  }

  private needsMerge(record: Pick<TaskRecord, "shape">): Set<string> {
    const ids = new Set<string>();
    for (const ref of record.shape?.needs_merge ?? []) {
      const task = this.tasks.resolve(ref);
      if (task) ids.add(task.id);
    }
    return ids;
  }

  /**
   * Whether the captain's merge approval of a task still says its work goes
   * in: standing, or spent by the merge that is closing it.
   */
  static approvedToMerge(task: Pick<TaskRecord, "delivery">): boolean {
    const status = task.delivery?.mergeAuthorization?.status;
    return status !== undefined && APPROVED_TO_MERGE.has(status);
  }

  /**
   * The newest version an approval covers: the last repair its kept
   * approval accepted, or the version the captain approved. A part started
   * on it, followed to it and merged at it read this one version
   * (docs/task-graph.md, "Following the part under it").
   */
  static newestApproved(approval: Pick<MergeAuthorization, "approvedHead" | "lineage">): string {
    return approval.lineage.at(-1)?.toHead ?? approval.approvedHead;
  }

  /**
   * The approved version a task's work merged at: it closed done by a
   * merge, which spent the captain's approval. The merge's receipt names the
   * version that merged; without one, the newest version the approval
   * covered. Undefined for any other close, a done close without a merge
   * included, and for live work.
   */
  static mergedAt(task: Pick<TaskRecord, "status" | "delivery">): string | undefined {
    const approval = task.delivery?.mergeAuthorization;
    return task.status === "done" && approval?.status === "consumed"
      ? (approval.receipt?.head ?? TaskGraph.newestApproved(approval))
      : undefined;
  }

  /**
   * The approved version this task's working copy started on
   * (`shape.built_on`), with its earlier part, while that part's work has
   * not merged, whether the part is live or closed without a merge: what
   * its place in the batch line goes by. Undefined once that work merged,
   * or for a task that started on none.
   */
  unmergedBuiltOn(
    record: Pick<TaskRecord, "shape"> | undefined,
  ): { task: TaskRecord; branch: string; head: string } | undefined {
    const builtOn = this.startedOn(record);
    return builtOn && TaskGraph.mergedAt(builtOn.task) === undefined ? builtOn : undefined;
  }

  /**
   * The approved version a part started on and the task it belongs to,
   * merged or not: a read of the part's own difference goes by whether its
   * version still builds on it (`WorkspaceService.builtOnAt`).
   */
  startedOn(
    record: Pick<TaskRecord, "shape"> | undefined,
  ): { task: TaskRecord; branch: string; head: string } | undefined {
    const builtOn = record?.shape?.built_on;
    if (!builtOn) return undefined;
    const base = this.tasks.resolve(builtOn.task);
    return base ? { task: base, branch: builtOn.branch, head: builtOn.head } : undefined;
  }

  /**
   * The waits among `blockers` that this task's approved base answers
   * (`approvedBase`): the base itself, and the parts under it that the
   * base's recorded base carries. They neither hold the start nor the
   * close. Once the task has started, only through the part it was built
   * on, so the batch line holds its merge behind it. Read once per task.
   */
  private answeredByApproval(id: string, blockers: readonly TaskRecord[]): Set<string> {
    // Only an approved wait can be answered: the common case reads nothing more.
    if (!blockers.some((blocker) => TaskGraph.approvedToMerge(blocker))) return new Set();
    const record = this.writer.store.get(id);
    if (!record) return new Set();
    const builtOn = record.status === "open" ? undefined : this.unmergedBuiltOn(record)?.task;
    if (record.status !== "open" && !builtOn) return new Set();
    const base = this.approvedPrerequisite(record, builtOn);
    return base ? new Set([base.task.id, ...base.carried]) : new Set();
  }

  private unanswered(id: string, blockers: TaskRecord[]): TaskRecord[] {
    const answered = this.answeredByApproval(id, blockers);
    return answered.size ? blockers.filter((task) => !answered.has(task.id)) : blockers;
  }

  /** Open, unheld work waiting on a dropped task - a wait that cannot end. */
  listDeadBlocked(): TaskRecord[] {
    return this.writer.store.listDeadBlocked();
  }

  waitingOn(id: string): TaskRecord[] {
    return this.unanswered(
      id,
      this.blocksIn(
        id,
        statusesWhere((blocker) => !TaskService.blockerCleared(blocker)),
      ).map(({ task }) => task),
    );
  }

  /**
   * Derived flags for a live row; everything false once it is closed.
   * `blocked` and `deadBlocker` hold for ACTIVE work too, for every live
   * edge: a task its crewmate works past a recorded wait must show it is
   * held, since the wait holds its start, draws the arrow and holds its
   * merge until the work it names closes (INF-3167), unless the captain's
   * recorded override passed that hold (`holdingClose`, as `blockerRefusal`
   * reads it and Blocked by reads the same rule).
   * `ready` stays a property of open, unstarted work.
   */
  flagsOf(record: TaskRecord): TaskFlags {
    if (record.status === "open") {
      const waiting = this.waitingOn(record.id);
      const blocked = waiting.length > 0;
      const held = record.gate !== null;
      return {
        blocked,
        held,
        ready: record.kind === "work" && !blocked && !held,
        deadBlocker: waiting.some((blocker) => blocker.status === "dropped"),
      };
    }
    if (record.status === "active") {
      // Readiness is behind an active row, but a blocks edge recorded
      // mid-task still holds its close - so the row being held must say so
      // rather than look free until the merge refuses. A dropped blocker does
      // not hold a close (`blockerHoldsClose`), so it is no dead wait here. A
      // gate holds an active row the way it holds an open one: a card up
      // for the captain, a round cap, or a timed wait (docs/task-graph.md).
      // The captain's words pass the wait (the recorded override), so a
      // released row reads free, as its Blocked by and the close gate do.
      return {
        blocked: this.holdingClose(record.id, record).length > 0,
        held: record.gate !== null,
        ready: false,
        deadBlocker: false,
      };
    }
    return { blocked: false, held: false, ready: false, deadBlocker: false };
  }

  /**
   * Whether only a start - the Firstmate's or the captain's - begins this
   * work (FI3-671): it is open and the ready sweep will not start it (on
   * request, held, or waiting on blockers of its own), or it was dropped.
   */
  awaitsStart(record: TaskRecord): boolean {
    if (record.status === "dropped") return true;
    if (record.status !== "open") return false;
    return !(record.startPolicy === "when-ready" && this.flagsOf(record).ready);
  }

  /**
   * The parent close rule (design section 7): a parent closes only when
   * every child is closed. Returns the structured refusal (WI-12) naming the
   * open children and the ways out, or undefined when the row may close. The
   * settle path adds the mode-specific `proceed_with_open` way; the ways here
   * are the ones that hold whoever closes - drop or start each child.
   * `carrierId` names a part carrying the task on: the child it sits under,
   * or itself, is where the work goes on and holds nothing; its siblings do.
   */
  closeRefusal(id: string, options: { carrierId?: string } = {}): SettleRefusal | undefined {
    const carrying = options.carrierId
      ? new Set([options.carrierId, ...this.ancestors(options.carrierId).map((task) => task.id)])
      : undefined;
    // Delivery machinery (a host-commissioned child, e.g. the review) never
    // holds its parent's close: the supervisor retires such children with
    // the parent's close.
    const open = this.openChildren(id).filter(
      (child) => !TaskService.isDeliveryChild(child) && !carrying?.has(child.id),
    );
    if (open.length === 0) return undefined;
    const task = settleRef(this.writer.store.get(id), id);
    const children = open.map((child) => settleRef(child, child.id));
    const names = children.map(refName).join(", ");
    const them = open.length === 1 ? "it" : "them";
    const they = open.length === 1 ? "it can" : "they can";
    const ways: SettleWay[] = [];
    for (const child of children) {
      ways.push({
        label: `Start ${child.key} first`,
        tool: "update_task",
        args: {
          task: child.key,
          start_policy: "when-ready",
          blocked_by: this.waitingOn(child.id).map((blocker) => keyOrId(blocker)),
        },
      });
      ways.push({
        label: `Drop ${child.key}`,
        tool: "update_task",
        args: { task: child.key, drop: true, reason: "superseded", confirm: true },
      });
    }
    const text = `Cannot close ${task.key} while ${open.length === 1 ? "its child is" : `${open.length} children are`} still open: ${names}. Start ${them} so ${they} close, drop ${them} as superseded, or settle ${task.key} keeping ${them} planned.`;
    return { refused: "children-open", task, tasks: children, ways, text };
  }

  /**
   * The blockers whose edges hold this task's close, before the captain's
   * override (`holdingClose` reads it); empty when none do.
   * Every live `blocks` edge into the task holds it (INF-3167, the
   * captain's choice A): a wait the first mate or a crewmate recorded, a
   * `blocks_me` filing and a required action's prerequisite alike. The
   * `holdsMerge` mark on an edge is kept as history and changes nothing.
   */
  blockersHoldingClose(id: string): TaskRecord[] {
    return this.unanswered(
      id,
      this.liveBlocks(id).map(({ task }) => task),
    );
  }

  /**
   * The blockers that hold this task's close now: every live `blocks` edge
   * into it (`blockersHoldingClose`), unless the captain's recorded override
   * passed the waits hold at the version on offer (`overridePasses`). The
   * one reading the close refusal, the active blocked flag, the settle
   * card's follow-up rows and the first mate's task line share, so a wait
   * the captain's words passed reads free in every one of them, as it does
   * in Blocked by (./holdingWaits.ts).
   */
  holdingClose(id: string, record = this.writer.store.get(id)): TaskRecord[] {
    const delivery = record?.delivery;
    if (overridePasses(delivery, "waits", delivery?.headSha)) return [];
    return this.blockersHoldingClose(id);
  }

  /**
   * What the task's Blocked by names in the tasks reader, by the board's own
   * rule (./holdingWaits.ts, INF-999): the waits that hold it now.
   */
  waitsHolding(id: string): TaskRecord[] {
    const record = this.writer.store.get(id);
    if (!record) return [];
    // Only live blockers can hold it, so a closed blocker is never read
    // whole: each tasks listing reads this for every active row (INF-3412).
    return holdingWaits({
      record,
      blockers: this.blockersHoldingClose(id),
      tasks: this.writer.store,
    });
  }

  /**
   * The blocks rule at close time: a task that waits on another does not
   * close until that work has closed (INF-3167): what `file_followup`'s
   * `blocks_me` promises ("your task cannot land until this one closes"), and
   * what every other recorded wait means too, since a wait on part of a
   * task's work is reshaped into its own task rather than held as a wait
   * that holds nothing. Returns the refusal naming the blockers and the
   * ways out: the blocker's close (its merge, or `settle_task` done, why
   * `answered`, when it is a step whose report was all the waiter needed), dropping
   * work that is not wanted, removing a wait that names the wrong task,
   * or the captain's override.
   */
  blockerRefusal(id: string): SettleRefusal | undefined {
    // The captain's override passes a wait on live work (`waits`).
    const holding = this.holdingClose(id);
    if (holding.length === 0) return undefined;
    const task = settleRef(this.writer.store.get(id), id);
    const blockers = holding.map((blocker) => settleRef(blocker, blocker.id));
    const names = blockers.map(refName).join(", ");
    const one = holding.length === 1;
    const them = one ? "it" : "them";
    // No `proceed_with_open`: the wait ends when the other task closes. The
    // ways close a step whose report was all the waiter needed, or remove a
    // wait that names the wrong task; a merge or a drop of the blocker is
    // its own settle, and the captain's override passes the hold.
    const ways: SettleWay[] = [];
    for (const blocker of blockers) {
      ways.push({
        label: `Close ${blocker.key} as answered`,
        tool: "settle_task",
        args: { task_id: blocker.id, mode: "done", why: "answered" },
      });
      ways.push({
        label: `Remove the wait on ${blocker.key}`,
        tool: "link_tasks",
        args: { from: blocker.key, to: task.key, type: "blocks", remove: true },
      });
    }
    const text = `Cannot close ${task.key} while ${one ? "it waits on" : `it waits on ${holding.length} tasks`}: ${names}. The wait ends when ${one ? "that task closes" : "they close"}: merge ${them}, close ${one ? "it" : "one"} with settle_task done, why answered, when it is a step whose report was all ${task.key} needed, or drop ${them} if the work is not wanted; remove ${one ? "the" : "a"} wait with link_tasks remove only when it names the wrong task.`;
    return { refused: "waits-on", task, tasks: blockers, ways, text };
  }

  /**
   * A typed edge. A `blocks` edge holds the waiter's start until the
   * blocker is done and its close until the blocker closes, whoever writes
   * it (INF-3167). `holdsMerge` records that the caller promised the hold,
   * as a `blocks_me` filing does; it is kept as history and no reader
   * branches on it. Idempotent; a repeat that promises the hold sets the
   * mark and never clears one.
   */
  link(
    fromId: string,
    toId: string,
    type: TaskLinkType,
    actor: TaskEventActor,
    holdsMerge = false,
  ): boolean {
    const at = this.writer.now();
    const run = this.writer.write(() => this.insertLink(fromId, toId, type, actor, at, holdsMerge));
    return run();
  }

  /**
   * The waits a crewmate's report names (INF-1428): one `blocks` link from
   * each task to the waiting one, holding its start and its merge until
   * that work closes (INF-3167), all in one write - a cycle any of them
   * would close refuses them all. Returns the tasks newly linked.
   */
  linkWaits(waiterId: string, blockerIds: readonly string[], actor: TaskEventActor): string[] {
    const at = this.writer.now();
    const run = this.writer.write(() =>
      blockerIds.filter((fromId) => this.insertLink(fromId, waiterId, "blocks", actor, at)),
    );
    return run();
  }

  unlink(fromId: string, toId: string, type: TaskLinkType, actor: TaskEventActor): boolean {
    const at = this.writer.now();
    const run = this.writer.write(() => {
      const edgeRemoved = this.writer.links.delete(fromId, toId, type);
      // INF-1137: baseline waits live on the delivery record, not in links.
      // Remove the standing reference too, keeping the diagnosis and failed
      // readings intact. One removal clears both representations of a wait.
      const record = this.writer.mustGet(toId);
      const repair = record.delivery?.ciRepair;
      let baselineRemoved = false;
      if (type === "blocks" && repair) {
        const diagnoses = repair.diagnoses.map((diagnosis) => {
          if (
            diagnosis.classification !== "baseline-blocked" ||
            diagnosis.dependencyTask !== fromId ||
            !baselineStands(record.delivery, diagnosis)
          )
            return diagnosis;
          baselineRemoved = true;
          const { dependencyTask: _dependency, ...kept } = diagnosis;
          return kept;
        });
        if (baselineRemoved)
          this.writer.writeDeliveryRecords(toId, { ciRepair: { ...repair, diagnoses } });
      }
      const removed = edgeRemoved || baselineRemoved;
      if (edgeRemoved && type === "blocks" && record.status === "open") {
        const shape = record.shape ?? { kind: "unclear" as const };
        this.writer.patch(toId, {
          shape: {
            ...shape,
            start_wait_since: {
              ...shape.start_wait_since,
              dependencies: at,
            },
          },
          updatedAt: at,
        });
      }
      if (edgeRemoved && type === "blocks") this.dropNeedsMerge(toId, fromId);
      if (removed) {
        this.writer.touch(fromId);
        const from = this.writer.store.get(fromId);
        this.writer.addEvent({
          taskId: toId,
          at,
          actor,
          kind: "unlinked",
          text: `no longer ${LINK_WORDS[type]} "${from?.title ?? fromId}"`,
          data: { fromId, type },
          ref: fromId,
          feed: false,
        });
      }
      return removed;
    });
    return run();
  }

  /**
   * Whether following `blocks` edges outward from `start` (the tasks it
   * blocks, the tasks they block, ...) reaches `target`. Used to refuse a
   * new edge that would close a cycle: from -> to is a cycle exactly when
   * `to` already blocks `from`, transitively.
   */
  blocksReaches(start: string, target: string): string[] | undefined {
    const seen = new Set<string>([start]);
    const stack = [[start]];
    while (stack.length > 0) {
      const path = stack.pop() as string[];
      const current = path[path.length - 1] as string;
      for (const link of this.writer.links.listFrom(current, "blocks")) {
        if (link.toId === target) return [...path, target];
        if (!seen.has(link.toId)) {
          seen.add(link.toId);
          stack.push([...path, link.toId]);
        }
      }
    }
    return undefined;
  }

  /**
   * A replaced-by link carries the live waits with the work (INF-1826): each
   * live task waiting on `fromId` now waits on `toId`, and each wait of
   * `fromId`'s own on live work becomes `toId`'s, keeping its merge mark and
   * when it began. A link between the two ends and the host's own delivery
   * machinery (a review) stay where they are, and so does a wait whose move
   * would close a cycle. Baseline waits on a delivery record are not links
   * and do not move.
   */
  private moveWaits(fromId: string, toId: string, actor: TaskEventActor, at: number): void {
    const moves = (other: TaskRecord | undefined): other is TaskRecord =>
      !!other && other.id !== fromId && other.id !== toId && !TaskService.isDeliveryChild(other);
    const from = this.writer.store.get(fromId);
    const to = this.writer.store.get(toId);
    if (from && TaskService.isDeliveryChild(from)) return;
    if (to && TaskService.isDeliveryChild(to)) return;
    const move = (link: TaskLink, next: { fromId: string; toId: string }) =>
      this.moveWait(link, next, toId, actor, at);
    for (const link of this.writer.links.listFrom(fromId, "blocks")) {
      const waiter = this.writer.store.get(link.toId);
      if (!moves(waiter) || TaskService.isClosed(waiter)) continue;
      move(link, { fromId: toId, toId: waiter.id });
    }
    for (const link of this.writer.links.listTo(fromId, "blocks")) {
      const blocker = this.writer.store.get(link.fromId);
      if (!moves(blocker) || !TaskService.blockerHoldsClose(blocker)) continue;
      move(link, { fromId: blocker.id, toId });
    }
  }

  /**
   * A replaced-by link carries the outside issue with the work
   * (docs/task-graph.md, "The graph"): the carrier takes the replaced
   * task's `WorkShape.issue` whole, so the intake round sees that issue's
   * work go on instead of every linked task closed. The replaced task keeps
   * its own link as history. Issue numbers belong to one repository, so a
   * carrier in another takes nothing, and a carrier that already answers an
   * issue keeps it: a task holds one issue link.
   */
  private carryIssue(fromId: string, toId: string, at: number): void {
    const from = this.writer.store.get(fromId);
    const to = this.writer.store.get(toId);
    const issue = from?.shape?.issue;
    if (!issue || !to || to.shape?.issue || to.repoId !== from.repoId) return;
    this.writer.patch(toId, { shape: withShapeKey(to.shape, "issue", issue), updatedAt: at });
  }

  /**
   * A shipped slice's after-merge step carries one wait on (INF-3846 piece
   * 4): `waiterId`'s wait on `fromId` becomes a wait on `carrierId`, the task
   * that does the rest of the work, keeping its merge mark and when it began,
   * and the waiter's timeline records the move as `moveWaits` does. False,
   * with nothing changed, when there is no such wait or the move would close
   * a cycle; the caller says why.
   */
  carryWait(
    fromId: string,
    waiterId: string,
    carrierId: string,
    actor: TaskEventActor,
    at: number,
  ): boolean {
    const link = this.writer.links
      .listFrom(fromId, "blocks")
      .find((candidate) => candidate.toId === waiterId);
    if (!link) return false;
    return this.moveWait(link, { fromId: carrierId, toId: waiterId }, carrierId, actor, at);
  }

  private moveWait(
    link: TaskLink,
    next: { fromId: string; toId: string },
    movedTo: string,
    actor: TaskEventActor,
    at: number,
  ): boolean {
    try {
      this.insertLink(next.fromId, next.toId, "blocks", actor, at, link.holdsMerge, link.createdAt);
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return false;
      throw caught;
    }
    this.moveNeedsMerge(link, next);
    this.writer.links.delete(link.fromId, link.toId, "blocks");
    this.writer.touch(link.fromId);
    this.writer.addEvent({
      taskId: link.toId,
      at,
      actor,
      kind: "unlinked",
      text: `no longer ${LINK_WORDS.blocks} "${this.writer.store.get(link.fromId)?.title ?? link.fromId}"`,
      data: { fromId: link.fromId, type: "blocks", movedTo },
      ref: link.fromId,
      feed: false,
    });
    return true;
  }

  /**
   * A wait the waiter declared it needs merged (`shape.needs_merge`) stays a
   * merge wait where the wait moves: off the old pair, onto the new one, in
   * the same write as the link, so a moved wait never starts its waiter at
   * an approval the filer ruled out.
   */
  private moveNeedsMerge(link: TaskLink, next: { fromId: string; toId: string }): void {
    if (!this.dropNeedsMerge(link.toId, link.fromId)) return;
    const target = this.writer.store.get(next.toId);
    const blocker = this.writer.store.get(next.fromId);
    if (!target || !blocker || this.namedInNeedsMerge(target, blocker.id).length > 0) return;
    this.writer.patch(target.id, {
      shape: withShapeKey(target.shape, "needs_merge", [
        ...(target.shape?.needs_merge ?? []),
        keyOrId(blocker),
      ]),
    });
  }

  private namedInNeedsMerge(record: TaskRecord | undefined, id: string): string[] {
    return (record?.shape?.needs_merge ?? []).filter((ref) => this.tasks.resolve(ref)?.id === id);
  }

  /**
   * Takes `blockerId` out of the waiter's needs_merge, in the write that
   * removes or moves that wait, so a merge requirement never outlives its
   * wait. Says whether the waiter had named it.
   */
  private dropNeedsMerge(waiterId: string, blockerId: string): boolean {
    const waiter = this.writer.store.get(waiterId);
    const declared = this.namedInNeedsMerge(waiter, blockerId);
    if (!waiter || declared.length === 0) return false;
    const rest = (waiter.shape?.needs_merge ?? []).filter((ref) => !declared.includes(ref));
    this.writer.patch(waiter.id, {
      shape: withShapeKey(waiter.shape, "needs_merge", rest.length ? rest : undefined),
    });
    return true;
  }

  insertLink(
    fromId: string,
    toId: string,
    type: TaskLinkType,
    actor: TaskEventActor,
    at: number,
    holdsMerge = false,
    createdAt = at,
    /** Facts the link's writer saves on its `linked` line, such as `linkMergeStep`'s `filed`. */
    saved: { filed?: boolean } = {},
  ): boolean {
    const from = this.writer.mustGet(fromId);
    const to = this.writer.mustGet(toId);
    if (fromId === toId) {
      throw new TaskGraphRefusal(`Refused: a task cannot be linked to itself (${type}).`);
    }
    if (type === "blocks") {
      // Keep structural refusal even for historical ordinary links.
      const structural = this.blocksReaches(toId, fromId);
      if (structural) {
        throw new TaskGraphRefusal(
          `Refused: ${keyOrId(to)} already blocks ${keyOrId(from)} (directly or through other tasks); "${keyOrId(from)} blocks ${keyOrId(to)}" would close a cycle and nothing could ever start. ${waitCycleWords(this.tasks, [toId, ...structural.toReversed()])} ${fixedHoldWords("recorded-path")}`,
        );
      }
      const cycle = liveWaitCycle(this.tasks, toId, fromId, TaskService.blockerHoldsClose);
      if (cycle) throw new TaskGraphRefusal(`Refused: ${waitCycleWords(this.tasks, cycle)}`);
    }
    const created = this.writer.links.insert({
      fromId,
      toId,
      type,
      actor,
      createdAt,
      holdsMerge: type === "blocks" && holdsMerge,
    });
    if (created && type === "replaced-by") {
      this.moveWaits(fromId, toId, actor, at);
      this.carryIssue(fromId, toId, at);
    }
    if (created) {
      // Both ends' views change (blockedBy on one, blocks on the other).
      this.writer.touch(fromId);
      this.writer.addEvent({
        taskId: toId,
        at,
        actor,
        kind: "linked",
        text:
          type === "blocks"
            ? `waits for "${from.title}" (${keyOrId(from)})`
            : type === "related"
              ? `related to "${from.title}" (${keyOrId(from)})`
              : type === "replaced-by"
                ? `replaces "${from.title}" (${keyOrId(from)})`
                : `follow-up filed: "${from.title}" (${keyOrId(from)})`,
        data: { fromId, type, ...saved },
        ref: fromId,
        feed: false,
      });
    }
    return created;
  }
}
