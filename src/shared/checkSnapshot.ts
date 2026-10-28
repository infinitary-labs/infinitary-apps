import { z } from "zod";
import type { FactDotState } from "./factDot";

/** Reported check states, shared by the forge reader and every displayed fact. */
export const checkStateSchema = z.enum([
  "success",
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "skipped",
  "neutral",
  "pending",
]);
export type ForgeCheckState = z.infer<typeof checkStateSchema>;

const RED_STATES = new Set<ForgeCheckState>([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);
export function isRedCheckState(state: ForgeCheckState): boolean {
  return RED_STATES.has(state);
}

/** One current reading, not the crew's judgment or a second history. */
export const checkSnapshotSchema = z.object({
  headSha: z.string(),
  items: z.array(z.object({ name: z.string(), state: checkStateSchema })),
  complete: z.boolean().optional(),
  /** Why part of this reading could not be obtained, not a sign-out inference. */
  problem: z.string().optional(),
  absenceDeclared: z.boolean(),
});
export type CheckSnapshot = z.infer<typeof checkSnapshotSchema>;
const STATE_WORDS: Record<ForgeCheckState, string> = {
  success: "passed",
  failure: "failed",
  error: "error",
  cancelled: "cancelled",
  timed_out: "timed out",
  action_required: "needs a decision",
  startup_failure: "did not start",
  stale: "out of date",
  skipped: "skipped",
  neutral: "neutral",
  pending: "running",
};

export const CHECKS_NOT_REPORTED_WORDS = "none reported";
export const CHECKS_ABSENT_WORDS = "no checks";

/** Display-only tally of reported facts; never a readiness or merge decision. */
export function checkSnapshotSummary(reading: CheckSnapshot): {
  overall: "green" | "red" | "pending" | "none";
  words: string;
  dot: FactDotState;
  problem?: string;
} {
  const problem = reading.problem ? { problem: reading.problem } : {};
  const incomplete = reading.complete === false || Boolean(reading.problem);
  const unknownWords = reading.problem
    ? `cannot read all checks: ${reading.problem}`
    : "reading incomplete";
  if (reading.items.length === 0) {
    const absent = reading.absenceDeclared && !incomplete;
    return {
      ...problem,
      overall: absent ? "none" : "pending",
      words: absent ? CHECKS_ABSENT_WORDS : incomplete ? unknownWords : CHECKS_NOT_REPORTED_WORDS,
      dot: absent ? "idle" : reading.problem ? "warn" : "running",
    };
  }
  const counts = new Map<ForgeCheckState, number>();
  for (const check of reading.items) counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
  const words =
    [...counts]
      .map(([state, count]) =>
        reading.items.length === 1 ? STATE_WORDS[state] : `${count} ${STATE_WORDS[state]}`,
      )
      .join(" · ") + (incomplete ? ` · ${unknownWords}` : "");
  if (reading.items.some((check) => isRedCheckState(check.state)))
    return { ...problem, overall: "red", words, dot: "failed" };
  if (incomplete || counts.has("pending"))
    return { ...problem, overall: "pending", words, dot: reading.problem ? "warn" : "running" };
  if (counts.has("neutral")) return { overall: "pending", words, dot: "warn" };
  return { overall: "green", words, dot: "ok" };
}

/** A cached reading never describes a different version. */
export function currentCheckSummary(delivery: {
  checks?: CheckSnapshot;
  headSha?: string;
}): ReturnType<typeof checkSnapshotSummary> | undefined {
  const reading = delivery.checks;
  if (!reading) return undefined;
  if (delivery.headSha && delivery.headSha !== reading.headSha)
    return { overall: "pending", words: "not read for this version", dot: "idle" };
  return checkSnapshotSummary(reading);
}
/** Existing merge-check status from facts, not a separate judgment of the work. */
export function currentCheckStatus(
  delivery:
    | {
        ci?: "green" | "red" | "pending" | "no-pr" | "merged";
        checks?: CheckSnapshot;
        headSha?: string;
      }
    | null
    | undefined,
): "green" | "red" | "pending" | "no-pr" | "merged" | undefined {
  if (!delivery) return undefined;
  if (delivery.ci === "no-pr" || delivery.ci === "merged") return delivery.ci;
  const summary = currentCheckSummary(delivery);
  // Declared absence satisfies the check condition; the visible fact remains "no checks".
  return summary ? (summary.overall === "none" ? "green" : summary.overall) : delivery.ci;
}
