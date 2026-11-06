import {
  SKIP_RULES_CARD_TITLE,
  SKIP_RULES_MERGE_MARKER,
  SKIP_RULES_MERGED_WAKE,
  SKIP_RULES_PULL,
} from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * FI3-1571 piece 2: the crewmate prepares the adopted release pull request
 * as a merge past the rules at the version read, then asks on a card; after
 * the click, the same review on a revised card sends nothing again.
 */
export const skipRules: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (latestUserTail.includes(SKIP_RULES_MERGE_MARKER)) {
      const { results } = sinceLastUser(body);
      const review = results[0]?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
      if (!results.length) {
        return {
          calls: [
            {
              name: "check_change",
              args: {
                pull: SKIP_RULES_PULL.number,
                skipRules: { headSha: SKIP_RULES_PULL.headSha, method: "squash" },
              },
            },
          ],
        };
      }
      if (results.length === 1 && review) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "release-past-rules",
                title: SKIP_RULES_CARD_TITLE,
                body: "<p>The release pull request waits on a code owner's review, and one check failed.</p><p>Your account may skip both, so I prepared the merge at the version I read.</p>",
                actions: [
                  { id: "merge", effect: { kind: "request_merge", review } },
                  { id: "not-now", label: "Not now" },
                ],
              },
            },
          ],
        };
      }
      if (results.length <= 2) {
        return {
          calls: [
            {
              name: "report",
              args: {
                text: results.join("\n"),
                summary: "The release merge past the rules is on a card for the captain.",
              },
            },
          ],
        };
      }
      return { text: "The release merge is waiting on the captain." };
    }
    if (latestUserTail.includes(SKIP_RULES_MERGED_WAKE)) {
      const { results } = sinceLastUser(body);
      const review = body.match(/Merge review (mr[0-9a-f]+)/)?.[1] ?? "";
      if (!results.length) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "release-past-rules",
                title: SKIP_RULES_CARD_TITLE,
                body: "<p>Asking again for the same merge.</p><p>I want to be sure the release went in at the version I read.</p>",
                actions: [
                  { id: "merge", effect: { kind: "request_merge", review } },
                  { id: "not-now", label: "Not now" },
                ],
              },
            },
          ],
        };
      }
      if (results.length === 1) {
        return {
          calls: [
            {
              name: "report",
              args: {
                text: `Asking again: ${results[0]}`,
                summary: "The release pull request merged past its rules.",
              },
            },
          ],
        };
      }
      return { text: "The release merged." };
    }
    return undefined;
  };
