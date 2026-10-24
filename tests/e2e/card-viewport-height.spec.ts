import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { expectFrameSettles } from "./frameSizing";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { settled, within } from "./layout";

import { promptInput } from "./prompt";
import {
  CARD_VIEWPORT_BODY,
  CARD_VIEWPORT_PROMPT_MARKER,
  CARD_VIEWPORT_SCRIPT,
  CARD_VIEWPORT_TITLE,
  cardWidths,
} from "./scenarios/cardWidths";
import { cardScroller, SHOWN_ENTRY, shownCard } from "./stack";

const SCROLLER = `${SHOWN_ENTRY} [data-card-body]`;
const SURFACE = "[data-card-layer] [data-card-presentation]";

for (const scripted of [false, true]) {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
  test(`min-height:100vh stops resizing in an emitted ${scripted ? "scripted" : "static"} card, and still grows to be read and shrinks`, async ({}, testInfo) => {
    const homeDir = scratchDir("infinitary-card-viewport-home-");
    const launched = await launchApp({
      scenarios: [cardWidths],
      withMockProvider: true,
      homeDir,
      env: {
        CFFIXED_USER_HOME: homeDir,
        INFINITARY_LOCAL_CODESIGN_DIR: `${homeDir}/local-codesign`,
      },
    });
    try {
      const { page } = launched;
      const input = promptInput(page);
      await input.fill(
        `commission a crewmate: ${CARD_VIEWPORT_PROMPT_MARKER}${scripted ? " scripted" : ""}`,
      );
      await input.press("Enter");
      await expect(shownCard(page, CARD_VIEWPORT_TITLE)).toBeVisible({ timeout: 30_000 });
      const emitted = (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === CARD_VIEWPORT_TITLE,
      );
      expect(emitted?.body).toBe(CARD_VIEWPORT_BODY + (scripted ? CARD_VIEWPORT_SCRIPT : ""));
      const iframe = cardBodyElement(page, CARD_VIEWPORT_TITLE);
      const frame = cardBody(page, CARD_VIEWPORT_TITLE);
      const content = frame.locator("[data-viewport-content]");
      await expect(content).toBeVisible();
      if (scripted) await expect(frame.locator(":root")).toHaveAttribute("data-body-script", "ran");
      await frame.locator("body").evaluate(() => document.fonts.ready);
      const scroller = cardScroller(page);

      // Counted as work across paints through the real bridge and height
      // setter, never as time.
      const settledAt = await expectFrameSettles(
        page,
        testInfo,
        "viewport-card",
        iframe,
        SCROLLER,
        SURFACE,
      );
      // Settled with all of the content inside the frame, none clipped.
      const boxes = await settled(page, async () => ({
        content: await content.boundingBox(),
        frame: await iframe.boundingBox(),
      }));
      if (!boxes.content || !boxes.frame) throw new Error("The card's content has no box");
      expect(within(boxes.content, boxes.frame)).toEqual([]);

      // Taller content still grows the frame, and scrolling the card reaches
      // its end; shortened again, the frame follows it down.
      await content.evaluate((element) => {
        element.style.minHeight = "650px";
      });
      await expect
        .poll(() => iframe.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(settledAt.height);
      await expect
        .poll(async () => {
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const [shown, view] = await Promise.all([content.boundingBox(), scroller.boundingBox()]);
          if (!shown || !view) return ["unmeasured"];
          return within({ ...shown, y: shown.y + shown.height - 1, height: 1 }, view);
        })
        .toEqual([]);
      const grown = await iframe.evaluate((element) => element.clientHeight);
      await content.evaluate((element) => {
        element.style.minHeight = "100px";
      });
      await expect
        .poll(() => iframe.evaluate((element) => element.clientHeight))
        .toBeLessThan(grown);
    } finally {
      await launched.close();
    }
  });
}
