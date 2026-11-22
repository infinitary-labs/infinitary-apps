import type { Appearance } from "@shared/preferences";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Keep cards maximized (the captain's ask, INF-3152: "if the user last
 * maximized a card, then other cards should reveal maximized by default
 * (including cards already in the stack)", made a separate switch beside
 * Default card size): turned on in Settings → Appearance by Tab and Space,
 * a maximize carries to the next card already in the stack, and a restore
 * carries back, each saved with the look.
 */

const TITLES: [string, string] = ["Compare the two launch plans", "Pick the release window"];

const control = (label: string) =>
  page.getByRole("button", { name: label, exact: true }).query() as HTMLElement | null;

const maximized = () => document.querySelector("[data-card-layer][data-card-maximized]") !== null;

const shownTitle = (title: string) => page.getByRole("region", { name: title, exact: true });

const switchOf = () =>
  document.querySelector<HTMLElement>('[data-setting="keep-cards-maximized"] [role="switch"]');

test("Keep cards maximized carries a maximize and a restore to every card in the stack", async () => {
  const home = subscribed(await seededHome({ titles: TITLES }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  const read = home["inf:settings:appearance:get"];
  if (!read || typeof read === "function") throw new Error("The home reads no appearance");
  let saved: Appearance = read;
  const saves: Appearance[] = [];
  bridge.answer("inf:settings:appearance:get", () => saved);
  bridge.answer("inf:settings:appearance:set", (appearance) => {
    saves.push(appearance);
    saved = appearance;
    return saved;
  });
  await openSize();
  await openWindow(bridge);
  await expect.element(shownTitle(TITLES[0])).toBeVisible();

  // Section: the switch is off on a fresh install, follows Default card size by Tab, and Space turns it on.
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Appearance", exact: true }));
  await expect.poll(() => switchOf()?.getAttribute("aria-checked")).toBe("false");
  const cardSize = document.querySelector<HTMLElement>(
    '[data-setting="default-card-size"] input:checked',
  );
  if (!cardSize) throw new Error("Default card size shows no choice");
  cardSize.focus();
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => document.activeElement === switchOf()).toBe(true);
  await userEvent.keyboard(" ");
  await expect.poll(() => switchOf()?.getAttribute("aria-checked")).toBe("true");
  await expect.poll(() => saved.keepCardsMaximized).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

  // Section: the first card opens at its usual size; maximizing it saves that cards are maximized.
  await expect.element(shownTitle(TITLES[0])).toBeVisible();
  expect(maximized()).toBe(false);
  await expect.poll(() => control(MAXIMIZE_LABEL)).not.toBeNull();
  await userEvent.click(control(MAXIMIZE_LABEL) as HTMLElement);
  await expect.poll(maximized).toBe(true);
  await expect.poll(() => saved.cardsMaximized).toBe(true);

  // Section: the next card, already in the stack, comes forward maximized.
  await userEvent.click(page.getByRole("button", { name: "Next card", exact: true }));
  await expect.element(shownTitle(TITLES[1])).toBeVisible();
  await stageAtRest();
  expect(maximized()).toBe(true);
  await expect.poll(() => control(RESTORE_LABEL)).not.toBeNull();

  // Section: Escape restores it, and the first card comes back restored too.
  (control(RESTORE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(maximized).toBe(false);
  await expect.poll(() => saved.cardsMaximized).toBe(false);
  await userEvent.click(page.getByRole("button", { name: "Previous card", exact: true }));
  await expect.element(shownTitle(TITLES[0])).toBeVisible();
  await stageAtRest();
  expect(maximized()).toBe(false);
  // Every save kept the rest of the look as it was.
  for (const save of saves) expect(save.theme).toBe(read.theme);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
