import { expect, type Locator, type Page, test } from "@playwright/test";
import { UI_SIZES } from "../../src/shared/preferences";
import { chooseSize } from "./captureMarkers";
import { launchApp } from "./launch";
import { settled } from "./layout";
import { promptInput } from "./prompt";
import {
  activityFrame,
  dockSummaryLine,
  dockTitle,
  expandDock,
  startedLine,
  taskKey,
} from "./rails";

/**
 * A one-line row centres its letters on its dot and its chevron (design
 * skill readme, Type: "one line beside a dot or an icon"). The captain saw
 * the collapsed Activity line sit off its centre (INF-855): the words, an
 * 11px mono age, a 5px dot and a 24px chevron were each centred by their
 * box, so on a 2x screen the 12.5px words' baseline rounded 0.84 px below
 * the age's and their lowercase sat 1.26 px below the dot.
 *
 * Each density is its own launch, through Chromium's own switch: the
 * DevTools device-metrics override leaves layout at 1x and never shows it.
 * At every Size, the words' and the age's x-height centres, the dot's
 * centre and the chevron's centre agree within 0.1 px; so do the Tasks
 * header's uppercase title, on its cap height, and the expanded feed rows,
 * whose trimmed words show no cut-short label while they fit.
 */

/** How far two centres may sit apart: well under a device pixel at 2x. */
const TOLERANCE = 0.1;

const TITLE = "Sign-in card shows its task and keeps the task board open";

type Centres = Record<string, number>;

/**
 * The vertical centre of each piece in a row, in CSS px from the row's top:
 * a box's own centre, and a text run's letters - its baseline less half its
 * x-height, or half its cap height for an uppercase run. The baseline is
 * read from a zero-size inline-block set on it; the letters' heights from
 * the run's own font, drawn by the app's canvas.
 */
function readCentres(row: Element, pieces: Piece[]): Centres {
  const top = row.getBoundingClientRect().top;
  const canvas = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  const centres: Centres = {};
  for (const { name, selector, letters } of pieces) {
    const element = row.querySelector(selector);
    if (!element) throw new Error(`No ${name} (${selector}) in the row`);
    if (!letters) {
      const box = element.getBoundingClientRect();
      centres[name] = (box.top + box.bottom) / 2 - top;
      continue;
    }
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    element.insertBefore(probe, element.firstChild);
    const baseline = probe.getBoundingClientRect().bottom - top;
    probe.remove();
    const style = getComputedStyle(element);
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    centres[name] = baseline - canvas.measureText(letters).actualBoundingBoxAscent / 2;
  }
  return centres;
}

/** Every centre against the first one named, which the others should share. */
function expectOneCentre(centres: Centres, where: string) {
  const [first, ...others] = Object.entries(centres);
  if (!first) throw new Error(`${where}: no pieces measured`);
  const [reference, centre] = first;
  for (const [name, other] of others)
    expect
      .soft(Math.abs(other - centre), `${where}: ${name} against ${reference}`)
      .toBeLessThanOrEqual(TOLERANCE);
}

type Piece = { name: string; selector: string; letters?: "x" | "H" };

/** The collapsed Activity header: its line's dot, words and age, and the chevron. */
const ACTIVITY_HEADER: Piece[] = [
  { name: "chevron", selector: "[data-panel-expand-chevron] svg" },
  { name: "dot", selector: '[data-panel-summary-line] [role="img"]' },
  { name: "words", selector: "span:has(> [data-panel-summary-words])", letters: "x" },
  { name: "age", selector: "[data-panel-summary]", letters: "x" },
];

/** The collapsed Tasks header: its uppercase title, its counts and the chevron. */
const TASKS_HEADER: Piece[] = [
  { name: "chevron", selector: "[data-panel-expand-chevron] svg" },
  { name: "title", selector: ":scope > span:first-child", letters: "H" },
  { name: "summary", selector: "[data-side-panel-compact]", letters: "x" },
];

/** An expanded Activity row: the same dot, words and age, in the panel's own page. */
const FEED_ROW: Piece[] = [
  { name: "dot", selector: ".dot" },
  { name: "words", selector: "[data-feed-line]", letters: "x" },
  { name: "age", selector: "[data-feed-time]", letters: "x" },
];

async function centresOf(page: Page, row: Locator, pieces: Piece[]): Promise<Centres> {
  await row.evaluate(() => document.fonts.ready.then(() => undefined));
  return settled(page, () => row.evaluate(readCentres, pieces));
}

async function setCollapsed(page: Page, dock: "activity" | "now") {
  const panel = page.locator(`[data-side-panel="${dock}"]`);
  if ((await panel.getAttribute("data-side-panel-collapsed")) === null)
    await panel.getByRole("button", { name: `Collapse ${dockTitle(dock)}` }).click();
  await expect(panel).toHaveAttribute("data-side-panel-collapsed", "");
}

for (const deviceScaleFactor of [1, 2]) {
  test(`a collapsed panel's line shares one centre at ${deviceScaleFactor}x, at every Size`, async () => {
    const launched = await launchApp({ withMockProvider: true, deviceScaleFactor });
    const { app, page } = launched;
    try {
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor);
      const input = promptInput(page);
      await input.click();
      await input.fill(`commission a crewmate: ${TITLE}`);
      await input.press("Enter");
      const key = await taskKey(page, TITLE);
      await expect(startedLine(page, key)).toBeVisible({ timeout: 30_000 });

      for (const size of UI_SIZES) {
        await chooseSize(app, page, size);
        const where = `${deviceScaleFactor}x, Size ${size}%`;

        await expandDock(page, "activity");
        const rows = activityFrame(page).locator("[data-feed-row]");
        await expect(rows.first()).toBeVisible();
        expectOneCentre(
          await centresOf(page, rows.last(), FEED_ROW),
          `${where}, expanded Activity row`,
        );
        // Trimmed to its letters, a line whose words fit still reads as
        // whole: no words-cut-short label on rest (readme, "Facts shown on
        // rest": words cut short only while cut).
        await expect(startedLine(page, key)).not.toHaveAttribute("title");

        // Collapsed, Activity says its newest line in the title's place.
        await setCollapsed(page, "activity");
        await setCollapsed(page, "now");
        await expect(dockSummaryLine(page, "activity")).toBeVisible();
        await expect(page.locator("[data-panel-summary-line-leaving]")).toHaveCount(0);
        expectOneCentre(
          await centresOf(
            page,
            page.locator('[data-side-panel="activity"] header'),
            ACTIVITY_HEADER,
          ),
          `${where}, collapsed Activity`,
        );
        expectOneCentre(
          await centresOf(page, page.locator('[data-side-panel="now"] header'), TASKS_HEADER),
          `${where}, collapsed Tasks`,
        );
      }
    } finally {
      await launched.close();
    }
  });
}
