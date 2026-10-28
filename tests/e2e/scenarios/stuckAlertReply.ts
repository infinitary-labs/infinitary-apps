import type { Scenario } from "../mockProvider";

/** The captain's question under the stuck alert, in their own words (INF-1670). */
export const STUCK_ALERT_QUESTION = "is it stuck because the secret PR hasn't landed yet?";

/** The first mate's answer, its turn's closing words. */
export const STUCK_ALERT_ANSWER =
  "Yes. It waits on the secrets change, which waits on your merge of its pull request.";

/**
 * The first mate answers a reply under the host's stuck alert in prose: the
 * host wrote the card, so the turn's closing words are the answer in its
 * thread. It needs the about line naming that alert, so no other turn takes it.
 */
export const stuckAlertReply: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes("about: card card-stall-")) return undefined;
    if (!latestUserTail.includes(STUCK_ALERT_QUESTION)) return undefined;
    return { text: STUCK_ALERT_ANSWER };
  };
