import type { Card } from "@shared/cards";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A card the captain reads counts as seen though the keyboard focus sat
 * inside its body when the window came back to the front (INF-3701, the
 * captain: "my current cards are always marked new even though i read
 * them"). A card's body is its own frame: the window coming back gives that
 * frame the focus, and the window's own page hears no focus of its own. The
 * frame's bridge says its window gained the focus, and the card on screen
 * counts as seen then.
 */

const TITLE = "Sampler result";

function listedCard(home: Awaited<ReturnType<typeof seededHome>>): Card {
  const listed = home["inf:cards:list"];
  if (!Array.isArray(listed) || listed.length !== 1)
    throw new Error("The seeded home lists no single card");
  return listed[0] as Card;
}

const inFront = (value: boolean) =>
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => value });

test("a shown card counts as seen when the window comes back with the focus inside its body", async () => {
  const home = await seededHome({ title: TITLE });
  const card = listedCard(home);
  const bridge = fakeBridge(home);
  answerStack(bridge, home);

  // Section: the window is behind another one while the card's body draws,
  // so nothing counts as seen yet.
  inFront(false);
  window.dispatchEvent(new Event("blur"));
  try {
    await openSize();
    await openWindow(bridge);
    await bodyDrawn(TITLE);
    await stageAtRest();
    expect(bridge.requests("inf:cards:seen-update")).toEqual([]);

    // Section: the captain brings the window back, and the focus returns to
    // the link inside the card's body: the body's own window gains it, and
    // the window's page hears nothing.
    inFront(true);
    await inCardBody(TITLE, () => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    await expect
      .poll(() => bridge.requests("inf:cards:seen-update"))
      .toEqual([[card.id, card.lifecycleId, card.currentUpdateId]]);
  } finally {
    Reflect.deleteProperty(document, "hasFocus");
  }
  expect(card.lifecycleId).toBeTruthy();
  expect(card.currentUpdateId).toBeTruthy();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
