import type { Scenario } from "../mockProvider";
import { answering } from "../providerRequest";

/**
 * A reply under a card shown while the first mate is down waits for it
 * (INF-6994's approved plan, piece 2). Once the seat serves again, the kept
 * reply reaches the first mate as a captain turn about that card, and the
 * scripted first mate answers in the card's thread, naming the captain's
 * message. The answer is held until the spec lets it go, so the spec can
 * see the card still up while the answer is owed.
 */
export const DOWN_CARD_REPLY = "is this reply kept while you are away";
export const DOWN_CARD_ANSWER = "I am back, and your reply waited for me.";

export function downCardReply(title: string): Scenario {
  return () =>
    ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
      if (!isFirstmate || !wantsStream || !latestUserTail.includes(DOWN_CARD_REPLY)) {
        return undefined;
      }
      const about = latestUserTail.match(/about: card (card-fm-[\w-]+)/)?.[1];
      if (!about) return undefined;
      if (hasToolResults) return { text: "Answered under the card." };
      const named = answering(latestUserTail).answers_message;
      return {
        threadHeld: [
          {
            name: "emit_card",
            args: {
              id: about,
              title,
              reply: DOWN_CARD_ANSWER,
              ...(named !== undefined ? { answers_message: named } : {}),
            },
          },
        ],
      };
    };
}
