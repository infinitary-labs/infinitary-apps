import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { readPicture } from "../../src/core/pictureFormat";
import { readDemoVideo } from "../../src/core/videoFormat";
import { RECORDING_UNPLAYABLE } from "../../src/renderer/src/design/cards/pictureViewerWords";
import { scratchDir } from "../helpers/scratchDirs";
import { DEMO_TARGET, startDemo } from "./demo";
import { DEMO_CAPTION, DEMO_POSTER, DEMO_RECORDING } from "./demoFixtures";
import { bodyIn, cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { DEMO_CARD_TITLE, SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import { promptInput } from "./prompt";
import { DEMO_PROMPT_MARKER, demoCard } from "./scenarios/demoCard";
import {
  clickInBody,
  closeQuestion,
  discardAndClose,
  SHOWN_ENTRY,
  showCard,
  shownCard,
} from "./stack";
import { pressKey } from "./windowKeys";

/**
 * A demo recording on a card (docs/card-authoring.md "Demo recordings"). A
 * crewmate writes a real H.264 recording and its poster into its working
 * copy and names them in its completion decision as
 * `<figure data-inf-demo="<recording>"><img src="<poster>">` - the real card
 * path. The host plays a recording in its own decoder before the card goes
 * up, so the crewmate's first recording, whose boxes are sound and whose
 * pictures are filler, is refused, and its second is kept and served. In
 * the card the person sees the poster and a Play button; the recording
 * plays only in the viewer, only on a press. This journey reads what the
 * person reaches and what the player does, never how either looks.
 */

const SERVED = /^app-frame:\/\/media\/[A-Za-z0-9_-]+-[0-9a-f]{32}\.mp4$/;

/** The window a recorded demo is made at: roomier than the demo target, so the recording is fitted to it. */
const WINDOW = { width: 1280, height: 800 };

let launched: LaunchedApp;

function body(page: Page): FrameLocator {
  return cardBody(page, DEMO_CARD_TITLE);
}

function viewer(page: Page) {
  return page.getByRole("dialog", { name: `Demo from ${DEMO_CARD_TITLE}` });
}

/** The viewer's recording, read off the element itself. */
function recording(page: Page) {
  return viewer(page).locator("video[data-demo-video]");
}

async function playerState(page: Page) {
  return recording(page).evaluate((video: HTMLVideoElement) => ({
    paused: video.paused,
    ended: video.ended,
    time: video.currentTime,
    duration: video.duration,
    loop: video.loop,
    error: video.error?.code ?? null,
  }));
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [demoCard] });
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${DEMO_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(shownCard(launched.page, DEMO_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
});

test.afterAll(async () => {
  await launched?.close();
});

test("the host keeps only a recording it could play, and the card shows its poster and a Play button", async () => {
  const { page, userDataDir } = launched;
  await showCard(page, DEMO_CARD_TITLE);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const shown = cards.filter((card) => card.title === DEMO_CARD_TITLE);
  // One card: the first offer, whose recording did not play, never went up.
  expect(shown).toHaveLength(1);
  const card = shown[0];
  if (!card?.taskId) throw new Error("expected the demo card on a task");
  const poster = card.pictures?.find((picture) => picture.demo);
  expect(poster?.alt).toBe(DEMO_POSTER.alt);
  expect(poster?.demo).toMatchObject({
    kind: "mp4",
    width: DEMO_RECORDING.width,
    height: DEMO_RECORDING.height,
    durationMs: DEMO_RECORDING.durationMs,
    bytes: DEMO_RECORDING.bytes.length,
  });
  // The task keeps the very bytes the crewmate wrote, under its own folder.
  const dir = join(userDataDir, "crewmates", card.taskId, "cards");
  const kept = (await readdir(dir)).filter((name) => name.endsWith(".mp4"));
  expect(kept).toEqual([`${poster?.demo?.id}.mp4`]);
  expect(await readFile(join(dir, kept[0] ?? ""))).toEqual(DEMO_RECORDING.bytes);

  // In the body: the poster, a Play button that says how long it plays, the caption.
  const frame = body(page);
  const figure = frame.locator("figure[data-inf-demo]");
  await expect(figure).toHaveAttribute("data-inf-demo", SERVED);
  await expect(figure.getByRole("img", { name: DEMO_POSTER.alt })).toBeVisible();
  await expect(figure.getByRole("button", { name: "Play the demo, 3 seconds" })).toBeVisible();
  await expect(figure.locator("figcaption")).toHaveText(DEMO_CAPTION);
  // Nothing plays on arrival: no player anywhere until a press.
  await expect(frame.locator("video")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
});

test("the Play button plays the demo once in the viewer, Replay plays it again, and Esc returns to the button", async () => {
  const { page } = launched;
  await showCard(page, DEMO_CARD_TITLE);
  const play = body(page).getByRole("button", { name: "Play the demo, 3 seconds" });
  await pressKey(play, "Enter");
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator("[data-picture-caption]")).toHaveText(DEMO_CAPTION);
  await expect(viewer(page).locator("[data-picture-count]")).toHaveText("0:03");

  // It plays from the start, one pass, and stops on its last picture.
  await expect.poll(async () => (await playerState(page)).paused).toBe(false);
  await expect.poll(async () => (await playerState(page)).ended, { timeout: 15_000 }).toBe(true);
  const ended = await playerState(page);
  expect(ended).toMatchObject({ loop: false, error: null });
  expect(ended.duration).toBeCloseTo(DEMO_RECORDING.durationMs / 1000, 0);
  const control = viewer(page).getByRole("button", { name: /^(Play|Pause|Replay)$/ });
  await expect(control).toHaveAccessibleName("Replay");

  // Replay starts it again from the start; Space on the focused control pauses it.
  await pressKey(control, "Enter");
  await expect.poll(async () => (await playerState(page)).paused).toBe(false);
  await expect(control).toHaveAccessibleName("Pause");
  await page.keyboard.press("Space");
  await expect.poll(async () => (await playerState(page)).paused).toBe(true);
  await expect(control).toHaveAccessibleName("Play");

  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  // Back on the Play button inside the card that opened it.
  await expect
    .poll(() =>
      cardBody(page, DEMO_CARD_TITLE).locator(":focus").getAttribute("data-inf-demo-play"),
    )
    .toBe("");
});

test("the poster opens the viewer paused on it, and the slider seeks by keys", async () => {
  const { page } = launched;
  await showCard(page, DEMO_CARD_TITLE);
  await clickInBody(body(page).getByRole("img", { name: DEMO_POSTER.alt }));
  await expect(viewer(page)).toBeVisible();
  const resting = await playerState(page);
  expect(resting).toMatchObject({ paused: true, time: 0 });
  const posterSrc = await body(page)
    .getByRole("img", { name: DEMO_POSTER.alt })
    .evaluate((image: HTMLImageElement) => image.src);
  await expect(recording(page)).toHaveAttribute("poster", posterSrc);

  // The slider is a Tab stop after the play control; a key seeks a second.
  const seek = viewer(page).getByRole("slider", { name: "Seek" });
  await pressKey(seek, "ArrowRight");
  await expect.poll(async () => Math.round((await playerState(page)).time)).toBe(1);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round((await playerState(page)).time)).toBe(0);
  await expect(viewer(page).locator("[data-demo-time]")).toHaveText("0:00 / 0:03");
  // Seeking plays nothing.
  expect((await playerState(page)).paused).toBe(true);
  await page.keyboard.press("Escape");
  await expect(viewer(page)).toHaveCount(0);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a demo of the Play journey, recorded by the demo helper, is one the card check accepts", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // A recording of its own app: this journey owns its prerequisites.
  const demo = await startDemo({ withMockProvider: true, scenarios: [demoCard], size: WINDOW });
  const { page } = demo.launched;
  try {
    const input = promptInput(page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${DEMO_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(shownCard(page, DEMO_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
    await showCard(page, DEMO_CARD_TITLE);
    const play = body(page).getByRole("button", { name: "Play the demo, 3 seconds" });
    await play.scrollIntoViewIfNeeded();
    // The whole window: the viewer the press opens covers it.
    await demo.record("Press Play on the demo and watch it play once", "window", async () => {
      await pressKey(play, "Enter");
      await expect
        .poll(async () => (await playerState(page)).ended, { timeout: 15_000 })
        .toBe(true);
    });
  } catch (error) {
    await demo.launched.close();
    throw error;
  }
  const files = await demo.finish({ dir: testInfo.outputPath("demo"), name: "card-demo-play" });

  // The host's own reading of it: a silent H.264 MP4 within the demo limits.
  const read = readDemoVideo(await readFile(files.recording));
  if (!read.ok) throw new Error(read.reason);
  // The whole window, in its own shape, fitted to the demo target with one side at its edge.
  expect(read.video.width / read.video.height).toBeCloseTo(WINDOW.width / WINDOW.height, 1);
  expect(
    Math.max(read.video.width / DEMO_TARGET.width, read.video.height / DEMO_TARGET.height),
  ).toBeCloseTo(1, 2);
  // The action's own length - a 3-second recording played once - plus its lead and tail.
  expect(read.video.durationMs).toBeGreaterThan(3_000);
  expect(read.video.durationMs).toBeLessThan(15_000);
  // Its poster is a picture of the recording's own size.
  expect(readPicture(await readFile(files.poster))?.size).toEqual({
    width: read.video.width,
    height: read.video.height,
  });
  const manifest = JSON.parse(await readFile(files.manifest, "utf8"));
  expect(manifest).toMatchObject({ format: "mp4", durationMs: read.video.durationMs });
});

test("the demo plays again after the app restarts and from the card once it is closed, and says so once its recording is gone", async () => {
  test.setTimeout(180_000);
  const userDataDir = scratchDir("infinitary-card-demo-restart-");
  const mockProvider = await startMockProvider({ scenarios: [demoCard] });
  let app: LaunchedApp | undefined;
  /** Presses a frame's Play button by key and waits for the recording to play. */
  const playFrom = async (page: Page, frame: FrameLocator) => {
    await pressKey(frame.getByRole("button", { name: "Play the demo, 3 seconds" }), "Enter");
    await expect(viewer(page)).toBeVisible();
    await expect
      .poll(async () => (await playerState(page)).time, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toHaveCount(0);
  };
  try {
    app = await launchApp({ reuseMockProvider: mockProvider, userDataDir });
    const input = promptInput(app.page);
    await input.click();
    await input.fill(`${SPAWN_PROMPT_MARKER} ${DEMO_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(shownCard(app.page, DEMO_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
    await app.close();
    app = undefined;

    // The card comes back with the app, and its recording still plays from the task's folder.
    app = await launchApp({ reuseMockProvider: mockProvider, userDataDir });
    const { page } = app;
    await expect(shownCard(page, DEMO_CARD_TITLE)).toBeVisible({ timeout: 30_000 });
    await showCard(page, DEMO_CARD_TITLE);
    const card = (await page.evaluate(() => window.infinitary.cards.list())).find(
      (open) => open.title === DEMO_CARD_TITLE,
    );
    if (!card) throw new Error("the demo card did not come back");
    await playFrom(page, body(page));

    // Closed, the card reads back as it was, and its demo plays there too.
    await page.locator(`${SHOWN_ENTRY} button[aria-label="Close"]`).first().click();
    if (await closeQuestion(page).isVisible()) await discardAndClose(page);
    await expect
      .poll(async () => (await page.evaluate(() => window.infinitary.cards.list())).length)
      .toBe(0);
    await page.evaluate((id) => window.infinitary.cards.showPast(id), card.id);
    const past = page.locator(`[data-past-card="${card.id}"]`);
    await expect(past).toBeVisible();
    await playFrom(page, bodyIn(past));

    await app.close();
    app = undefined;

    // A recording that is gone leaves its poster and says so, with nothing to press.
    const dir = join(userDataDir, "crewmates", card.taskId ?? "", "cards");
    for (const name of await readdir(dir)) if (name.endsWith(".mp4")) await rm(join(dir, name));
    app = await launchApp({ reuseMockProvider: mockProvider, userDataDir });
    await app.page.evaluate((id) => window.infinitary.cards.showPast(id), card.id);
    const again = app.page.locator(`[data-past-card="${card.id}"]`);
    await expect(again).toBeVisible({ timeout: 30_000 });
    await clickInBody(bodyIn(again).getByRole("img", { name: DEMO_POSTER.alt }));
    await expect(viewer(app.page)).toBeVisible();
    await expect(viewer(app.page).locator("[data-demo-time]")).toHaveText(RECORDING_UNPLAYABLE);
    await expect(viewer(app.page).getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(recording(app.page)).toHaveAttribute("poster", /^app-frame:\/\/images\//);
  } finally {
    await app?.close();
    await mockProvider.close();
  }
});
