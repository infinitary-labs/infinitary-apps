import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { PICTURE_GROUP_CLASS } from "../../src/core/pi/cardImages";
import { cardFileSavedWords } from "../../src/renderer/src/cards/cardFileWords";
import { pictureHint, pictureSize } from "../../src/renderer/src/design/cards/pictureViewerWords";
import { CARD_PICTURE_HOST, parseCardPictureFileName } from "../../src/shared/cardPictures";
import { APP_FRAME_SCHEME } from "../../src/shared/csp";
import * as m from "../../src/shared/i18n/messages.generated";
import { PICTURE_STRIP_SHOWN } from "../../src/shared/plugins/bridge";
import { cardBody, cardBodyElement, cardBodySelector } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { pseudoBox, within } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  encodeInBrowser,
  FIRST_GROUP,
  INLINE_PICTURE,
  SECOND_GROUP,
  TALL_PICTURE,
  WIDE_PICTURE,
  WORKING_COPY_PICTURES,
} from "./pictureFixtures";
import { promptInput } from "./prompt";
import {
  CARD_DIAGRAM,
  CARD_PICTURES_PROMPT_MARKER,
  cardPictures,
  PICTURE_CARD_TITLES,
} from "./scenarios/cardPictures";
import { clickInBody, pager, showCard, shownCard } from "./stack";
import { focusOn, pressWindowKey } from "./windowKeys";

/**
 * The picture viewer, card pictures phase 3 of the locked plan: the binding
 * test. A crewmate names real files from its working copy in its card bodies
 * - the real card path - and a click on any picture in the body's frame
 * reaches the host over the bridge's `image` message and opens the viewer on
 * that picture's group: the `figure.inf-pictures` it sits in, else the
 * picture alone. Each set is read back off the viewer itself - its count,
 * caption and thumbnails - and the keys, 1:1 with pan, the three ways out,
 * reduced motion and both themes are driven for real.
 */

let launched: LaunchedApp;

function body(page: Page, title: string): FrameLocator {
  return cardBody(page, title);
}

function viewer(page: Page) {
  return page.getByRole("dialog", { name: /^Pictures from / });
}

async function readViewer(page: Page) {
  const dialog = viewer(page);
  await expect(dialog).toBeVisible();
  const shown = dialog.locator("[data-picture-image]");
  await expect.poll(() => shown.evaluate((image: HTMLImageElement) => image.complete)).toBe(true);
  return {
    name: await dialog.getAttribute("aria-label"),
    count: (await dialog.locator("[data-picture-count]").textContent()) ?? "",
    caption: (await dialog.locator("[data-picture-caption]").textContent()) ?? "",
    hint: (await dialog.locator("[data-picture-hint]").textContent()) ?? "",
    src: await shown.getAttribute("src"),
    thumbnails: await dialog
      .locator("[data-picture-thumbs] button")
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))),
    current: await dialog
      .locator("[data-picture-thumbs] button[aria-current='true']")
      .evaluateAll((buttons) => buttons[0]?.getAttribute("aria-label") ?? null),
  };
}

/**
 * Clicks the `nth` picture of the frame's `group`-th group (or of the whole
 * body, with no group), played in the frame (`clickInBody`), where the
 * bridge's own listener takes it.
 */
async function clickPicture(page: Page, title: string, nth: number, group?: number) {
  await showCard(page, title);
  const frame = body(page, title);
  const scope =
    group === undefined
      ? frame.locator("body")
      : frame.locator(`figure.${PICTURE_GROUP_CLASS}`).nth(group);
  const picture = scope.locator(group === undefined ? "img" : ":scope > img").nth(nth);
  await expect(picture).toBeVisible();
  await clickInBody(picture);
}

async function closeWithEscape(page: Page) {
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [cardPictures] });
  const { page } = launched;
  await encodeInBrowser(page, WORKING_COPY_PICTURES);
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${CARD_PICTURES_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(pager(page, 4)).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await launched.close();
});

