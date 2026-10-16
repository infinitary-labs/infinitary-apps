import { expect, type Page, test } from "@playwright/test";
import { KEYBOARD_COMMANDS } from "../../src/shared/keyboard";
import { ariaKeysOf, HAS_APP_MENU, keyWords } from "./desktop";
import { type LaunchedApp, launchApp } from "./launch";
import { promptInput } from "./prompt";
import {
  commandSearch,
  endRecording,
  keyboardSettings,
  menuItemAccelerator,
  pressWindowKey,
  startRecording,
} from "./windowKeys";

/** The keys this journey records and reads, as this computer draws them. */
const COMMAND_P = keyWords({ key: "p", meta: true });
const COMMAND_L = keyWords({ key: "l", meta: true });

/**
 * Changing keys (docs/keyboard.md, "Changing keys"): a person opens
 * Keyboard settings from command search, records a new key for a command,
 * is told when a key belongs to another command and moves it on purpose, is
 * refused a key the Mac keeps, and finds the changed keys working - in the
 * window, its hints and the app menu - after a restart, until Reset all
 * keys puts every key back.
 */

/** Opens Keyboard settings the keyboard's way: command search, then its row. */
async function openKeyboardSettings(app: LaunchedApp["app"], page: Page): Promise<void> {
  await pressWindowKey(app, "k", ["meta"]);
  const search = commandSearch(page);
  await search.field.fill("keyboard");
  await expect(search.row("settings.keyboard")).toBeVisible();
  await pressWindowKey(app, "Enter");
  await expect(search.dialog).toBeHidden();
  await expect(keyboardSettings(page).search).toBeFocused();
}

test("a person changes keys, moves one on purpose, and keeps them across a restart until Reset all", async () => {
  test.setTimeout(120_000);
  let launched = await launchApp();
  const { userDataDir, homeDir } = launched;
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);

    await test.step("records ⌘P for Open Settings, which then opens Settings", async () => {
      await openKeyboardSettings(app, page);
      await startRecording(page, "settings.open");
      await pressWindowKey(app, "p", ["meta"]);
      await expect(keyboard.verdict("settings.open")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.row("settings.open")).toHaveAttribute("data-keyboard-changed", "true");
      await expect(keyboard.keys("settings.open").locator("kbd")).toHaveText([COMMAND_P]);
      // A desktop whose window draws its own controls has no app menu.
      if (HAS_APP_MENU) expect(await menuItemAccelerator(app, "settings-open")).toBe("Command+P");

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(promptInput(page)).toBeVisible();
      // ⌘, is no longer the window's; ⌘P is.
      await pressWindowKey(app, ",", ["meta"]);
      await expect(keyboard.section).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
        "aria-keyshortcuts",
        ariaKeysOf("settings.open", { key: "p", meta: true }) ?? "",
      );
      await pressWindowKey(app, "p", ["meta"]);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
    });

    await test.step("refuses a key the Mac keeps, and saves nothing", async () => {
      await openKeyboardSettings(app, page);
      await startRecording(page, "cards.next");
      await pressWindowKey(app, "q", ["meta"]);
      await expect(keyboard.verdict("cards.next")).toHaveAttribute(
        "data-keyboard-verdict",
        "refused",
      );
      await pressWindowKey(app, "Enter");
      await endRecording(app, page, "Escape");
      await expect(keyboard.row("cards.next").locator("[data-keyboard-recorder]")).toHaveCount(0);
      await expect(keyboard.row("cards.next")).not.toHaveAttribute("data-keyboard-changed");
    });

    await test.step("names the command a key belongs to, and moves it only when saved", async () => {
      await startRecording(page, "cards.next");
      await pressWindowKey(app, "l", ["meta"]);
      await expect(keyboard.verdict("cards.next")).toHaveAttribute(
        "data-keyboard-verdict",
        "moves",
      );
      await expect(keyboard.verdict("cards.next")).toContainText(
        KEYBOARD_COMMANDS["focus.main-message"].label,
      );
      // Nothing moved yet: ⌘L still belongs to the main message.
      await expect(keyboard.keys("focus.main-message").locator("kbd")).toHaveText([COMMAND_L]);
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("cards.next").locator("kbd")).toHaveText([COMMAND_L]);
      await expect(keyboard.keys("focus.main-message")).toHaveText("No key");
    });

    await test.step("records a two-key shortcut that opens Keyboard settings", async () => {
      await startRecording(page, "settings.keyboard");
      await pressWindowKey(app, "j", ["control"]);
      await pressWindowKey(app, "s");
      await expect(keyboard.verdict("settings.keyboard")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.keyboard").locator("kbd")).toHaveText([
        keyWords({ key: "j", ctrl: true }),
        keyWords({ key: "s" }),
      ]);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(keyboard.section).toHaveCount(0);
      await pressWindowKey(app, "j", ["control"]);
      await pressWindowKey(app, "s");
      await expect(keyboard.search).toBeFocused();
    });
  } finally {
    await launched.close();
  }

  launched = await launchApp({ userDataDir, homeDir });
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);

    await test.step("after a restart the changed keys are installed, shown and in the menu", async () => {
      if (HAS_APP_MENU) expect(await menuItemAccelerator(app, "settings-open")).toBe("Command+P");
      await pressWindowKey(app, "p", ["meta"]);
      await expect(page.locator("[data-screen-label]")).toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
      await page.getByRole("tab", { name: "Keyboard", exact: true }).click();
      await expect(keyboard.keys("cards.next").locator("kbd")).toHaveText([COMMAND_L]);
      await expect(keyboard.keys("settings.open").locator("kbd")).toHaveText([COMMAND_P]);
    });

    await test.step("Reset all keys puts every key back", async () => {
      await keyboard.resetAll.click();
      await keyboard.resetAll.click();
      await expect(keyboard.section.locator("[data-keyboard-changed]")).toHaveCount(0);
      await expect(keyboard.keys("focus.main-message").locator("kbd")).toHaveText([COMMAND_L]);
      if (HAS_APP_MENU) expect(await menuItemAccelerator(app, "settings-open")).toBe("Command+,");
      // Command search reads the same installed keys.
      await pressWindowKey(app, "k", ["meta"]);
      await expect(commandSearch(page).row("focus.main-message").locator("kbd")).toHaveText(
        COMMAND_L,
      );
      await expect(commandSearch(page).row("settings.open").locator("kbd")).toHaveText(
        keyWords({ key: ",", meta: true }),
      );
      await pressWindowKey(app, "Escape");
    });
  } finally {
    await launched.close();
  }
});
