import { basename, join } from "node:path";
import type { BrowserCommand } from "vitest/node";
import type { HomeRead, HomeSeed, readHome } from "./browserFreshHome";
import type { ReducedMotion } from "./browserProvided";

/**
 * What a browser test asks of the page that holds it, beyond the runner's
 * own user events (docs/testing.md, "The browser layer"): the media a
 * person's Mac sets (Reduced motion), applied to the whole page as the
 * window's Chromium applies the system setting, a reading inside a
 * sandboxed frame the page cannot script, the page's cookies cleared, its
 * garbage collected, and the answers of a home seeded for the test's story.
 */
const emulateReducedMotion: BrowserCommand<[ReducedMotion]> = async (context, reducedMotion) => {
  await context.page.emulateMedia({ reducedMotion });
};

/**
 * Runs a function, given as its source, in a frame of the test's page - the
 * one named `frame`, or the one whose element carries `frame.title`, as a
 * card body's frame carries its card's - and answers what it returns. A card
 * body draws in a sandboxed frame of its own origin, which the page that
 * holds it cannot script; the browser can, as the journeys' frame locators did.
 */
const evaluateInFrame: BrowserCommand<
  [frame: string | { title: string }, source: string, argument?: unknown]
> = async ({ page }, frame, source, argument) => {
  let found = typeof frame === "string" ? page.frame({ name: frame }) : null;
  if (typeof frame !== "string") {
    // More than one element may carry the title - a card leaving the stage
    // keeps its drawing a moment longer - so the one that shows wins.
    for (const candidate of page.frames()) {
      const element = await candidate.frameElement().catch(() => null);
      if (!element || (await element.getAttribute("title")) !== frame.title) continue;
      found ??= candidate;
      if (await element.isVisible()) {
        found = candidate;
        break;
      }
    }
  }
  if (!found) throw new Error(`The page has no frame ${JSON.stringify(frame)}`);
  // The function arrives as its source, so the frame evaluates a call of it.
  return found.evaluate(`(${source})(${JSON.stringify(argument ?? null)})`);
};

/**
 * Clears every cookie of the page's browser context, as a fresh window
 * profile has none; a page cannot reach a cookie its script may not read.
 */
const clearCookies: BrowserCommand<[]> = async (context) => {
  await context.page.context().clearCookies();
};

/**
 * Collects the page's garbage, as a fresh window holds none. Each file's
 * window draws in a frame the runner drops when the file ends, and what it
 * drew holds the browser's shared memory until a collection finds the frame
 * gone. The script heap that would prompt one stays small, so without this
 * the drawings of file after file pile up. On Linux the page's Chromium
 * keeps that memory in files under the temp folder, so the pile fills the
 * disk.
 */
const collectGarbage: BrowserCommand<[]> = async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage");
  } finally {
    await session.detach();
  }
};

/**
 * The home a browser test's story starts in, read from a real core booted on
 * a data folder its seed wrote first: the seed is the test's own module under
 * ./browserHomes/, named as the test file is (card-place.test.tsx seeds from
 * browserHomes/card-place.ts), whose default export writes the home through
 * the core's own stores from the `input` the test passes - the words its
 * story reads back, so they have one owner - and whose `asked` names any
 * read with arguments the window sends it.
 */
const seededHome: BrowserCommand<[input?: unknown]> = async ({ project, testPath }, input) => {
  if (!testPath) throw new Error("A seeded home is asked from a test file, which names its seed");
  const name = basename(testPath).replace(/\.test\.tsx?$/, "");
  const root = project.config.root;
  const seed = await project.import<{ default: HomeSeed; asked?: HomeRead[] }>(
    join(root, "tests/helpers/browserHomes", `${name}.ts`),
  );
  const home = await project.import<{ readHome: typeof readHome }>(
    join(root, "tests/helpers/browserFreshHome.ts"),
  );
  return home.readHome(seed.default, input, seed.asked);
};

export const browserCommands = {
  emulateReducedMotion,
  evaluateInFrame,
  clearCookies,
  collectGarbage,
  seededHome,
};
