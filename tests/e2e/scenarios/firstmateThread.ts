import { resolveFirstmateCardId } from "../../../src/core/pi/cardTool";
import type { ScriptedArgs } from "../../helpers/scriptedCalls";
import { FM_THREAD_CARD_TITLE } from "../crewCards";
import { THREAD_PROSE_REPLY, THREAD_REVISE_REPLY } from "../crewScripts";
import type { Scenario } from "../mockProvider";
import { answering, providerToolCalls } from "../providerRequest";

/**
 * Cards as threads, phase 2: a Firstmate-authored card. The captain's
 * reply is a captain TURN about that card (not a crewmate steer). The
 * Firstmate revises under the same id, or resends its latest version of
 * the card unchanged with its answer as `reply` - it has no reply tool, and
 * its closing words alone leave the captain's question open. Either answer
 * names the captain's message (the captain's "Only a line that says it
 * answers it"). Under a card it never wrote it has no version to resend,
 * so its answer is its closing words. The captain's two replies are the
 * crewmate thread's, in the shared stand-in.
 */
export const FM_THREAD_PROMPT_MARKER = "keep a firstmate thread open";
export const FM_THREAD_CARD_REVISED_TITLE = "Lead with the caption, not the chips";
export const FM_THREAD_REVISE_ANSWER = "Good catch; the card now leads with the caption.";
export const FM_THREAD_PROSE_ANSWER = "The chips stay; the caption is the first thing you read.";

/** The first mate's card as it first shows. */
const ORIGINAL_CARD = {
  title: FM_THREAD_CARD_TITLE,
  body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
  actions: [
    { id: "chips-first", label: "Lead with the chips" },
    { id: "caption-first", label: "Lead with the caption", default: true },
  ],
};

/** The card after the captain's words changed what it says. */
const REVISED_CARD = {
  title: FM_THREAD_CARD_REVISED_TITLE,
  body: '<p>Lead with the caption, not the chips.</p><p>The chips stay underneath once the caption has said what this is.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
  actions: [
    { id: "chips-first", label: "Keep the chips first" },
    { id: "caption-first", label: "Lead with the caption", default: true },
  ],
};

/** The card the about line names, as the id emit_card revises. */
function aboutId(served: string): string {
  const id = served.match(/about: card (card-[\w-]+)/)?.[1] ?? "fm-thread-card";
  return id.startsWith("card-fm-") ? id : "fm-thread-card";
}

/**
 * The first mate's own card, and its answers to the captain's replies
 * about it. Asked before the first-run wake: a coalesced captain turn
 * carries that wake, and the captain's words outrank it. Revise and prose
 * require the about line so thread-activity excerpts of earlier replies
 * cannot steal the prompt.
 */
export const firstmateThread: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (latestUserTail.includes("about: card") && latestUserTail.includes(THREAD_REVISE_REPLY)) {
      // The revision lands at once: the body frame the thread's opening
      // just remounted is swapped while its first document still loads.
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              ...REVISED_CARD,
              id: aboutId(latestUserTail),
              reply: FM_THREAD_REVISE_ANSWER,
              ...answering(latestUserTail),
            },
          },
        ],
      };
    }
    if (latestUserTail.includes("about: card") && latestUserTail.includes(THREAD_PROSE_REPLY)) {
      // Nothing on the card changes: its own latest emit of this card, read
      // from the conversation as a real model reads it, goes again with the
      // answer, keeping what that emit declared (holds_place among it).
      const about = latestUserTail.match(/about: card (card-[\w-]+)/)?.[1];
      const latest = providerToolCalls(body).findLast(
        (call) =>
          call.name === "emit_card" &&
          typeof call.args.id === "string" &&
          resolveFirstmateCardId(call.args.id) === about,
      );
      if (!latest) return { text: FM_THREAD_PROSE_ANSWER };
      // The conversation's own emit_card, whose arguments the tool's schema took.
      const {
        reply: _reply,
        answers_message: _named,
        ...card
      } = latest.args as ScriptedArgs<"emit_card">;
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              ...card,
              reply: FM_THREAD_PROSE_ANSWER,
              ...answering(latestUserTail),
            },
          },
        ],
      };
    }
    if (latestUserTail.includes(FM_THREAD_PROMPT_MARKER)) {
      return {
        calls: [{ name: "emit_card", args: { ...ORIGINAL_CARD, id: "fm-thread-card" } }],
      };
    }
    return undefined;
  };
