import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { type Rect, within } from "./layout";
import { bodyDrawn, inCardBody, inShown, stageAtRest } from "./stack";
import { APP_WINDOW, openWindow } from "./window";

/**
 * A card body as tall as its viewport (`min-height:100vh`) once resized its
 * frame without end: the frame's height is the body's viewport, so each
 * report made the body taller. Counted as work across paints through the
 * real bridge and height setter, never as time. The scripted body, which
 * mounts over the shell's own frame scheme, keeps its journey
 * (tests/e2e/card-viewport-height.spec.ts).
 */

const TITLE = "A viewport-height card";
const BODY =
  '<div data-viewport-content style="min-height:100vh;display:flex;flex-direction:column;justify-content:space-between"><span>Viewport-height content</span><span>Bottom of the content</span></div>';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The run of consecutive paints with no change that counts as settled. */
const SETTLED_PAINTS = 120;
/**
 * The paints sampled once the body has drawn: as many again before the
 * settled run. A static card without the loop has stopped changing by its
 * first sampled paint. The journey sampled 360, six seconds of real paints
 * in a page whose test time limit is fifteen.
 */
const SAMPLED_PAINTS = 2 * SETTLED_PAINTS;

/** The content's box in the page: its box in the frame, moved by the frame's own place. */
async function contentBox(frame: HTMLIFrameElement): Promise<Rect> {
  const inner = await inCardBody(TITLE, () => {
    const content = document.querySelector("[data-viewport-content]");
    if (!content) throw new Error("The card drew no viewport-height content");
    const box = content.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const outer = frame.getBoundingClientRect();
  return { ...inner, x: inner.x + outer.x, y: inner.y + outer.y };
}

const setMinHeight = (height: string) =>
  inCardBody(
    TITLE,
    (next) => {
      const content = document.querySelector<HTMLElement>("[data-viewport-content]");
      if (!content) throw new Error("The card drew no viewport-height content");
      content.style.minHeight = next;
      return null;
    },
    height,
  );

test("min-height:100vh stops resizing in a static card, and still grows to be read and shrinks", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, body: BODY }));
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(APP_WINDOW.width, APP_WINDOW.height);
  await openWindow(bridge);
  const iframe = await bodyDrawn(TITLE);
  await stageAtRest();
  await inCardBody(TITLE, () => document.fonts.ready.then(() => null));
  const scroller = inShown("[data-card-body]");
  const surface = iframe.closest<HTMLElement>("[data-card-layer] [data-card-presentation]");
  if (!surface) throw new Error("The shown card has no surface");

  // Unchanged content settles: the last of the sampled paints show no change
  // to the frame, the card or its scroller, and no height the host still writes.
  const samples: string[] = [];
  const writes: number[] = [];
  let paint = 0;
  const observer = new MutationObserver(() => writes.push(paint));
  observer.observe(iframe, { attributes: true, attributeFilter: ["style"] });
  try {
    for (; paint < SAMPLED_PAINTS; paint++) {
      await nextFrame();
      const box = iframe.getBoundingClientRect();
      const outer = surface.getBoundingClientRect();
      samples.push(
        JSON.stringify({
          width: box.width,
          height: box.height,
          surfaceHeight: outer.height,
          surfaceTop: outer.top,
          scrollerWidth: scroller.clientWidth,
          scrollerHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
        }),
      );
    }
  } finally {
    observer.disconnect();
  }
  const tail = samples.slice(-SETTLED_PAINTS);
  const changes = tail.reduce((n, sample, i) => n + Number(i > 0 && sample !== tail[i - 1]), 0);
  expect(changes, `unchanged content must settle across ${SETTLED_PAINTS} paints`).toBe(0);
  expect(
    writes.filter((at) => at >= SAMPLED_PAINTS - SETTLED_PAINTS),
    "no ongoing host height writes",
  ).toEqual([]);
  const settledHeight = iframe.getBoundingClientRect().height;

  // Settled with all of the content inside the frame, none clipped.
  expect(within(await contentBox(iframe), iframe.getBoundingClientRect())).toEqual([]);

  // Taller content still grows the frame, and scrolling the card reaches its
  // end; shortened again, the frame follows it down.
  await setMinHeight("650px");
  await expect.poll(() => iframe.clientHeight).toBeGreaterThan(settledHeight);
  await expect
    .poll(async () => {
      scroller.scrollTop = scroller.scrollHeight;
      const shown = await contentBox(iframe);
      return within(
        { ...shown, y: shown.y + shown.height - 1, height: 1 },
        scroller.getBoundingClientRect(),
      );
    })
    .toEqual([]);
  const grown = iframe.clientHeight;
  await setMinHeight("100px");
  await expect.poll(() => iframe.clientHeight).toBeLessThan(grown);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
