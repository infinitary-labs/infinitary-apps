import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import * as m from "../../src/shared/i18n/messages.generated";
import { DEFAULT_AMBIENT_STYLE, DEFAULT_AMBIENT_VOLUME } from "../../src/shared/preferences";
import { pointsAlong, windowDragAt } from "./dragRegions";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { atRest } from "./layout";
import { promptInput } from "./prompt";
import { feedLine } from "./rails";
import { readSavedData } from "./savedData";
import {
  AMBIENT_OWN_PROMPT,
  AMBIENT_SLOWER_PROMPT,
  ambientOwn,
  LOFI_SLOWER,
  LOFI_STYLE,
} from "./scenarios/ambientOwn";
import { settingRow } from "./settings";
import { MAC_ONLY_TAG } from "./tags";
import { focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

function playingStyle(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.ambientStyle);
}

function player(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.ambientMusic);
}

function savedSound(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const read = db.prepare("SELECT value FROM settings WHERE key = ?");
    const value = (key: string) => (read.get(key) as { value: string } | undefined)?.value;
    const music = value("ambient-music");
    return { ...(music ? JSON.parse(music) : {}), paused: value("ambient-paused") === "true" };
  });
}

const settings = (page: Page) =>
  page.getByRole("button", { name: m.shellTopBarSettings(), exact: true });
// The sound button itself, never the style name in its rest pill.
const sound = (page: Page) => page.locator("[data-ambient-control] > button");
const appearance = (page: Page) =>
  page.getByRole("tab", { name: m.panelSettingsAppearance(), exact: true });

// INF-4911: command search enables music, then pauses and resumes it without
// removing the control. Keyboard pause survives closing and reopening the app.
// INF-5053: ⌥⌘P (Ctrl+Alt+P elsewhere) pauses and resumes it from anywhere.
test("ambient music can be paused from the toolbar and stays paused after reopening", async () => {
  let launched = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = launched;
  try {
    const { app, page } = launched;
    await expect.poll(() => player(page)).toBe("off");
    await expect(sound(page)).toHaveCount(0);
    await settings(page).click();
    await appearance(page).click();
    const music = settingRow(page, "ambient-music").getByRole("switch");
    const volume = settingRow(page, "ambient-volume").getByRole("slider");
    await expect(music).toHaveAttribute("aria-checked", "false");
    await expect(volume).toHaveValue(String(DEFAULT_AMBIENT_VOLUME));

    await runFromSearch(app, page, "ambient.toggle");
    await expect.poll(() => player(page)).toBe("playing");
    await expect(music).toHaveAttribute("aria-checked", "true");
    await expect(sound(page)).toHaveCount(0);
    await pressWindowKey(app, "P", ["alt", "meta"]);
    await expect.poll(() => player(page)).toBe("paused");
    await pressWindowKey(app, "P", ["alt", "meta"]);
    await expect.poll(() => player(page)).toBe("playing");
    await pressKey(appearance(page), "Escape");
    await focusOn(settings(page), { focusVisible: true });
    await pressKey(settings(page), "Shift+Tab");
    await expect(sound(page)).toBeFocused();
    await pressKey(sound(page), "Enter");
    await expect(sound(page)).toHaveAccessibleName(m.shellAmbientPlay());
    await expect.poll(() => savedSound(userDataDir)).toMatchObject({ on: true, paused: true });
    await launched.close();

    launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    const reopened = launched.page;
    await expect.poll(() => player(reopened)).toBe("paused");
    await pressKey(sound(reopened), "Space");
    await expect.poll(() => player(reopened)).toBe("playing");
    await settings(reopened).click();
    await appearance(reopened).click();
    await settingRow(reopened, "ambient-music").getByRole("switch").click();
    await pressKey(appearance(reopened), "Escape");
    await expect(sound(reopened)).toHaveCount(0);
    await expect.poll(() => player(reopened)).toBe("off");
  } finally {
    await launched.close();
  }
});

