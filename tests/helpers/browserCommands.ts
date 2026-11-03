import type { BrowserCommand } from "vitest/node";
import type { ReducedMotion } from "./browserProvided";

/**
 * What a browser test asks of the page that holds it, beyond the runner's
 * own user events (docs/testing.md, "The browser layer"): the media a
 * person's Mac sets (Reduced motion), applied to the whole page as the
 * window's Chromium applies the system setting.
 */
const emulateReducedMotion: BrowserCommand<[ReducedMotion]> = async (context, reducedMotion) => {
  await context.page.emulateMedia({ reducedMotion });
};

export const browserCommands = { emulateReducedMotion };
