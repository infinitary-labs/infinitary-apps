import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { intersects, type Rect, within } from "./layout";
import {
  bodyDrawn,
  cardFactsFrame,
  inCardBody,
  inFrameTitled,
  SHOWN_ENTRY,
  stageAtRest,
} from "./stack";
import { openWindow } from "./window";

/**
 * A completion card shows each changed view as it stood under Before and as
 * it is under After, as many pictures as the change needs (contract v4.69).
 * Each picture is a file the crewmate wrote, verified and kept by the core;
 * this test reads where the person finds each picture, never how the card
 * looks, and that the settle facts stay beside the merge button while the
 * long body scrolls.
 */

const TITLE = "The meter row and transcript read at a glance";
const MERGE = "Put it in";

const view = (
  path: string,
  alt: string,
  width: number,
  height: number,
  caption: string,
  fresh = false,
) => ({ picture: { path, alt, width, height }, caption, fresh });
const BEFORE = [
  view("shots/meters-before.png", "The meter row, before", 1200, 420, "The meter row"),
  view("shots/transcript-before.png", "The transcript, before", 1200, 700, "The transcript"),
];
const AFTER = [
  view("shots/meters-after.png", "The meter row, after", 1200, 420, "The meter row"),
  view("shots/transcript-after.png", "The transcript, after", 1200, 700, "The transcript"),
  view("shots/history-after.png", "The history list, new", 1200, 600, "The history list", true),
];

const inWindow = (box: Rect, frame: Element): Rect => {
  const at = frame.getBoundingClientRect();
  return { ...box, x: box.x + at.x, y: box.y + at.y };
};

const scroller = () => document.querySelector<HTMLElement>(`${SHOWN_ENTRY} [data-card-body]`);