test("a click in each of two groups opens the viewer on that group alone", async () => {
  const { page } = launched;
  const title = PICTURE_CARD_TITLES.groups;

  // The first group's second picture: a thumbnail, and a JPEG.
  await clickPicture(page, title, 1, 0);
  const first = await readViewer(page);
  expect(first.count).toBe(`2 / ${FIRST_GROUP.length}`);
  expect(first.caption).toBe(FIRST_GROUP[1]?.alt);
  expect(first.thumbnails).toEqual(FIRST_GROUP.map((p, i) => `Picture ${i + 1}: ${p.alt}`));
  expect(first.current).toBe(`Picture 2: ${FIRST_GROUP[1]?.alt}`);
  // The very copy the frame shows, served by the host.
  const frameSrc = await body(page, title)
    .locator(`figure.${PICTURE_GROUP_CLASS}`)
    .first()
    .locator(":scope > img")
    .nth(1)
    .evaluate((image: HTMLImageElement) => image.src);
  expect(first.src).toBe(frameSrc);
  await closeWithEscape(page);

  // The second group's lead: the other set, and none of the first.
  await clickPicture(page, title, 0, 1);
  const second = await readViewer(page);
  expect(second.count).toBe(`1 / ${SECOND_GROUP.length}`);
  expect(second.caption).toBe(WIDE_PICTURE.alt);
  expect(second.thumbnails).toEqual(SECOND_GROUP.map((p, i) => `Picture ${i + 1}: ${p.alt}`));
  await closeWithEscape(page);
});

test("the +N tile opens its group at the first picture the strip does not show", async () => {
  const { page } = launched;
  const title = PICTURE_CARD_TITLES.groups;
  await showCard(page, title);
  // The second group is the one its wide lead leads.
  const frame = body(page, title);
  const group = frame
    .getByRole("figure")
    .filter({ has: frame.getByRole("img", { name: WIDE_PICTURE.alt, exact: true }) });
  await expect(group.getByRole("img").first()).toBeVisible();
  // The tile is the figure's ::after: it has no element of its own, so a
  // click at its middle - wherever it paints at this card's width, beside
  // the last thumbnail or on the line under it - lands on the figure
  // itself, dispatched in the frame at that point.
  const tile = await pseudoBox(group, "::after");
  if (!tile) throw new Error("the second group has no +N tile");
  // A press on the figure, which takes no focus, focuses its frame.
  await focusOn(cardBodyElement(page, title));
  await group.evaluate(
    (figure, point) => {
      figure.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    },
    { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 },
  );
  const opened = await readViewer(page);
  // The strip shows PICTURE_STRIP_SHOWN pictures; the tile opens the next one.
  expect(opened.count).toBe(`${PICTURE_STRIP_SHOWN + 1} / ${SECOND_GROUP.length}`);
  expect(opened.caption).toBe(SECOND_GROUP[PICTURE_STRIP_SHOWN]?.alt);
  await closeWithEscape(page);
});

test("a lone picture and a body's own data: picture each open alone", async () => {
  const { page } = launched;
  const title = PICTURE_CARD_TITLES.mixed;
  await clickPicture(page, title, 0);
  const inline = await readViewer(page);
  expect(inline.src?.startsWith("data:image/png;base64,")).toBe(true);
  expect(inline.caption).toBe(INLINE_PICTURE.alt);
  // A group of one counts nothing; its header says its size instead.
  expect(inline.count).toBe(pictureSize(INLINE_PICTURE));
  expect(inline.thumbnails).toEqual([]);
  await expect(viewer(page).getByRole("button", { name: "Next picture" })).toHaveCount(0);
  await closeWithEscape(page);
  await clickPicture(page, title, 2);
  const tall = await readViewer(page);
  expect(tall.caption).toBe(TALL_PICTURE.alt);
  expect(tall.count).toBe(pictureSize(TALL_PICTURE));
  await closeWithEscape(page);
});

