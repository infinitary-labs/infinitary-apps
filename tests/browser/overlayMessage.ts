import { CARD_OVERLAY_ATTRIBUTE } from "@shared/cardOverlay";
import type { Card } from "@shared/cards";
import type { MainDraft } from "@shared/overlayDraft";
import { page } from "vitest/browser";
import { type FakeBridge, fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack } from "./stack";
import { openWindow } from "./window";

/**
 * The card overlay with its message box, as its browser tests open it
 * (docs/card-overlay.md, "The message box"): a subscribed home's cards, the
 * window's lent message and the overlay's own channels answered. A file opens
 * one window, so each test of the box is a file of its own.
 */

export const TITLES = ["Merge the login fix", "Turn on nightly backups"];
/** The panel's width (`OVERLAY_WIDTH`, src/shared/cardOverlay.ts) and a laptop display's work area. */
const PANEL = { width: 592, height: 945 };
export const HALF_TYPED = "Tell the crew about the";

export const draft = (text: string): MainDraft => ({
  text,
  pastes: [],
  attachments: [],
  lastSent: null,
  replacing: null,
});

export async function openOverlay(titles: string[], lent: MainDraft | null): Promise<FakeBridge> {
  const home = subscribed(await seededHome({ titles }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  let cards = home["inf:cards:list"] as Card[];
  bridge.answer("inf:cards:act", (id) => {
    cards = cards.filter((card) => card.id !== id);
    const held = cards;
    bridge.answer("inf:cards:list", held);
    setTimeout(() => bridge.push("inf:cards", held));
    return {};
  });
  bridge.answer("inf:overlay:start", { cardId: null, lent: lent && { ask: 7, draft: lent } });
  bridge.answer("inf:overlay:ready", { ok: true });
  bridge.answer("inf:overlay:pointer", { ok: true });
  bridge.answer("inf:overlay:wide", { ok: true });
  bridge.answer("inf:overlay:hide", { ok: true });
  bridge.answer("inf:overlay:hand-back", { ok: true });
  bridge.answer("inf:converse", { ok: true });
  document.documentElement.setAttribute(CARD_OVERLAY_ATTRIBUTE, "");
  await page.viewport(PANEL.width, PANEL.height);
  await openWindow(bridge);
  return bridge;
}

export const box = () =>
  document.querySelector<HTMLTextAreaElement>("[data-overlay-message] textarea");
export const boxLocator = () => page.getByRole("textbox", { name: "Task prompt", exact: true });
