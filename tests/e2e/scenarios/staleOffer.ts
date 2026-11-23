import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/**
 * Card evidence (docs/card-evidence.md, "The stage"): a crewmate that puts
 * its card up with its report, then revises the same card in the same turn
 * and keeps working, held until the spec releases it or the app closes. The
 * stage keeps showing the first offer while the stored head is the second,
 * so a click on the stage chooses from an offer the card row no longer holds.
 */
export const STALE_OFFER_PROMPT_MARKER = "revise the offer after reporting";

export const STALE_OFFER_TITLE = "Retry on the queue flush";

export const STALE_OFFER_REVISED_TITLE = "Retry on the clock instead";

export const STALE_OFFER_CHOICE_LABEL = "Retry on the flush";
export const STALE_OFFER_CHOICE_ID = "retry-flush";
/** A line of the first offer's body: card words a count-only export never prints. */
export const STALE_OFFER_BODY_LINE =
  "Ten runs in a row passed with the retry waiting on the flush.";

export const staleOffer: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream) return undefined;
    if (!isFirstmate && body.includes(STALE_OFFER_PROMPT_MARKER) && wantsStream) {
      if (latestUserTail.includes("the user chose")) {
        return { text: "Retrying on the queue flush, as chosen." };
      }
      if (!calledTool(latestUserTail, "emit_card")) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "stale-offer",
                title: STALE_OFFER_TITLE,
                body: `<p>Retrying on the queue flush removes the race.</p><p>${STALE_OFFER_BODY_LINE}</p>`,
                actions: [
                  { id: STALE_OFFER_CHOICE_ID, label: STALE_OFFER_CHOICE_LABEL, default: true },
                  { id: "leave-it", label: "Leave it as it is" },
                ],
              },
            },
          ],
        };
      }
      if (!calledTool(latestUserTail, "report")) {
        return {
          calls: [
            {
              name: "report",
              args: { text: "The retry card is up; checking the clock path next." },
            },
          ],
        };
      }
      if (!latestUserTail.includes(STALE_OFFER_REVISED_TITLE)) {
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "stale-offer",
                title: STALE_OFFER_REVISED_TITLE,
                body: "<p>Retrying on the clock is simpler than waiting on the flush.</p><p>The clock path passed the same ten runs.</p>",
                actions: [
                  { id: "retry-clock", label: "Retry on the clock", default: true },
                  { id: "leave-it", label: "Leave it as it is" },
                ],
              },
            },
          ],
        };
      }
      return { held: true };
    }
    return undefined;
  };
