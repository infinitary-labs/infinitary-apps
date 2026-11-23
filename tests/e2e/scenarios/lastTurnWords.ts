import { MOCK_FM_DONE_TEXT, type Scenario } from "../mockProvider";

/**
 * Any captain turn carrying this phrase gets its closing line after its tool
 * calls only once MOCK_SLOW_CLOSE_MS has passed, the way a real model writes
 * its final hidden line after a tool result: the Firstmate's turn stays
 * open, so what happens mid-turn and what waits for the turn's end differ
 * observably (the reply emotes).
 */
export const SLOW_CLOSE_PROMPT_MARKER = "and take your time closing";

export const MOCK_SLOW_CLOSE_MS = 2_500;

/**
 * The reply line (docs/composer.md "The last turn"): the mock Firstmate
 * answers a turn carrying SALUTE_PROMPT_MARKER with one wordless salute, and
 * closes with MOCK_FM_DONE_TEXT, which becomes the turn's reply line. Beside
 * SLOW_CLOSE_PROMPT_MARKER the turn stays open after the call, so the
 * Firstmate's bubble works a while before the reply. A turn carrying
 * WORDLESS_CLOSE_PROMPT_MARKER closes with no words after its tool calls,
 * so the line is the app's typed fallback.
 */
export const SALUTE_PROMPT_MARKER = "salute me";

export const WORDLESS_CLOSE_PROMPT_MARKER = "and close without words";

export const lastTurnWords: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(SALUTE_PROMPT_MARKER)) {
      return { calls: [{ name: "emote", args: { emote: "salute" } }] };
    }
    if (hasToolResults && latestUserTail.includes(WORDLESS_CLOSE_PROMPT_MARKER)) {
      return { text: "" };
    }
    if (hasToolResults && latestUserTail.includes(SLOW_CLOSE_PROMPT_MARKER)) {
      return { text: MOCK_FM_DONE_TEXT, afterMs: MOCK_SLOW_CLOSE_MS };
    }
    return undefined;
  };