test("keys move within the group and never page the stack", async () => {
  const { page } = launched;
  await clickPicture(page, PICTURE_CARD_TITLES.groups, 0, 1);
  const stackPager = pager(page, 4);
  const stackBefore = await stackPager.getAttribute("data-pager-position");
  const count = viewer(page).locator("[data-picture-count]");
  const last = SECOND_GROUP.length;
  // The viewer takes focus once it has drawn; a key before that is the stack's.
  await expect
    .poll(() =>
      viewer(page).evaluate((dialog) => dialog.contains(dialog.ownerDocument.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(count).toHaveText(`1 / ${last}`);
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`2 / ${last}`);
  await expect(viewer(page).locator("[data-picture-caption]")).toHaveText(
    SECOND_GROUP[1]?.alt ?? "",
  );
  await page.keyboard.press("End");
  await expect(count).toHaveText(`${last} / ${last}`);
  await expect(viewer(page).getByRole("button", { name: "Next picture" })).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(count).toHaveText(`${last} / ${last}`);
  await page.keyboard.press("Home");
  await expect(count).toHaveText(`1 / ${last}`);
  await expect(viewer(page).getByRole("button", { name: "Previous picture" })).toBeDisabled();
  await viewer(page).getByRole("button", { name: "Next picture" }).click();
  await expect(count).toHaveText(`2 / ${last}`);
  await viewer(page)
    .getByRole("button", { name: `Picture 5: ${SECOND_GROUP[4]?.alt}` })
    .click();
  await expect(count).toHaveText(`5 / ${last}`);
  await expect(stackPager).toHaveAttribute("data-pager-position", stackBefore ?? "");
  await closeWithEscape(page);
});

async function pictureGeometry(page: Page) {
  return viewer(page).evaluate((dialog) => {
    const row = dialog.querySelector("[data-picture-row]") as HTMLElement;
    const button = dialog.querySelector("[data-picture]") as HTMLElement;
    const image = button.querySelector("[data-picture-image]") as HTMLImageElement;
    const picture = image.getBoundingClientRect();
    const frame = button.getBoundingClientRect();
    return {
      row: row.getBoundingClientRect().toJSON() as DOMRect,
      button: frame.toJSON() as DOMRect,
      picture: picture.toJSON() as DOMRect,
      pressed: button.getAttribute("aria-pressed"),
      offset: { x: picture.left - frame.left, y: picture.top - frame.top },
    };
  });
}

test("a click, Z, Enter or Space toggles 1:1, and a drag or the wheel moves the picture", async () => {
  const { page } = launched;
  await clickPicture(page, PICTURE_CARD_TITLES.wide, 0);
  const opened = await readViewer(page);
  expect(opened.hint).toBe(pictureHint(WIDE_PICTURE, "fitted"));

  const fitted = await pictureGeometry(page);
  expect(fitted.pressed).toBe("false");
  expect(within(fitted.picture, fitted.row)).toEqual([]);

  await page.keyboard.press("z");
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "true");
  await expect(viewer(page).locator("[data-picture-hint]")).toHaveText(
    pictureHint(WIDE_PICTURE, "one"),
  );
  const one = await pictureGeometry(page);
  expect(one.picture.width).toBeGreaterThan(fitted.picture.width);

  const start = {
    x: one.button.left + one.button.width / 2,
    y: one.button.top + one.button.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 150, start.y + 40, { steps: 5 });
  await page.mouse.up();
  const dragged = await pictureGeometry(page);
  expect(dragged.offset.x).toBeLessThan(one.offset.x);
  // The drag was not a click: still at 1:1.
  expect(dragged.pressed).toBe("true");
  await page.screenshot({ path: test.info().outputPath("card-pictures-wide-1to1-dark.png") });

  await page.mouse.wheel(100, 0);
  await expect
    .poll(async () => (await pictureGeometry(page)).offset.x)
    .toBeLessThan(dragged.offset.x);
  await page.keyboard.press("Enter");
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press(" ");
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "true");
  await viewer(page).locator("[data-picture]").click();
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "false");
  await viewer(page).locator("[data-picture]").click();
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "true");
  await closeWithEscape(page);

  // Another picture always opens fitted.
  await clickPicture(page, PICTURE_CARD_TITLES.wide, 0);
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "false");
  await closeWithEscape(page);
});

