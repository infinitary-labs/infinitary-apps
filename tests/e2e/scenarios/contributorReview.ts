import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

export const CONTRIBUTOR_REVIEW_MARKER = "review-the-contributor";
export const CONTRIBUTOR_REVIEW_TITLE = "Merge the reviewed contribution";
export const CONTRIBUTOR_PULL = 151;

/** Accepted contributor plan A: read code, prepare a version-bound review, then ask. */
export const contributorReview: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !latestUserTail.includes(CONTRIBUTOR_REVIEW_MARKER))
      return undefined;
    const { results } = sinceLastUser(body);
    if (results.length === 0)
      return {
        calls: [{ name: "bash", args: { command: "git show contribution -- feature.txt" } }],
      };
    if (results.length === 1)
      return { calls: [{ name: "check_change", args: { pull: CONTRIBUTOR_PULL } }] };
    const review = results
      .find((result) => result.includes("Merge review mr"))
      ?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
    if (results.length === 2 && review)
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "contributor-review",
              title: CONTRIBUTOR_REVIEW_TITLE,
              body: "<p>I read the contributor's change and its checks at this version.</p><p>Your merge click merges only this reviewed version.</p>",
              actions: [
                {
                  id: "merge",
                  effect: {
                    kind: "merge",
                    review,
                    after: "continue",
                    asks_first: "The captain decides whether reviewed contributor code merges.",
                  },
                },
              ],
            },
          },
        ],
      };
    return { text: "The contribution waits for the captain's merge click." };
  };
