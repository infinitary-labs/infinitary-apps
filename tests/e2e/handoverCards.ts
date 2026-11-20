import { expect, type Locator, type Page } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { showCard, shownCard } from "./stack";

/**
 * The first mate's hand-over cards as the journeys read them
 * (primitives/app-actions.md, "Hand over"): the card a line offers, worded by
 * the host's own offer from the value and what the window reads, the card
 * once it shows its one dismissal, and the way back from Settings.
 * The hand-over journeys import it: settings-handover-cards, device-sign-ins,
 * devices-ssh and view-home-only-cards.
 */

/** The card a hands line offers for this value, as the host words it; throws its refusal. */
export function offeredCard(
  action: keyof typeof ACTIONS,
  value: unknown,
  current: unknown,
  also?: unknown,
) {
  const parsed = ACTIONS[action].value.parse(value) as Record<string, unknown>;
  const offer = ACTIONS[action].offer?.(parsed, current, {
    platform: process.platform,
    ...(also === undefined ? {} : { also }),
  });
  if (!offer) throw new Error(`${action} offers a card`);
  return offer;
}

/**
 * The card for this offer, once it shows its one dismissal and no second one of the app's.
 * Another card may lead the stack, such as a new computer's own setup card, so it pages to it.
 */
export async function handoverCard(
  page: Page,
  offer: { title: string; decline: string },
): Promise<Locator> {
  await showCard(page, offer.title);
  const card = shownCard(page, offer.title);
  await expect(card.getByRole("button", { name: offer.decline, exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0);
  return card;
}

/** Escape until the window is home again, each press closing what it holds. */
export async function leaveSettings(page: Page): Promise<void> {
  const settings = page.locator("[data-settings-column]");
  await expect
    .poll(async () => {
      if (await settings.count()) await page.keyboard.press("Escape");
      return settings.count();
    })
    .toBe(0);
}
