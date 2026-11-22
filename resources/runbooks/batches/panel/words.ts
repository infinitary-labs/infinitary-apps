import type { PanelBatchRepo, PanelTaskRow } from "@infinitary/contracts";
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

/**
 * Who has a held batch's next step (docs/forge.md, "A held batch"): the crew
 * while its repair works or a rerun passed, the captain while that repair
 * waits on a card of theirs or a setting refuses the merge, a rule, or no
 * one. A copy of `batchHoldState` in src/shared/batches.ts, since a panel
 * imports only its own files; a test holds the two equal.
 */
export type HoldState =
  | "repairing"
  | "own"
  | "fixing"
  | "sent-back"
  | "passed"
  | "approve"
  | "card"
  | "setting"
  | "rule"
  | "none";

/** The facts `holdState` reads, as `BatchHoldFacts` names them. */
export type HoldFacts = {
  reason: "checks" | "merge-way" | "rules";
  repair: { own: boolean; fixing: boolean } | null;
  awaitsFix: boolean;
  passed: boolean;
  task: { status: string; waitingCardId: string | null; waitingCardMerges?: boolean } | null;
};

export function holdState(facts: HoldFacts): HoldState {
  if (facts.reason === "merge-way") return "setting";
  if (facts.reason === "rules") return "rule";
  if (facts.passed) return "passed";
  const { repair, task } = facts;
  if (!repair || task?.status === "done" || task?.status === "dropped") return "none";
  if (task?.waitingCardId) return task.waitingCardMerges ? "approve" : "card";
  if (facts.awaitsFix) return "sent-back";
  if (repair.fixing) return "fixing";
  return repair.own ? "own" : "repairing";
}

/** Whether the crew has the hold, so nothing is asked of the captain. */
export function crewHolds(state: HoldState): boolean {
  return (
    state === "repairing" ||
    state === "own" ||
    state === "fixing" ||
    state === "sent-back" ||
    state === "passed"
  );
}

/** An open batch's hold state, reading its repair's row from the board; null while it is not held. */
export function holdOf(open: Open, rows: readonly PanelTaskRow[] | null): HoldState | null {
  if (!open.hold) return null;
  const repair = open.repair;
  const row = repair ? rows?.find((task) => task.id === repair.taskId) : undefined;
  return holdState({
    reason: open.hold.reason,
    repair,
    awaitsFix: open.awaitsFix,
    passed: open.passed,
    task: row
      ? {
          status: row.status,
          waitingCardId: row.waitingCardId,
          ...(row.waitingCardMerges ? { waitingCardMerges: true } : {}),
        }
      : null,
  });
}

/** Whether the captain's next step is in Settings: a setting, a rule or no repair. */
export function answersInSettings(state: HoldState | null): boolean {
  return state === "setting" || state === "rule" || state === "none";
}

/** Whether a hold's sentence names its repair by key. */
export function namesRepair(state: HoldState): boolean {
  return crewHolds(state) ? state !== "passed" : state === "approve" || state === "card";
}

/** The dot's tone for a state, and for a hold who has it. */
export function toneOf(open: Open, hold: HoldState | null = null): "busy" | "danger" | "warn" | "ok" | "idle" {
  const state = stateOf(open);
  if (state === "held") {
    const held = hold ?? (open.hold?.reason === "checks" ? "none" : "rule");
    if (crewHolds(held)) return "busy";
    return held === "none" ? "danger" : "warn";
  }
  if (state === "combining" || state === "opening") return "idle";
  return "busy";
}

/** A held batch's sentence: who has the hold, with the repair's key where `{key}` stands. */
export function holdSentence(open: Open, hold: HoldState): string {
  const key = open.repair ? taskName(open.repair) : "";
  switch (hold) {
    case "repairing":
      return m.batchesPanelWhoRepairing({ key });
    case "own":
      return m.batchesPanelWhoOwn({ key });
    case "fixing":
      return m.batchesPanelWhoFixing({ key });
    case "sent-back":
      return m.batchesPanelWhoSentBack({ key });
    case "passed":
      return m.batchesPanelWhoPassed();
    case "approve":
      return m.batchesPanelWhoApprove({ key });
    case "card":
      return m.batchesPanelWhoCard({ key });
    case "setting":
      return open.hold?.detail ? m.batchesPanelWhoRefused() : m.batchesPanelWhoNoWay();
    case "rule":
      return m.batchesPanelWhoRule();
    case "none":
      return m.batchesPanelWhoNone();
  }
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

/**
 * The open batch's short state, with how long it has held it: `checking 49m`;
 * a hold says who has it: `repairing 5m`, `needs you 5m`, `held 5m`.
 */
export function stateShort(open: Open, now: number, hold: HoldState | null = null): string {
  switch (stateOf(open)) {
    case "held": {
      const duration = took(now - (open.hold?.at ?? now));
      if (hold === "passed") return m.batchesPanelRerunPassed();
      if (hold && crewHolds(hold)) return m.batchesPanelRepairing({ duration });
      if (hold === "approve" || hold === "card" || hold === "setting")
        return m.batchesPanelNeedsYou({ duration });
      return m.batchesPanelHeld({ duration });
    }
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
