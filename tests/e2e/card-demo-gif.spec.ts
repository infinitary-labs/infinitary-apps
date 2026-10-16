import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { readDemoGif } from "../../src/core/gifFormat";
import { readPicture } from "../../src/core/pictureFormat";
import { GIF_DEMO_TARGET, startDemo } from "./demo";
import { DEMO_CAPTION, DEMO_POSTER, GIF_DEMO_RECORDING } from "./demoFixtures";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { GIF_DEMO_CARD_TITLE, GIF_DEMO_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { clickInBody, showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

/**
 * A GIF demo on a card (docs/card-authoring.md "Demo recordings"): the
 * single-play fallback a crewmate attaches when it could make no MP4. The
 * mock crewmate first names a GIF told to loop, which the host refuses, then
 * the one that plays once, which it keeps. In the card the person sees the
 * poster and a Play button, as for any demo; in the viewer the GIF is drawn
 * only once Play is pressed, Stop takes it away, and at its end the poster
 * returns with Replay. This journey reads what the person reaches and what
 * the player holds, never how either looks.
 */

const SERVED = /^app-frame:\/\/media\/[A-Za-z0-9_-]+-[0-9a-f]{32}\.gif$/;

let launched: LaunchedApp;

function body(page: Page): FrameLocator {
  return cardBody(page, GIF_DEMO_CARD_TITLE);
}

function viewer(page: Page) {
  return page.getByRole("dialog", { name: `Demo from ${GIF_DEMO_CARD_TITLE}` });
}

/** The animation the viewer draws over the poster while it plays; none at rest. */
function animation(page: Page) {
  return viewer(page).locator("img[data-demo-animation]");
}

/** The viewer's one play control, whatever it reads now. */
function control(page: Page) {
  return viewer(page).getByRole("button", { name: /^(Play|Stop|Replay)$/ });
}

/** Opens the app with the GIF demo card up, for the journeys that read the same card. */
async function launchWithCard(): Promise<LaunchedApp> {
  const app = await launchApp({ withMockProvider: true });
  const input = promptInput(app.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${GIF_DEMO_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(shownCard(app.page, GIF_DEMO_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
  return app;
}

test.beforeAll(async () => {
  launched = await launchWithCard();
});

test.afterAll(async () => {
  await launched?.close();
});

test("the host refuses a GIF that loops and keeps the one that plays once, shown as its poster and a Play button", async () => {
  const { page, userDataDir } = launched;
  await showCard(page, GIF_DEMO_CARD_TITLE);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const shown = cards.filter((card) => card.title === GIF_DEMO_CARD_TITLE);
  // One card: the first offer, whose GIF loops, never went up.
  expect(shown).toHaveLength(1);
  const card = shown[0];
  if (!card?.taskId) throw new Error("expected the GIF demo card on a task");
  const poster = card.pictures?.find((picture) => picture.demo);
  expect(poster?.alt).toBe(DEMO_POSTER.alt);
  expect(poster?.demo).toMatchObject({
    kind: "gif",
    width: GIF_DEMO_RECORDING.width,
    height: GIF_DEMO_RECORDING.height,
    durationMs: GIF_DEMO_RECORDING.durationMs,
    bytes: GIF_DEMO_RECORDING.bytes.length,
  });
  // The task keeps the very bytes the crewmate wrote, and only the single-play ones.
  const dir = join(userDataDir, "crewmates", card.taskId, "cards");
  const kept = (await readdir(dir)).filter((name) => name.endsWith(".gif"));
  expect(kept).toEqual([`${poster?.demo?.id}.gif`]);
  expect(await readFile(join(dir, kept[0] ?? ""))).toEqual(GIF_DEMO_RECORDING.bytes);

  const frame = body(page);
  const figure = frame.locator("figure[data-inf-demo]");
  await expect(figure).toHaveAttribute("data-inf-demo", SERVED);
  await expect(figure.getByRole("img", { name: DEMO_POSTER.alt })).toBeVisible();
  await expect(figure.getByRole("button", { name: "Play the demo, 3 seconds" })).toBeVisible();
  await expect(figure.locator("figcaption")).toHaveText(DEMO_CAPTION);
  // Nothing moves on arrival: the GIF itself is loaded nowhere until a press.
  await expect(frame.locator('img[src^="app-frame://media/"]')).toHaveCount(0);
  await expect(page.locator('img[src^="app-frame://media/"]')).toHaveCount(0);
});

test("Play draws the GIF once in the viewer, Stop takes it away, its end returns the poster with Replay, and Esc returns to the button", async () => {
  test.setTimeout(90_000);
  const { page } = launched;
  await showCard(page, GIF_DEMO_CARD_TITLE);
  await pressKey(body(page).getByRole("button", { name: "Play the demo, 3 seconds" }), "Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator("[data-picture-caption]")).toHaveText(DEMO_CAPTION);
  await expect(viewer(page).locator("[data-picture-count]")).toHaveText("0:03");
  // A GIF cannot seek: Play, Stop and Replay are its only control.
  await expect(viewer(page).getByRole("slider")).toHaveCount(0);

  // Opened from Play, it plays at once: the host's copy, from its first frame, decoded.
  await expect(animation(page)).toHaveCount(1);
  await expect(animation(page)).toHaveAttribute("src", /\.gif\?play=1$/);
  await expect
    .poll(() => animation(page).evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(GIF_DEMO_RECORDING.width);
  await expect(control(page)).toHaveAccessibleName("Stop");
  await expect(control(page)).toBeFocused();

  // Stop takes the animation away and leaves the poster, at the start.
  await page.keyboard.press("Space");
  await expect(animation(page)).toHaveCount(0);
  await expect(control(page)).toHaveAccessibleName("Play");
  await expect(viewer(page).locator("[data-demo-time]")).toHaveText("0:00 / 0:03");

  // Play draws it again from its first frame; at its end the poster returns with Replay.
  await page.keyboard.press("Enter");
  await expect(animation(page)).toHaveAttribute("src", /\.gif\?play=2$/);
  await expect(control(page)).toHaveAccessibleName("Replay", { timeout: 15_000 });
  await expect(animation(page)).toHaveCount(0);
  await expect(viewer(page).locator("[data-demo-time]")).toHaveText("0:03 / 0:03");

  // Replay plays it once more.
  await page.keyboard.press("Enter");
  await expect(animation(page)).toHaveAttribute("src", /\.gif\?play=3$/);
  await expect(control(page)).toHaveAccessibleName("Stop");

  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator('img[src^="app-frame://media/"]')).toHaveCount(0);
  // Back on the Play button inside the card that opened it.
  await expect
    .poll(() =>
      cardBody(page, GIF_DEMO_CARD_TITLE).locator(":focus").getAttribute("data-inf-demo-play"),
    )
    .toBe("");
});

test("the poster opens the viewer resting on it with nothing loaded, and hiding the app stops the GIF", async () => {
  const { page } = launched;
  await showCard(page, GIF_DEMO_CARD_TITLE);
  const posterSrc = await body(page)
    .getByRole("img", { name: DEMO_POSTER.alt })
    .evaluate((image: HTMLImageElement) => image.src);
  await clickInBody(body(page).getByRole("img", { name: DEMO_POSTER.alt }));
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator("img[data-demo-poster]")).toHaveAttribute("src", posterSrc);
  await expect(animation(page)).toHaveCount(0);
  await expect(control(page)).toHaveAccessibleName("Play");

  await pressKey(control(page), "Enter");
  await expect(animation(page)).toHaveCount(1);
  await expect(control(page)).toHaveAccessibleName("Stop");

  // The window hidden stops it, and nothing plays it again until a press.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(animation(page)).toHaveCount(0);
  await expect(control(page)).toHaveAccessibleName("Play");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(animation(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a GIF made by the demo helper's fallback is one the card check accepts", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // A recording of its own app: this journey owns its prerequisites.
  const demo = await startDemo({ withMockProvider: true, size: { width: 1280, height: 800 } });
  const { page } = demo.launched;
  try {
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${GIF_DEMO_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(shownCard(page, GIF_DEMO_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
    await showCard(page, GIF_DEMO_CARD_TITLE);
    const play = body(page).getByRole("button", { name: "Play the demo, 3 seconds" });
    await play.scrollIntoViewIfNeeded();
    // The whole window: the viewer the press opens covers it.
    await demo.record("Press Play on the GIF demo and watch it play once", "window", async () => {
      await pressKey(play, "Enter");
      await expect(control(page)).toHaveAccessibleName("Replay", { timeout: 15_000 });
    });
  } catch (error) {
    await demo.launched.close();
    throw error;
  }
  const files = await demo.finish({
    dir: testInfo.outputPath("demo"),
    name: "card-demo-gif-play",
    format: "gif",
  });
  expect(files.format).toBe("gif");
  expect(files.recording).toMatch(/\.gif$/);

  // The host's own walk of it: a single-play GIF within the GIF demo limits.
  const bytes = await readFile(files.recording);
  expect(bytes.length).toBeLessThanOrEqual(GIF_DEMO_TARGET.bytes);
  const read = readDemoGif(bytes);
  if (!read.ok) throw new Error(read.reason);
  // biome-ignore lint/plugin/e2e-measured-box: Encoded GIF limits are the attachment contract, not its on-screen size.
  expect(Math.max(read.gif.width, read.gif.height)).toBeLessThanOrEqual(GIF_DEMO_TARGET.width);
  // biome-ignore lint/plugin/e2e-measured-box: Encoded GIF limits are the attachment contract, not its on-screen size.
  expect(Math.min(read.gif.width, read.gif.height)).toBeLessThanOrEqual(GIF_DEMO_TARGET.height);
  // The action's own length - a 3-second GIF played once - plus its lead and tail.
  expect(read.gif.durationMs).toBeGreaterThan(3_000);
  expect(read.gif.durationMs).toBeLessThanOrEqual(GIF_DEMO_TARGET.seconds * 1000);
  expect(read.gif.frames).toBe(read.gif.durationMs / 100);
  // Its poster is a picture of the GIF's own size.
  expect(readPicture(await readFile(files.poster))?.size).toEqual({
    width: read.gif.width,
    height: read.gif.height,
  });
  const manifest = JSON.parse(await readFile(files.manifest, "utf8"));
  expect(manifest).toMatchObject({ format: "gif", durationMs: read.gif.durationMs });
});
