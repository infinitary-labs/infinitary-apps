import { expect, type Locator, type Page } from "@playwright/test";
import { pressKey } from "./windowKeys";

/**
 * A panel's status mark by its name (docs/personal-panels.md, "The status
 * mark"): the one place the host says what it knows about a panel that its
 * code cannot say.
 */
export function panelStatusMark(page: Page, id: string): Locator {
  return page.locator(`[data-side-panel="${id}"] [data-panel-status-mark="${id}"]`);
}

/** The mark's open details, drawn over the window. */
export function panelStatusDetails(page: Page, id: string): Locator {
  return page.locator(`[data-panel-status-details="${id}"]`);
}

/** Opens the mark's details from the keyboard, as a person reaching it with Tab would; open ones stay open. */
export async function openPanelStatus(page: Page, id: string): Promise<Locator> {
  const details = panelStatusDetails(page, id);
  if (!(await details.isVisible())) await pressKey(panelStatusMark(page, id), "Enter");
  await expect(details).toBeVisible();
  return details;
}

/** Closes the mark's details with Esc, which gives focus back to the mark. */
export async function closePanelStatus(page: Page, id: string): Promise<void> {
  const details = panelStatusDetails(page, id);
  await pressKey(details, "Escape");
  await expect(details).toHaveCount(0);
  await expect(panelStatusMark(page, id)).toBeFocused();
}
