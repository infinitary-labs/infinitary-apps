import { MERGE_CONTINUED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedArgs } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * INF-2490, the declared close: a crewmate names pull requests as its task's
 * changes with check_change, offers a continuing merge with request_merge and
 * the finishing merge on its completion card. One crewmate, three shapes, each
 * from a case the plan named.
 */
export const DECLARED_CLOSE_MARKER = "merge the release then finish";
/** release-please's pull request, on a branch the task did not open (RUU-35). */
export const RELEASE_PULL = { number: 151, branch: "release-please--branches--main" } as const;
/** The pull request on the task's own branch. */
export const OWN_PULL = 56;
export const RELEASE_CARD_TITLE = "Merge the release pull request";
export const FINISH_CARD_TITLE = "The meter reads on the first paint";
/**
 * The first mate's steer in the `stale` shape: the crewmate checks the
 * task's own pull request after its finishing card went up for the release.
 */
export const STALE_STEER = "check the meter fix as well";

/**
 * - `two-pulls`: merge the release as a continuing change, then, once woken,
 *   name the task's own pull request and offer it as the finishing change.
 * - `release` (RUU-35): merge the release as a continuing change, and
 *   nothing more; the first mate closes the task.
 * - `taken-over` (INF-1539): the release is the task's only change, offered
 *   as the finishing change on the completion card.
 * - `stale` (INF-2546 R1): offer the release as the finishing change, then,
 *   once steered (`STALE_STEER`), check the task's own pull request, which
 *   makes it the current change while that card stays up.
 */
export type DeclaredCloseShape = "two-pulls" | "release" | "taken-over" | "stale";

const finishCard: ScriptedArgs<"emit_card"> = {
  title: FINISH_CARD_TITLE,
  body: completionCardBody(
    "<p>The meter read before its first paint.</p>",
    "<p>The meter waits for the first paint before it reads.</p>",
    "<p>The meter showed zero until the next refresh.</p>",
    "<p>The meter shows its reading on the first paint.</p>",
  ),
  actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
};

export function declaredClose(shape: DeclaredCloseShape): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (isFirstmate || !wantsStream) return undefined;
      const { results } = sinceLastUser(body);
      const review = results[0]?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
      if (shape === "stale" && latestUserTail.includes(STALE_STEER)) {
        if (!results.length) return { calls: [{ name: "check_change", args: { pull: OWN_PULL } }] };
        return { text: "The meter fix is checked too." };
      }
      // The continuing merge's outcome wakes the crewmate once.
      if (latestUserTail.includes(MERGE_CONTINUED_LEAD)) {
        if (shape !== "two-pulls")
          return { text: "The release merged; the task waits for the first mate to close it." };
        if (!results.length) return { calls: [{ name: "check_change", args: { pull: OWN_PULL } }] };
        if (results.length === 1 && review)
          return {
            calls: [
              { name: "emit_card", args: finishCard },
              {
                name: "report",
                args: { text: "The meter fix is ready to merge; it finishes the task." },
              },
            ],
          };
        return { text: "The finishing merge is offered." };
      }
      if (!latestUserTail.includes(DECLARED_CLOSE_MARKER)) return undefined;
      if (!results.length)
        return { calls: [{ name: "check_change", args: { pull: RELEASE_PULL.number } }] };
      if (results.length === 1 && review)
        return {
          calls:
            shape === "taken-over" || shape === "stale"
              ? [
                  { name: "emit_card", args: finishCard },
                  {
                    name: "report",
                    args: { text: "The release is ready to merge; it finishes the task." },
                  },
                ]
              : [
                  {
                    name: "emit_card",
                    args: {
                      title: RELEASE_CARD_TITLE,
                      body: "<p>release-please opened the release pull request.</p><p>Merging it publishes the release.</p>",
                      actions: [
                        { id: "merge", effect: { kind: "request_merge", review } },
                        { id: "not-now", label: "Not now" },
                      ],
                    },
                  },
                ],
        };
      return { text: "The merge is offered to the captain." };
    };
}
