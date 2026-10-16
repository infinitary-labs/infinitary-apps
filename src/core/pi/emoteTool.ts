import { type AgentEmote, EMOTE_WORDS_MAX, emoteWords, FIRSTMATE_EMOTES } from "@shared/emotes";
import { Type } from "typebox";
import { boundTool, stringEnum } from "../session/tools";

export { FIRSTMATE_EMOTES };
export type FirstmateEmote = AgentEmote;

export const EMOTE_TOOL_NAME = "emote";

/**
 * Request one supported character reaction. This is deliberately a visual
 * side channel: it neither creates a card nor changes task or consult state.
 * The reply emotes (nod, salute, tick, tuck, aww) stay callable here even
 * though the host fires nod, tuck and tick itself (FirstmateAgent): the
 * captain's call was that every emote is the agent's to use.
 *
 * `text` is the few words that, on a captain turn, become the reply line
 * beside the captain's message (FI3-622's plan, the captain's 40
 * characters; FI3-1089's plan for where they show), cleaned by the shared rule
 * (`emoteWords`). They are required (FI3-798, the captain: "it should
 * concisely express what the captain should know about what happened"), so
 * no words and words past the limit refuse the whole call alike: nothing is
 * requested, so nothing plays and the turn delivered nothing by it.
 */
export function createEmoteTool(request: (emote: FirstmateEmote, text: string) => void) {
  return boundTool({
    name: EMOTE_TOOL_NAME,
    label: "Emote",
    description: [
      "Make the first mate's character perform one brief emote with a few words. Use this for a",
      "fitting visible acknowledgement when no card is needed; it is visual only and does not",
      "replace required work or a card. greet: hello. celebrate: good news. ponder: thinking it",
      "over. confused: something went wrong. fidget: idle play. The reply emotes play as your",
      "turn ends: nod - got it, an instruction understood; salute - on it, work sent out; tick",
      "- all set, a change you made yourself; tuck - noted, something kept; aww - any time, the",
      "captain's thanks or praise. On a captain turn the app already nods for a steer you",
      "deliver, tucks for a note you keep and ticks for a personalize you apply.",
    ].join(" "),
    parameters: Type.Object({
      emote: stringEnum(FIRSTMATE_EMOTES, {
        description: "The supported character emote to perform",
      }),
      text: Type.String({
        description: `Plain words that may show beside the captain's message until the next reply or message, that concisely say what the captain should know about what happened, at most ${EMOTE_WORDS_MAX} characters; never an answer`,
      }),
    }),
    run: async (params) => {
      const words = emoteWords(params.text);
      if (words.kind === "too-long") {
        return {
          text: `Refused: the words are ${words.length} characters; keep them to ${EMOTE_WORDS_MAX} or fewer. Nothing was shown.`,
        };
      }
      if (words.kind === "none") {
        return {
          text: `Refused: an emote needs words that say what the captain should know about what happened, at most ${EMOTE_WORDS_MAX} characters. Nothing was shown.`,
        };
      }
      request(params.emote, words.text);
      return { text: `Emote requested: ${params.emote}, with the words "${words.text}"` };
    },
  });
}
