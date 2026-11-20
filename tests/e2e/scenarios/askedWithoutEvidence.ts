import type { Scenario } from "../mockProvider";
import { latestServedTurn, sinceLastUser } from "../providerRequest";

/**
 * INF-5355's review, scenario-action-signals: the first mate calls an asked
 * line - show-task or show-settings - with no words of the captain's as its
 * evidence. Asked with `ASKED_WITHOUT_EVIDENCE_MARKER` and the call's JSON
 * (`{ action, value }`) on the same line, it makes that one call with blank
 * evidence, then ends its turn; the journey reads that nothing moved.
 */
export const ASKED_WITHOUT_EVIDENCE_MARKER = "point without my words ";
const DONE = "I did not open it.";

export const askedWithoutEvidence: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(ASKED_WITHOUT_EVIDENCE_MARKER))
      return undefined;
    if (sinceLastUser(body).results.length > 0) return { text: DONE };
    const input =
      latestServedTurn(body)?.segments.findLast((part) =>
        part.body.includes(ASKED_WITHOUT_EVIDENCE_MARKER),
      )?.body ?? "";
    const json = input
      .slice(
        input.lastIndexOf(ASKED_WITHOUT_EVIDENCE_MARKER) + ASKED_WITHOUT_EVIDENCE_MARKER.length,
      )
      .split("\n")[0];
    return {
      calls: [{ name: "app_change", args: { ...JSON.parse(json ?? "{}"), evidence: " " } }],
    };
  };
