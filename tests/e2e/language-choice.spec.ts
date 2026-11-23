import { expect, test } from "@playwright/test";
import { inLanguage } from "../../src/shared/i18n/current";
import { ownLanguageName } from "../../src/shared/i18n/languages";
import * as m from "../../src/shared/i18n/messages.generated";
import { choosableLanguages } from "../../src/shared/i18n/start";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { settingRow, settingsSection } from "./settings";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

// The approved plan for the app's languages (INF-3674), as the captain
// answered its review (INF-3850): English stays the default whatever the
// computer asks for, and only a choice in Settings → Appearance switches the
// language, live and across a restart, until the captain picks the default
// again. A language the keyboard steps to applies on Enter or when the
// keyboard leaves the picker, not at each step.
// The computer asks for German here (`INFINITARY_LANGUAGE` stands in for it).
test("Language stays English over the computer's, takes the captain's choice on Enter, on leaving or a pick and across a restart, and returns to English", async () => {
  const computer = { INFINITARY_LANGUAGE: "de" };
  // One data folder and HOME across both launches, so the second reads what the first saved.
  const userDataDir = scratchDir("infinitary-language-");
  const homeDir = scratchDir("infinitary-language-home-");
  const first = await launchApp({ withMockProvider: true, env: computer, userDataDir, homeDir });
  try {
    const { page } = first;
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en");

    // Settings by its key, then Appearance, the tab after General, by the arrow.
    await pressWindowKey(first.app, ",", ["meta"]);
    await pressKey(page.locator('[data-settings-tabs] [role="tab"]').first(), "ArrowDown");
    const row = settingRow(page, "language");
    const picker = row.locator("select");
    await expect(picker.locator("option").first()).toHaveText(
      inLanguage("en", () => m.settingsLanguageDefault({ language: ownLanguageName("en") })),
    );

    // The keyboard steps to the last language: the window stays English and
    // nothing is saved until Enter applies it. A closed picker's step keys
    // change its value only on Linux (and Windows); on the Mac they open the
    // menu and step nothing, so this part runs on Linux alone.
    if (process.platform === "linux") {
      await pressKey(picker, "End");
      const stepped = choosableLanguages().at(-1);
      await expect(picker).toHaveValue(stepped ?? "");
      await expect(html).toHaveAttribute("lang", "en");
      expect(
        await page.evaluate(() => window.infinitary.settings.getAppearance()),
      ).not.toHaveProperty("language");
      await pressKey(picker, "Enter");
      await expect(html).toHaveAttribute("lang", stepped ?? "");
      await expect(picker).toBeFocused();

      await pressKey(picker, "ArrowUp");
      const left = choosableLanguages().at(-2);
      await expect(picker).toHaveValue(left ?? "");
      await expect(html).toHaveAttribute("lang", stepped ?? "");
      await pressKey(picker, "Tab");
      await expect(html).toHaveAttribute("lang", left ?? "");
      await expect
        .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
        .toMatchObject({ language: left });
    }

    // Arabic, chosen from the row, redraws the window right to left at once,
    // on the same tab with the picker still focused.
    await focusOn(picker);
    await picker.selectOption("ar");
    await expect(html).toHaveAttribute("lang", "ar");
    await expect(html).toHaveAttribute("dir", "rtl");
    await expect(settingsSection(page, "appearance")).toBeVisible();
    await expect(picker).toBeFocused();
    await expect(row).toContainText(inLanguage("ar", () => m.settingsLanguage()));
    // The notice that parts still show English sits on a line of its own.
    await expect(row.locator("[data-language-partial]")).toHaveText(
      inLanguage("ar", () => m.settingsLanguagePartial()),
    );
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .toMatchObject({ language: "ar" });
  } finally {
    await first.close();
  }

  const second = await launchApp({ withMockProvider: true, env: computer, userDataDir, homeDir });
  try {
    const { page } = second;
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "ar");
    await pressWindowKey(second.app, ",", ["meta"]);
    await pressKey(page.locator('[data-settings-tabs] [role="tab"]').first(), "ArrowDown");
    const picker = settingRow(page, "language").locator("select");
    await expect(picker).toHaveValue("ar");

    await focusOn(picker);
    await picker.selectOption("");
    await expect(html).toHaveAttribute("lang", "en");
    await expect(html).toHaveAttribute("dir", "ltr");
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .not.toHaveProperty("language");
  } finally {
    await second.close();
  }
});