// INF-3107 (the captain's Approve and build): a diagram drawn in a card opens in the same viewer, as a drawing that
// fills the room there is, and Z goes to its own size.
test("a click or Enter on a diagram opens it fitted and enlarged, and Z shows its own size", async () => {
  const { page } = launched;
  const title = PICTURE_CARD_TITLES.mixed;
  await showCard(page, title);
  const diagram = body(page, title).getByRole("img", { name: "Card, card page and viewer" });
  await expect(diagram).toBeVisible();
  await clickInBody(diagram);
  const opened = await readViewer(page);
  expect(opened.caption).toBe(CARD_DIAGRAM.caption);
  expect(opened.count).toBe(pictureSize(CARD_DIAGRAM));
  expect(opened.hint).toBe(pictureHint(CARD_DIAGRAM, "fitted"));
  const fitted = await pictureGeometry(page);
  expect(within(fitted.picture, fitted.row)).toEqual([]);
  // Its words keep the card's look: the label is in the drawing the viewer shows.
  expect(decodeURIComponent(opened.src ?? "")).toContain(`>${CARD_DIAGRAM.label}</text>`);

  await page.keyboard.press("z");
  await expect(viewer(page).locator("[data-picture]")).toHaveAttribute("aria-pressed", "true");
  expect((await readViewer(page)).hint).toBe(pictureHint(CARD_DIAGRAM, "one"));
  // Fitted, it was drawn larger than its own size, since a drawing stays sharp.
  const own = await pictureGeometry(page);
  expect(own.picture.width).toBeLessThan(fitted.picture.width);
  await closeWithEscape(page);

  await focusOn(diagram);
  await page.keyboard.press("Enter");
  await expect(viewer(page).locator("[data-picture-caption]")).toHaveText(CARD_DIAGRAM.caption);
  await closeWithEscape(page);
});

