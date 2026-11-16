import {
  BATCH_STATUS_WORDS,
  type BatchChange,
  type BatchHold,
  type BatchMember,
  type BatchReceipt,
  type BatchRecord,
  type BatchStatus,
  type OpenBatch,
} from "@shared/batches";
import { BATCH_WAITING_WORDS } from "../forge";
import type { Combined } from "./combine";

/**
 * The rules of a project's line and its one open batch (docs/forge.md,
 * "Batches of your own"), as pure steps over the saved record. `Batches`
 * decides when each runs and does the work where the project lives;
 * nothing here reads a clock, a host or a folder.
 */

/** What a change's own merge reads of its place in the line and the batch. */
export type Standing =
  | { state: "merged"; receipt: BatchReceipt }
  /**
   * In line, in the open batch while it is checked (`batch`), or in a batch
   * of several that holds (`held`): the batch's repair answers that hold.
   */
  | {
      state: "waiting";
      place: "line" | "batch" | "held";
      /** Why its batch holds, where it does. */
      hold?: BatchHold["reason"];
      number?: number;
      url?: string | null;
    }
  /** The only change of a batch whose checks failed: its own crewmate repairs it. */
  | { state: "failed"; checks: string[]; number?: number; url?: string | null }
  | { state: "left-out"; reason: string };

/** A change's place at `head`; undefined when the record holds none for that version. */
export function standing(record: BatchRecord, taskId: string, head: string): Standing | undefined {
  const receipt = record.receipts.find((entry) => entry.taskId === taskId && entry.head === head);
  if (receipt) return { state: "merged", receipt };
  const member = record.open?.members.find(
    (entry) => entry.taskId === taskId && entry.head === head,
  );
  if (member && record.open) {
    const hold = record.open.hold;
    const request = {
      ...(record.open.number !== undefined ? { number: record.open.number } : {}),
      ...(record.open.url !== undefined ? { url: record.open.url } : {}),
    };
    return hold?.reason === "checks" && record.open.members.length === 1
      ? { state: "failed", checks: hold.checks, ...request }
      : hold
        ? { state: "waiting", place: "held", hold: hold.reason, ...request }
        : { state: "waiting", place: "batch", ...request };
  }
  if (record.line.some((entry) => entry.taskId === taskId && entry.head === head))
    return { state: "waiting", place: "line" };
  const left = record.leftOut.find((entry) => entry.taskId === taskId && entry.head === head);
  return left ? { state: "left-out", reason: left.reason } : undefined;
}

/** A change's place as its batch check says it (`BatchStatus`). */
export function batchStatus(place: Standing): BatchStatus {
  const link = (url: string | null | undefined) => (url ? { link: url } : {});
  switch (place.state) {
    case "merged":
      return { kind: "passed", words: BATCH_STATUS_WORDS.merged, ...link(place.receipt.url) };
    case "failed":
      return { kind: "failed", words: BATCH_STATUS_WORDS.failed(place.checks), ...link(place.url) };
    case "left-out":
      return { kind: "failed", words: BATCH_STATUS_WORDS.leftOut(place.reason) };
    case "waiting":
      return place.place === "line"
        ? { kind: "waiting", words: BATCH_WAITING_WORDS }
        : place.place === "held"
          ? {
              kind: "paused",
              words: BATCH_STATUS_WORDS.held(place.hold ?? "checks"),
              ...link(place.url),
            }
          : { kind: "in-batch", words: BATCH_STATUS_WORDS.batch, ...link(place.url) };
  }
}

/**
 * Put an approved change in line, in approval order. An earlier version of
 * the same task leaves the line and the open batch: only the approved
 * version is carried. `fix` marks the change the held batch's declared fix,
 * also when that version already waits in line: a fix may be declared after
 * its approval, and the same approval may come again.
 */
export function enqueue(record: BatchRecord, change: BatchChange): BatchRecord {
  if (standing(record, change.taskId, change.head)?.state === "waiting")
    return change.fix ? markFix(record, change.taskId) : record;
  const without = withdraw(record, change.taskId);
  return {
    ...without,
    line: [...without.line, change].sort((a, b) => a.at - b.at),
    leftOut: without.leftOut.filter((entry) => entry.taskId !== change.taskId),
  };
}

