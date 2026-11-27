import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { showCard } from "./stack";
import { pressKey } from "./windowKeys";

// The approved plan for color themes (INF-6888, part 1): Settings → Appearance → Theme is one
// group of tiles, a pick applies at once to the window and to every open card and panel, and
// a card drawn later is drawn in it. The accents are the plan's: Dracula's purple, Night Owl's
// blue, and Dark's and Light's own (src/renderer/src/design/tokens/colors.css).
const DRACULA_ACCENT = "#bd93f9";
const NIGHT_OWL_ACCENT = "#82aaff";
const DARK_ACCENT = "#7fdcff";
const LIGHT_ACCENT = "#0e8fd0";
const TITLE = "Chart the harbor";

/** `--accent` in the window and in every open frame that draws a theme, each as it reads it. */
async function accents(page: Page): Promise<{ window: string; frames: string[] }> {
  const read = () =>
    getComputedStyle(document.body).getPropertyValue("--accent").trim().toLowerCase();
  const frames: string[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const accent = await frame
      .evaluate(() =>
        document.body?.dataset.theme
          ? getComputedStyle(document.body).getPropertyValue("--accent").trim().toLowerCase()
          : null,
      )
      .catch(() => null);
    if (accent !== null) frames.push(accent);
  }
  return { window: await page.evaluate(read), frames };
}

async function everywhere(page: Page, accent: string): Promise<void> {
  await expect
    .poll(async () => {
      const seen = await accents(page);
      // Each reading named, so a failure says which frame missed and what it read.
      return seen.frames.length > 0 ? seen : { window: seen.window, frames: ["none open"] };
    })
    .toEqual({ window: accent, frames: expect.arrayContaining([accent]) });
  const { frames } = await accents(page);
  expect(frames.filter((one) => one !== accent)).toEqual([]);
}

test("a color theme picked in Settings recolors the window and every open frame at once", async () => {
  const userDataDir = scratchDir("infinitary-color-themes-");
  const card: Card = {
    id: "card-color-themes",
    author: "crewmate",
    meta: "crewmate",
    priority: 30,
    title: TITLE,
    body: '<p>The chart reaches every dock. <a href="#north">One link</a> sits in the accent.</p>',
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert(card);
  } finally {
    db.close();
  }
  const { page, close } = await launchApp({ userDataDir, withMockProvider: true });
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const themes = page.getByRole("radiogroup", { name: "Theme", exact: true });
  const openAppearance = async () => {
    await settings.click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  };
  const closeSettings = async () => {
    await page.keyboard.press("Escape");
    await showCard(page, TITLE);
  };
  try {
    await showCard(page, TITLE);
    await everywhere(page, DARK_ACCENT);

    // A look saved elsewhere, as the first mate's theme line saves it, reaches the open card
    // without building it again: the mark set in its document survives.
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame())
        await frame
          .evaluate(() => {
            (window as { kept?: boolean }).kept = true;
          })
          .catch(() => {});
    }
    await page.evaluate(async () => {
      const saved = await window.infinitary.settings.getAppearance();
      await window.infinitary.settings.setAppearance({
        ...saved,
        theme: "dark",
        colorTheme: "dracula",
      });
    });
    await expect.poll(() => page.evaluate(() => document.body.dataset.colorTheme)).toBe("dracula");
    await everywhere(page, DRACULA_ACCENT);
    const kept = await Promise.all(
      page
        .frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) =>
          frame.evaluate(() => (window as { kept?: boolean }).kept === true).catch(() => null),
        ),
    );
    expect(kept.filter((one) => one !== null)).not.toContain(false);

    // Settings shows the pick, and the arrow keys move it to the next tile, which applies at once.
    await openAppearance();
    const dracula = themes.getByRole("radio", { name: "Dracula", exact: true });
    await expect(dracula).toBeChecked();
    await pressKey(dracula, "ArrowRight");
    await expect(themes.getByRole("radio", { name: "Night Owl", exact: true })).toBeChecked();
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--accent").trim()),
      )
      .toBe(NIGHT_OWL_ACCENT);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .toMatchObject({ theme: "dark", colorTheme: "night-owl" });
    // A card drawn after the pick is born in it.
    await closeSettings();
    await everywhere(page, NIGHT_OWL_ACCENT);

    // Light is a look with no color theme.
    await openAppearance();
    await themes.getByRole("radio", { name: "Light", exact: true }).check();
    await expect.poll(() => page.evaluate(() => document.body.dataset.colorTheme)).toBeUndefined();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .not.toHaveProperty("colorTheme");
    await closeSettings();
    await everywhere(page, LIGHT_ACCENT);
  } finally {
    await close();
  }
});
