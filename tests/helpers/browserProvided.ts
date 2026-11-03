/**
 * What the browser project's Node side gives its pages (docs/testing.md,
 * "The browser layer"): the fresh home's answers, provided by its global
 * setup (./browserFreshHome.ts), and the commands a page may ask of itself
 * (./browserCommands.ts). Both sides read these types.
 */

/**
 * Each core read channel's answer, as a fresh home gives it: `plain` for
 * reads that take no arguments, `asked` for the reads with arguments the
 * setup names, by channel and then by the request as JSON.
 */
export type FreshHomeAnswers = {
  plain: Record<string, unknown>;
  asked: Record<string, Record<string, unknown>>;
};

/** The media a person's system sets for motion. */
export type ReducedMotion = "reduce" | "no-preference";

declare module "vitest" {
  interface ProvidedContext {
    freshHome: FreshHomeAnswers;
  }
}

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateReducedMotion(reducedMotion: ReducedMotion): Promise<void>;
  }
}
