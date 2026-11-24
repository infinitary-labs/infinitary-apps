import type { Scenario } from "../mockProvider";

/**
 * A short conversation with one card in it (docs/composer.md "The
 * conversation"): the first mate answers the backlog question with a note
 * and a reply line, and the reminder with a salute and a reply line, so the
 * conversation holds two messages, their replies and the note the captain
 * pressed Got it on, in plain words a person would use.
 */
export const BACKLOG_ASK = "can a panel chart my backlog each week?";
export const BACKLOG_CARD_TITLE = "Your backlog chart";
export const BACKLOG_REPLY = "Yes. The chart is on a card for you to look at.";
export const REMINDER_ASK = "remind me to check usage on Friday";
export const REMINDER_REPLY = "Done. I will remind you on Friday morning.";

export const conversationRounds: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (latestUserTail.includes(BACKLOG_ASK)) {
      return hasToolResults
        ? { text: BACKLOG_REPLY }
        : {
            calls: [
              {
                name: "emit_card",
                args: {
                  title: BACKLOG_CARD_TITLE,
                  body: "<p>A weekly bar chart of your open tasks, on its own panel.</p>",
                },
              },
            ],
          };
    }
    if (latestUserTail.includes(REMINDER_ASK)) {
      return hasToolResults
        ? { text: REMINDER_REPLY }
        : { calls: [{ name: "emote", args: { emote: "salute" } }] };
    }
    return undefined;
  };
