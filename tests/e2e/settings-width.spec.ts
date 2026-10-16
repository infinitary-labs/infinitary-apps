import { expect, test } from "@playwright/test";
import { builtinManifest } from "../../src/renderer/src/plugins/builtin/manifest";
import { launchApp } from "./launch";
import { minimumWindowSize, overflows, resizeWindow, within } from "./layout";

test("at the minimum window every Settings section opens and none needs a sideways scroll", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const screen = page.locator('[data-screen-label="Settings"]');
    const tabs = page.getByRole("tablist", { name: "Settings sections" });
    // Every section the app declares; Observe's gate is open in an
    // unpackaged run (docs/dev-observe.md).
    const labels = builtinManifest.contributes.settingsSections.map((section) => section.label);
    await resizeWindow(app, page, await minimumWindowSize(app));
    for (const label of labels) {
      await test.step(label, async () => {
        const tab = tabs.getByRole("tab", { name: label, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        const [tabBox, screenBox] = await Promise.all([tab.boundingBox(), screen.boundingBox()]);
        if (!tabBox || !screenBox) throw new Error(`${label}: tab or screen has no box`);
        expect(within(tabBox, screenBox), `${label}'s tab stays in the window`).toEqual([]);
        expect(await overflows(screen), `${label} has no horizontal scrolling`).toBe(0);
      });
    }
  } finally {
    await launched.close();
  }
});