// INF-4911: keyboard and drag on the revealed track edit the same saved
// volume the Settings slider reads; the closed track is not a Tab stop.
// INF-5053: the top bar drags the window, and on a Mac a pointer over a drag
// point leaves the page, which closed the track on the way to it: the open
// track is no part of the drag strip, and the closed one gives it back.
test("the toolbar volume track shares its value with Settings", async () => {
  const { app, page, close, userDataDir } = await launchApp({ withMockProvider: true });
  try {
    // Park the pointer before adding a hover target, and return focus to the
    // gear rather than relying on the window's initial focus or pointer.
    await page.mouse.move(12, 100);
    await focusOn(settings(page), { focusVisible: true });
    await runFromSearch(app, page, "ambient.toggle");
    await focusOn(settings(page), { focusVisible: true });
    const slider = page
      .locator("[data-ambient-control]")
      .getByRole("slider", { includeHidden: true });
    const closedTrack = page.locator("[data-ambient-control] [inert]").filter({
      has: page.getByRole("slider", { includeHidden: true }),
    });
    await expect(closedTrack).toHaveCount(1);
    await focusOn(sound(page), { focusVisible: true });
    await expect(slider).toHaveValue(String(DEFAULT_AMBIENT_VOLUME));
    await pressKey(sound(page), "ArrowRight");
    await expect(slider).toHaveValue(String(DEFAULT_AMBIENT_VOLUME + 5));
    await pressKey(sound(page), "Tab");
    await expect(page.locator("[data-ambient-style-name]")).toBeFocused();
    await pressKey(page.locator("[data-ambient-style-name]"), "Tab");
    await expect(slider).toBeFocused();
    await pressKey(slider, "Escape");
    await expect(sound(page)).toBeFocused();
    await expect(closedTrack).toHaveCount(1);
    await pressKey(sound(page), "Tab");
    await expect(settings(page)).toBeFocused();

    await sound(page).hover();
    await expect(closedTrack).toHaveCount(0);
    await atRest(slider);
    const button = await sound(page).boundingBox();
    const pill = await page.locator("[data-ambient-control] [data-open]").boundingBox();
    if (!button || !pill) throw new Error("The open volume track is not drawn");
    const centre = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    const farEnd = { x: pill.x + 1, y: centre.y };
    const way = pointsAlong(centre, farEnd, 11);
    expect(await windowDragAt(page, way)).toEqual(way.map(() => false));
    const box = await slider.boundingBox();
    if (!box) throw new Error("The rest volume track is not drawn");
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const dragged = Number(await slider.inputValue());
    expect(dragged).toBeGreaterThan(DEFAULT_AMBIENT_VOLUME + 5);
    await expect.poll(() => savedSound(userDataDir).volume).toBe(dragged);
    await page.mouse.move(12, 100);
    await expect(closedTrack).toHaveCount(1);
    const trackCentre = { x: box.x + box.width / 2, y: centre.y };
    expect(await windowDragAt(page, [trackCentre])).toEqual([true]);
    await settings(page).click();
    await appearance(page).click();
    await expect(settingRow(page, "ambient-volume").getByRole("slider")).toHaveValue(
      String(dragged),
    );
  } finally {
    await close();
  }
});

function savedStyle(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("ambient-style") as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as { style: string }).style : null;
  });
}

// INF-5056's kept choices: Star cruise plays until someone picks another of
// the nine styles; the Style picker is the next stop after the switch, a
// pick plays at once, and it is kept across a relaunch.
test("the ambient music plays Star cruise first and keeps the style picked in Settings", async () => {
  let launched = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = launched;
  try {
    const { page } = launched;
    await settings(page).click();
    await appearance(page).click();
    const music = settingRow(page, "ambient-music").getByRole("switch");
    const style = settingRow(page, "ambient-style").getByRole("combobox", {
      name: m.settingsSoundStyle(),
    });
    await expect(style).toHaveValue(DEFAULT_AMBIENT_STYLE);
    await expect(settingRow(page, "ambient-style")).toContainText(
      m.settingsSoundStyleStarCruiseDescription(),
    );
    await music.click();
    await expect.poll(() => player(page)).toBe("playing");
    await expect.poll(() => playingStyle(page)).toBe(DEFAULT_AMBIENT_STYLE);

    await focusOn(music, { focusVisible: true });
    await pressKey(music, "Tab");
    await expect(style).toBeFocused();
    await style.selectOption({ label: m.settingsSoundStyleHarborDawn() });
    await expect(settingRow(page, "ambient-style")).toContainText(
      m.settingsSoundStyleHarborDawnDescription(),
    );
    await expect.poll(() => playingStyle(page)).toBe("harbor-dawn");
    await expect.poll(() => player(page)).toBe("playing");
    await expect.poll(() => savedStyle(userDataDir)).toBe("harbor-dawn");
    await launched.close();

    launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
    await expect.poll(() => playingStyle(launched.page)).toBe("harbor-dawn");
  } finally {
    await launched.close();
  }
});

function savedOwnStyles(userDataDir: string) {
  return readSavedData(userDataDir, (db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("ambient-own-styles") as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as { styles: { id: string; bpm?: number }[] }).styles : [];
  });
}

