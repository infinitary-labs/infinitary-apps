import type { Scenario } from "../mockProvider";
import { answering } from "../providerRequest";

/** The captain's question under the stuck alert, in their own words (INF-1670). */
export const STUCK_ALERT_QUESTION = "is it stuck because the secret PR hasn't landed yet?";

/** The first mate's answer, the reply it writes on the alert. */
export const STUCK_ALERT_ANSWER =
  "Yes. It waits on the secrets change, which waits on your merge of its pull request.";

/**
 * The first mate answers a reply under the host's stuck alert: the host
 * wrote the card, so its emit_card on the alert's id writes only its reply,
 * naming the captain's message, since closing words alone leave the
 * question open (the captain's "Only a line that says it answers it"). It
 * needs the about line naming that alert, so no other turn takes it.
 */
export const stuckAlertReply: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    const alert = latestUserTail.match(/about: card (card-stall-[\w-]+)/)?.[1];
    if (!alert) return undefined;
    if (!latestUserTail.includes(STUCK_ALERT_QUESTION)) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            id: alert,
            title: "Stuck task",
            body: "<p>The alert stays as the app wrote it.</p>",
            reply: STUCK_ALERT_ANSWER,
            ...answering(latestUserTail),
          },
        },
      ],
    };
  };
