import type { Scenario } from "../mockProvider";

/**
 * The first mate's answers under its own card for the working-row reveal
 * (tests/e2e/thread-working-reveal.spec.ts): a reply asking to fill the
 * thread gets a long answer, so a few replies push the thread past its
 * height, and a reply asking it to take its time holds the turn open, so
 * the thread shows `working`.
 */
export const THREAD_FILL_REPLY = "fill the thread";
export const THREAD_HOLD_REPLY = "take your time on this one";
export const THREAD_LONG_ANSWER =
  "Here is a longer answer so the thread grows past its height. " +
  "It names the caption first, the chips second, and why the order matters to someone reading it cold. " +
  "It keeps going for a few more sentences so each message takes several lines in the thread column. " +
  "That way a handful of replies are enough to push the newest line below the visible area.";

export const threadWorkingReveal: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes("about: card")) return undefined;
    if (latestUserTail.includes(THREAD_HOLD_REPLY)) return { held: true };
    if (latestUserTail.includes(THREAD_FILL_REPLY)) return { text: THREAD_LONG_ANSWER };
    return undefined;
  };
