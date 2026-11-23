import type { Scenario } from "../mockProvider";
import { answering, calledTool } from "../providerRequest";

/**
 * Saying you are done under an answer closes it (INF-2845, the captain's
 * direction A: "the crewmate marks a reply that says you are done, in any
 * words, as closing, and a seen answer is never asked for again").
 *
 * The first mate starts an answer task; its crewmate shows one answering
 * decision. A captain's line under that card reaches the crewmate as a thread
 * steer: the scripted crewmate first tries the mark on an interim line, which
 * the host refuses, then marks its real line.
 * Whether the words say "done" is a real model's judgment; the scripted one
 * only needs a needle, and the captain's line is it.
 */
export const SIGN_OFF_PROMPT_MARKER = "answer and wait for my word:";
export const SIGN_OFF_CARD_TITLE = "Three of the four plans can be built now";
export const SIGN_OFF_LEAVE_LABEL = "Leave them for now";
/** The captain's closing line, worded with no phrase the host could look for. */
export const SIGN_OFF_CAPTAIN_LINE = "i'll take it from here";
export const SIGN_OFF_CREWMATE_LINE = "Understood; nothing more is needed from me.";

export const threadSignOff: Scenario = () => {
  return ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (hasToolResults || !latestUserTail.includes(SIGN_OFF_PROMPT_MARKER)) return undefined;
      const title =
        latestUserTail.match(/answer and wait for my word: ([^"\\]+)/)?.[1]?.trim() ?? "Plans";
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title,
              goal: `Find out ${title} and answer it.`,
              user_words: `${SIGN_OFF_PROMPT_MARKER} ${title}`,
              constraints: [{ kind: "read-only" }],
            },
          },
        ],
      };
    }
    if (!body.includes(SIGN_OFF_PROMPT_MARKER)) return undefined;
    if (hasToolResults) return { text: "Waiting on the captain." };
    const cardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "missing";
    if (latestUserTail.includes(SIGN_OFF_CAPTAIN_LINE)) {
      const named = answering(latestUserTail);
      return {
        calls: [
          {
            name: "reply",
            args: {
              card_id: cardId,
              text: "Checking.",
              interim: true,
              signs_off: true,
              ...named,
            },
          },
          {
            name: "reply",
            args: { card_id: cardId, text: SIGN_OFF_CREWMATE_LINE, signs_off: true, ...named },
          },
        ],
      };
    }
    if (calledTool(body, "emit_card")) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: SIGN_OFF_CARD_TITLE,
            body: "<p>Three plans touch nothing the restructure moves; the fourth moves the card store.</p>",
            answering: true,
            actions: [
              { id: "leave", label: SIGN_OFF_LEAVE_LABEL },
              { id: "build-three", label: "Build the three clear plans now", default: true },
            ],
          },
        },
        {
          name: "report",
          args: { text: "Three of the four plans are clear; the card says which." },
        },
      ],
    };
  };
};
