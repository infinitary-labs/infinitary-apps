import { expect, type Locator, type Page } from "@playwright/test";
import { SETUP_CARD_WORDS } from "../../src/shared/projectSetup";
import { showCard, shownCard } from "./stack";

/**
 * The projects the captain added, oldest first: every registered one but the
 * personal workspace, which is a project from the first start so a panel
 * instruction can be a direction scoped to it (INF-1054).
 */
export async function addedProjects(page: Page) {
  return (await page.evaluate(() => window.infinitary.repos.list())).filter(
    (repo) => repo.kind !== "personal",
  );
}

/** One Settings -> Projects row, by its registered repository id. */
export function projectRow(page: Page, id: string): Locator {
  return page.locator(`[data-project="${id}"]`);
}

/**
 * The setup card a Firstmate proposal put up for the project named `name`
 * (docs/fleet.md, "Asking the first mate to add a project"), as the stage shows it.
 */
export function setupCard(page: Page, name: string): Locator {
  return shownCard(page, SETUP_CARD_WORDS.title(name));
}

/** Brings the setup card for `name` forward once the app has put it up. */
export async function showSetupCard(page: Page, name: string): Promise<void> {
  const title = SETUP_CARD_WORDS.title(name);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (card) => card.title === title,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await showCard(page, title);
}

/**
 * The captain's Add project on the setup card for `name`: its own footer
 * button, which alone adds the project, with whatever its questions hold.
 * The card leaves the stage on the click.
 */
export async function addFromSetupCard(page: Page, name: string): Promise<void> {
  await showSetupCard(page, name);
  await page
    .locator("[data-card-layer]")
    .getByRole("button", { name: SETUP_CARD_WORDS.add, exact: true })
    .click();
  await expect(setupCard(page, name)).toHaveCount(0, { timeout: 10_000 });
}
