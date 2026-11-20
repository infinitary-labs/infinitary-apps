import type { LiveValidation } from "../../src/shared/liveValidation";

/** Existing review-lifecycle fixtures use empty branches, not a running product.
 * INF-125 adds proof as a prerequisite without weakening those lifecycle assertions.
 * Behavioral proof and permission refusals are exercised by liveValidation.test.ts and the host tests.
 */
export function noSurfaceProof(
  head: string,
  reviewer = "fixture-reviewer",
  reason?: string,
): LiveValidation {
  return {
    scenarioRevision: 1,
    scenarios: [],
    plans: [
      {
        revision: 1,
        reason: reason ?? "The lifecycle fixture's branch contains no running product.",
        scenarios: [],
        at: 1,
      },
    ],
    runs: [
      {
        kind: "run",
        id: "empty-branch",
        head,
        scenarioRevision: 1,
        revision: 1,
        deviceId: null,
        at: 2,
        completion: "complete",
        verdict: "no-surface",
        reason: reason ?? "This empty branch has no behavior to run.",
        observations: [],
        evidence: [],
      },
    ],
    reviews: [
      {
        kind: "review",
        head,
        revision: 1,
        code: "clear",
        coverage: "complete",
        coverageReason: reason ?? "No running surface exists in this lifecycle fixture.",
        effects: [],
        omitted: [],
        verdict: "no-surface",
        reason: reason
          ? `${reason} No live pass is claimed.`
          : "The reviewer accepts the empty branch's no-surface reason, not a live pass.",
        reviewer,
        scenarioRevision: 1,
        at: 3,
      },
    ],
    permissions: [],
  };
}
