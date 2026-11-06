import type { Scenario } from "../mockProvider";
import { answering } from "../providerRequest";

/** The first mate's seeded harbour note a reply waits under (stage-reveals.spec.ts). */
export const REPLYING_NOTE = "Reply under this harbour note";
export const REPLYING_NOTE_BODY = "<p>Answered next.</p>";
/** The captain's question under it, and the first mate's answer. */
export const REPLYING_QUESTION = "Which tide is this for?";
export const REPLYING_ANSWER = "The evening tide.";

/**
 * The first mate answers the captain's question under its own seeded note:
 * it resends the note unchanged with its answer as `reply`, naming the
 * captain's message, since its closing words alone leave the question open
 * (the captain's "Only a line that says it answers it"). It needs the about
 * line naming that note, so no other turn takes it.
 */
export const replyingNote: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes("about: card replying ")) return undefined;
    if (!latestUserTail.includes(REPLYING_QUESTION)) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            id: "replying",
            title: REPLYING_NOTE,
            body: REPLYING_NOTE_BODY,
            actions: [],
            reply: REPLYING_ANSWER,
            ...answering(latestUserTail),
            standalone: true,
          },
        },
      ],
    };
  };
