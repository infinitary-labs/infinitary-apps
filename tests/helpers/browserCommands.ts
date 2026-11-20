import { availableParallelism, loadavg } from "node:os";
import { basename, join } from "node:path";
import type { BrowserCommand, TestProject } from "vitest/node";
import type { HomeRead, HomeSeed, holdLine, readHome } from "./browserFreshHome";
import type { LoadReading, ReducedMotion } from "./browserProvided";
import { GRADES_BUDGETS } from "./budgets";
import { firstmateIdleReadings, layoutReadings } from "./journeyHelperPages";
import { processorShare } from "./loadClock";

/**
 * What a browser test asks of the page that holds it, beyond the runner's
 * own user events (docs/testing.md, "The browser layer"): the media a
 * person's Mac sets (Reduced motion), applied to the whole page as the
 * window's Chromium applies the system setting, a reading inside a
 * sandboxed frame the page cannot script, the page's cookies cleared, its
 * garbage collected, the answers of a home seeded for the test's story, and
 * the journeys' own Playwright helpers read on a plain page
 * (`journeyHelperPages.ts`), and the beat of the page's load clock.
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
 *
 * The test asks once its page shows the frame drawn, and that word reaches
 * this process over the runner's own connection, while the browser's word
 * that the frame exists comes over Playwright's: on a busy computer it may
 * still be unread, and Playwright's list of the page's frames then lacks a
 * frame the page already drew. A request on Playwright's connection is
 * answered only after every word the browser sent before it, so the list is
 * read once one has been answered.
 */
const evaluateInFrame: BrowserCommand<
  [frame: string | { title: string }, source: string, argument?: unknown]
> = async ({ page }, frame, source, argument) => {
  await page.mainFrame().evaluate("0");
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
 * A finger held on the element `selector` finds in the frame named `frame`
 * for `holdMs`, through the browser's own touch input (the DevTools
 * protocol's touch events, which a page cannot make), as a phone's press
 * reaches a card body. It presses the element's middle and lifts there.
 *
 * A touch that lands anywhere else - off the page, on a scrollbar beside the
 * frame, on something drawn over it - reaches no element, and the press it
 * stood for would do nothing unseen. So the element is brought into view,
 * and its middle is followed out frame by frame to the page, each frame
 * checking that a point there reaches the element or the frame holding it;
 * a press that would land elsewhere fails here, naming what it would reach.
 */
const holdTouchInFrame: BrowserCommand<[frame: string, selector: string, holdMs: number]> = async (
  { page },
  frame,
  selector,
  holdMs,
) => {
  await page.mainFrame().evaluate("0");
  const found = page.frame({ name: frame });
  if (!found) throw new Error(`The page has no frame ${JSON.stringify(frame)}`);
  const target = found.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  // Where a press reaches, read in one frame: the element's own middle, which
  // must reach the element, or a point `inner` in the frame `element` holds,
  // which must reach that frame, as the frame is drawn - the runner's own
  // page draws a test's page scaled to fit. It names what it reaches instead.
  const reach = (element: Element, inner: { x: number; y: number } | null) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const drawn = element as HTMLElement;
    const x = inner
      ? rect.x +
        (element.clientLeft + Number.parseFloat(style.paddingLeft) + inner.x) *
          (rect.width / drawn.offsetWidth)
      : rect.x + rect.width / 2;
    const y = inner
      ? rect.y +
        (element.clientTop + Number.parseFloat(style.paddingTop) + inner.y) *
          (rect.height / drawn.offsetHeight)
      : rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && (inner ? hit === element : element.contains(hit))) return { x, y, lands: null };
    return { x, y, lands: hit ? `${hit.localName}${hit.id ? `#${hit.id}` : ""}` : "nothing" };
  };
  let point: { x: number; y: number; lands: string | null } = await target.evaluate(reach, null);
  let at = found;
  let around = at.parentFrame();
  while (around && point.lands === null) {
    point = await (await at.frameElement()).evaluate(reach, point);
    at = around;
    around = at.parentFrame();
  }
  if (point.lands !== null) {
    const where = at === found ? frame : at.name() || at.url();
    throw new Error(`A press on ${selector} in ${frame} lands on ${point.lands} in ${where}`);
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y }],
    });
    await new Promise((done) => setTimeout(done, holdMs));
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
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

