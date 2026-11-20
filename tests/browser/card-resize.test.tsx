import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { bodyDrawn, inCardBody, inShown, stageAtRest } from "./stack";
import { APP_WINDOW, openWindow } from "./window";

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

const TITLE = "The meter row reads on first paint";
const FIGURE = "Resize reproduction";
const BODY = `<p>A drawing.</p><figure aria-label="${FIGURE}"><svg viewBox="0 0 510 290" width="100%" role="img" aria-label="${FIGURE}"><rect width="510" height="290" style="fill:var(--accent)"/></svg></figure>`;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The run of consecutive paints with no change that counts as settled. */
const SETTLED_PAINTS = 120;
/**
 * The paints sampled after the drawing changes: as many again before the
 * settled run. A card without the loop stops changing by the first paint
 * after the change, and FI3-234's loop changes it on every paint. The
 * journey sampled 600, ten seconds of real paints in a page whose test
 * time limit is fifteen.
 */
const SAMPLED_PAINTS = 2 * SETTLED_PAINTS;

/** Polls `read` until two reads a paint apart agree, and answers the last. */
async function settled<T>(read: () => Promise<T> | T): Promise<T> {
  let last: string | undefined;
  let value: T | undefined;
  await expect
    .poll(async () => {
      if (last !== undefined) await nextFrame();
      value = await read();
      const json = JSON.stringify(value);
      const same = json === last;
      last = json;
      return same;
    })
    .toBe(true);
  return value as T;
}

test("an unchanged card settles at the outer scrollbar threshold and still resizes and scrolls", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, body: BODY }));
  bridge.answer("inf:cards:seen-update", { ok: true });
  await page.viewport(APP_WINDOW.width, APP_WINDOW.height);
  // Exercise width-consuming scrollbars even where native scrollbars overlay
  // content. This is the reproduction's 15px gutter; overflow, gutter
  // reservation and all frame sizing remain production code.
  const gutter = document.createElement("style");
  gutter.textContent = "[data-card-body]::-webkit-scrollbar { width: 15px; }";
  document.head.append(gutter);
  await openWindow(bridge);

  const iframe = await bodyDrawn(TITLE);
  await stageAtRest();
  expect(await inCardBody(TITLE, () => document.documentElement.getAttribute("data-width"))).toBe(
    "regular",
  );
  await inCardBody(TITLE, () => document.fonts.ready.then(() => null));
  const scroller = inShown("[data-card-body]");
  const overflow = () => scroller.scrollHeight - scroller.clientHeight;
  const reshape = (height: number) =>
    inCardBody(
      TITLE,
      (next) => {
        const svg = document.querySelector<SVGSVGElement>("svg[role=img]");
        if (!svg) throw new Error("The card drew no drawing");
        svg.viewBox.baseVal.height = next;
        svg.firstElementChild?.setAttribute("height", String(next));
        return null;
      },
      height,
    );
  const drawing = () =>
    inCardBody(TITLE, () => {
      const svg = document.querySelector<SVGSVGElement>("svg[role=img]");
      if (!svg) throw new Error("The card drew no drawing");
      const box = svg.getBoundingClientRect();
      return { width: box.width, height: box.height, units: svg.viewBox.baseVal.width };
    });

  // The drawing's height follows its width, and a scrollbar takes width from
  // it. Proportions that fill the cap halfway between the drawing's widths
  // with and without the scrollbar leave the body fitting with the scrollbar
  // and overflowing without it: the threshold. Read the cap with the drawing
  // taller than the window, so the reading holds wherever the cap and chrome
  // move.
  await reshape(2 * innerHeight);
  await expect.poll(overflow).toBeGreaterThan(0);
  const cap = await settled(async () => ({
    height: scroller.clientHeight,
    content: scroller.scrollHeight,
    scrollbar: scroller.offsetWidth - scroller.clientWidth,
    drawing: await drawing(),
  }));
  expect(cap.scrollbar, "the overflowing body takes the scrollbar's width").toBeGreaterThan(0);
  const rest = cap.content - cap.drawing.height;
  const threshold =
    (cap.drawing.units * (cap.height - rest)) / (cap.drawing.width + cap.scrollbar / 2);
  // How much taller the drawing is when the scrollbar's width comes back.
  const growth = (cap.scrollbar * threshold) / cap.drawing.units;
  await reshape(threshold);

  const card = scroller.parentElement;
  if (!card) throw new Error("The card's scroll surface has no card");
  const samples: string[] = [];
  let last = { scrollHeight: 0 };
  for (let paint = 0; paint < SAMPLED_PAINTS; paint++) {
    await nextFrame();
    const box = iframe.getBoundingClientRect();
    last = { scrollHeight: scroller.scrollHeight };
    samples.push(
      JSON.stringify({
        width: box.width,
        height: box.height,
        cardHeight: card.getBoundingClientRect().height,
        scrollerWidth: scroller.clientWidth,
        scrollerHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
      }),
    );
  }
  const tail = samples.slice(-SETTLED_PAINTS);
  const changes = tail.reduce((n, sample, i) => n + Number(i > 0 && sample !== tail[i - 1]), 0);
  expect(changes, `unchanged card must settle across ${SETTLED_PAINTS} consecutive paints`).toBe(0);
  // It settled at the threshold: the body fits its cap with the scrollbar's
  // width taken, by less than the drawing grows without it.
  expect(last.scrollHeight, "the body fits with the scrollbar's width taken").toBeLessThanOrEqual(
    cap.height,
  );
  expect(last.scrollHeight + growth, "the body overflows at its full width").toBeGreaterThan(
    cap.height,
  );

  const boundary = iframe.getBoundingClientRect();
  // Make the same drawing taller. The frame must still follow its body, with
  // one outer scroll surface, not a cap or suppressed resize reports.
  await reshape(3 * threshold);
  await expect.poll(overflow).toBeGreaterThan(0);
  await expect.poll(() => iframe.clientHeight).toBeGreaterThan(boundary.height);
  await expect
    .poll(() => inCardBody(TITLE, () => document.documentElement.scrollHeight - window.innerHeight))
    .toBeLessThanOrEqual(1);
  await expect.poll(() => iframe.getBoundingClientRect().width).toBe(boundary.width);
  scroller.scrollTop = scroller.scrollHeight;
  await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);

  // Shorten it again: overflow goes away but content width must not change.
  await reshape(threshold / 2);
  await expect.poll(overflow).toBe(0);
  await expect.poll(() => iframe.clientHeight).toBeLessThan(boundary.height);
  await expect.poll(() => iframe.getBoundingClientRect().width).toBe(boundary.width);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
