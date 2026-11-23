import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { characters } from "./crew";
import { seededHome } from "./freshHome";
import { answerStack, cardLeave, SHOWN_ENTRY, shownEntry, stageAtRest } from "./stack";
import { openWindow } from "./window";

// The captain's ask: "whenever i close the last card on the screen, we would
// play a random fidget animation in the center area". The machine's own
// rules are machine.test.ts's and which presses count is stageCleared.test.ts's;
// this test owns the wiring between them: the store's stack, this window's
// press and the character's frame.

const firstmate = () => characters()[0]?.getAttribute("aria-label");

/** Puts the shown note aside with its corner, the captain's own press. */
async function putAside(id: string): Promise<void> {
  await expect.poll(() => shownEntry()?.dataset.stageEntryId).toBe(id);
  await stageAtRest();
  await page.elementLocator(cardLeave()).click();
  await expect.poll(() => document.querySelector(`[data-stage-entry-id="${id}"]`)).toBeNull();
}

test("closing the last card plays a fidget, closing one of two does not", async () => {
  const home = await seededHome({ count: 2 });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openWindow(bridge);
  // The opening greeting ends behind the cards.
  await expect.poll(firstmate, { timeout: 10_000 }).toBe("First mate - idle");

  // One of two: a card is still up, so the first mate stays as it was.
  await putAside("fidget-0");
  await stageAtRest();
  expect(firstmate()).toBe("First mate - idle");

  // The last card: the stage empties and the first mate fidgets.
  await putAside("fidget-1");
  expect(document.querySelectorAll(SHOWN_ENTRY)).toHaveLength(0);
  await expect.poll(firstmate, { timeout: 2_000 }).toBe("First mate - fidget");
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
