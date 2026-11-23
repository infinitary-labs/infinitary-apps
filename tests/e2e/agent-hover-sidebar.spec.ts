import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { RAIL_CONTENTS_SELECTOR } from "../../src/renderer/src/plugins/railRoom";
import { SMALLEST_WINDOW } from "../../src/shared/smallestWindow";
import { agentHoverFixture, HOVER_COUNTS, HOVER_NOTE } from "./agentHoverFixture";
import { nextFrame } from "./crew";
import { type LaunchedApp, launchApp } from "./launch";
import { clearOfLosses, intersects, resizeWindow } from "./layout";
import { movePanelTo } from "./panelLayout";
import { seedClockPanels } from "./personalFixtures";
import { heroShot, regionShot, windowShot } from "./pictures";
import {
  expandDock,
  expectRecordBody,
  keySummary,
  nowFrame,
  recordFrame,
  restOnFramedKey,
  restOnRow,
  rowSummaryBody,
  showRecordTab,
  taskKeyLinks,
} from "./rails";
import { focusOn, pressKey } from "./windowKeys";

/** Issue #44 and the accepted review: real crewmate summaries stay readable
 * beside both rails, or above them only when no clear placement exists.
 * Fleet paint behind the rails remains intentional. Real panel frames need
 * the desktop shell; task facts and pairing come from their existing owners.
 */
const TITLE =
  "Keep keyboard focus on the selected result when a background refresh updates the task board";
const summarySelector = "[data-crew-target] ~ div [data-crew-summary]";
const LANGUAGES = ["en", "ar"] as const;

async function stageAnchors(page: Page) {
  return page.locator("[data-crew-model-anchor][data-painted]").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const { x, y } = element.getBoundingClientRect();
      // The name attaches just above its glyph. This point stays inside
      // the minimum hit radius, without reconstructing canvas pixels.
      const point = { x, y: y + 6 };
      if (point.x <= 0 || point.x >= innerWidth || point.y <= 0 || point.y >= innerHeight)
        return [];
      if (document.elementFromPoint(point.x, point.y)?.closest("[data-rail]")) return [];
      return [point];
    }),
  );
}

async function prepare(launched: LaunchedApp) {
  const { page, app } = launched;
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await resizeWindow(app, page, { width: 1024, height: 800 });
  await expandDock(page, "now");
  await expandDock(page, "activity");
  await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();
  await expect(page.locator("[data-computer-cluster]")).toHaveCount(HOVER_COUNTS.length);
  await expect(page.locator("[data-card-stack-open]")).toHaveCount(0);
}

async function language(page: Page, choice: (typeof LANGUAGES)[number]) {
  await page.mouse.move(20, 50);
  await page.evaluate(
    async (language) =>
      window.infinitary.settings.setAppearance({
        ...(await window.infinitary.settings.getAppearance()),
        language,
      }),
    choice,
  );
  await expect(page.locator("html")).toHaveAttribute("lang", choice);
  await expect(page.locator("[data-crew-model-anchor][data-painted]").first()).toBeVisible();
  await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();
  await nextFrame(page);
}

async function controls(page: Page) {
  return page.locator(RAIL_CONTENTS_SELECTOR).filter({ visible: true }).all();
}

/** Removing only a sidebar's paint must not reveal words previously hidden
 * beneath it. Compare an actual fact row inside the opaque summary, away
 * from its rounded border; restore the paint even if the assertion fails.
 */
