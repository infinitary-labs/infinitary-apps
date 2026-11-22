import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { readSoundClip } from "../../src/core/soundFormat";
import { readDemoVideo } from "../../src/core/videoFormat";
import { cardBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import {
  SOUND_CAPTION,
  SOUND_CARD_TITLE,
  SOUND_CLIP,
  SOUND_DEMO,
  SOUND_PROMPT_MARKER,
  soundCard,
} from "./scenarios/soundCard";
import { cardLeave, showCard, shownCard, shownEntry } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * A sound clip on a card (docs/card-authoring.md "Sound clips"; INF-4543,
 * the captain's "A: sound clips only"): a crewmate's narration plays inside
 * the card, with no browser and no Take Control. The mock crewmate first
 * names a recording with pictures as its sound, which the host refuses, then
 * the clip, which it keeps. The card shows the clip's Listen button with its
 * length, and nothing plays until the captain presses it; the press plays it
 * in the card's sound strip, to its end, and Pause holds it; putting the card
 * aside stops it. A demo on the same card keeps its sound, says so on its
 * Play button, and its press takes the one sound from the clip. This journey reads what the person reaches and what the
 * player holds, never how either looks.
 */

const SERVED = /^app-frame:\/\/media\/[A-Za-z0-9_-]+-[0-9a-f]{32}\.m4a$/;

const read = readSoundClip(SOUND_CLIP.bytes);
if (!read.ok) throw new Error(`the narration fixture is no clip: ${read.reason}`);
const SECONDS = Math.round(read.clip.durationMs / 1000);

const demoRead = readDemoVideo(SOUND_DEMO.bytes);
if (!demoRead.ok || !demoRead.video.sound) throw new Error("the sound demo fixture keeps no sound");
const DEMO_SECONDS = Math.round(demoRead.video.durationMs / 1000);

/**
 * A length as the strip shows it, `m:ss`: the format is `soundClock` in
 * `CardSound.tsx`, a renderer module a spec cannot load, so only the seconds
 * come from their owner here.
 */
const LENGTH = `${Math.floor(SECONDS / 60)}:${String(SECONDS % 60).padStart(2, "0")}`;

let launched: LaunchedApp;

function strip(page: Page) {
  const at = shownEntry(page).locator("[data-card-sound]");
  return {
    at,
    toggle: at.locator("button[data-sound-toggle]"),
    caption: at.locator("[data-sound-caption]"),
    time: at.locator("[data-sound-time]"),
    seek: at.getByRole("slider"),
  };
}

/** Where the window's one player stands: how far in, and whether it plays. */
function player(page: Page) {
  return page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>("audio[data-card-sound-audio]");
    return audio ? { at: audio.currentTime, paused: audio.paused } : null;
  });
}

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [soundCard] });
  const input = promptInput(launched.page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${SOUND_PROMPT_MARKER}`);
  await input.press("Enter");
  await expect(shownCard(launched.page, SOUND_CARD_TITLE)).toBeVisible({ timeout: 45_000 });
});

test.afterAll(async () => {
  await launched?.close();
});

test("the host refuses a recording with pictures as sound and keeps the clip, shown as a Listen button with its length", async () => {
  const { page, userDataDir } = launched;
  await showCard(page, SOUND_CARD_TITLE);
  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const shown = cards.filter((card) => card.title === SOUND_CARD_TITLE);
  // One card: the first offer, whose sound held pictures, never went up.
  expect(shown).toHaveLength(1);
  const card = shown[0];
  if (!card?.taskId) throw new Error("expected the sound card on a task");
  // The task keeps the very bytes the crewmate wrote: the clip's, and the
  // demo's with its sound - never the refused recording's.
  const dir = join(userDataDir, "crewmates", card.taskId, "cards");
  const kept = (await readdir(dir)).filter((name) => /\.(m4a|mp4)$/.test(name)).sort();
  expect(kept).toHaveLength(2);
  const bytes = await Promise.all(kept.map((name) => readFile(join(dir, name))));
  expect(bytes).toEqual(
    kept.map((name) => (name.endsWith(".m4a") ? SOUND_CLIP.bytes : SOUND_DEMO.bytes)),
  );

  const figure = cardBody(page, SOUND_CARD_TITLE).locator("figure[data-inf-sound]");
  await expect(figure).toHaveAttribute("data-inf-sound", SERVED);
  await expect(figure).toHaveAttribute("data-inf-sound-duration", String(read.clip.durationMs));
  await expect(figure.locator("figcaption")).toHaveText(SOUND_CAPTION);
  await expect(figure.getByRole("button", { name: `Listen, ${SECONDS} seconds` })).toBeVisible();
  // Nothing plays on arrival: no strip, and no player anywhere in the window.
  await expect(strip(page).at).toHaveCount(0);
  expect(await player(page)).toBeNull();
});

test("a demo that keeps its sound says so, plays with its sound on the press, and stops the card's clip", async () => {
  // INF-4543's ruling: a demo keeps its sound when it is about something that needs to be heard.
  test.setTimeout(60_000);
  const { page } = launched;
  await showCard(page, SOUND_CARD_TITLE);
  const body = cardBody(page, SOUND_CARD_TITLE);
  const demo = body.locator("figure[data-inf-demo]");
  await expect(demo).toHaveAttribute("data-inf-demo-sound", "true");
  const play = demo.getByRole("button", {
    name: `Play the demo with sound, ${DEMO_SECONDS} seconds`,
  });
  await expect(play).toBeVisible();

  // The card's clip plays first; the demo's press then takes the one sound.
  await pressKey(body.getByRole("button", { name: `Listen, ${SECONDS} seconds` }), "Enter");
  await expect(strip(page).at).toHaveAttribute("data-sound-state", "playing");
  await pressKey(play, "Enter");
  const viewer = page.getByRole("dialog", { name: `Demo from ${SOUND_CARD_TITLE}` });
  await expect(viewer).toBeVisible();
  const video = viewer.locator("video[data-demo-video]");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  await expect(strip(page).at).toHaveCount(0);
  await expect.poll(() => player(page)).toBeNull();

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("Listen plays the clip in the card's strip to its end, Replay and Pause hold it, and putting the card aside stops it", async () => {
  test.setTimeout(90_000);
  const { app, page } = launched;
  await showCard(page, SOUND_CARD_TITLE);
  const figure = cardBody(page, SOUND_CARD_TITLE).locator("figure[data-inf-sound]");
  await pressKey(figure.getByRole("button", { name: `Listen, ${SECONDS} seconds` }), "Enter");

  // The press plays it at once, in the window's hidden test run, as when the window is hidden.
  const { at, toggle, caption, time, seek } = strip(page);
  await expect(at).toBeVisible();
  await expect(caption).toHaveText(SOUND_CAPTION);
  await expect(at).toHaveAttribute("data-sound-state", "playing");
  await expect(toggle).toHaveAccessibleName("Pause");
  await expect(seek).toBeVisible();
  await expect.poll(async () => (await player(page))?.at ?? 0).toBeGreaterThan(0);

  await expect(at).toHaveAttribute("data-sound-state", "ended", { timeout: 15_000 });
  await expect(toggle).toHaveAccessibleName("Replay");
  await expect(time).toHaveText(`${LENGTH} / ${LENGTH}`);

  await pressKey(toggle, "Enter");
  await expect(at).toHaveAttribute("data-sound-state", "playing");
  await pressKey(toggle, "Enter");
  await expect(at).toHaveAttribute("data-sound-state", "paused");
  await expect(toggle).toHaveAccessibleName("Play");
  expect(await player(page)).toMatchObject({ paused: true });

  // Play or pause the card's sound, from command search, plays it on from
  // where it stood; then putting the card aside takes the strip and its player.
  await runFromSearch(app, page, "cards.sound");
  await expect(at).toHaveAttribute("data-sound-state", "playing");
  await cardLeave(page).click();
  await expect(shownCard(page, SOUND_CARD_TITLE)).toBeHidden();
  await expect.poll(() => player(page)).toBeNull();
});
