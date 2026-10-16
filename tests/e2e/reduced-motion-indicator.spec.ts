import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

test("someone who reduces motion on their Mac sees why Firstmate holds still, and only then", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    const badge = page.getByRole("button", { name: "Reduced motion", exact: true });
    const panel = page.locator("[data-reduced-motion-panel]");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(badge).toHaveCount(0);

    // Turning the Mac setting on shows the badge at once.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(badge).toBeVisible();

    // Hovering it opens the explanation; leaving closes it.
    await expect(panel).toHaveCount(0);
    await badge.hover();
    await expect(panel).toBeVisible();
    await page.mouse.move(400, 400);
    await expect(panel).toHaveCount(0);

    // A click keeps it open until Esc.
    await badge.click();
    await page.mouse.move(400, 400);
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // Settings has no gear, and no badge either.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(badge).toHaveCount(0);
    await page.getByRole("button", { name: "Back" }).click();

    // Turning it off removes the badge again.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(badge).toHaveCount(0);
  } finally {
    await app.close();
  }
});
