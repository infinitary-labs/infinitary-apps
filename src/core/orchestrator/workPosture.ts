import type { AccountHold, WorkPosture } from "@shared/workPosture";
import type { TaskRecord } from "../storage/taskStore";
import type { Witnesses } from "./reportSort";

/** The live facts a posture reads; gathering them reads the database and the card stack. */
export type PostureFacts = Witnesses & {
  turnRunning: boolean;
  liveJobs: boolean;
  clientJobs: number | undefined;
  observable: boolean;
  blocked: boolean;
  /** The typed cut-off behind `accountHeld`, as the waiting line names it. */
  hold?: AccountHold;
};

/**
 * Unlike supervision, live jobs outrank a question and have no inspection bound.
 * Only active work has a live posture, so `gather` runs for active work alone:
 * every other row - most of a long record - is inactive without a fact read.
 */
export function deriveWorkPosture(record: TaskRecord, gather: () => PostureFacts): WorkPosture {
  if (record.status !== "active") return { state: "idle", reason: "inactive" };
  const facts = gather();
  if (facts.turnRunning) return { state: "active", reason: "turn" };
  if (facts.liveJobs || (facts.clientJobs ?? 0) > 0) return { state: "active", reason: "job" };
  if (facts.pendingSettle) return { state: "active", reason: "settlement" };
  // A held lane is not evidence that its queued delivery can proceed.
  if (facts.accountHeld || record.gate?.kind === "quota-reset")
    return {
      state: "paused",
      reason: "access",
      ...(facts.accountHeld && facts.hold ? { hold: facts.hold } : {}),
    };
  if (facts.checksWatched) return { state: "active", reason: "checks" };
  if (facts.deliverable || facts.threadAwaitingAuthor)
    return { state: "active", reason: "guidance" };
  if (facts.timedWait && Number.isFinite(record.gate?.until))
    return { state: "active", reason: "timed-wait" };
  if (facts.decisionCardOpen || facts.captainGateOwed) return { state: "idle", reason: "captain" };
  // A blocks edge holding its close, or a wait it declared on other work
  // (FI3-671, FI3-250): either way it waits on another task.
  if (facts.blocked || facts.waitsOnUnderway || facts.waitsOnUnstarted)
    return { state: "idle", reason: "dependency" };
  if (!facts.observable && facts.clientJobs === undefined)
    return { state: "unknown", reason: "unobserved" };
  return { state: "idle", reason: "inactive" };
}
