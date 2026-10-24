import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { classicScrollbars, expectFrameSettles } from "./frameSizing";
import { panelBody, panelElement } from "./frames";
import { launchApp } from "./launch";
import { within } from "./layout";

import { promptInput } from "./prompt";
import { ADD_PANEL_PROMPT_MARKER, installPanel } from "./scenarios/installPanel";

const PANEL_ID = "fractional-drawing";
const PANEL = `[data-side-panel="${PANEL_ID}"]`;
const SCROLLER = `${PANEL} [data-side-panel-body]`;

function drawingSource(size: "content" | "fill"): string {
  const source = join(scratchDir("infinitary-panel-fractional-source-"), "fractional-drawing");
  cpSync(join(process.cwd(), "tests/fixtures/frame-realm/fractional"), source, { recursive: true });
  const path = join(source, "manifest.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), size }));
  return source;
}

async function addDrawing(page: Page, source: string): Promise<void> {
  await classicScrollbars(page, SCROLLER);
  const input = promptInput(page);
  await input.fill(`${ADD_PANEL_PROMPT_MARKER}${source}`);
  await input.press("Enter");
  await page.getByRole("button", { name: "Add it", exact: true }).click({ timeout: 30_000 });
  const frame = panelBody(page, PANEL_ID);
  await expect(frame.locator("[data-fractional-drawing]")).toBeVisible({ timeout: 30_000 });
  await frame.locator("body").evaluate(() => document.fonts.ready);
  // Only the environment's scrollbar width is forced, inside and outside.
  // Do not suppress overflow or replace the production resize bridge/setter.
  await frame.locator(":root").evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "html::-webkit-scrollbar { width: 15px; }";
    document.head.append(style);
  });
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("fractional-height installed panels stop resizing, show all of their document, and scroll only at the outer surface", async ({}, testInfo) => {
  const source = drawingSource("content");
  const launched = await launchApp({ scenarios: [installPanel], withMockProvider: true });
  try {
    const { page } = launched;
    await addDrawing(page, source);
    const iframe = panelElement(page, PANEL_ID);
    const frame = panelBody(page, PANEL_ID);
    const scroller = page.locator(SCROLLER);
    const end = frame.locator("[data-fractional-end]");
    for (const [name, button] of [
      ["short", "Short"],
      ["changed", "Change"],
      ["tall", "Tall"],
      ["shrunk", "Short"],
    ] as const) {
      await frame
        .getByRole("button", { name: button, exact: true })
        .evaluate((el) => (el as HTMLElement).click());
      if (name === "shrunk") {
        await page.evaluate(() => window.infinitary.settings.setAppearance({ theme: "light" }));
        await expect(frame.locator(":root")).toHaveAttribute("data-theme", "light");
      }
      if (name === "tall") {
        await expect
          .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
          .toBeGreaterThan(0);
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      }
      // Counted as work across paints, never as time.
      await expectFrameSettles(page, testInfo, name, iframe, SCROLLER, PANEL);
      // The panel's own document never scrolls: a scroll inside it goes nowhere.
      const innerScroll = await frame.locator("body").evaluate(() => {
        document.scrollingElement?.scrollTo(0, 100);
        return document.scrollingElement?.scrollTop;
      });
      expect(innerScroll, "fitting content must not create an inner scroll surface").toBe(0);
      // All of the document is inside the frame, its end included, and the
      // outer surface brings that end into view.
      const [endBox, frameBox, viewBox] = await Promise.all([
        end.boundingBox(),
        iframe.boundingBox(),
        scroller.boundingBox(),
      ]);
      if (!endBox || !frameBox || !viewBox) throw new Error("Panel endpoint has no box");
      expect(within(endBox, frameBox), "the frame shows its whole document").toEqual([]);
      expect(within(endBox, viewBox), "the outer surface reaches the endpoint").toEqual([]);
    }
  } finally {
    await launched.close();
  }
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a fill-sized installed panel scrolls its own document to reach genuinely taller content", async ({}, testInfo) => {
  const source = drawingSource("fill");
  const launched = await launchApp({ scenarios: [installPanel], withMockProvider: true });
  try {
    const { page } = launched;
    await addDrawing(page, source);
    const iframe = panelElement(page, PANEL_ID);
    const frame = panelBody(page, PANEL_ID);
    await frame
      .getByRole("button", { name: "Tall", exact: true })
      .evaluate((el) => (el as HTMLElement).click());
    await expect
      .poll(() => frame.locator(":root").evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    await frame
      .locator(":root")
      .evaluate((el) => document.scrollingElement?.scrollTo(0, el.scrollHeight));
    await expect
      .poll(() => frame.locator(":root").evaluate(() => document.scrollingElement?.scrollTop ?? 0))
      .toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("fill-scrolled.png") });
    const endpoint = await frame.locator("[data-fractional-end]").boundingBox();
    const viewport = await iframe.boundingBox();
    if (!endpoint || !viewport) throw new Error("Fill panel endpoint has no box");
    expect(
      within(endpoint, viewport),
      "the document scrollbar still reaches the full endpoint",
    ).toEqual([]);
  } finally {
    await launched.close();
  }
});