// INF-5541's approved plan: asked for music of the person's own, the first
// mate saves it as a style and it plays in the same reply; Settings shows
// it chosen under Yours with the person's words; asked to change it, the
// same style changes; Remove, reached by keys, brings back the default; and
// Describe your own starts the ask in the message box.
// Data: a fresh profile and the plan's own lofi style. Completion: the
// player's playing style and the saved row. Prerequisites: Electron and the
// built renderer; no network.
test("the first mate writes the person's own style, and Settings lists and removes it", async () => {
  const { page, close, userDataDir } = await launchApp({
    withMockProvider: true,
    scenarios: [ambientOwn],
  });
  const id = "own-late-shift";
  try {
    await askFirstmate(page, AMBIENT_OWN_PROMPT);
    await expect(
      feedLine(page, ACTIONS["ambient-own-style"].done({ saved: [LOFI_STYLE] })),
    ).toBeVisible({ timeout: 30_000 });
    // The window measures a new style's loudness before it first plays it.
    await expect.poll(() => playingStyle(page), { timeout: 60_000 }).toBe(id);
    await expect.poll(() => player(page)).toBe("playing");

    await askFirstmate(page, AMBIENT_SLOWER_PROMPT);
    await expect
      .poll(() => savedOwnStyles(userDataDir))
      .toEqual([expect.objectContaining({ id, bpm: LOFI_SLOWER.bpm })]);
    await expect.poll(() => playingStyle(page), { timeout: 60_000 }).toBe(id);

    await settings(page).click();
    await appearance(page).click();
    const style = settingRow(page, "ambient-style").getByRole("combobox", {
      name: m.settingsSoundStyle(),
    });
    await expect(style).toHaveValue(id);
    await expect(settingRow(page, "ambient-style")).toContainText(LOFI_STYLE.words);
    await expect(
      style.locator(`optgroup[label="${m.settingsSoundStyleGroupYours()}"] option`),
    ).toHaveText([LOFI_STYLE.name]);

    const remove = settingRow(page, "ambient-own").getByRole("button", {
      name: m.settingsSoundOwnRemove(),
      exact: true,
    });
    const describe = settingRow(page, "ambient-own").getByRole("button", {
      name: m.settingsSoundOwnDescribe(),
      exact: true,
    });
    await focusOn(style, { focusVisible: true });
    await pressKey(style, "Tab");
    await expect(remove).toBeFocused();
    await pressKey(remove, "Enter");
    await expect.poll(() => playingStyle(page)).toBe(DEFAULT_AMBIENT_STYLE);
    await expect(style).toHaveValue(DEFAULT_AMBIENT_STYLE);
    await expect(remove).toHaveCount(0);
    await expect.poll(() => savedOwnStyles(userDataDir)).toEqual([]);

    await focusOn(style, { focusVisible: true });
    await pressKey(style, "Tab");
    await expect(describe).toBeFocused();
    await pressKey(describe, "Enter");
    await expect(promptInput(page)).toBeFocused();
    await expect(promptInput(page)).toHaveValue(m.settingsSoundOwnDraft());
  } finally {
    await close();
  }
});