async function expectAboveSidebar(summary: Locator, obstacles: Locator[]) {
  for (const obstacle of obstacles) {
    const box = await obstacle.boundingBox();
    if (!box) throw new Error("A visible rail control has no geometry");
    for (const fact of await summary.locator("[data-task-fact]").all()) {
      const row = await fact.boundingBox();
      if (!row || !intersects(row, box)) continue;
      const before = await regionShot(fact);
      await obstacle.evaluate((element) => element.style.setProperty("opacity", "0", "important"));
      try {
        const withoutSidebarPaint = await regionShot(fact);
        expect(
          withoutSidebarPaint.equals(before),
          "Sidebar paint must not obscure summary facts",
        ).toBe(true);
      } finally {
        await obstacle.evaluate((element) => element.style.removeProperty("opacity"));
      }
      return;
    }
  }
  throw new Error("The overlapping summary has no fact row over a sidebar to inspect");
}

async function hoverNearRail(
  launched: LaunchedApp,
  side: "left" | "right",
  size: { width: number; height: number },
  options: { allowOverlay?: boolean; capture?: string; hero?: boolean } = {},
) {
  const { page, app } = launched;
  await page.mouse.move(20, 50);
  await resizeWindow(app, page, size);
  await nextFrame(page);
  const anchors = (await stageAnchors(page))
    .filter((point) => (side === "right" ? point.x > size.width / 2 : point.x < size.width / 2))
    .sort((a, b) => (side === "right" ? b.x - a.x : a.x - b.x))
    .slice(0, 5);
  expect(anchors.length, "The fleet has glyphs inside the stage near this sidebar").toBeGreaterThan(
    0,
  );
  let overlays = 0;
  for (const [index, anchor] of anchors.entries()) {
    await page.mouse.move(20, 50);
    await expect(page.locator(summarySelector)).toHaveCount(0);
    await page.mouse.move(anchor.x, anchor.y);
    const summary = page.locator(summarySelector);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(HOVER_NOTE);
    await expect(page.locator("[data-crew-target]")).toBeVisible();
    await nextFrame(page);
    expect(await clearOfLosses(page, summary), "The summary stays inside the window").toEqual([]);
    const obstacles = await controls(page);
    const losses = await clearOfLosses(page, summary, ...obstacles);
    if (options.allowOverlay && losses.length > 0) {
      await expectAboveSidebar(summary, obstacles);
      overlays++;
    } else {
      expect(losses, "A clear-place summary must avoid every visible rail control").toEqual([]);
    }
    if (index === 0 && options.capture && process.env.HOVER_EVIDENCE) {
      await windowShot(page, join(process.env.HOVER_EVIDENCE, `${options.capture}.png`));
      if (options.hero && process.env.HOVER_HERO) {
        await heroShot(app, page, {
          name: "fleet-hover-sidebar",
          region: summary,
          anchors: [page.locator("[data-crew-target]")],
          ready: async () => {
            await page.mouse.move(anchor.x, anchor.y);
            await expect(summary).toBeVisible();
          },
        });
      }
    }
  }
  return overlays;
}

test("crewmate summaries clear both rails in both text directions", async () => {
  const launched = await launchApp({ ...agentHoverFixture(TITLE), withMockProvider: true });
  try {
    await prepare(launched);
    const { page } = launched;
    for (const choice of LANGUAGES) {
      await language(page, choice);
      for (const side of ["right", "left"] as const) {
        await movePanelTo(page, "activity", { x: side === "right" ? "left" : "right", y: "top" });
        await movePanelTo(page, "now", { x: side, y: "top" });
        for (const width of [SMALLEST_WINDOW.width, 1024, 1200, 1440]) {
          await test.step(`${choice}, ${side} rail, ${width} pixels`, async () => {
            await hoverNearRail(
              launched,
              side,
              { width, height: 800 },
              {
                capture: `review-after-${choice}-${side}-${width}`,
                hero: choice === "en" && side === "left" && width === SMALLEST_WINDOW.width,
              },
            );
          });
        }
        await hoverNearRail(launched, side, SMALLEST_WINDOW, {
          allowOverlay: true,
          capture: `review-after-${choice}-${side}-smallest`,
        });
      }
      // The same physical CSS also places the normal Tasks-row summary.
      await page.mouse.move(20, 50);
      const board = await page.evaluate(() => window.infinitary.tasks.board());
      const task = board.tasks.find((task) => task.status === "active");
      if (!task) throw new Error("No live task to inspect from Tasks");
      await restOnRow(page, task.key);
      await expect(rowSummaryBody(page)).toBeVisible();
      expect(await clearOfLosses(page, rowSummaryBody(page))).toEqual([]);
    }
  } finally {
    await launched.close();
  }
});

