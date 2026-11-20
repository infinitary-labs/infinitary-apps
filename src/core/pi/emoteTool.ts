import { type AgentEmote, FIRSTMATE_EMOTES } from "@shared/emotes";
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
 * The emote is motion only (INF-772's plan, the captain's "drop them"): it
 * carries no words. What the captain should know about what happened
 * (FI3-798) is the turn's closing sentence, which becomes the reply line
 * beside the captain's message (core orchestrator/replyLine.ts).
 */
export function createEmoteTool(request: (emote: FirstmateEmote) => void) {
  return boundTool({
    name: EMOTE_TOOL_NAME,
    label: "Emote",
    description: [
      "One brief, motion-only first mate emote: greet - hello; celebrate - good news; ponder - thinking;",
      "confused - something went wrong; fidget - idle play. Reply emotes play as your turn ends:",
      "nod - got it, instruction understood; salute - on it, work sent out; tick - all set,",
      "a change you made; tuck - noted, something kept; aww - captain's thanks or praise, any time.",
      "On a captain turn the app already nods, tucks or ticks for a steer, note or personalize.",
    ].join(" "),
    parameters: Type.Object({
      emote: stringEnum(FIRSTMATE_EMOTES, {
        description: "The supported character emote to perform",
      }),
    }),
    run: async (params) => {
      request(params.emote);
      return { text: `Emote requested: ${params.emote}` };
    },
  });
}
