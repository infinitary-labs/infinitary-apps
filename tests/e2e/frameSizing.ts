import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

/** Force the environment's scrollbar width, never the production overflow/sizing policy. */
export async function classicScrollbars(page: Page, scrollerSelector: string): Promise<void> {
  await page.evaluate((selector) => {
    const style = document.createElement("style");
    style.textContent = `${selector}::-webkit-scrollbar { width: 15px; }`;
    document.head.append(style);
  }, scrollerSelector);
}

/** Passive measurements through the real resize bridge and host height setter. */
export async function captureFrameSizing(
  iframe: Locator,
  scrollerSelector: string,
  surfaceSelector: string,
  paints = 360,
) {
  return iframe.evaluate(
    async (element, options) => {
      const scroller = element.closest<HTMLElement>(options.scrollerSelector);
      const surface = element.closest<HTMLElement>(options.surfaceSelector);
      if (!scroller || !surface) throw new Error("Frame scroll surface is missing");
      let paint = 0;
      const messages: { paint: number; height: number }[] = [];
      const writes: { paint: number; height: string }[] = [];
      const onMessage = (event: MessageEvent) => {
        if (
          event.source === (element as HTMLIFrameElement).contentWindow &&
          event.data?.type === "resize"
        ) {
          messages.push({ paint, height: event.data.height });
        }
      };
      const observer = new MutationObserver(() =>
        writes.push({ paint, height: element.style.height }),
      );
      window.addEventListener("message", onMessage);
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      const samples = [];
      try {
        for (; paint < options.paints; paint++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const box = element.getBoundingClientRect();
          const outer = surface.getBoundingClientRect();
          samples.push({
            width: box.width,
            height: box.height,
            surfaceHeight: outer.height,
            surfaceTop: outer.top,
            scrollerWidth: scroller.clientWidth,
            scrollerHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
            scrollTop: scroller.scrollTop,
          });
        }
      } finally {
        window.removeEventListener("message", onMessage);
        observer.disconnect();
      }
      const tail = samples.slice(-120).map((sample) => JSON.stringify(sample));
      return {
        samples,
        messages,
        writes,
        summary: {
          changes: tail.reduce((n, sample, i) => n + Number(i > 0 && sample !== tail[i - 1]), 0),
          ongoingHeightWrites: writes.filter((write) => write.paint >= options.paints - 120).length,
          states: [...new Set(samples.map((sample) => JSON.stringify(sample)))],
          overflowY: getComputedStyle(scroller).overflowY,
        },
      };
    },
    { scrollerSelector, surfaceSelector, paints },
  );
}

/** Save evidence before asserting, so a failing threshold keeps its geometry and picture. */
export async function expectFrameSettles(
  page: Page,
  testInfo: TestInfo,
  name: string,
  iframe: Locator,
  scrollerSelector: string,
  surfaceSelector: string,
) {
  const capture = await captureFrameSizing(iframe, scrollerSelector, surfaceSelector);
  console.log(name, JSON.stringify(capture.summary));
  await writeFile(testInfo.outputPath(`${name}.json`), JSON.stringify(capture, null, 2));
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  expect(capture.summary.changes, `${name}: unchanged content must settle across 120 paints`).toBe(
    0,
  );
  expect(capture.summary.ongoingHeightWrites, `${name}: no ongoing host height writes`).toBe(0);
  const last = capture.samples.at(-1);
  if (!last) throw new Error("No frame sizing samples were captured");
  return last;
}
