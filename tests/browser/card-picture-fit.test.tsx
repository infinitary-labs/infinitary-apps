import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { within } from "./layout";
import { bodyDrawn, inCardBody } from "./stack";
import { openWindow } from "./window";

/**
 * Pictures in cards, phases 1 and 2 of the locked plan: a crewmate names a
 * file it wrote in its body, and the core verifies it, keeps its own copy
 * and names that copy with the size it read. However wide a picture is, the
 * person sees all of it inside the card. How it is fitted (sizes, thumbnails,
 * groups) is the frame stylesheet's, judged by eye.
 */

const TITLE = "The whole meter row, at any width";

const WIDE = { path: "shots/wide.png", alt: "The whole meter row", width: 2800, height: 520 };

test("a very wide picture shows whole inside its card at the smallest window", async () => {
  const bridge = fakeBridge(await seededHome({ title: TITLE, picture: WIDE }));
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();
  const frame = await bodyDrawn(TITLE);

  // The very file the crewmate wrote, decoded in full; and nothing of it is
  // cut off: it lies inside the card's body, which has no sideways scroll to
  // hide a part behind.
  const read = await inCardBody(
    TITLE,
    async (alt) => {
      const image = [...document.images].find((each) => each.alt === alt);
      if (!image) throw new Error(`The body drew no picture called ${alt}`);
      await image.decode();
      const box = image.getBoundingClientRect();
      const root = document.documentElement;
      return {
        size: [image.naturalWidth, image.naturalHeight],
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        overflow: Math.max(0, root.scrollWidth - root.clientWidth),
      };
    },
    WIDE.alt,
  );
  expect(read.size).toEqual([WIDE.width, WIDE.height]);
  const body = frame.getBoundingClientRect();
  const picture = { ...read.box, x: read.box.x + body.x, y: read.box.y + body.y };
  expect(within(picture, body)).toEqual([]);
  expect(read.overflow).toBe(0);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
