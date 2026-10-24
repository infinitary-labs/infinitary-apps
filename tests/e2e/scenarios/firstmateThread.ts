import {
  FM_THREAD_CARD_TITLE,
  type Scenario,
  THREAD_PROSE_REPLY,
  THREAD_REVISE_REPLY,
} from "../mockProvider";

/**
 * Cards as threads, phase 2: a Firstmate-authored card. The captain's
 * reply is a captain TURN about that card (not a crewmate steer). The
 * Firstmate revises under the same id, or its closing words land as
 * prose in the thread - it has no reply tool. The captain's two replies
 * are the crewmate thread's, in the shared stand-in.
 */
export const FM_THREAD_PROMPT_MARKER = "keep a firstmate thread open";
export const FM_THREAD_CARD_REVISED_TITLE = "Lead with the caption, not the chips";
export const FM_THREAD_REVISE_ANSWER = "Good catch; the card now leads with the caption.";
export const FM_THREAD_PROSE_ANSWER = "The chips stay; the caption is the first thing you read.";

/**
 * The first mate's own card, and its answers to the captain's replies
 * about it. Asked before the first-run wake: a coalesced captain turn
 * carries that wake, and the captain's words outrank it. Revise and prose
 * require the about line so thread-activity excerpts of earlier replies
 * cannot steal the prompt.
 */
export const firstmateThread: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes("about: card") && latestUserTail.includes(THREAD_REVISE_REPLY)) {
      const aboutCardId =
        latestUserTail.match(/about: card (card-[\w-]+)/)?.[1] ?? "fm-thread-card";
      // The revision lands at once: the body frame the thread's opening
      // just remounted is swapped while its first document still loads.
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: aboutCardId.startsWith("card-fm-") ? aboutCardId : "fm-thread-card",
              reply: FM_THREAD_REVISE_ANSWER,
              title: FM_THREAD_CARD_REVISED_TITLE,
              body: '<p>Lead with the caption, not the chips.</p><p>The chips stay underneath once the caption has said what this is.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
              actions: [
                { id: "chips-first", label: "Keep the chips first" },
                { id: "caption-first", label: "Lead with the caption", default: true },
              ],
              standalone: true,
            },
          },
        ],
      };
    }
    if (latestUserTail.includes("about: card") && latestUserTail.includes(THREAD_PROSE_REPLY)) {
      return { text: FM_THREAD_PROSE_ANSWER };
    }
    if (latestUserTail.includes(FM_THREAD_PROMPT_MARKER)) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "fm-thread-card",
              title: FM_THREAD_CARD_TITLE,
              body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
              actions: [
                { id: "chips-first", label: "Lead with the chips" },
                { id: "caption-first", label: "Lead with the caption", default: true },
              ],
              standalone: true,
            },
          },
        ],
      };
    }
    return undefined;
  };