/** The fresh home's module as this project loads it, which keeps the one boot line. */
function freshHomeModule(project: TestProject) {
  return project.import<{ readHome: typeof readHome; holdLine: typeof holdLine }>(
    join(project.config.root, "tests/helpers/browserFreshHome.ts"),
  );
}

/**
 * How many seeded homes each page - by its session - has waiting in line
 * behind another page's boot: one core boots at a time (./browserFreshHome.ts),
 * so on a busy computer a page may wait for several boots before its own starts.
 */
const homesInLine = new Map<string, number>();

/**
 * The home a browser test's story starts in, read from a real core booted on
 * a data folder its seed wrote first: the seed is the test's own module under
 * ./browserHomes/, named as the test file is (card-place.test.tsx seeds from
 * browserHomes/card-place.ts), whose default export writes the home through
 * the core's own stores from the `input` the test passes - the words its
 * story reads back, so they have one owner - and whose `asked` names any
 * read with arguments the window sends it.
 */
const seededHome: BrowserCommand<[input?: unknown]> = async (
  { project, testPath, sessionId },
  input,
) => {
  if (!testPath) throw new Error("A seeded home is asked from a test file, which names its seed");
  const name = basename(testPath).replace(/\.test\.tsx?$/, "");
  const root = project.config.root;
  const seed = await project.import<{ default: HomeSeed; asked?: HomeRead[] }>(
    join(root, "tests/helpers/browserHomes", `${name}.ts`),
  );
  const home = await freshHomeModule(project);
  return home.readHome(seed.default, input, seed.asked, (inLine) => {
    const waiting = (inLine ? 1 : -1) + (homesInLine.get(sessionId) ?? 0);
    if (waiting > 0) homesInLine.set(sessionId, waiting);
    else homesInLine.delete(sessionId);
  });
};

/**
 * The beat of the page's load clock (tests/browser/loadClock.ts): the page
 * asks for it on every tick, so while this process - the one that answers
 * every command, a seeded home's boot among them - is stalled, the beat waits
 * and the page's limits stop counting. It answers whether the run grades
 * budgets, which keeps the wall clock, and the share of a processor this
 * computer's load leaves: none while the page's seeded home waits in line
 * behind another page's boot, as its test does not run then (INF-4644).
 */
const loadReading: BrowserCommand<[]> = ({ sessionId }): LoadReading => ({
  grades: GRADES_BUDGETS,
  share: homesInLine.has(sessionId) ? 0 : processorShare(loadavg()[0] ?? 0, availableParallelism()),
});

/**
 * Holds the line of seeded homes' boots for `milliseconds`, as another page's
 * boot holds it, with this process free to answer meanwhile, so a test shows
 * its seeded home's wait in line does not count (tests/browser/load-clock.test.ts).
 */
const holdBootLine: BrowserCommand<[milliseconds: number]> = async ({ project }, milliseconds) => {
  (await freshHomeModule(project)).holdLine(milliseconds);
};

/**
 * Holds this process for `milliseconds`, its event loop blocked as a read
 * from a starved disk blocks it, so a test shows its limit does not count
 * the time (tests/browser/load-clock.test.ts).
 */
const holdCommandProcess: BrowserCommand<[milliseconds: number]> = (_context, milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

export const browserCommands = {
  emulateReducedMotion,
  evaluateInFrame,
  holdTouchInFrame,
  clearCookies,
  collectGarbage,
  seededHome,
  layoutReadings,
  firstmateIdleReadings,
  loadReading,
  holdCommandProcess,
  holdBootLine,
};
