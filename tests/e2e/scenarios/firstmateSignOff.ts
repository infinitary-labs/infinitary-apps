import type { Scenario } from "../mockProvider";
import { answering } from "../providerRequest";

/**
 * Saying you are done under the first mate's own card answers the message it
 * was shown for (INF-6317 part 1, the captain's "figure out why it didn't
 * count the earlier card interactions as answer to my message").
 *
 * The first mate shows an answering decision for the captain's message. The
 * captain's line under it is a captain turn about that card: the scripted
 * first mate first puts the mark on a line naming a message the card does not
 * wait on, which the host refuses, then marks its real answer.
 * Whether the words say "done" is a real model's judgment; the scripted one
 * only needs a needle, and the captain's line is it.
 */
export const FM_SIGN_OFF_PROMPT_MARKER = "which repo holds the panels plan";
export const FM_SIGN_OFF_CARD_TITLE = "The panels plan is already in your project";
/** The captain's closing line, worded with no phrase the host could look for. */
export const FM_SIGN_OFF_CAPTAIN_LINE = "this card can close now";
export const FM_SIGN_OFF_ANSWER = "Closing it now; both panels pieces are being built.";

export const firstmateSignOff: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    const about = latestUserTail.match(/about: card (card-fm-[\w-]+)/)?.[1];
    if (about && latestUserTail.includes(FM_SIGN_OFF_CAPTAIN_LINE)) {
      if (hasToolResults) return { text: "Signed the card off." };
      const named = answering(latestUserTail).answers_message ?? 0;
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: about,
              title: FM_SIGN_OFF_CARD_TITLE,
              reply: "Closing it.",
              answers_message: named + 1,
              signs_off: true,
            },
          },
          {
            name: "emit_card",
            args: {
              id: about,
              title: FM_SIGN_OFF_CARD_TITLE,
              reply: FM_SIGN_OFF_ANSWER,
              answers_message: named,
              signs_off: true,
            },
          },
        ],
      };
    }
    if (hasToolResults || about || !latestUserTail.includes(FM_SIGN_OFF_PROMPT_MARKER)) {
      return undefined;
    }
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: FM_SIGN_OFF_CARD_TITLE,
            body: "<p>Both panels pieces are planned in your project already.</p>",
            answering: true,
            actions: [
              { id: "ok", label: "That's what I meant", default: true },
              { id: "other", label: "I meant other work", declines: true },
            ],
          },
        },
      ],
    };
  };
