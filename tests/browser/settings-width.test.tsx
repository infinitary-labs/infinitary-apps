import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, offeredSettingsSections } from "./freshHome";
import { within } from "./layout";
import { openWindow } from "./window";

test("at the smallest window every Settings section opens and none needs a sideways scroll", async () => {
  await page.viewport(SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
  const home = freshHome();
  const bridge = fakeBridge(home);
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect.element(tabs).toBeVisible();
  const screen = document.querySelector<HTMLElement>('[data-screen-label="Settings"]');
  if (!screen) throw new Error("Settings drew no screen");
  // Every section the app declares that the home offers; Observe's gate is
  // open in a run from source (docs/dev-observe.md), as the fresh home's
  // answer says, and Secrets' is shut without protected storage.
  const labels = offeredSettingsSections(home).map((section) => section.label);
  for (const label of labels) {
    const tab = tabs.getByRole("tab", { name: label, exact: true });
    await userEvent.click(tab);
    await expect.element(tab).toHaveAttribute("aria-selected", "true");
    expect(
      within(tab.element().getBoundingClientRect(), screen.getBoundingClientRect()),
      `${label}'s tab stays in the window`,
    ).toEqual([]);
    expect(screen.scrollWidth - screen.clientWidth, `${label} has no horizontal scrolling`).toBe(0);
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