/**
 * Take a task's change out of the line and the open batch: its approval was
 * withdrawn, or it was sent back. An open batch that carried it combines
 * again without it (`stale`).
 */
export function withdraw(record: BatchRecord, taskId: string): BatchRecord {
  const open = record.open;
  const member = open?.members.some((entry) => entry.taskId === taskId);
  return {
    ...record,
    line: record.line.filter((entry) => entry.taskId !== taskId),
    ...(open && member
      ? {
          open: {
            ...open,
            members: open.members.filter((entry) => entry.taskId !== taskId),
            stale: true,
          },
        }
      : {}),
  };
}

/**
 * A change's story was confirmed on its pushed branch at `head`. The version
 * already in line or in the open batch keeps its place and takes the story's
 * title and words; an open batch whose member's words changed combines again
 * so that change's commit says them (`stale`). Any other version of the task
 * leaves, as a withdrawn one does: only the approved version is carried.
 */
export function reworded(
  record: BatchRecord,
  change: Pick<BatchChange, "taskId" | "head" | "title" | "body">,
): BatchRecord {
  const waits = (entry: BatchChange) =>
    entry.taskId === change.taskId && entry.head === change.head;
  const open = record.open;
  if (!record.line.some(waits) && !open?.members.some(waits))
    return withdraw(record, change.taskId);
  const says = (entry: BatchChange) =>
    !waits(entry) || (entry.title === change.title && entry.body === change.body);
  const worded = <Entry extends BatchChange>(entry: Entry): Entry =>
    says(entry) ? entry : { ...entry, title: change.title, body: change.body };
  return {
    ...record,
    line: record.line.map(worded),
    ...(open && !open.members.every(says)
      ? { open: { ...open, members: open.members.map(worded), stale: true } }
      : {}),
  };
}

/**
 * The formation rule: at least one change in line, no open batch of this
 * home's, and the project's batch gap (`gap`, in minutes) passed since its
 * last batch formed (docs/forge.md, "The batch gap"). With no gap, or no
 * batch formed yet, a batch forms at once. `now` is the pass's own clock.
 */
export function forms(record: BatchRecord, gap?: number, now?: number): boolean {
  if (record.open || record.line.length === 0) return false;
  const next = nextBatchAt(record, gap);
  return next === undefined || (now !== undefined && now >= next);
}

/**
 * When the project's next batch may form under its gap (epoch ms), or
 * undefined when one may form at once: no gap, or no batch formed yet.
 * A held batch's repair never reads it: it answers the open batch.
 */
export function nextBatchAt(record: BatchRecord, gap?: number): number | undefined {
  return gap && record.formed !== undefined ? record.formed + gap * 60_000 : undefined;
}

/**
 * Mark the change a task has waiting in line as the held batch's declared
 * fix. The same record when it has none there, or it is marked already.
 */
export function markFix(record: BatchRecord, taskId: string): BatchRecord {
  if (!record.line.some((entry) => entry.taskId === taskId && !entry.fix)) return record;
  return {
    ...record,
    line: record.line.map((entry) =>
      entry.taskId === taskId ? { ...entry, fix: true as const } : entry,
    ),
  };
}

/**
 * The record with no declared fix left: its batch merged or ended, so the
 * declarations and the marks they put on changes in line answer nothing now.
 */
export function unfixed(record: BatchRecord): BatchRecord {
  const { fixes: _fixes, ...rest } = record;
  return {
    ...rest,
    line: record.line.map(({ fix: _fix, ...entry }) => entry),
  };
}

/** Whether an approved fix waits in line for the held batch. */
export function fixWaits(record: BatchRecord): boolean {
  return Boolean(record.open?.hold) && record.line.some((entry) => entry.fix);
}

/**
 * The changes the next combine carries, in order. A new batch takes the
 * whole line. An open batch combines its own members again; `line` adds
 * every change waiting behind them, as a held batch's answer does (a fix
 * joining, Try again, a send-back): the declared fixes first, so the change
 * that ends the hold sits right behind the members, then the rest of the
 * line in approval order.
 */
export function carried(record: BatchRecord, join: "none" | "line" = "none"): BatchChange[] {
  if (!record.open) return [...record.line];
  const joining =
    join === "line"
      ? [...record.line.filter((entry) => entry.fix), ...record.line.filter((entry) => !entry.fix)]
      : [];
  return [...record.open.members.map(asChange), ...joining];
}

