import type { PiModelRef } from "./routingEngine";

/**
 * Capability checking at routing time (redesign stage 1).
 *
 * A routed choice used to be a bare `{provider, id}` resolved only at
 * session creation. This module resolves the def BEFORE the choice is made
 * and skips a candidate the turn would not fit, with a reason that lands
 * in `routing_decisions`. `withHonestReasoning` stays underneath as the
 * data corrector.
 *
 * Image and context-window checks stay: they are about what the turn
 * sends, not about rank. The high-slot reasoning skip is gone (captain,
 * 2026-09-10): trust the placement fully. A def that cannot take a
 * reasoning parameter is still honest underneath - `withHonestReasoning`
 * never sends a parameter the def rejects.
 *
 * There is deliberately NO failure ledger.
 */

/** What a candidate model's own def says it can carry. */
export type ModelCapability = {
  /**
   * Whether the def can take a reasoning/thinking parameter, as corrected by
   * `withHonestReasoning` - never the raw catalog claim.
   */
  reasoning: boolean;
  /** Input modalities the def declares. */
  input: ReadonlyArray<string>;
  /** Total context window, in tokens. */
  contextWindow: number;
};

/**
 * Resolves a routed ref to its def. Returns undefined for a model no Pi
 * runtime knows - a Claude model served by its own first-party client, or a custom models.json entry. Unknown is NOT a miss: those
 * backends manage their own request shape, and refusing what we cannot read
 * would silently empty the pool.
 */
export type ModelCapabilityLookup = (ref: PiModelRef) => ModelCapability | undefined;

/** What the turn about to run will actually send. */
export type TurnNeeds = {
  images?: boolean;
  contextTokens?: number;
};

/**
 * Roughly four characters per token. Good enough for a fits/does-not-fit
 * gate against a 128k-1M window; nothing here needs a tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What a session wraps around the prompt - system prompt, tool schemas, the
 * context block - before any tool output. A deliberate allowance rather than
 * a measurement: it exists so the context check fires on a model that is
 * genuinely too small for the turn, not on one that would fit the prompt
 * with nothing to spare.
 */
export const PROMPT_CONTEXT_HEADROOM_TOKENS = 8_000;

/**
 * The reason a candidate cannot serve this turn, or undefined when it can.
 * The string is written for the audit record and for the feed: it names the
 * model, the need, and the def's own number.
 */
export function capabilityMiss(input: {
  ref: PiModelRef;
  needs?: TurnNeeds;
  capabilityFor?: ModelCapabilityLookup;
}): string | undefined {
  const capability = input.capabilityFor?.(input.ref);
  if (!capability) return undefined;
  const name = `${input.ref.provider}/${input.ref.id}`;
  if (input.needs?.images && !capability.input.includes("image")) {
    return `skipped ${name}: the turn carries images and its def takes text only`;
  }
  const contextTokens = input.needs?.contextTokens;
  if (
    typeof contextTokens === "number" &&
    capability.contextWindow > 0 &&
    contextTokens > capability.contextWindow
  ) {
    return `skipped ${name}: the turn needs ~${Math.round(contextTokens / 1000)}k tokens and its context window is ${Math.round(capability.contextWindow / 1000)}k`;
  }
  return undefined;
}
