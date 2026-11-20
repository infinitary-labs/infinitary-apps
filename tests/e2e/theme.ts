import { expect, type Page } from "@playwright/test";

/**
 * Theme lives in Settings → Appearance (the main-view sun/moon control is gone).
 * Opens Settings when needed, chooses Dark or Light to the wanted
 * value, and leaves Settings open so a caller that was already there stays
 * there. Escape closes if the caller opened Settings for this alone.
 */
export async function setThemeViaSettings(
  page: Page,
  want: "light" | "dark",
  options: { close?: boolean } = {},
): Promise<void> {
  // Exact: a thread's "settings · N values" line is a button too.
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const opened = (await settings.isVisible().catch(() => false)) === true;
  if (opened) await settings.click();
  const previous = await page.getByRole("tab", { selected: true }).textContent();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const choice = page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio", { name: want === "dark" ? "Dark" : "Light", exact: true });
  await choice.check();
  await expect(choice).toBeChecked();
  await expect.poll(async () => page.evaluate(() => document.body.dataset.theme ?? "")).toBe(want);
  if ((!opened || options.close === false) && previous) {
    await page.getByRole("tab", { name: previous, exact: true }).click();
  }
  if (options.close !== false && opened) {
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
      "data-screen-label",
      "Settings",
    );
  }
}
