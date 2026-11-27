import type { Rigor } from "@shared/rigor";
import type { TaskDelivery } from "../storage/taskRecords";
import { reviewCoversHead } from "./reviewCarry";

/** The committed version of Careful work that waits for its independent review. */
export type CarefulReviewOwed = { head: string };

/** The version a Careful builder's branch held commits of its own at, and when its report read it. */
export type CommittedVersion = { head: string; at: number };

/**
 * Careful work committed with no review open (INF-7116 fix 3): the task's
 * rigor is Careful, its branch held commits of its own at the version its
 * last report read, no passed review covers that version and no review of
 * the task is open. The host starts no Careful review by itself, so only
 * the first mate can start one; this is the typed fact that wakes it. A
 * review task reads a change and owes no review of its own.
 *
 * A review started or a verdict recorded since that read judges a later
 * version than the kept one, so the kept version owes nothing until the
 * next report reads it again: fix rounds that end in closing text never
 * refresh it.
 */
export function carefulReviewOwed(input: {
  rigor: Rigor | undefined;
  kind: string | undefined;
  committed: CommittedVersion | undefined;
  reviewOpen: boolean;
  /** When the latest review of the task started, closed ones included. */
  reviewStartedAt: number | undefined;
  delivery: TaskDelivery | null | undefined;
}): CarefulReviewOwed | undefined {
  const { committed } = input;
  if (input.rigor !== "reviewed" || input.kind === "review") return undefined;
  if (!committed || input.reviewOpen) return undefined;
  const reviewedAt = input.delivery?.reviewedAt;
  if (reviewedAt !== undefined && reviewedAt >= committed.at) return undefined;
  if (input.reviewStartedAt !== undefined && input.reviewStartedAt >= committed.at)
    return undefined;
  if (reviewCoversHead(input.delivery, committed.head)) return undefined;
  return { head: committed.head };
}
