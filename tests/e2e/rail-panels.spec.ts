import { expect, type Page, test } from "@playwright/test";
import { ActivityStore } from "../../src/core/storage/activityStore";
import { openDatabase } from "../../src/core/storage/db";
import { type FeedLine, feedLineFrom, reportSummary } from "../../src/shared/feed";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_COMPLETION_TEXT, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { measured, PERF_TAG } from "./perf";
import { promptInput } from "./prompt";
import { activityFrame, feedLine, feedLineOf, reportLine, startedLine, taskKey } from "./rails";

/**
 * The left rail's Activity feed against the built app - the phase-2
 * streaming probe (docs/ui-plugins.md). The activity feed is the fastest-
 * updating surface in the app, so its Tier-2 frame is the measurement that
 * decides whether the vehicle can carry live data: every feed line the core
 * writes must reach the frame, and a feed that starts full (the persisted
 * two hundred lines) must come back whole with the newest line in view.
 *
 * The lines are asserted, the time is measured (./perf.ts). The durations
 * (`feed:lag`: a line's own timestamp to its paint, both on the frame's
 * clock; `feed:render`: one paint of the list) are printed and annotated
 * in every run as the probe's result, and graded against their budgets only
 * on a perf run, because on a loaded machine a wall-clock budget grades the
 * load rather than the frame.
 */

/** From the core writing a line to the frame having painted it. */
const LAG_BUDGET_MS = 1_000;
/** One paint of the list, the full two-hundred-line window included. */
const RENDER_BUDGET_MS = 100;
const RETAINED_LINES = 200;
const seededLine = (i: number) => `seeded line ${i}`;

type Paint = { duration: number; rows: number; added: number; removed: number };
type Measures = { lag: number[]; render: Paint[] };

function measures(page: Page): Promise<Measures> {
  return activityFrame(page)
    .locator("body")
    .evaluate(() => ({
      lag: performance.getEntriesByName("feed:lag").map((entry) => entry.duration),
      render: performance.getEntriesByName("feed:render").map((entry) => ({
        duration: entry.duration,
        ...(entry as PerformanceMeasure).detail,
      })),
    }));
}

function feedRows(page: Page): Promise<string[]> {
  return activityFrame(page)
    .locator("[data-feed-row] [data-feed-text]")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
}

/** "pinned", or the scroller's metrics so a failed pin explains itself. */
async function feedPinned(page: Page): Promise<string> {
  const pin = await feedPin(page);
  return pin.pinned && pin.flag === "true" ? "pinned" : JSON.stringify(pin);
}

function feedPin(page: Page): Promise<{
  pinned: boolean;
  flag: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}> {
  return activityFrame(page)
    .locator("[data-feed-scroller]")
    .evaluate((el) => ({
      pinned: el.scrollHeight - el.scrollTop - el.clientHeight <= 8,
      flag: el.getAttribute("data-feed-pinned"),
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("every feed line the core writes reaches the frame, in order, with the newest in view", {
  tag: PERF_TAG,
}, async () => {
  const { page } = launched;
  const input = promptInput(page);
  // A first line opens the panel, so its frame is up before the burst and
  // every later push is measured.
  await input.fill("hello there");
  await input.press("Enter");
  await expect(feedLineOf(page, { type: "user_turn", text: "hello there" })).toBeVisible();
  const asked = `${SPAWN_PROMPT_MARKER} write a short status note`;
  await input.click();
  await input.fill(asked);
  await input.press("Enter");
  await expect(feedLineOf(page, { type: "user_turn", text: asked })).toBeVisible({
    timeout: 10_000,
  });
  const key = await taskKey(page, "write a short status note");
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(
    reportLine(page, key).filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) }),
  ).toBeVisible({ timeout: 30_000 });

  const core = await page.evaluate(() => window.infinitary.feed.recent());
  await expect.poll(() => feedRows(page)).toEqual(core.map((line) => line.text));
  await expect.poll(() => feedPinned(page)).toBe("pinned");

  const { lag, render } = await measures(page);
  measured("feed:lag", lag, LAG_BUDGET_MS);
  measured(
    "feed:render",
    render.map((paint) => paint.duration),
    RENDER_BUDGET_MS,
  );
});

test("two hundred persisted lines come back at boot with the newest in view, and the next line lands after them", {
  tag: PERF_TAG,
}, async () => {
  const { userDataDir } = launched;
  await launched.close();
  // Seed the retained window to the brim, as a long-running app would have
  // it: the feed the frame gets at boot is the largest it will ever be.
  // The lines go in through the feed's own store, a minute apart on its
  // clock, as the app writes them (INF-2456).
  const db = openDatabase(userDataDir);
  try {
    const feedKinds: FeedLine["kind"][] = ["info", "ok", "warn", "danger", "you"];
    let at = Date.now() - RETAINED_LINES * 60_000;
    const feed = new ActivityStore(db, () => (at += 60_000));
    feed.clear();
    for (let i = 0; i < RETAINED_LINES; i += 1) {
      feed.record({ kind: feedKinds[i % feedKinds.length] ?? "info", text: seededLine(i) });
    }
  } finally {
    db.close();
  }

  launched = await launchApp({ withMockProvider: true, userDataDir });
  const { page } = launched;
  await expect(feedLine(page, seededLine(RETAINED_LINES - 1))).toBeVisible({
    timeout: 15_000,
  });
  const boot = await page.evaluate(() => window.infinitary.feed.recent());
  await expect.poll(() => feedRows(page)).toEqual(boot.map((line) => line.text));
  await expect.poll(() => feedPinned(page)).toBe("pinned");
  const { render } = await measures(page);
  measured(
    `feed:render (first paint of ${RETAINED_LINES} lines)`,
    [render[0]?.duration ?? Number.NaN],
    RENDER_BUDGET_MS,
  );

  const input = promptInput(page);
  await input.click();
  await input.fill("hello there");
  await input.press("Enter");
  const said = { type: "user_turn", text: "hello there" } as const;
  await expect(feedLineOf(page, said)).toBeVisible({ timeout: 10_000 });
  const core = await page.evaluate(() => window.infinitary.feed.recent());
  expect(core.at(-1)?.text).toBe(feedLineFrom(said)?.text);
  await expect.poll(() => feedRows(page)).toEqual(core.map((line) => line.text));
  await expect.poll(() => feedPinned(page)).toBe("pinned");
  const after = await measures(page);
  measured("feed:lag (full window)", after.lag, LAG_BUDGET_MS);
});
