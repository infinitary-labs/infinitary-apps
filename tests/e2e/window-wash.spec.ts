import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { THIS_DESKTOP } from "./desktop";
import { launchApp } from "./launch";
import { MAC_ONLY_TAG } from "./tags";

// The window wash tints the Mac's window material; Linux draws an opaque
// window and Settings offers no wash there (docs/translucent-window.md).
test.skip(!THIS_DESKTOP.material, "the window wash is the Mac's");

test("saved 20% becomes 0% once, and a later 20% survives relaunch", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const userDataDir = scratchDir("infinitary-wash-migration-");
  const db = openDatabase(userDataDir);
  const write = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  write.run("appearance", JSON.stringify({ theme: "dark", washStrength: 20 }));
  write.run("wash-opacity-v2", "true");
  db.close();
  let app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await app.page.getByRole("button", { name: "Settings" }).click();
    await app.page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const slider = app.page.getByRole("slider", { name: "Window wash" });
    await expect(slider).toHaveValue("0");
    expect(
      (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
        .washStrength,
    ).toBe(0);
    await app.page.screenshot({ path: test.info().outputPath("migrated-zero.png") });
    await slider.fill("20");
    await expect
      .poll(
        async () =>
          (await app.page.evaluate(() => window.infinitary.settings.getPreferences())).appearance
            .washStrength,
      )
      .toBe(20);
    const homeDir = app.homeDir;
    await app.close();
    app = await launchApp({ userDataDir, homeDir, withMockProvider: true });
    await app.page.getByRole("button", { name: "Settings" }).click();
    await app.page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(app.page.getByRole("slider", { name: "Window wash" })).toHaveValue("20");
    await app.page.screenshot({ path: test.info().outputPath("later-twenty.png") });
  } finally {
    await app.close();
  }
});
