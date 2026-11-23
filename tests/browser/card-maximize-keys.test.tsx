import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { EDGE_KEY_STEP } from "../../src/renderer/src/app/stage/CardEdges";
import { CARD_DRAG_MIN } from "../../src/renderer/src/cards/cardGeometry";
import {
  FIND_LABEL,
  MAXIMIZE_LABEL,
  PUT_ASIDE_LABEL,
  RESTORE_LABEL,
} from "../../src/renderer/src/design/cards/cardSizeWords";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { messageBox } from "./prompt";
import { answerStack } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A maximized card from the keyboard (design skill ResponseCard, "Maximize";
 * the captain's rule that every feature works from the keyboard): the size
 * control maximizes the shown card and keeps focus, Tab and Shift+Tab go
 * round the card and its pager while the rest of the window is aside, Escape
 * gives it back, and the arrows, Home and Enter move its edge. Guardrails for
 * INF-2625's renderer piece, which moves this code out of HomeScreen.tsx:
 * they hold what a person sees before and after the move.
 */

const TITLES: [string, string] = ["Compare the two launch plans", "Pick the release window"];

const control = (label: string) =>
  page.getByRole("button", { name: label, exact: true }).query() as HTMLElement | null;

const focused = () => document.activeElement;

/** Whether the main message box shows: a maximized card puts it aside. */
const messageShown = () =>
  messageBox()?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ?? false;

const maximized = () => document.querySelector("[data-card-layer][data-card-maximized]") !== null;

const rightEdge = () =>
  document.querySelector<HTMLElement>('[data-card-layer] [data-card-edge="right"]');

test("a card maximizes from the keyboard, keeps Tab round it and its pager, and its edge moves by keys", async () => {
  const home = subscribed(await seededHome({ titles: TITLES }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openSize();
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLES[0], exact: true })).toBeVisible();

  // Section: the size control maximizes the card and keeps focus.
  await expect.poll(() => control(MAXIMIZE_LABEL)).not.toBeNull();
  (control(MAXIMIZE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => focused() === control(RESTORE_LABEL)).toBe(true);
  await expect.poll(maximized).toBe(true);
  await expect.poll(messageShown).toBe(false);

  // Section: Tab and Shift+Tab go round the card and its pager.
  (control(PUT_ASIDE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.poll(() => focused() === control(RESTORE_LABEL)).toBe(true);
  // Find in this card's magnifying glass stands just before Maximize.
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.poll(() => focused() === control(FIND_LABEL)).toBe(true);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  await expect.poll(() => focused()?.closest("[data-card-pager]") !== null).toBe(true);
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => focused() === control(FIND_LABEL)).toBe(true);
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => focused() === control(RESTORE_LABEL)).toBe(true);
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => focused() === control(PUT_ASIDE_LABEL)).toBe(true);

  // Section: Escape gives the card back, focus on the control that maximizes it again.
  (control(RESTORE_LABEL) as HTMLElement).focus();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => focused() === control(MAXIMIZE_LABEL)).toBe(true);
  await expect.poll(maximized).toBe(false);
  await expect.poll(messageShown).toBe(true);

  // Section: the arrows, Home and Enter move the card's edge and give its width back.
  await expect.poll(() => rightEdge()).not.toBeNull();
  const chosen = Number(rightEdge()?.getAttribute("aria-valuenow"));
  (rightEdge() as HTMLElement).focus();
  // The card is centred, so a step on one edge moves both and the width changes by two steps.
  await userEvent.keyboard("{ArrowLeft}");
  await expect
    .poll(() => rightEdge()?.getAttribute("aria-valuenow"))
    .toBe(String(chosen - 2 * EDGE_KEY_STEP));
  await userEvent.keyboard("{Home}");
  await expect.poll(() => rightEdge()?.getAttribute("aria-valuenow")).toBe(String(CARD_DRAG_MIN));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => rightEdge()?.getAttribute("aria-valuenow")).toBe(String(chosen));
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
