import { expect, test } from "@playwright/test";
import { THIS_DESKTOP } from "./desktop";
import { launchApp } from "./launch";
import { minimumWindowSize, resizeWindow } from "./layout";
import { pressKey } from "./windowKeys";

test("Appearance groups the existing saved choices without changing General or resetting them", async () => {
  // Settings offers the window wash only beside the Mac's window material
  // (docs/translucent-window.md); elsewhere the other choices are grouped
  // the same way.
  const { material: washOffered } = THIS_DESKTOP;
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    // An existing appearance record survives the move, including a non-default wash.
    await page.evaluate(() =>
      window.infinitary.settings.setAppearance({
        theme: "light",
        washStrength: 42,
        showCrewModelNames: false,
      }),
    );
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: test.info().outputPath("general.png") });
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const light = page.getByRole("radio", { name: "Light", exact: true });
    const dark = page.getByRole("radio", { name: "Dark", exact: true });
    const wash = page.getByRole("slider", { name: "Window wash" });
    const names = page.getByRole("switch", { name: "Crew model names" });
    await expect(light).toBeChecked();
    if (washOffered) await expect(wash).toHaveValue("42");
    await expect(names).not.toBeChecked();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({ path: test.info().outputPath("appearance-light.png") });
    await dark.check();
    await expect.poll(() => page.evaluate(() => document.body.dataset.theme)).toBe("dark");
    if (washOffered) await wash.fill("35");
    await names.click();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getPreferences()))
      .toMatchObject({
        appearance: {
          theme: "dark",
          ...(washOffered ? { washStrength: 35 } : {}),
          showCrewModelNames: true,
        },
      });
    await page.screenshot({ path: test.info().outputPath("appearance-dark.png") });
    await resizeWindow(app.app, page, await minimumWindowSize(app.app));
    for (const control of [dark, light, ...(washOffered ? [wash] : []), names])
      await expect(control).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("appearance-minimum.png") });
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(dark).toBeChecked();
    if (washOffered) await expect(wash).toHaveValue("35");
    await expect(names).toBeChecked();
    await light.check();
    // Native radios also expose the other choice through the keyboard.
    await pressKey(light, "ArrowLeft");
    await expect(dark).toBeChecked();
    await expect.poll(() => page.evaluate(() => document.body.dataset.theme)).toBe("dark");
  } finally {
    await app.close();
  }
});
