import { type Card, splitSettleFacts } from "@shared/cards";
import { changeLinesShortWords } from "@shared/vocabulary";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, bodyDrawn, inFrameTitled, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A merge card counts as seen though the host rewrote its fact strip after
 * its body drew (INF-3429). The host fills the strip in as its facts come in
 * - the lines the change adds and deletes, read from git a moment after the
 * card goes up, and the checks' ages on every tick - while the body frame,
 * which draws the body without the strip, has nothing new to draw. A Mac
 * journey's completion card stayed unseen when the lines came in between
 * its body drawing and its seen report: the stage waited for a drawing of
 * the whole body that never came.
 */

const TITLE = "The meter test reads after the write";
const MERGE = "Merge";
const LINES = { added: 12, deleted: 3 };

function listedCard(home: Awaited<ReturnType<typeof seededHome>>): Card {
  const listed = home["inf:cards:list"];
  if (!Array.isArray(listed) || listed.length !== 1)
    throw new Error("The seeded home lists no single card");
  return listed[0] as Card;
}

/** The window is in front of the captain, or behind another one. */
const present = (value: boolean) => {
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => value });
  window.dispatchEvent(new Event(value ? "focus" : "blur"));
};

test("a merge card counts as seen once shown, though its facts came in after its body drew", async () => {
  const home = await seededHome({ title: TITLE, merge: MERGE });
  const card = listedCard(home);
  // The same card as the host lists it once it has read the change's lines.
  const refreshed = listedCard(await seededHome({ title: TITLE, merge: MERGE, lines: LINES }));
  expect(refreshed.body).not.toBe(card.body);
  expect(splitSettleFacts(refreshed.body)?.body).toBe(splitSettleFacts(card.body)?.body);
  const bridge = fakeBridge(home);
  answerStack(bridge, home);

  // Section: the window is behind another one while the card's body draws,
  // so nothing counts as seen yet.
  present(false);
  try {
    await openSize();
    await openWindow(bridge);
    await bodyDrawn(TITLE);
    await stageAtRest();

    // Section: the host's strip gains the Lines fact, as it does once it has
    // read the change; the card's facts show it above the buttons.
    bridge.push("inf:cards", [{ ...card, body: refreshed.body }]);
    await expect
      .poll(() => inFrameTitled(`${TITLE} facts`, () => document.body.textContent ?? ""))
      .toContain(changeLinesShortWords(LINES.added, LINES.deleted));
    expect(bridge.requests("inf:cards:seen-update")).toEqual([]);

    // Section: the captain comes back to the window; the card on screen is
    // the update the core released, and the window reports it seen once.
    present(true);
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
