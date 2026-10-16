import type { FrameLocator, Locator, Page } from "@playwright/test";
import { drawnFrame } from "./frames";
import { SHOWN_ENTRY } from "./stack";

/**
 * A panel's cards on the stack and the buttons the app draws in a panel's
 * header (docs/ui-plugins.md, "A panel's cards"), by their data hooks:
 * a card by its panel and its id there, never by its words.
 */

/** The shown entry when it is this panel's card. */
export function shownPanelCard(page: Page, panel: string, id: string): Locator {
  return page.locator(`${SHOWN_ENTRY} [data-panel-card="${panel}/${id}"]`);
}

/** The app's own title row of the shown panel card: its title, attribution and Hide. */
export function panelCardChrome(page: Page): {
  title: Locator;
  attribution: Locator;
  hide: Locator;
} {
  const chrome = page.locator(`${SHOWN_ENTRY} [data-panel-card-chrome]`);
  return {
    title: chrome.locator("[data-panel-card-title]"),
    attribution: chrome.locator("[data-panel-card-attribution]"),
    hide: chrome.getByRole("button", { name: "Hide", exact: true }),
  };
}

/** The page of the shown card of a panel from elsewhere, drawn in a frame of its own. */
export function shownPanelCardFrame(page: Page): FrameLocator {
  return drawnFrame(page, `${SHOWN_ENTRY} [data-panel-card-page] iframe`);
}

/** One of the buttons the app draws in a panel's header, by its id in the manifest. */
export function panelHeaderButton(page: Page, panel: string, button: string): Locator {
  return page.locator(`[data-side-panel="${panel}"] [data-panel-header-button="${button}"]`);
}
