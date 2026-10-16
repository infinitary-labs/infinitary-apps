import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { feedLineFrom, reportSummary } from "../../src/shared/feed";
import { type LaunchedApp, launchApp } from "./launch";
import { MOCK_COMPLETION_TEXT } from "./mockProvider";
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
/** The words of the spec's own seeded feed line `i`, where it is written and where it is read. */
const seededLine = (i: number) => `seeded line ${i}`;

/** One paint of the list: what it built, and how long it took. */
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

/** The scroller's pin and its metrics. */
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
  const asked = "commission a crewmate: write a short status note";
  await input.click();
  await input.fill(asked);
  await input.press("Enter");
  // A fleet moment: the captain's turn, the spawn and the report - lines
  // through the vehicle.
  await expect(feedLineOf(page, { type: "user_turn", text: asked })).toBeVisible({
    timeout: 10_000,
  });
  const key = await taskKey(page, "write a short status note");
  await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });
  await expect(
    reportLine(page, key).filter({ hasText: reportSummary(MOCK_COMPLETION_TEXT) }),
  ).toBeVisible({ timeout: 30_000 });

  // The frame shows exactly the core's feed, oldest first, newest last.
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
  const db = new Database(join(userDataDir, "firstmate.db"));
  db.prepare("DELETE FROM activity_events").run();
  const insert = db.prepare("INSERT INTO activity_events (kind, text, at) VALUES (?, ?, ?)");
  const feedKinds = ["info", "ok", "warn", "danger", "you"];
  const base = Date.now() - RETAINED_LINES * 60_000;
  for (let i = 0; i < RETAINED_LINES; i += 1) {
    insert.run(feedKinds[i % feedKinds.length], seededLine(i), base + i * 60_000);
  }
  db.close();

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

  // A new line lands: it is the newest, in view, and the list is still
  // exactly the core's.
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
