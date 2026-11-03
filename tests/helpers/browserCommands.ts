import type { BrowserCommand } from "vitest/node";
import type { ReducedMotion } from "./browserProvided";

/**
 * What a browser test asks of the page that holds it, beyond the runner's
 * own user events (docs/testing.md, "The browser layer"): the media a
 * person's Mac sets (Reduced motion), applied to the whole page as the
 * window's Chromium applies the system setting, a reading inside a
 * sandboxed frame the page cannot script, and the page's cookies cleared.
 */
const emulateReducedMotion: BrowserCommand<[ReducedMotion]> = async (context, reducedMotion) => {
  await context.page.emulateMedia({ reducedMotion });
};

/**
 * Runs a function, given as its source, in the frame of the test's page that
 * carries `name`, and answers what it returns. A card body draws in a
 * sandboxed frame of its own origin, which the page that holds it cannot
 * script; the browser can, as the journeys' frame locators did.
 */
const evaluateInFrame: BrowserCommand<[name: string, source: string, argument?: unknown]> = async (
  context,
  name,
  source,
  argument,
) => {
  const frame = context.page.frame({ name });
  if (!frame) throw new Error(`The page has no frame named ${name}`);
  // The function arrives as its source, so the frame evaluates a call of it.
  return frame.evaluate(`(${source})(${JSON.stringify(argument ?? null)})`);
};

/**
 * Clears every cookie of the page's browser context, as a fresh window
 * profile has none; a page cannot reach a cookie its script may not read.
 */
const clearCookies: BrowserCommand<[]> = async (context) => {
  await context.page.context().clearCookies();
};

export const browserCommands = { emulateReducedMotion, evaluateInFrame, clearCookies };
