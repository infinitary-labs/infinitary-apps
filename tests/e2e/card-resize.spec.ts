import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { CARD_SIZES } from "../../src/renderer/src/cards/cardGeometry";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { settled } from "./layout";
import {
  CARD_RESIZE_BODY,
  CARD_RESIZE_FIGURE,
  CARD_RESIZE_PROMPT_MARKER,
  WIDTH_CARD_TITLES,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { cardScroller, dragCardTo, shownCard } from "./stack";

/**
 * FI3-234: the real card at 1200 × 800 in the regular column, with a fluid
 * SVG and the reply row below it. A classic scrollbar used to narrow the
 * frame, shrinking the SVG and its height report until overflow
 * disappeared; removing the scrollbar widened it again. That threshold moves
 * whenever the card's cap or chrome does, so the test reads the cap and
 * gives the drawing the proportions that put it there, never a tuned
 * fixture (FI3-529). Observe work across paints, not a millisecond budget,
 * through the production bridge and height setter.
 */
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("an unchanged card settles at the outer scrollbar threshold and still resizes and scrolls", async ({}, testInfo) => {
  const homeDir = scratchDir("infinitary-card-resize-home-");
  const launched = await launchApp({
    withMockProvider: true,
    homeDir,
    env: { CFFIXED_USER_HOME: homeDir, INFINITARY_LOCAL_CODESIGN_DIR: `${homeDir}/local-codesign` },
  });
  try {
    const { page } = launched;
    // Exercise width-consuming scrollbars even on machines whose native
    // scrollbars overlay content. This is the reproduction's 15px gutter;
    // overflow, gutter reservation and all frame sizing remain production code.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = "[data-card-body]::-webkit-scrollbar { width: 15px; }";
      document.head.append(style);
    });
    const input = promptInput(page);
    await input.fill(`commission a crewmate: ${CARD_RESIZE_PROMPT_MARKER}`);
    await input.press("Enter");
    const title = WIDTH_CARD_TITLES.regular;
    await expect(shownCard(page, title)).toBeVisible({ timeout: 30_000 });
    const emitted = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (card) => card.title === title,
    );
    expect(emitted?.body).toBe(CARD_RESIZE_BODY);
    const iframe = cardBodyElement(page, title);
    const frame = cardBody(page, title);
    const svg = frame.getByRole("img", { name: CARD_RESIZE_FIGURE });
    await expect(svg).toBeVisible();
    // A drawing makes the card default-wide, and between the docked rails it
    // takes more room than its 510 units, where the drawing no longer
    // narrows with its column. The captain's own drag takes it to the
    // regular column the reproduction was built for.
    await dragCardTo(page, CARD_SIZES.regular);
    await expect(frame.locator(":root")).toHaveAttribute("data-width", "regular");
    await frame.locator("body").evaluate(() => document.fonts.ready);
    const scroller = cardScroller(page);
    const reshape = (height: number) =>
      svg.evaluate((element, next) => {
        (element as SVGSVGElement).viewBox.baseVal.height = next;
        element.firstElementChild?.setAttribute("height", String(next));
      }, height);

    // The drawing's height follows its width, and a scrollbar takes width
    // from it. Proportions that fill the cap halfway between the drawing's
    // widths with and without the scrollbar leave the body fitting with the
    // scrollbar and overflowing without it: the threshold. Read the cap with
    // the drawing taller than the window, so the reading holds wherever the
    // cap and chrome move.
    await reshape(2 * (await page.evaluate(() => window.innerHeight)));
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(0);
    const cap = await settled(async () => ({
      ...(await scroller.evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
        scrollbar: (element as HTMLElement).offsetWidth - element.clientWidth,
      }))),
      drawing: await svg.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const units = (element as SVGSVGElement).viewBox.baseVal.width;
        return { width: box.width, height: box.height, units };
      }),
    }));
    expect(cap.scrollbar, "the overflowing body takes the scrollbar's width").toBeGreaterThan(0);
    const rest = cap.content - cap.drawing.height;
    const threshold =
      (cap.drawing.units * (cap.height - rest)) / (cap.drawing.width + cap.scrollbar / 2);
    // How much taller the drawing is when the scrollbar's width comes back.
    const growth = (cap.scrollbar * threshold) / cap.drawing.units;
    await reshape(threshold);

    const capture = await iframe.evaluate(async (element) => {
      const scroller = element.closest<HTMLElement>("[data-card-body]");
      const card = scroller?.parentElement;
      if (!scroller || !card) throw new Error("Card scroll surface is missing");
      const messages: { at: number; height: number }[] = [];
      const writes: { at: number; height: string }[] = [];
      const onMessage = (event: MessageEvent) => {
        if (
          event.source === (element as HTMLIFrameElement).contentWindow &&
          event.data?.type === "resize"
        ) {
          messages.push({ at: performance.now(), height: event.data.height });
        }
      };
      const observer = new MutationObserver(() => {
        writes.push({ at: performance.now(), height: element.style.height });
      });
      window.addEventListener("message", onMessage);
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      const samples = [];
      try {
        for (let paint = 0; paint < 600; paint++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const box = element.getBoundingClientRect();
          samples.push({
            width: box.width,
            height: box.height,
            cardHeight: card.getBoundingClientRect().height,
            scrollerWidth: scroller.clientWidth,
            scrollerHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
          });
        }
      } finally {
        window.removeEventListener("message", onMessage);
        observer.disconnect();
      }
      return { samples, messages, writes, overflowY: getComputedStyle(scroller).overflowY };
    });
    const tail = capture.samples.slice(-120).map((sample) => JSON.stringify(sample));
    const changes = tail.reduce((n, sample, i) => n + Number(i > 0 && sample !== tail[i - 1]), 0);
    const states = [...new Set(capture.samples.map((sample) => JSON.stringify(sample)))];
    const summary = {
      changes,
      states,
      heightWrites: capture.writes.length,
      overflowY: capture.overflowY,
      threshold: { cap, drawingHeight: threshold, growth },
    };
    console.log("card-resize", JSON.stringify(summary));
    await writeFile(
      testInfo.outputPath("geometry.json"),
      JSON.stringify({ summary, ...capture }, null, 2),
    );
    await page.screenshot({ path: testInfo.outputPath("threshold.png") });
    expect(changes, "unchanged card must settle across 120 consecutive paints").toBe(0);
    // It settled at the threshold: the body fits its cap with the
    // scrollbar's width taken, by less than the drawing grows without it.
    const last = capture.samples.at(-1);
    if (!last) throw new Error("No geometry samples were captured");
    expect(last.scrollHeight, "the body fits with the scrollbar's width taken").toBeLessThanOrEqual(
      cap.height,
    );
    expect(last.scrollHeight + growth, "the body overflows at its full width").toBeGreaterThan(
      cap.height,
    );

    const boundary = await iframe.boundingBox();
    if (!boundary) throw new Error("Card frame has no box");
    // Make the same drawing taller. The frame must still follow its body,
    // with one outer scroll surface, not a cap or suppressed resize reports.
    await reshape(3 * threshold);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(0);
    await expect
      .poll(() => iframe.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(boundary.height);
    await expect
      .poll(() =>
        frame.locator(":root").evaluate((element) => element.scrollHeight - window.innerHeight),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(boundary.width);
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("scrolling.png") });

    // Shorten it again: overflow goes away but content width must not change.
    await reshape(threshold / 2);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBe(0);
    await expect
      .poll(() => iframe.evaluate((element) => element.clientHeight))
      .toBeLessThan(boundary.height);
    await expect
      .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(boundary.width);
    await page.screenshot({ path: testInfo.outputPath("shortened.png") });
  } finally {
    await launched.close();
  }
});
