import { cpSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { classicScrollbars, expectFrameSettles } from "./frameSizing";
import { panelBody, panelElement } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow, settled, within } from "./layout";

import { promptInput } from "./prompt";
import {
  expandDock,
  nowFrame,
  pressRow,
  RECORD_CARD_SELECTOR,
  RECORD_FRAME_SELECTOR,
  recordCard,
  recordFrame,
} from "./rails";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";

const RECORD_SCROLLER = "[data-task-record] [data-card-body]";
const PANEL_SCROLLER = '[data-side-panel="resize-probe"] [data-side-panel-body]';
const PANEL_ID = "resize-probe";
const PANEL = `[data-side-panel="${PANEL_ID}"]`;

/** FI3-247: real text/disclosures, not a drawing injected into a record that only renders text. */
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("the task record stops resizing on both sides of a classic scrollbar threshold, and reads to its end", async ({}, testInfo) => {
  const userDataDir = scratchDir("infinitary-record-threshold-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const goal = Array.from(
    { length: 8 },
    (_, i) =>
      `${i + 1}. Read the harbour report and compare the soundings with the chart. Keep the full explanation available while checking the channel, the shoreline and the weather.`,
  ).join("\n\n");
  const task = seedTask(tasks, {
    id: "record-threshold",
    title: "Read the harbour report",
    intent: { goal, userWords: "Keep all of the soundings readable in the task record." },
    startPolicy: "on-request",
    status: "queued",
  });
  db.close();
  const launched = await launchApp({
    scenarios: [installPanel],
    userDataDir,
    withMockProvider: true,
  });
  try {
    const { app, page } = launched;
    await classicScrollbars(page, RECORD_SCROLLER);
    await resizeWindow(app, page, { width: 1200, height: 1400 });
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    await pressRow(page, task.key);
    const pane = recordCard(page);
    const iframe = page.locator(RECORD_FRAME_SELECTOR);
    const frame = recordFrame(page);
    const scroller = page.locator(RECORD_SCROLLER);
    await expect(pane).toHaveCSS("opacity", "1");
    await frame
      .locator('[data-record-section="words"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    await expect(frame.locator("[data-record-goal]")).toHaveText(goal);
    await frame.locator("body").evaluate(() => document.fonts.ready);
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    const natural = await settled(page, () =>
      pane.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        margin: window.innerHeight - parseFloat(getComputedStyle(el).maxHeight),
      })),
    );
    // Read the actual content/cap, then move the window just either side of it.
    // Do not replace production flex sizing, clipping, placement or the height setter.
    const boundary = Math.ceil(natural.height + natural.margin);
    for (const [index, offset] of [8, -8].entries()) {
      await resizeWindow(app, page, { width: 1200, height: boundary + offset });
      // Counted as work across paints, never as time.
      await expectFrameSettles(
        page,
        testInfo,
        `record-${index}-${offset > 0 ? "above" : "below"}`,
        iframe,
        RECORD_SCROLLER,
        RECORD_CARD_SELECTOR,
      );
      // The record stays inside the window, nothing of it cut off.
      const box = await pane.boundingBox();
      if (!box) throw new Error("Task record has no box");
      const windowBox = await page.evaluate(() => ({
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(within(box, windowBox)).toEqual([]);
    }
    // A longer disclosure remains readable to its end through the outer
    // scroller; closing it shrinks the record again.
    await resizeWindow(app, page, { width: 1200, height: boundary - 100 });
    const goalText = frame.locator("[data-record-goal]");
    await expect
      .poll(async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const [shown, view] = await Promise.all([goalText.boundingBox(), scroller.boundingBox()]);
        if (!shown || !view) return ["unmeasured"];
        return within({ ...shown, y: shown.y + shown.height - 1, height: 1 }, view);
      })
      .toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("record-scrolled.png") });
    await frame
      .locator('[data-record-section="words"] > summary')
      .evaluate((el) => (el as HTMLElement).click());
    const short = await expectFrameSettles(
      page,
      testInfo,
      "record-collapsed",
      iframe,
      RECORD_SCROLLER,
      RECORD_CARD_SELECTOR,
    );
    expect(short.surfaceHeight).toBeLessThan(natural.height);
  } finally {
    await launched.close();
  }
});

/** A fluid drawing is legitimate installed-panel content: compile and add it through the real UI. */
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a content-sized panel stops resizing at the width-consuming scrollbar threshold, and still grows to be read and shrinks", async ({}, testInfo) => {
  const source = join(scratchDir("infinitary-panel-threshold-source-"), "resize-probe");
  cpSync(join(process.cwd(), "tests/fixtures/frame-realm/resize"), source, { recursive: true });
  const launched = await launchApp({ scenarios: [installPanel], withMockProvider: true });
  try {
    const { page } = launched;
    await classicScrollbars(page, PANEL_SCROLLER);
    const input = promptInput(page);
    await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
    await input.press("Enter");
    await page.getByRole("button", { name: "Add it", exact: true }).click({ timeout: 30_000 });
    const iframe = panelElement(page, PANEL_ID);
    const frame = panelBody(page, PANEL_ID);
    const svg = frame.locator("[data-resize-drawing]");
    const content = frame.locator("[data-resize-probe]");
    const scroller = page.locator(PANEL_SCROLLER);
    await expect(svg).toBeVisible({ timeout: 30_000 });
    await frame.locator("body").evaluate(() => document.fonts.ready);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    const cap = await settled(page, () =>
      scroller.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          fullWidth:
            el.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
          height: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        };
      }),
    );
    const endHeight = await frame
      .locator("[data-resize-end]")
      .evaluate((el) => el.getBoundingClientRect().height);
    // Put the cap between the drawing's heights at full and scrollbar-narrowed
    // widths. The 15px is environmental; the cap and all layout are measured.
    const ratio = (cap.height - endHeight) / (cap.fullWidth - 15 / 2);
    console.log("panel-cap", JSON.stringify({ ...cap, endHeight, ratio }));
    await content.evaluate(
      (el, next) => (el as HTMLElement).style.setProperty("--drawing-ratio", String(next)),
      ratio,
    );
    const threshold = await expectFrameSettles(
      page,
      testInfo,
      "panel-threshold",
      iframe,
      PANEL_SCROLLER,
      PANEL,
    );

    await content.evaluate(
      (el, next) => (el as HTMLElement).style.setProperty("--drawing-ratio", String(next)),
      ratio * 2,
    );
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expectFrameSettles(page, testInfo, "panel-tall-scrolled", iframe, PANEL_SCROLLER, PANEL);
    const endBox = await frame.locator("[data-resize-end]").boundingBox();
    const scrollBox = await scroller.boundingBox();
    if (!endBox || !scrollBox) throw new Error("Panel scrolling endpoint is missing");
    expect(within(endBox, scrollBox), "the bottom of the drawing must be readable").toEqual([]);
    await page.evaluate(() => window.infinitary.settings.setAppearance({ theme: "light" }));
    await expect(frame.locator(":root")).toHaveAttribute("data-theme", "light");
    await content.evaluate((el) => (el as HTMLElement).style.setProperty("--drawing-ratio", "0.5"));
    const short = await expectFrameSettles(
      page,
      testInfo,
      "panel-short",
      iframe,
      PANEL_SCROLLER,
      PANEL,
    );
    expect(short.surfaceHeight).toBeLessThan(threshold.surfaceHeight);
  } finally {
    await launched.close();
  }
});
