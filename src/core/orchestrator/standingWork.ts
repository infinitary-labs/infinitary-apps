import { formatDurationShort } from "@shared/quotaSignals";
import { encode } from "@toon-format/toon";
import type { InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { keyOrId } from "../tasks/taskWriter";
import type { IdleLadder } from "./idleLadder";
import { startedBuilding } from "./nextMove";
import { readerSavedLine, servedTaskTitle, withReaderDataReminder } from "./readerData";

/**
 * The standing list (INF-6664 piece 1; docs/report-sort.md, "The standing
 * list"): waiting work that no wake reports to the first mate, and every
 * hold and wait on unstarted work (INF-6853), read from typed facts the
 * record already holds. It only reads; each store keeps its
 * one writer, and the new mark rides the inbox's once-names, so it adds no
 * store.
 */

const DAY_MS = 24 * 60 * 60_000;

/**
 * At most this many rows, those marked new first and the rest oldest first;
 * the rest are counted. New rows lead so a row the cap would cut still
 * reaches the reader at each milestone.
 */
export const STANDING_ROW_CAP = 12;

/**
 * The ages, in days, at which a row reads new again: its first appearance,
 * then 1, 3 and 7 days, then every 7 days after that.
 */
function milestoneDays(ageMs: number): number {
  const days = Math.floor(Math.max(0, ageMs) / DAY_MS);
  if (days >= 7) return days - (days % 7);
  if (days >= 3) return 3;
  if (days >= 1) return 1;
  return 0;
}

/**
 * The once-name that marks a row seen at its current milestone, recorded
 * about the row's task: one per stay (its since) and milestone, so a new
 * stay or the next milestone reads new again. A parked part that had
 * prerequisites and whose prerequisites have all closed carries
 * `:prerequisites-closed` too, so that close reads new again inside the
 * same milestone.
 */
export function standingOnce(since: number, now: number, prerequisitesClosed = false): string {
  const name = `standing:${since}:${milestoneDays(now - since)}`;
  return prerequisitesClosed ? `${name}:prerequisites-closed` : name;
}

/** A hold set more than this far ahead is a wait, not a check-back. */
const HELD_ROW_MS = DAY_MS;

type RowBase = {
  taskId: string;
  key: string;
  title: string;
  /** When the stay began, read from the record. */
  since: number;
  /** Whether its current milestone's once-name is not yet recorded. */
  new: boolean;
  /** The once-name a delivery records about `taskId` to mark it seen. */
  once: string;
};

export type StandingRow =
  | (RowBase & {
      kind: "parked-part";
      parent: string;
      /** Its parent's other open parts. */
      openSiblings: number;
      /** Whether every task it waits on has closed. */
      prerequisitesClosed: boolean;
    })
  | (RowBase & {
      kind: "open-ended-wait";
      /** The newest report's observation of what it waits for. */
      reason: string;
    })
  | (RowBase & {
      kind: "held";
      /** The hold's time. */
      until: number;
      /** The hold's reason, as the first mate wrote it. */
      reason: string;
      /** Whether an Automation event or an app update ends it sooner. */
      endsSooner: { event: boolean; update: boolean };
    })
  | (RowBase & {
      kind: "linked-wait";
      /** The work only a start begins that it waits on, and whether the captain stopped each. */
      waits: { taskId: string; key: string; title: string; stopped: boolean }[];
    });

/** A row before its new mark is read. */
type Unmarked<R = StandingRow> = R extends StandingRow ? Omit<R, "new" | "once"> : never;

export type StandingWork = {
  rows: StandingRow[];
  /** Standing rows past the cap, left out. */
  more: number;
  /** Open work on request that is not a row or a saved plan, by how long since it was filed. */
  filedForLater: { under3Days: number; days3To14: number; over14Days: number };
  /** Open work on request built on an answer that closed: a saved plan not built. */
  savedPlans: { count: number; oldest?: number };
};

export type StandingWorkHost = {
  tasks: TaskService;
  inbox: Pick<InboxStore, "woken">;
  /** The work a task waits on, as the idle ladder reads it. */
  waits: Pick<IdleLadder, "unstartedWaits" | "underwayWaits">;
};

/**
 * Its parent, when that parent is begun: live, building work rather than an
 * answer (whose parts are ideas for later), and it or another part started
 * building work. As in the next-move check, a part that delivers an answer,
 * a dropped part and a part the captain stopped make nothing begun.
 */
function begunParent(tasks: TaskService, record: TaskRecord): TaskRecord | undefined {
  const parent = record.parentId ? tasks.get(record.parentId) : undefined;
  if (!parent || TaskService.isClosed(parent) || parent.shape?.deliverable === "answer") return;
  const begun =
    startedBuilding(parent) ||
    tasks.graph
      .children(parent.id)
      .some(
        (part) =>
          part.id !== record.id && startedBuilding(part) && !tasks.starts.stoppedByCaptain(part),
      );
  return begun ? parent : undefined;
}

function parkedPart(tasks: TaskService, record: TaskRecord): Unmarked | undefined {
  if (!tasks.starts.stoppedByCaptain(record)) return;
  const parent = begunParent(tasks, record);
  if (!parent) return;
  return {
    kind: "parked-part",
    taskId: record.id,
    key: keyOrId(record),
    title: record.title,
    since: tasks.starts.latestStopAt(record.id) ?? record.createdAt,
    parent: keyOrId(parent),
    openSiblings: tasks.graph
      .openChildren(parent.id)
      .filter((part) => part.id !== record.id && !TaskService.isDeliveryChild(part)).length,
    prerequisitesClosed: tasks.graph.waitingOn(record.id).length === 0,
  };
}

/**
 * A started, idle task out of the backlog whose newest report declared a
 * work wait with no end: nothing typed ends it. A gate (a dated hold, an
 * allowance, a card for the captain) is a typed end, so a gated task is not
 * one. A turn that failed after that report ends the wait, as the idle
 * ladder reads a declared wait (`IdleLadder.declaredWait`). Until the idle
 * ladder reaches its last rung (its stall card) the ladder itself wakes the
 * first mate about the task, so only a wait past rung 3 with that card gone
 * is one no wake reports.
 */
function openEndedWait(tasks: TaskService, record: TaskRecord): Unmarked | undefined {
  if (record.activity !== "idle" || record.backlogSince != null || record.gate) return;
  if ((record.recoveryRung ?? 0) < 3) return;
  const report = tasks.lastReportEntries(record.id).at(-1);
  const wait = report?.declared.workWait;
  if (!report || !wait || wait.end) return;
  if ((tasks.lastFailureAt(record.id) ?? -1) > report.at) return;
  return {
    kind: "open-ended-wait",
    taskId: record.id,
    key: keyOrId(record),
    title: record.title,
    since: report.at,
    reason: wait.observation,
  };
}

/**
 * A started task out of the backlog that the first mate held for more than
 * a day from when it set the hold (`TaskTurns.holdSetAt`): a hold's reason
 * is words no code reads, so nothing else reports what it waits for until
 * its time. A shorter hold is a check-back its time soon ends.
 */
function heldRow(tasks: TaskService, record: TaskRecord): Unmarked | undefined {
  const gate = record.gate;
  if (record.backlogSince != null || gate?.kind !== "at-time" || gate.until === undefined) return;
  const since = tasks.turns.holdSetAt(record);
  if (since === undefined || gate.until - since <= HELD_ROW_MS) return;
  return {
    kind: "held",
    taskId: record.id,
    key: keyOrId(record),
    title: record.title,
    since,
    until: gate.until,
    reason: gate.reason ?? "",
    endsSooner: { event: gate.ref !== undefined, update: gate.update !== undefined },
  };
}

/**
 * A started, idle task out of the backlog, with no gate, whose waits end
 * only in work nobody has started (`IdleLadder.unstartedWaits`), work the
 * captain stopped included. A wait on work underway beside them is no row:
 * that work's close wakes the task. Its stay starts at its newest live
 * `blocks` link, or when it went idle for a wait no link names.
 */
function linkedWait(host: StandingWorkHost, record: TaskRecord): Unmarked | undefined {
  if (record.activity !== "idle" || record.backlogSince != null || record.gate) return;
  const { tasks } = host;
  const waited = host.waits.unstartedWaits(record);
  if (waited.length === 0 || host.waits.underwayWaits(record).length > 0) return;
  const linkedAt = tasks.graph.liveBlocks(record.id).map(({ link }) => link.createdAt);
  return {
    kind: "linked-wait",
    taskId: record.id,
    key: keyOrId(record),
    title: record.title,
    since: linkedAt.length > 0 ? Math.max(...linkedAt) : (record.idleSince ?? record.updatedAt),
    waits: waited.map((task) => ({
      taskId: task.id,
      key: keyOrId(task),
      title: task.title,
      stopped: tasks.starts.stoppedByCaptain(task),
    })),
  };
}

function savedPlan(tasks: TaskService, record: TaskRecord): boolean {
  const basis = tasks.graph.basisOf(record);
  const plan = basis ? tasks.resolve(basis.ref) : undefined;
  return plan?.status === "done" && plan.shape?.deliverable === "answer";
}

export function standingWork(host: StandingWorkHost, now: number): StandingWork {
  const { tasks } = host;
  const found: Unmarked[] = [];
  const filedForLater = { under3Days: 0, days3To14: 0, over14Days: 0 };
  const savedPlans: StandingWork["savedPlans"] = { count: 0 };
  for (const record of tasks.listLive()) {
    if (record.kind !== "work" || TaskService.isDeliveryChild(record)) continue;
    const onRequest = record.status === "open" && record.startPolicy === "on-request";
    const row =
      onRequest || record.backlogSince != null
        ? parkedPart(tasks, record)
        : record.status === "active"
          ? (heldRow(tasks, record) ?? linkedWait(host, record) ?? openEndedWait(tasks, record))
          : undefined;
    if (row) {
      found.push(row);
      continue;
    }
    if (!onRequest) continue;
    if (savedPlan(tasks, record)) {
      savedPlans.count += 1;
      savedPlans.oldest = Math.min(savedPlans.oldest ?? record.createdAt, record.createdAt);
      continue;
    }
    const age = now - record.createdAt;
    if (age < 3 * DAY_MS) filedForLater.under3Days += 1;
    else if (age <= 14 * DAY_MS) filedForLater.days3To14 += 1;
    else filedForLater.over14Days += 1;
  }
  const marked = found.map((row) => {
    // Only a part that had prerequisites reads new on their close.
    const closed =
      row.kind === "parked-part" &&
      row.prerequisitesClosed &&
      tasks.graph.linksTo(row.taskId).some((link) => link.type === "blocks");
    const once = standingOnce(row.since, now, closed);
    return { ...row, once, new: !host.inbox.woken(row.taskId, once) } as StandingRow;
  });
  marked.sort(
    (a, b) => Number(b.new) - Number(a.new) || a.since - b.since || a.key.localeCompare(b.key),
  );
  const rows = marked.slice(0, STANDING_ROW_CAP);
  return { rows, more: marked.length - rows.length, filedForLater, savedPlans };
}

/**
 * The list in the first mate's context format (TOON), each title as the
 * context serves it and each wait's reason between reader-data marks, with
 * the one reminder after them.
 */
export function standingWorkText(tasks: TaskService, list: StandingWork, now: number): string {
  const iso = (at: number) => new Date(at).toISOString();
  const title = (task: { taskId: string; title: string }) =>
    servedTaskTitle(
      { id: task.taskId, title: task.title },
      tasks.graph.discoveredOrigins(task.taskId),
      "line",
    );
  const reason = (row: { taskId: string; reason: string }) =>
    readerSavedLine(`standing:${row.taskId}:reason`, row.reason);
  const fields = (row: StandingRow) => {
    switch (row.kind) {
      case "parked-part":
        return {
          parent: row.parent,
          open_siblings: row.openSiblings,
          prerequisites_closed: row.prerequisitesClosed,
        };
      case "open-ended-wait":
        return { reason: reason(row) };
      case "held":
        return {
          until: iso(row.until),
          reason: reason(row),
          ends_sooner_on_event: row.endsSooner.event,
          ends_sooner_on_update: row.endsSooner.update,
        };
      case "linked-wait":
        return {
          waits_on: row.waits.map((task) => ({
            task: task.key,
            title: title(task),
            stopped_by_captain: task.stopped,
          })),
        };
    }
  };
  const rows = list.rows.map((row) => ({
    kind: row.kind,
    task: row.key,
    title: title(row),
    since: iso(row.since),
    waited: formatDurationShort(now - row.since),
    new: row.new,
    ...fields(row),
  }));
  const standing_work = {
    // i18n-exempt: sent to the first mate in English; a heartbeat's History shows it as sent
    note: "Waiting work: parked parts, waits nothing ends, holds over a day and waits on unstarted work, rows marked new first, then oldest first. A row is new when it joins the list and again at 1, 3 and 7 days, then every 7 days. Reading it grants no permission.",
    rows,
    ...(list.more > 0 ? { more: list.more } : {}),
    filed_for_later: {
      under_3_days: list.filedForLater.under3Days,
      "3_to_14_days": list.filedForLater.days3To14,
      over_14_days: list.filedForLater.over14Days,
    },
    saved_plans_not_built: {
      count: list.savedPlans.count,
      ...(list.savedPlans.oldest !== undefined ? { oldest: iso(list.savedPlans.oldest) } : {}),
    },
  };
  return withReaderDataReminder(encode({ standing_work }));
}