// INF-5610's approved plan, the captain's "Name in the pill": the sound
// button's rest pill names the playing style, and a rest on the name drops
// the list Settings' picker shows, own styles under Yours. A pick plays at
// once, resumes a pause and leaves the list open; the list is reached by
// keys and by Choose ambient music, and the pointer's way into it never
// crosses a drag point.
// Data: a fresh profile and the plan's own lofi style, saved by the first
// mate. Completion: the player's playing style and the saved style row.
// Prerequisites: Electron and the built renderer; no network.
test("the sound button's list picks the ambient music by pointer and keys", async () => {
  const { app, page, close, userDataDir } = await launchApp({
    withMockProvider: true,
    scenarios: [ambientOwn],
  });
  const own = "own-late-shift";
  const name = page.locator("[data-ambient-style-name]");
  const list = page.getByRole("menu", { name: m.settingsSoundStyle() });
  const option = (style: string) => page.locator(`[data-ambient-style-option="${style}"]`);
  try {
    await page.mouse.move(12, 100);
    await askFirstmate(page, AMBIENT_OWN_PROMPT);
    await expect.poll(() => playingStyle(page), { timeout: 60_000 }).toBe(own);

    await sound(page).hover();
    await expect(name).toHaveAccessibleName(m.shellAmbientStyleNamed({ name: LOFI_STYLE.name }));
    await name.hover();
    await expect(list).toBeVisible();
    await expect(list.getByRole("group", { name: m.settingsSoundStyleGroupYours() })).toContainText(
      LOFI_STYLE.name,
    );
    await atRest(list);
    const from = await name.boundingBox();
    const into = await option("star-cruise").boundingBox();
    if (!from || !into) throw new Error("The style list is not drawn");
    const way = pointsAlong(
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: from.x + from.width / 2, y: into.y + into.height / 2 },
      9,
    );
    expect(await windowDragAt(page, way)).toEqual(way.map(() => false));
    await option("harbor-dawn").click();
    await expect.poll(() => playingStyle(page)).toBe("harbor-dawn");
    await expect.poll(() => savedStyle(userDataDir)).toBe("harbor-dawn");
    await expect(name).toHaveAccessibleName(
      m.shellAmbientStyleNamed({ name: m.settingsSoundStyleHarborDawn() }),
    );
    await expect(option("harbor-dawn")).toHaveAttribute("aria-checked", "true");

    await sound(page).click();
    await expect.poll(() => player(page)).toBe("paused");
    await name.hover();
    await option(own).click();
    await expect.poll(() => player(page)).toBe("playing");
    await expect.poll(() => playingStyle(page)).toBe(own);
    await page.mouse.move(12, 100);
    await expect(list).toHaveCount(0);

    await focusOn(sound(page), { focusVisible: true });
    await pressKey(sound(page), "Tab");
    await expect(name).toBeFocused();
    await pressKey(name, "ArrowDown");
    await expect(option(own)).toBeFocused();
    await pressKey(option(own), "Home");
    await expect(option("star-cruise")).toBeFocused();
    await pressKey(option("star-cruise"), "ArrowDown");
    await expect(option("deep-drift")).toBeFocused();
    await pressKey(option("deep-drift"), "Enter");
    await expect.poll(() => playingStyle(page)).toBe("deep-drift");
    await expect(list).toBeVisible();
    await pressKey(option("deep-drift"), "Escape");
    await expect(list).toHaveCount(0);
    await expect(name).toBeFocused();
    await pressKey(name, "Escape");
    await expect(sound(page)).toBeFocused();

    await focusOn(settings(page), { focusVisible: true });
    await runFromSearch(app, page, "ambient.style");
    await expect(option("deep-drift")).toBeFocused();
    await settings(page).click();
    await appearance(page).click();
    await expect(
      settingRow(page, "ambient-style").getByRole("combobox", { name: m.settingsSoundStyle() }),
    ).toHaveValue("deep-drift");
  } finally {
    await close();
  }
});

/** The Mac telling the app its screen locked or unlocked, as the system's own event does. */
function lockScreen(app: ElectronApplication, locked: boolean) {
  return app.evaluate(
    ({ powerMonitor }, event) => powerMonitor.emit(event),
    locked ? "lock-screen" : "unlock-screen",
  );
}

// INF-5528's answer and the captain's choice ("As the default, with a switch
// to keep playing"): the music stops while nobody is at the computer,
// closing its player as the pause button does, never saving a pause, and
// plays again once they are back; Keep playing in Settings keeps it going.
test("ambient music pauses while the screen is locked and plays again at the unlock", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // A Linux desktop tells the app nothing of a lock, so it never pauses there.
  test.skip(process.platform !== "darwin", "only a Mac and a Windows PC say a lock");
  const { app, page, close, userDataDir } = await launchApp({ withMockProvider: true });
  try {
    await settings(page).click();
    await appearance(page).click();
    await settingRow(page, "ambient-music").getByRole("switch").click();
    await expect.poll(() => player(page)).toBe("playing");
    const away = settingRow(page, "ambient-away").getByRole("switch", {
      name: m.settingsSoundPauseWhenAway(),
    });
    await expect(away).toHaveAttribute("aria-checked", "true");

    await lockScreen(app, true);
    await expect.poll(() => player(page)).toBe("away");
    expect(await playingStyle(page)).toBeUndefined();
    expect(await savedSound(userDataDir)).toMatchObject({ on: true, paused: false });
    await lockScreen(app, false);
    await expect.poll(() => player(page)).toBe("playing");
    await expect.poll(() => playingStyle(page)).toBe(DEFAULT_AMBIENT_STYLE);

    await focusOn(away, { focusVisible: true });
    await pressKey(away, "Space");
    await expect(away).toHaveAttribute("aria-checked", "false");
    await lockScreen(app, true);
    // Every push the lock sent this window has arrived once the fence resolves.
    await page.evaluate(() => window.infinitary.app.fence());
    expect(await player(page)).toBe("playing");
    expect(await playingStyle(page)).toBe(DEFAULT_AMBIENT_STYLE);
    await lockScreen(app, false);
  } finally {
    await close();
  }
});