function asChange(member: BatchMember): BatchChange {
  const { commit: _commit, ...change } = member;
  return change;
}

/**
 * The record after a combine was pushed to `branch`: its members are the
 * open batch, any hold has ended, and each carried change has left the
 * line. A change left out is kept with its reason until its branch moves.
 * A combine that carried nothing leaves no open batch.
 */
export function combined(
  record: BatchRecord,
  result: Combined,
  batch: { branch: string; at: number },
): BatchRecord {
  const carriedIds = new Set([
    ...result.members.map((member) => member.taskId),
    ...result.leftOut.map((entry) => entry.change.taskId),
  ]);
  const { open: previous, ...rest } = record;
  const open: OpenBatch | undefined = result.members.length
    ? {
        branch: batch.branch,
        head: result.head,
        base: result.base,
        ...(previous?.number !== undefined ? { number: previous.number } : {}),
        ...(previous?.url !== undefined ? { url: previous.url } : {}),
        members: result.members,
        since: previous?.since ?? batch.at,
      }
    : undefined;
  // A new batch from the line starts the project's gap; the open batch combined again does not.
  const formed = open && !previous ? batch.at : record.formed;
  return {
    ...rest,
    ...(formed !== undefined ? { formed } : {}),
    line: record.line.filter((entry) => !carriedIds.has(entry.taskId)),
    ...(open ? { open } : {}),
    leftOut: [
      ...record.leftOut.filter((entry) => !carriedIds.has(entry.taskId)),
      ...result.leftOut.map((entry) => ({
        taskId: entry.change.taskId,
        head: entry.change.head,
        reason: entry.reason,
        at: batch.at,
      })),
    ],
  };
}

/**
 * Hold the open batch at its version. Answers `fresh` only for a hold this
 * version did not already carry, so its owner hears of it once.
 */
export function hold(
  record: BatchRecord,
  next: BatchHold,
): { record: BatchRecord; fresh: boolean } {
  const open = record.open;
  if (!open) return { record, fresh: false };
  if (open.hold?.head === next.head && open.hold.reason === next.reason)
    return { record, fresh: false };
  return { record: { ...record, open: { ...open, hold: next } }, fresh: true };
}

/** End the open batch's hold: its checks run again, or it was combined again. */
export function release(record: BatchRecord): BatchRecord {
  if (!record.open?.hold) return record;
  const { hold: _hold, ...open } = record.open;
  return { ...record, open };
}

/**
 * The record after the open batch merged: each member's receipt, naming its
 * own commit on the default branch where one was read, and no open batch.
 */
export function merged(
  record: BatchRecord,
  landed: ReadonlyMap<string, string | undefined>,
  at: number,
): BatchRecord {
  const { open, ...rest } = record;
  if (!open || open.number === undefined) return record;
  const number = open.number;
  return {
    ...rest,
    receipts: [
      ...record.receipts.filter(
        (entry) => !open.members.some((member) => member.taskId === entry.taskId),
      ),
      ...open.members.map((member) => {
        const sha = landed.get(member.taskId);
        return {
          taskId: member.taskId,
          head: member.head,
          ...(sha ? { sha } : {}),
          number,
          ...(open.url !== undefined ? { url: open.url } : {}),
          at,
        };
      }),
    ],
  };
}

/**
 * The record after its open batch's pull request was closed without a
 * merge where the project lives: the members go back to the front of the
 * line, in their order, and the next batch forms from it.
 */
export function reopened(record: BatchRecord): BatchRecord {
  const { open, ...rest } = record;
  if (!open) return record;
  return { ...rest, line: [...open.members.map(asChange), ...record.line] };
}

/** Drop what only closed tasks still hold: a merged receipt once read, a left-out note. */
export function pruned(record: BatchRecord, live: (taskId: string) => boolean): BatchRecord {
  const receipts = record.receipts.filter((entry) => live(entry.taskId));
  const leftOut = record.leftOut.filter((entry) => live(entry.taskId));
  return receipts.length === record.receipts.length && leftOut.length === record.leftOut.length
    ? record
    : { ...record, receipts, leftOut };
}
