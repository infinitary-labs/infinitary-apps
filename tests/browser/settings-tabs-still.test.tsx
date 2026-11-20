import { expect, test } from "vitest";
import { type Locator, page, userEvent } from "vitest/browser";
import { SETTINGS_COLUMN_PX } from "../../src/renderer/src/settings/SettingsScreen";
import { fakeBridge } from "./bridge";
import { freshHome, offeredSettingsSections } from "./freshHome";
import { APP_WINDOW, openWindow } from "./window";

// The captain's ask: "keep all settings tab a consistent width, so the left
// hand tab list also stays static not keep shifting left and right slightly".
// A scroll bar that takes room comes in on a tall section and goes on a short
// one; it used to narrow the scroll region, recentre the column and move the
// tab list sideways.
test("the Settings tab list and section keep one place whether or not the section scrolls", async () => {
  await page.viewport(APP_WINDOW.width, APP_WINDOW.height);
  // Draw a scroll bar that takes room, as a Mac with a mouse attached or
  // "Show scroll bars: Always" does, even where this browser floats its own.
  const bar = document.createElement("style");
  bar.textContent = '[data-screen-label="Settings"]::-webkit-scrollbar { width: 15px; }';
  document.head.append(bar);
  const home = freshHome();
  const bridge = fakeBridge(home);
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect.element(tabs).toBeVisible();
  const screen = document.querySelector<HTMLElement>('[data-screen-label="Settings"]');
  if (!screen) throw new Error("Settings drew no screen");

  // The app's own window, where the column fills it and a scroll bar would
  // narrow the section, and one wider than the column plus a scroll bar,
  // where the column sits centred and a scroll bar would move it; both short
  // enough that some sections scroll and others do not.
  for (const width of [APP_WINDOW.width, SETTINGS_COLUMN_PX + 232]) {
    await page.viewport(width, APP_WINDOW.height);
    await placesKept(width, tabs, screen, offeredSettingsSections(home));
  }
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});

async function placesKept(
  width: number,
  tabs: Locator,
  screen: HTMLElement,
  sections: readonly { label: string }[],
): Promise<void> {
  const places: { label: string; scrolls: boolean; tabsLeft: number; sectionWidth: number }[] = [];
  for (const { label } of sections) {
    const tab = tabs.getByRole("tab", { name: label, exact: true });
    await userEvent.click(tab);
    await expect.element(tab).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel").element().getBoundingClientRect();
    places.push({
      label,
      scrolls: screen.scrollHeight > screen.clientHeight,
      tabsLeft: tabs.element().getBoundingClientRect().left,
      sectionWidth: panel.width,
    });
  }
  // The check only means something when the sections differ in height.
  expect(
    new Set(places.map((place) => place.scrolls)),
    `at ${width} px some sections scroll and some do not`,
  ).toEqual(new Set([true, false]));
  const first = places[0];
  for (const place of places) {
    expect(
      { tabsLeft: place.tabsLeft, sectionWidth: place.sectionWidth },
      `at ${width} px ${place.label} (${place.scrolls ? "scrolls" : "fits"}) keeps the tab list and section in place`,
    ).toEqual({ tabsLeft: first?.tabsLeft, sectionWidth: first?.sectionWidth });
  }
}
