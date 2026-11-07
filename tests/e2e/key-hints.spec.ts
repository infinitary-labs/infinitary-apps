import { expect, type Page, test } from "@playwright/test";
import { type LaunchedApp, launchApp } from "./launch";
import {
  commandSearch,
  endRecording,
  focusOn,
  keyboardSettings,
  pressWindowKey,
  startRecording,
} from "./windowKeys";

/**
 * A control's label teaches its command's key as it is now (INF-3019's plan,
 * direction A, guard; docs/keyboard.md, "Key hints"; the captain: "the
 * tooltip should include the current keyboard shortcut assigned to the
 * button"): a person gives Open Automation a key in Keyboard settings and
 * Settings' Automation tab names it on rest, gives it another and the tab
 * names the new one, and removes it and the tab names none.
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

test("a control's label names the key its command has now, as Keyboard settings sets, changes and removes it", async () => {
  test.setTimeout(90_000);
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    const keyboard = keyboardSettings(page);
    const tab = page.locator('[data-settings-tab="automation"]');
    const label = page.locator("[data-icon-label]");
    // The keyboard rests on the tab as a person's Tab would: the app's label shows.
    const restOnTab = () => focusOn(tab, { focusVisible: true });

    await openKeyboardSettings(app, page);

    await test.step("with no key, the tab names none", async () => {
      await expect(tab).not.toHaveAttribute("aria-keyshortcuts");
      await restOnTab();
      await expect(label).toBeHidden();
    });

    await test.step("records F7 for Open Automation, and the tab's label names F7", async () => {
      await startRecording(page, "settings.automation");
      await pressWindowKey(app, "F7");
      await expect(keyboard.verdict("settings.automation")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveText(["F7"]);
      await expect(tab).toHaveAttribute("aria-keyshortcuts", "F7");
      await restOnTab();
      await expect(label).toBeVisible();
      await expect(label).toContainText("Automation");
      await expect(label).toContainText("F7");
    });

    await test.step("records F8 in its place, and the label follows", async () => {
      await startRecording(page, "settings.automation");
      await pressWindowKey(app, "F8");
      await expect(keyboard.verdict("settings.automation")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveText(["F8"]);
      await expect(tab).toHaveAttribute("aria-keyshortcuts", "F8");
      await restOnTab();
      await expect(label).toContainText("F8");
      await expect(label).not.toContainText("F7");
    });

    await test.step("removes the key, and the tab names none again", async () => {
      await keyboard
        .row("settings.automation")
        .getByRole("button", { name: /^Remove / })
        .click();
      await expect(keyboard.keys("settings.automation").locator("kbd")).toHaveCount(0);
      await expect(tab).not.toHaveAttribute("aria-keyshortcuts");
      await restOnTab();
      await expect(label).toBeHidden();
    });
  } finally {
    await launched.close();
  }
});
