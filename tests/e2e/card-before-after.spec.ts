import { expect, test } from "@playwright/test";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { intersects, minimumWindowSize, pseudoBox, resizeWindow, settled, within } from "./layout";
import {
  BEFORE_AFTER_CARD_TITLE,
  BEFORE_AFTER_NEW_PICTURE,
  BEFORE_AFTER_PROMPT_MARKER,
  SPAWN_PROMPT_MARKER,
} from "./mockProvider";
import { CHANGE_AFTER_PICTURES, CHANGE_BEFORE_PICTURES } from "./pictureFixtures";
import { promptInput } from "./prompt";
import { cardScroller, cardSurface, completionAction, factsStrip, shownCard } from "./stack";

/**
 * A completion card shows each changed view as it stood under Before and as
 * it is under After, as many pictures as the change needs (contract v4.69).
 * The crewmate writes real files and offers a merge through the real tool
 * and its card check; this journey reads where the person finds each picture,
 * never how the card looks.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${BEFORE_AFTER_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(shownCard(launched.page, BEFORE_AFTER_CARD_TITLE)).toBeVisible({
    timeout: 30_000,
  });
  // The card's title shows while its body's frame still holds the empty
  // document it was born with, and loading the body replaces that document:
  // the journeys read the body once it has drawn (docs/renderer.md).
  await expect(cardBodyElement(launched.page, BEFORE_AFTER_CARD_TITLE)).toHaveAttribute(
    "data-frame-drawn",
    "",
  );
});

test.afterAll(async () => {
  await launched.close();
});

test("two before pictures and three after pictures, one new, are all reachable in order at the smallest window", async () => {
  const { app, page } = launched;
  const original = await resizeWindow(app, page, await minimumWindowSize(app));
  try {
    const iframe = cardBodyElement(page, BEFORE_AFTER_CARD_TITLE);
    const frame = cardBody(page, BEFORE_AFTER_CARD_TITLE);
    const expected = [
      ...CHANGE_BEFORE_PICTURES.map((p) => ({ alt: p.alt, section: "Before", fresh: false })),
      ...CHANGE_AFTER_PICTURES.map((p, index) => ({
        alt: p.alt,
        section: "After",
        fresh: index === CHANGE_AFTER_PICTURES.length - 1,
      })),
    ];
    // In document order, each picture sits under the heading it belongs to.
    const found = await frame.locator("img").evaluateAll((images) =>
      images.map((image) => {
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
          alt: image.getAttribute("alt") ?? "",
          section: heading,
          fresh: image.closest("[data-inf-new]") !== null,
        };
      }),
    );
    expect(found).toEqual(expected);

    // Each one is reachable: scrolled to, it shows whole inside the card's
    // body, and it decoded to the size the crewmate wrote.
    let previousTop = Number.NEGATIVE_INFINITY;
    for (const picture of [...CHANGE_BEFORE_PICTURES, ...CHANGE_AFTER_PICTURES]) {
      const image = frame.getByRole("img", { name: picture.alt, exact: true });
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      expect(
        await image.evaluate(async (node: HTMLImageElement) => {
          await node.decode();
          return [node.naturalWidth, node.naturalHeight];
        }),
      ).toEqual([picture.width, picture.height]);
      const box = await settled(page, () => image.boundingBox());
      const body = await settled(page, () => iframe.boundingBox());
      if (!box || !body) throw new Error(`${picture.alt} or its card has no box`);
      expect(within(box, body)).toEqual([]);
      const top = await image.evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
      expect(top).toBeGreaterThan(previousTop);
      previousTop = top;
    }

    // Only the new view is marked new, and its New tag is drawn.
    const marked = frame.locator("[data-inf-new]");
    await expect(marked).toHaveCount(1);
    await expect(
      marked.getByRole("img", { name: BEFORE_AFTER_NEW_PICTURE.alt, exact: true }),
    ).toBeVisible();
    await marked.scrollIntoViewIfNeeded();
    const tag = await settled(page, () => pseudoBox(marked, "::before"));
    expect(tag?.width).toBeGreaterThan(0);
    expect(tag?.height).toBeGreaterThan(0);
  } finally {
    await resizeWindow(app, page, original);
  }
});

test("the facts stay in view beside the merge button while the long body scrolls, in a short window and a tall one", async () => {
  const { app, page } = launched;
  const facts = factsStrip(cardBody(page, BEFORE_AFTER_CARD_TITLE));
  const merge = await completionAction(page, BEFORE_AFTER_CARD_TITLE);
  const scroller = cardScroller(page);
  const original = await resizeWindow(app, page, await minimumWindowSize(app));
  try {
    for (const size of [await minimumWindowSize(app), { width: 1280, height: 1100 }]) {
      await resizeWindow(app, page, size);
      // The body is longer than the card and still scrolls...
      expect(await scroller.evaluate((body) => body.scrollHeight > body.clientHeight)).toBe(true);
      for (const end of ["top", "bottom"] as const) {
        await scroller.evaluate((body, to) => {
          body.scrollTop = to === "top" ? 0 : body.scrollHeight;
        }, end);
        // ...while the facts stay whole on the card, never under the body.
        const boxes = await settled(page, async () => ({
          strip: await facts.strip.boundingBox(),
          card: await cardSurface(page).boundingBox(),
          body: await scroller.boundingBox(),
        }));
        if (!boxes.strip || !boxes.card || !boxes.body) throw new Error("The card has no facts");
        expect(within(boxes.strip, boxes.card), `facts at the ${end}`).toEqual([]);
        expect(intersects(boxes.strip, boxes.body), `facts at the ${end}`).toBe(false);
      }
      await expect(facts.project).toBeVisible();
      await expect(merge).toBeVisible();
    }
  } finally {
    await resizeWindow(app, page, original);
  }
});