// INF-6347's approved plan: a right-click on the picture opens its menu, whose Copy puts the
// picture's own pixels on the clipboard and whose Save, or ⌘S, keeps its own file in Downloads.
test("a right-click opens the picture's menu: Copy, Save to Downloads, and Esc closes only the menu", async () => {
  const { app, page, userDataDir } = launched;
  const title = PICTURE_CARD_TITLES.wide;
  await clickPicture(page, title, 0);
  const opened = await readViewer(page);
  const menu = page.getByRole("menu", { name: m.uiPictureViewerMenu() });
  const geometry = await pictureGeometry(page);
  // A press lands on a whole pixel, which is where the window says it was.
  const inside = {
    x: Math.round(geometry.button.left + geometry.button.width / 3),
    y: Math.round(geometry.button.top + geometry.button.height / 2),
  };

  // The space around the picture opens nothing.
  await page.mouse.click(inside.x, geometry.row.top + 4, { button: "right" });
  await expect(menu).toHaveCount(0);
  await expect(viewer(page)).toBeVisible();

  await page.mouse.click(inside.x, inside.y, { button: "right" });
  await expect(menu).toBeVisible();
  // Each item's key is drawn beside it but kept out of its name.
  const names = [
    m.uiPictureViewerCopyPicture(),
    m.uiPictureViewerSaveToDownloads(),
    m.uiPictureViewerActualSize(),
    // The card takes a reply, so its viewer offers Point at, and its menu does too.
    m.cardNotePointAt(),
  ];
  await expect(menu.getByRole("menuitem")).toHaveCount(names.length);
  for (const [i, name] of names.entries())
    await expect(menu.getByRole("menuitem").nth(i)).toHaveAccessibleName(name);
  // It opens where the press was, its first item focused.
  const panel = await menu.boundingBox();
  expect(panel?.x).toBe(inside.x);
  expect(panel?.y).toBe(inside.y);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(viewer(page)).toBeVisible();

  // Save keeps the picture's own file, named for the card.
  const downloads = await app.evaluate(({ app: electron }) => electron.getPath("downloads"));
  const savedAs = `${title}.png`;
  const kept = (opened.src ?? "").slice(`${APP_FRAME_SCHEME}://${CARD_PICTURE_HOST}/`.length);
  const keptFile = parseCardPictureFileName(kept);
  if (!keptFile) throw new Error(`not a kept picture: ${opened.src}`);
  const own = readFileSync(
    join(userDataDir, "crewmates", keptFile.taskId, "cards", keptFile.fileName),
  );
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  await page.mouse.click(inside.x, inside.y, { button: "right" });
  await menu.getByRole("menuitem", { name: m.uiPictureViewerSaveToDownloads() }).click();
  await expect(menu).toHaveCount(0);
  await expect(viewer(page).locator("[data-picture-hint]")).toHaveText(cardFileSavedWords(savedAs));
  expect(sha256(readFileSync(join(downloads, savedAs)))).toBe(sha256(own));
  // ⌘S saves it again, under the next free name, never over the first.
  await pressWindowKey(app, "s", ["meta"]);
  const again = `${title} (2).png`;
  await expect(viewer(page).locator("[data-picture-hint]")).toHaveText(cardFileSavedWords(again));
  expect(existsSync(join(downloads, again))).toBe(true);

  // Native Copy is exercised only on the disposable Linux CI desktop, never this computer's clipboard.
  if (process.platform === "linux" && process.env.CI === "true") {
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.mouse.click(inside.x, inside.y, { button: "right" });
    await menu.getByRole("menuitem", { name: m.uiPictureViewerCopyPicture() }).click();
    await expect(viewer(page).locator("[data-picture-hint]")).toHaveText(m.uiPictureViewerCopied());
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readImage().getSize()))
      .toEqual({ width: WIDE_PICTURE.width, height: WIDE_PICTURE.height });
  }
  await closeWithEscape(page);
});

test("the close control and the backdrop leave too, and focus returns to the card", async () => {
  const { page } = launched;
  const title = PICTURE_CARD_TITLES.tall;
  const bodyFocused = () =>
    page.evaluate(
      (selector) => document.activeElement?.matches(selector) ?? false,
      cardBodySelector(title),
    );

  await clickPicture(page, title, 0);
  await expect(viewer(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("role")))
    .toBe("dialog");
  await closeWithEscape(page);
  expect(await bodyFocused()).toBe(true);

  await clickPicture(page, title, 0);
  await viewer(page).getByRole("button", { name: "Close the viewer" }).click();
  await expect(viewer(page)).toHaveCount(0);
  expect(await bodyFocused()).toBe(true);

  await clickPicture(page, title, 0);
  const row = viewer(page).locator("[data-picture-row]");
  // The row's corner: the backdrop, beside the letterboxed tall picture.
  await row.click({ position: { x: 8, y: 8 } });
  await expect(viewer(page)).toHaveCount(0);
  expect(await bodyFocused()).toBe(true);
  // The card stayed: leaving the viewer is not leaving the card.
  await expect(shownCard(page, title)).toBeVisible();
});

test("under reduced motion the viewer opens without moving", async () => {
  const { page } = launched;
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await clickPicture(page, PICTURE_CARD_TITLES.wide, 0);
    const running = await viewer(page).evaluate(
      (dialog) =>
        dialog.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
    );
    expect(running).toBe(0);
    await expect(viewer(page)).toHaveCSS("opacity", "1");
    await closeWithEscape(page);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
});
