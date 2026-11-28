import type { MainDraft } from "@shared/overlayDraft";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { messageBox, messageBoxLocator } from "./prompt";
import { openSize, openWindow } from "./window";

/**
 * The window's side of one main message in two places (docs/card-overlay.md,
 * "The message box"). The captain asked for the first mate's message box in
 * the card overlay; the accepted plan has the window lend its unsent words as
 * the overlay opens and take them back as it goes, never replacing words
 * typed in the window meanwhile.
 */

const draft = (text: string): MainDraft => ({
  text,
  pastes: [],
  attachments: [],
  lastSent: null,
  replacing: null,
});

test("the window lends its words to the overlay, takes back the overlay's, and keeps words typed here meanwhile", async () => {
  const bridge = fakeBridge(subscribed(freshHome()));
  bridge.answer("inf:composer:lent", { ok: true });
  await openSize();
  await openWindow(bridge);
  await userEvent.click(messageBoxLocator());
  await userEvent.keyboard("Ask about the");

  // Section: asked, the window lends what its box holds.
  bridge.push("inf:composer:lend-ask", { ask: 3 });
  await expect
    .poll(() => bridge.requests("inf:composer:lent"))
    .toEqual([[{ ask: 3, draft: draft("Ask about the") }]]);

  // Section: the overlay's words come back into the unchanged box.
  bridge.push("inf:composer:hand-back", { ask: 3, draft: draft("Ask about the backups") });
  await expect.poll(() => messageBox()?.value).toBe("Ask about the backups");
  // A hand-back for a lending already taken back changes nothing.
  bridge.push("inf:composer:hand-back", { ask: 3, draft: draft("stale") });

  // Section: words typed here while the overlay is up stay as the overlay goes.
  bridge.push("inf:composer:lend-ask", { ask: 4 });
  await expect.poll(() => bridge.requests("inf:composer:lent").length).toBe(2);
  await userEvent.click(messageBoxLocator());
  await userEvent.keyboard(" tonight");
  bridge.push("inf:composer:hand-back", { ask: 4, draft: draft("from the overlay") });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(messageBox()?.value).toBe("Ask about the backups tonight");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
