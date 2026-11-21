import type { PanelBatchRepo } from "@infinitary/contracts";
import * as m from "./messages.generated";

/**
 * The Batches panel's words for a batch's state, its times and its counts,
 * from one owner for the rail and the details card.
 */

type Open = NonNullable<PanelBatchRepo["open"]>;

/** What the open batch is doing now. */
export type BatchState = "held" | "queued" | "combining" | "opening" | "checking";

export function stateOf(open: Open): BatchState {
  if (open.hold) return "held";
  if (open.queued) return "queued";
  if (open.stale) return "combining";
  if (open.number === null) return "opening";
  return "checking";
}

/** The dot's tone for a state, and for a hold its reason. */
export function toneOf(open: Open): "busy" | "danger" | "warn" | "ok" | "idle" {
  const state = stateOf(open);
  if (state === "held") return open.hold?.reason === "checks" ? "danger" : "warn";
  if (state === "combining" || state === "opening") return "idle";
  return "busy";
}

/** A span of time as the rail says it: `49m`, `1h 26m`. */
export function took(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60
    ? m.batchesPanelMinutes({ count: minutes })
    : m.batchesPanelHours({
        hours: String(Math.floor(minutes / 60)),
        minutes: String(minutes % 60),
      });
}

/** A clock time in the frame's language: `3:18 PM`. */
export function clock(at: number): string {
  const lang = (typeof document === "undefined" ? "" : document.documentElement.lang) || "en";
  return new Date(at).toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
}

/** The open batch's short state, with how long it has held it: `checking 49m`. */
export function stateShort(open: Open, now: number): string {
  switch (stateOf(open)) {
    case "held":
      return m.batchesPanelHeld({ duration: took(now - (open.hold?.at ?? now)) });
    case "queued":
      return m.batchesPanelInQueue();
    case "combining":
      return m.batchesPanelCombining();
    case "opening":
      return m.batchesPanelOpening();
    case "checking":
      return m.batchesPanelChecking({ duration: took(now - open.since) });
  }
}

/** The open batch's state in full words, for the details card. */
export function stateFull(open: Open): string {
  const hold = open.hold;
  if (hold) {
    const since = clock(hold.at);
    if (hold.reason === "rules") return m.batchesPanelHoldRules({ time: since });
    if (hold.reason === "merge-way")
      return hold.detail
        ? m.batchesPanelHoldRefused({ time: since, detail: hold.detail })
        : m.batchesPanelHoldMergeWay({ time: since });
    return m.batchesPanelHoldChecks({ time: since });
  }
  switch (stateOf(open)) {
    case "queued":
      return m.batchesPanelStateQueue();
    case "combining":
      return m.batchesPanelStateCombining();
    case "opening":
      return m.batchesPanelStateOpening();
    default:
      return m.batchesPanelStateChecking({ time: clock(open.since) });
  }
}

/** A batch's title: `Batch #1795 · 16 changes`, or a new one before its pull request. */
export function batchTitle(number: number | null, count: number): string {
  return number === null
    ? m.batchesPanelNewBatchTitle({ count })
    : m.batchesPanelBatchTitle({ number: String(number), count });
}

/** A task as a chip or a list names it: its key, or its title when it has no key. */
export function taskName(task: { key: string | null; title: string }): string {
  return task.key ?? task.title;
}

/** What a repository shows: anything in line, open, left out or ended in the last day. */
export function showsAny(repo: PanelBatchRepo): boolean {
  return (
    repo.line.length > 0 ||
    repo.open !== null ||
    repo.leftOut.length > 0 ||
    repo.finished.length > 0
  );
}

/** Why the changes in line wait, in short: the gap's next batch, or the open batch. */
export function waitShort(repo: PanelBatchRepo): string | undefined {
  if (repo.open?.number) return m.batchesPanelAfter({ number: String(repo.open.number) });
  if (repo.nextBatchAt !== null) return m.batchesPanelNext({ time: clock(repo.nextBatchAt) });
  return undefined;
}

/** Why one change in line waits, in full, for the details card. */
export function waitFull(repo: PanelBatchRepo, change: PanelBatchRepo["line"][number]): string {
  if (change.fix) return m.batchesPanelWaitsFix();
  if (change.afterKey) return m.batchesPanelWaitsAfter({ key: change.afterKey });
  if (repo.open?.number) return m.batchesPanelWaitsBatch({ number: String(repo.open.number) });
  if (repo.nextBatchAt !== null) return m.batchesPanelWaitsGap({ time: clock(repo.nextBatchAt) });
  return m.batchesPanelWaitsNow();
}