test("a completion card's pictures are reachable in order and its facts stay beside the merge button", async () => {
  const bridge = fakeBridge(
    await seededHome({ title: TITLE, merge: MERGE, before: BEFORE, after: AFTER }),
  );
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  const frame = await bodyDrawn(TITLE);
  await stageAtRest();

  // Section: two before pictures and three after pictures, one new, are all
  // reachable in order at the smallest window. In document order, each
  // picture sits under the heading it belongs to.
  const found = await inCardBody(TITLE, () =>
    [...document.images].map((image) => {
      let heading = "";
      for (let node: Element | null = image; node && !heading; node = node.parentElement) {
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.tagName === "H3") {
            heading = sib.textContent ?? "";
            break;
          }
        }
      }
      return {
        alt: image.alt,
        section: heading,
        fresh: image.closest("[data-inf-new]") !== null,
      };
    }),
  );
  expect(found).toEqual([
    ...BEFORE.map((each) => ({ alt: each.picture.alt, section: "Before", fresh: false })),
    ...AFTER.map((each) => ({
      alt: each.picture.alt,
      section: "After",
      fresh: each.fresh,
    })),
  ]);

  // Each one is reachable: scrolled to, it shows inside the card's body,
  // decoded to the size the crewmate wrote, each below the one before.
  let previousTop = Number.NEGATIVE_INFINITY;
  for (const { picture } of [...BEFORE, ...AFTER]) {
    const read = await inCardBody(
      TITLE,
      async (alt) => {
        const image = [...document.images].find((each) => each.alt === alt);
        if (!image) throw new Error(`The body drew no picture called ${alt}`);
        await image.decode();
        const box = image.getBoundingClientRect();
        return {
          size: [image.naturalWidth, image.naturalHeight],
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      },
      picture.alt,
    );
    expect(read.size, picture.alt).toEqual([picture.width, picture.height]);
    expect(read.box.width * read.box.height, `${picture.alt} draws`).toBeGreaterThan(0);
    const outer = scroller();
    if (!outer) throw new Error("The card drew no body scroller");
    // Scrolled to: the card's one scroll surface brings the picture into its view.
    outer.scrollTop += inWindow(read.box, frame).y - outer.getBoundingClientRect().y;
    await stageAtRest();
    const box = inWindow(read.box, frame);
    expect(within(box, frame.getBoundingClientRect()), picture.alt).toEqual([]);
    expect(intersects(box, outer.getBoundingClientRect()), `${picture.alt} in view`).toBe(true);
    expect(read.box.y).toBeGreaterThan(previousTop);
    previousTop = read.box.y;
  }

  const marked = await inCardBody(TITLE, () => {
    const figures = [...document.querySelectorAll("[data-inf-new]")];
    const tag = (el: Element) => {
      const generated = getComputedStyle(el, "::before");
      if (generated.content === "none" || generated.display === "none") return null;
      // A generated box is not in the DOM: a hidden probe anchored to it is measured instead.
      const mark = "data-browser-pseudo-box";
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`[${mark}]::before { anchor-name: --browser-pseudo-box; }`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      el.setAttribute(mark, "");
      const probe = document.createElement("div");
      probe.style.cssText =
        "position: fixed; visibility: hidden; margin: 0; position-anchor: --browser-pseudo-box;" +
        " left: anchor(left); top: anchor(top);" +
        " width: anchor-size(width); height: anchor-size(height);";
      document.documentElement.append(probe);
      const box = probe.getBoundingClientRect();
      probe.remove();
      el.removeAttribute(mark);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((each) => each !== sheet);
      return { width: box.width, height: box.height };
    };
    return figures.map((figure) => ({
      pictures: [...figure.querySelectorAll("img")].map((image) => image.alt),
      tag: tag(figure),
    }));
  });
  const fresh = AFTER.find((each) => each.fresh)?.picture.alt;
  expect(marked.map((each) => each.pictures)).toEqual([[fresh]]);
  const tag = marked[0]?.tag;
  expect(tag, "the new view draws its New tag").not.toBeNull();
  expect(tag?.width ?? 0).toBeGreaterThan(0);
  expect(tag?.height ?? 0).toBeGreaterThan(0);

  // Section: the facts stay in view beside the merge button while the long
  // body scrolls, in a short window and a tall one.
  for (const size of [SMALLEST_WINDOW, { width: 1280, height: 1100 }]) {
    await page.viewport(size.width, size.height);
    await stageAtRest();
    const outer = scroller();
    if (!outer) throw new Error("The card drew no body scroller");
    // The body is longer than the card and still scrolls...
    expect(outer.scrollHeight, `the body scrolls at ${size.width}x${size.height}`).toBeGreaterThan(
      outer.clientHeight,
    );
    for (const end of ["top", "bottom"] as const) {
      outer.scrollTop = end === "top" ? 0 : outer.scrollHeight;
      await stageAtRest();
      // ...while the facts stay whole on the card, never under the body.
      const facts = cardFactsFrame(TITLE);
      const surface = document.querySelector("[data-card-layer] [data-card-presentation]");
      if (!facts || !surface) throw new Error("The card drew no facts");
      const read = await inFrameTitled(`${TITLE} facts`, () => {
        const strip = document.querySelector("[data-facts]")?.getBoundingClientRect();
        const project = document.querySelector('[data-fact="project"]')?.getBoundingClientRect();
        return {
          strip: strip && { x: strip.x, y: strip.y, width: strip.width, height: strip.height },
          project: (project?.width ?? 0) * (project?.height ?? 0) > 0,
        };
      });
      if (!read.strip) throw new Error("The facts frame drew no strip");
      const strip = inWindow(read.strip, facts);
      const where = `facts at the ${end}, ${size.width}x${size.height}`;
      expect(within(strip, surface.getBoundingClientRect()), where).toEqual([]);
      expect(intersects(strip, outer.getBoundingClientRect()), where).toBe(false);
      expect(read.project, `the project shows, ${where}`).toBe(true);
      await expect.element(page.getByRole("button", { name: MERGE, exact: true })).toBeInViewport();
    }
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
