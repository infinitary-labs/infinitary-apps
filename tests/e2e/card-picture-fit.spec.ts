import { expect, test } from "@playwright/test";
import { cardBody, cardBodyElement } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, overflows, resizeWindow, settled, within } from "./layout";
import { encodeInBrowser, WIDE_PICTURE, WORKING_COPY_PICTURES } from "./pictureFixtures";
import { promptInput } from "./prompt";
import {
  CARD_PICTURES_PROMPT_MARKER,
  cardPictures,
  PICTURE_CARD_TITLES,
} from "./scenarios/cardPictures";
import { pager, showCard } from "./stack";

/**
 * Pictures in cards, phases 1 and 2 of the locked plan. A picture is markup:
 * a crewmate writes real files into its working copy and names each in its
 * body as `<img src="<path>" alt>` - the real card path - and the host
 * verifies it, keeps its own copy under the task and serves it over the
 * frame scheme, so no picture's bytes ride the body. However wide a picture
 * is, the person sees all of it inside the card. How it is fitted (sizes,
 * thumbnails, groups) is the frame stylesheet's, judged by eye.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [cardPictures] });
  const { page } = launched;
  // The JPEG and WebP the crewmate writes come from the app's own encoder.
  await encodeInBrowser(page, WORKING_COPY_PICTURES);
  const input = promptInput(page);
  await input.click();
  await input.fill(`commission a crewmate: ${CARD_PICTURES_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("a very wide picture shows whole inside its card at the smallest window", async () => {
  const { app, page } = launched;
  const original = await resizeWindow(app, page, await minimumWindowSize(app));
  try {
    const title = PICTURE_CARD_TITLES.wide;
    await showCard(page, title);
    const iframe = cardBodyElement(page, title);
    const picture = cardBody(page, title).getByRole("img", { name: WIDE_PICTURE.alt, exact: true });
    await expect(picture).toBeVisible();
    // The very file the crewmate wrote, decoded in full.
    expect(
      await picture.evaluate(async (image: HTMLImageElement) => {
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }),
    ).toEqual([WIDE_PICTURE.width, WIDE_PICTURE.height]);
    // Nothing of it is cut off: it lies inside the card's body, which has no
    // sideways scroll to hide a part behind.
    const boxes = await settled(page, async () => ({
      picture: await picture.boundingBox(),
      body: await iframe.boundingBox(),
    }));
    if (!boxes.picture || !boxes.body) throw new Error("the wide picture or its card has no box");
    expect(within(boxes.picture, boxes.body)).toEqual([]);
    expect(await overflows(cardBody(page, title).locator(":root"))).toBe(0);
  } finally {
    await resizeWindow(app, page, original);
  }
});