test("a tall summary stays above sidebars only when the smallest window leaves no clear spot", async () => {
  const launched = await launchApp({
    ...agentHoverFixture(TITLE, { tall: true }),
    withMockProvider: true,
  });
  try {
    await prepare(launched);
    const { page } = launched;
    for (const choice of LANGUAGES) {
      await language(page, choice);
      let overlays = 0;
      for (const side of ["right", "left"] as const) {
        await movePanelTo(page, "activity", { x: side === "right" ? "left" : "right", y: "top" });
        await movePanelTo(page, "now", { x: side, y: "top" });
        overlays += await hoverNearRail(launched, side, SMALLEST_WINDOW, {
          allowOverlay: true,
          capture: `review-after-${choice}-${side}-tall`,
        });
        await hoverNearRail(
          launched,
          side,
          { width: 1440, height: 800 },
          {
            capture: `review-after-${choice}-${side}-tall-clear`,
          },
        );
      }
      expect(
        overlays,
        "The minimum-height fixture must exercise an otherwise unreadable summary",
      ).toBeGreaterThan(0);
    }
    // Task-key summaries share the physical positioning rule, too. Use a
    // real linked dependency inside the actual task record in Arabic.
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const task = board.tasks.find((task) => task.status === "active");
    if (!task) throw new Error("No live task with dependency keys");
    const target = page.locator(`[data-crew-model-name="${task.id}"]`);
    await focusOn(target);
    await pressKey(target, "Enter");
    await expectRecordBody(page);
    await showRecordTab(page, "info");
    await restOnFramedKey(page, taskKeyLinks(recordFrame(page)).first());
    const summary = keySummary(page).locator("[data-crew-summary]");
    await expect(summary).toBeVisible();
    expect(await clearOfLosses(page, summary)).toEqual([]);
  } finally {
    await launched.close();
  }
});

const CLOCKS = [
  { title: "Tokyo", zone: "Asia/Tokyo" },
  { title: "London", zone: "Europe/London" },
  { title: "Paris", zone: "Europe/Paris" },
  { title: "Sydney", zone: "Australia/Sydney" },
  { title: "New York", zone: "America/New_York" },
  { title: "Berlin", zone: "Europe/Berlin" },
  { title: "Los Angeles", zone: "America/Los_Angeles" },
  { title: "Chicago", zone: "America/Chicago" },
  { title: "Toronto", zone: "America/Toronto" },
  { title: "Singapore", zone: "Asia/Singapore" },
  { title: "Seoul", zone: "Asia/Seoul" },
  { title: "Auckland", zone: "Pacific/Auckland" },
];

for (const kind of ["create-slot", "more"] as const) {
  test(`crewmate summaries stay readable beside the real ${kind} rail control`, async () => {
    const fixture = agentHoverFixture(TITLE, { createSlot: kind === "create-slot" });
    if (kind === "more") seedClockPanels(fixture.userDataDir, CLOCKS);
    const launched = await launchApp({ ...fixture, withMockProvider: true });
    try {
      await prepare(launched);
      await resizeWindow(launched.app, launched.page, SMALLEST_WINDOW);
      await expect(
        launched.page.locator(kind === "more" ? "[data-rail-more]" : "[data-create-panel-slot]"),
      ).toBeVisible();
      await hoverNearRail(launched, "left", SMALLEST_WINDOW, {
        allowOverlay: true,
        capture: `review-after-${kind}`,
      });
    } finally {
      await launched.close();
    }
  });
}
