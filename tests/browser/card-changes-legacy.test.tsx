import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { bodyDrawn, inCardBody, SHOWN_ENTRY } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Card changes, moved from `tests/e2e/card-changes.spec.ts`: a card revised
 * before revisions carried their links says its change links are
 * unavailable and guesses none, and its plain-text body keeps its paragraph
 * breaks. One window with the first mate's card, whose thread holds the
 * host's plain note of an earlier revision.
 */

const TITLE = "Review the project checks";
const PARAGRAPHS = ["First paragraph.", "Second paragraph."];

test("legacy revisions have no guessed links and keep plain-text paragraph breaks", async () => {
  const bridge = fakeBridge(
    subscribed(
      await seededHome({
        first: { title: TITLE, body: PARAGRAPHS.join("\n\n") },
        captain: "Check the connected account before starting.",
        earlier: "An earlier revision",
      }),
    ),
  );
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect
    .poll(() =>
      document.querySelector(`${SHOWN_ENTRY} [data-revision-unavailable]`)?.checkVisibility(),
    )
    .toBe(true);
  expect(document.querySelectorAll(`${SHOWN_ENTRY} [data-revision-link]`)).toHaveLength(0);
  await bodyDrawn(TITLE);
  await expect
    .poll(() =>
      inCardBody(TITLE, () => [...document.querySelectorAll("p")].map((p) => p.textContent)),
    )
    .toEqual(PARAGRAPHS);
  // The core's own reading of the thread the window drew names no revision
  // on any message.
  const [cardId] = bridge.requests("inf:cards:thread")[0] ?? [];
  if (!cardId) throw new Error("The window read no thread");
  const { messages } = await bridge.api.cards.thread(cardId);
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.every((message) => !message.revision)).toBe(true);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
