import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { type FakeBridge, fakeBridge } from "./bridge";
import { seededHome } from "./freshHome";
import { answerStack, SHOWN_ENTRY, shownEntry, stageAtRest } from "./stack";
import { openWindow } from "./window";

// INF-1011, captain: closing a card must remove it without a brief flash.
// Ordinary ready notes reproduce the alpha's failure without model or network work.

type Sample = { role: string | null; opacity: number; connected: boolean };

/**
 * Reads the closing drawing's role and opacity on every frame until it
 * leaves, and at the real cancellation boundary too: an opaque connected
 * outgoing node there is the exact rebound a paint can expose before React
 * retires it.
 */
function sampleWhileItLeaves(node: HTMLElement): Sample[] {
  const samples: Sample[] = [];
  const read = () =>
    samples.push({
      role: node.getAttribute("data-stage-entry"),
      opacity: Number(getComputedStyle(node).opacity),
      connected: node.isConnected,
    });
  const cancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function (this: Animation) {
    const target = (this.effect as KeyframeEffect | null)?.target;
    cancel.call(this);
    if (target === node) read();
  };
  const tick = () => {
    read();
    if (node.isConnected) requestAnimationFrame(tick);
    else Animation.prototype.cancel = cancel;
  };
  requestAnimationFrame(tick);
  return samples;
}

/** Closes the shown note and returns what its drawing did until it left. */
async function closeShown(bridge: FakeBridge, id: string): Promise<Sample[]> {
  await expect.poll(() => shownEntry()?.dataset.stageEntryId).toBe(id);
  await stageAtRest();
  const closing = shownEntry();
  if (!closing) throw new Error(`${id} has not drawn`);
  const samples = sampleWhileItLeaves(closing);
  await page.elementLocator(closing).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => document.querySelector(`[data-stage-entry-id="${id}"]`)).toBeNull();
  expect(bridge.requests("inf:cards:close").at(-1)?.[0]).toBe(id);
  return samples;
}

/** Whether a closing drawing ever became more opaque before it left. */
function expectNoRebound(samples: Sample[]): void {
  const outgoing = samples.filter((sample) => sample.connected && sample.role === "outgoing");
  const reversals = outgoing.filter((sample, i) => {
    const previous = outgoing[i - 1];
    return previous !== undefined && sample.opacity > previous.opacity;
  });
  expect(outgoing.length, "the check observed the real outgoing drawing").toBeGreaterThan(1);
  expect(reversals, "a closing card must not become more opaque before it leaves").toEqual([]);
}

test("Close never restores the outgoing drawing, with a card behind it or as the last card", async () => {
  const home = await seededHome({ count: 2 });
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  await openWindow(bridge);

  // With a card behind it: the next note comes up as the first leaves.
  expectNoRebound(await closeShown(bridge, "flash-0"));
  await expect.poll(() => shownEntry()?.dataset.stageEntryId).toBe("flash-1");

  // As the last card: the stack empties as it leaves.
  expectNoRebound(await closeShown(bridge, "flash-1"));
  expect(document.querySelectorAll(SHOWN_ENTRY)).toHaveLength(0);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
