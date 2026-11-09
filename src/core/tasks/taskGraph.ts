import type { OpenEffect } from "@shared/cards";
import { isRepairAssessment } from "@shared/checkRepair";
import { fixedHoldWords, overridePasses } from "@shared/holds";
import { taskStatusSchema } from "@shared/tasks";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskLink, TaskLinkType } from "../storage/taskLinkStore";
import type { TaskReference, TaskReferenceKind } from "../storage/taskReferenceStore";
import type { TaskRecord, TaskStatus } from "../storage/taskStore";
import { baselineStands } from "./dependencyWaits";
import { holdingWaits } from "./holdingWaits";
import { TaskService } from "./taskService";
import { keyOrId, type TaskWriter } from "./taskWriter";
import { liveWaitCycle, waitCycleWords } from "./waitCycles";

/** A graph rule refused the write; the message is meant for the agent. */
export class TaskGraphRefusal extends Error {
  override readonly name = "TaskGraphRefusal";
}

/** The derived state of an open row (design section 4.1, "derived on open"). */
/** A `blocks` edge into a task, with the blocker it runs from. */
export type BlockingEdge = { link: TaskLink; task: TaskRecord };

/** The statuses a blocker predicate holds for, so a read can ask SQLite for only those rows. */
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

/**
 * How a link's `to` stands to its `from` - the end a `linked` event is
 * written on - and so how that event's task reads from the other end.
 */
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
export class TaskGraph {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  /** Active work a finding holds, in link order, without composing closed waiter records. */
  activeWaiters(id: string): TaskRecord[] {
    const known = this.writer.projection?.activeWaiters.get(id);
    if (known) return known;
    const links = this.linksFrom(id).filter((link) => link.type === "blocks" && !link.holdsMerge);
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
   * not the task itself, not a task under it (its close would take it
   * along), and not a dropped task, which does no work.
   */
  carrierRefusal(id: string, carrierId: string): string | undefined {
    const record = this.writer.mustGet(id);
    const carrier = this.writer.mustGet(carrierId);
    const key = keyOrId(record);
    const other = keyOrId(carrier);
    if (carrier.id === record.id) return `Refused: ${key} cannot be replaced by itself.`;
    if (this.ancestors(carrier.id).some((ancestor) => ancestor.id === record.id))
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
   * every blocker closed successfully. The R1 sweep dispatches these.
   */
  listReady(): TaskRecord[] {
    return this.writer.store.listReady();
  }

  /** Open, unheld work waiting on a dropped task - a wait that cannot end. */
  listDeadBlocked(): TaskRecord[] {
    return this.writer.store.listDeadBlocked();
  }

  /** The uncleared blockers of a task. */
  waitingOn(id: string): TaskRecord[] {
    return this.blocksIn(
      id,
      statusesWhere((blocker) => !TaskService.blockerCleared(blocker)),
    ).map(({ task }) => task);
  }

  /**
   * Derived flags for a live row; everything false once it is closed.
   * `blocked` and `deadBlocker` hold for ACTIVE work too, and only for a
   * marked edge: a follow-up filed with `blocks_me` lands on a task a
   * crewmate is holding, and that is the one row that must show it. A
   * recorded wait holds the start and draws the arrow, and the origin
   * stays free to merge.
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
      // Readiness is behind an active row, but a blocks edge filed mid-task
      // still holds its close - so the row being held must say so rather
      // than look free until the merge refuses. A dropped blocker does not
      // hold a close (`blockerHoldsClose`), so it is no dead wait here. A
      // gate holds an active row the way it holds an open one: a card up
      // for the captain, a round cap, or a timed wait (docs/task-graph.md).
      return {
        blocked: this.blockersHoldingClose(record.id).length > 0,
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
   */
  closeRefusal(id: string): SettleRefusal | undefined {
    // Delivery machinery (a host-commissioned child, e.g. the review) never
    // holds its parent's close: the supervisor retires such children with
    // the parent's close.
    const open = this.openChildren(id).filter((child) => !TaskService.isDeliveryChild(child));
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
   * The blockers that still hold this task's close; empty when none do.
   * Only a marked edge holds the close (INF-416 piece E): a `blocks_me`
   * filing or a required action's prerequisite.
   * A recorded wait keeps the edge, and the start, and holds nothing here.
   */
  blockersHoldingClose(id: string): TaskRecord[] {
    return this.liveBlocks(id).flatMap(({ link, task }) => (link.holdsMerge ? [task] : []));
  }

  /**
   * What the task's Blocked by names in the tasks reader, by the board's own
   * rule (./holdingWaits.ts, INF-999): the waits that hold it now.
   * `idleOnWaits` says its crewmate stands idle on its waits.
   */
  waitsHolding(id: string, idleOnWaits: boolean): TaskRecord[] {
    const record = this.writer.store.get(id);
    if (!record) return [];
    const marked = new Set(
      this.linksTo(id)
        .filter((link) => link.type === "blocks" && link.holdsMerge)
        .map((link) => link.fromId),
    );
    return holdingWaits({
      record,
      blockers: this.blockers(id),
      holdsMerge: (blocker) => marked.has(blocker.id),
      tasks: this.writer.store,
      idleOnWaits,
    });
  }

  /**
   * The blocks rule at close time: a task that something must land before
   * does not close until it has. This is what `file_followup`'s `blocks_me`
   * promises ("your task cannot land until this does"); blocks edges
   * otherwise gate dispatch alone, which says nothing about work already
   * under way. Returns the refusal naming the blockers and the ways out.
   */
  blockerRefusal(id: string): SettleRefusal | undefined {
    // The captain's override passes a must-merge-first wait (`waits`).
    const record = this.writer.store.get(id);
    const delivery = record?.delivery;
    const passed = record !== undefined && overridePasses(delivery, "waits", delivery?.headSha);
    const holding = passed ? [] : this.blockersHoldingClose(id);
    if (holding.length === 0) return undefined;
    const task = settleRef(this.writer.store.get(id), id);
    const blockers = holding.map((blocker) => settleRef(blocker, blocker.id));
    const names = blockers.map(refName).join(", ");
    const them = holding.length === 1 ? "it" : "them";
    // No `proceed_with_open`: a blocks_me edge is the crewmate's own promise
    // that its task cannot land until this does. The ways out land the
    // blocker, drop it, retract the promise, or the captain's override.
    const ways: SettleWay[] = [];
    for (const blocker of blockers) {
      ways.push({
        label: `Remove the wait on ${blocker.key}`,
        tool: "link_tasks",
        args: { from: blocker.key, to: task.key, type: "blocks", remove: true },
      });
    }
    const text = `Cannot close ${task.key} while ${holding.length === 1 ? "it waits on" : `it waits on ${holding.length} tasks`}: ${names}. Merge ${them} first, drop ${them} if the work is not wanted, or remove the wait with link_tasks remove.`;
    return { refused: "waits-on", task, tasks: blockers, ways, text };
  }

  /**
   * A typed edge; `blocks` carries readiness. `holdsMerge` is the close
   * mark, and only a caller that promised the hold passes it. Idempotent;
   * a repeat that promises the hold sets the mark and never clears one.
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
   * each task to the waiting one, a recorded wait that holds no merge, all
   * in one write - a cycle any of them would close refuses them all.
   * Returns the tasks newly linked.
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
    const move = (link: TaskLink, next: { fromId: string; toId: string }) => {
      try {
        this.insertLink(
          next.fromId,
          next.toId,
          "blocks",
          actor,
          at,
          link.holdsMerge,
          link.createdAt,
        );
      } catch (caught) {
        if (caught instanceof TaskGraphRefusal) return;
        throw caught;
      }
      this.writer.links.delete(link.fromId, link.toId, "blocks");
      this.writer.touch(link.fromId);
      this.writer.addEvent({
        taskId: link.toId,
        at,
        actor,
        kind: "unlinked",
        text: `no longer ${LINK_WORDS.blocks} "${this.writer.store.get(link.fromId)?.title ?? link.fromId}"`,
        data: { fromId: link.fromId, type: "blocks", movedTo: toId },
        ref: link.fromId,
        feed: false,
      });
    };
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

  insertLink(
    fromId: string,
    toId: string,
    type: TaskLinkType,
    actor: TaskEventActor,
    at: number,
    holdsMerge = false,
    createdAt = at,
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
    if (created && type === "replaced-by") this.moveWaits(fromId, toId, actor, at);
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
        data: { fromId, type },
        ref: fromId,
        feed: false,
      });
    }
    return created;
  }
}
