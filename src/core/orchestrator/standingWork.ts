import { formatDurationShort } from "@shared/quotaSignals";
import { encode } from "@toon-format/toon";
import type { InboxStore } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { keyOrId } from "../tasks/taskWriter";
import { startedBuilding } from "./nextMove";
import { readerSavedLine, servedTaskTitle, withReaderDataReminder } from "./readerData";

/**
 * The standing list (INF-6664 piece 1; docs/report-sort.md, "The standing
 * list"): waiting work that no wake reports to the first mate, read from
 * typed facts the record already holds. It only reads; each store keeps its
 * one writer, and the new mark rides the inbox's once-names, so it adds no
 * store.
 */

const DAY_MS = 24 * 60 * 60_000;

/** At most this many rows, oldest first; the rest are counted. */
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
 * stay or the next milestone reads new again.
 */
export function standingOnce(since: number, now: number): string {
  return `standing:${since}:${milestoneDays(now - since)}`;
}

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
 * ladder reads a declared wait (`IdleLadder.declaredWait`).
 */
function openEndedWait(tasks: TaskService, record: TaskRecord): Unmarked | undefined {
  if (record.activity !== "idle" || record.backlogSince != null || record.gate) return;
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
          ? openEndedWait(tasks, record)
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
  found.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  const rows = found.slice(0, STANDING_ROW_CAP).map((row) => {
    const once = standingOnce(row.since, now);
    return { ...row, once, new: !host.inbox.woken(row.taskId, once) } as StandingRow;
  });
  return { rows, more: found.length - rows.length, filedForLater, savedPlans };
}

/**
 * The list in the first mate's context format (TOON), each title as the
 * context serves it and each wait's reason between reader-data marks, with
 * the one reminder after them.
 */
export function standingWorkText(tasks: TaskService, list: StandingWork, now: number): string {
  const iso = (at: number) => new Date(at).toISOString();
  const title = (row: StandingRow) =>
    servedTaskTitle(
      { id: row.taskId, title: row.title },
      tasks.graph.discoveredOrigins(row.taskId),
      "line",
    );
  const rows = list.rows.map((row) => ({
    kind: row.kind,
    task: row.key,
    title: title(row),
    since: iso(row.since),
    waited: formatDurationShort(now - row.since),
    new: row.new,
    ...(row.kind === "parked-part"
      ? {
          parent: row.parent,
          open_siblings: row.openSiblings,
          prerequisites_closed: row.prerequisitesClosed,
        }
      : { reason: readerSavedLine(`standing:${row.taskId}:reason`, row.reason) }),
  }));
  const standing_work = {
    // i18n-exempt: served to the first mate, never shown to a person
    note: "Waiting work no wake reports, oldest first. A row is new when it joins the list and again at 1, 3 and 7 days, then every 7 days. Reading it grants no permission.",
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
