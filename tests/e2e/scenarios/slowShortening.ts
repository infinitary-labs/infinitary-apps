import type { Scenario } from "../mockProvider";

export const SHORTENING_HOLD_MS = 6000;

/**
 * Claude's client shortens its conversation by asking for a summary of it,
 * in a request whose own words ask for one. The stand-in takes its time over
 * that answer, the way a real model does over a long conversation, so the
 * character's look while it shortens can be watched; every other request
 * passes on.
 */
export const slowShortening: Scenario = () => {
  return ({ anthropicMessages, latestUserTail }) => {
    if (!anthropicMessages || !/summary of the conversation/i.test(latestUserTail))
      return undefined;
    return {
      text: "<analysis>The captain asked to recover an overlong conversation.</analysis>\n<summary>The captain asked the first mate to recover an overlong conversation and say hello.</summary>",
      afterMs: SHORTENING_HOLD_MS,
    };
  };
};
