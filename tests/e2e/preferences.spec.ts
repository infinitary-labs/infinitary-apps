import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";
import { setThemeViaSettings } from "./theme";

/**
 * The captain's presentation choices are the CORE's, not the window's
 * (src/shared/preferences.ts): the theme in the `appearance` KV, the rail
 * collapse in `layout`. The proof is a relaunch with a FRESH WINDOW PROFILE
 * - Chromium's own per-origin storage wiped between runs, the app's
 * userData kept - which is exactly what the renderer-local copies these
 * replaced could not survive: the theme lived only in the shell store and
 * was forgotten at every launch, and collapse lived in `localStorage`.
 */

/** Chromium's per-origin storage inside userData: the window's own memory. */
const WINDOW_PROFILE_DIRS = [
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "databases",
  "WebStorage",
];

function wipeWindowProfile(userDataDir: string): string[] {
  const removed: string[] = [];
  for (const name of WINDOW_PROFILE_DIRS) {
    const dir = join(userDataDir, name);
    if (!existsSync(dir)) continue;
    // e2e-fixture: mutation -- Prove app settings survive removal of the window storage caches.
    rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function theme(page: Page): Promise<string> {
  return page.evaluate(() => document.body.dataset.theme ?? "");
}

function activityCollapsed(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean(
      document
        .querySelector('[data-side-panel="activity"]')
        ?.hasAttribute("data-side-panel-collapsed"),
    ),
  );
}

test("the theme and the rail collapse survive a relaunch with a fresh window profile", async () => {
  let launched: LaunchedApp = await launchApp();
  const { userDataDir } = launched;
  try {
    await expect(launched.page.locator("[data-screen-label]")).toHaveAttribute(
      "data-screen-label",
      "Null state",
    );
    // The app's own look, and Activity on its collapsed default.
    expect(await theme(launched.page)).toBe("dark");
    expect(await activityCollapsed(launched.page)).toBe(true);

    await setThemeViaSettings(launched.page, "light");
    await launched.page.getByRole("button", { name: "Expand Activity" }).click();
    expect(await theme(launched.page)).toBe("light");
    expect(await activityCollapsed(launched.page)).toBe(false);
  } finally {
    await launched.close();
  }

  // The record is the core's database, not anything the window kept.
  expect(existsSync(join(userDataDir, "firstmate.db"))).toBe(true);
  // The wipe has to be real: Chromium writes "Local Storage" on every run,
  // and that is where the collapse state used to be kept.
  expect(wipeWindowProfile(userDataDir)).toContain("Local Storage");
  expect(readdirSync(userDataDir).filter((name) => WINDOW_PROFILE_DIRS.includes(name))).toEqual([]);

  launched = await launchApp({ userDataDir });
  try {
    await expect(launched.page.locator("[data-screen-label]")).toHaveAttribute(
      "data-screen-label",
      "Null state",
    );
    expect(await theme(launched.page)).toBe("light");
    expect(await activityCollapsed(launched.page)).toBe(false);
    await launched.page.getByRole("button", { name: "Settings" }).click();
    await expect(launched.page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await launched.page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(launched.page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
    await launched.page.keyboard.press("Escape");
  } finally {
    await launched.close();
  }
});
