import { describe, expect, it } from "vitest";
import type { OpenRecord } from "./stack";
import { clearedByPress, PRESS_COUNTS_MS } from "./stageCleared";
import { card, DECIDE } from "./storeTestKit";

// The captain's ask: "whenever i close the last card on the screen, we would
// play a random fidget". Which emptied stages count is decided here; the
// plan's answer kept views (a task's record, a past card) out.

const note = card({ id: "n1", status: "ready", title: "One", body: "a" });
const decision = card({ id: "d1", status: "ready", actions: DECIDE, title: "Two", body: "b" });
const record: OpenRecord = { taskId: "t1" };

const stage = (cards = [note], records: OpenRecord[] = [], heldBackCardIds: string[] = []) => ({
  cards,
  records,
  heldBackCardIds,
});
const NOW = 100_000;
const pressed = (...ids: string[]) => new Map(ids.map((id) => [id, NOW - 1_000]));

describe("clearedByPress", () => {
  it("counts this window's press on the last card", () => {
    expect(clearedByPress(stage(), stage([]), pressed("n1"), NOW)).toBe(true);
  });

  it("counts Put every card aside, which presses every card at once", () => {
    expect(clearedByPress(stage([note, decision]), stage([]), pressed("n1", "d1"), NOW)).toBe(true);
  });

  it("leaves a withdrawal or another computer's close still: nothing was pressed here", () => {
    expect(clearedByPress(stage(), stage([]), pressed(), NOW)).toBe(false);
  });

  it("counts a card that leaves up to 15 seconds after the press, and not later", () => {
    const at = new Map([["n1", NOW - PRESS_COUNTS_MS]]);
    expect(clearedByPress(stage(), stage([]), at, NOW)).toBe(true);
    expect(clearedByPress(stage(), stage([]), at, NOW + 1)).toBe(false);
  });

  it("stays still while a card remains up", () => {
    expect(clearedByPress(stage([note, decision]), stage([decision]), pressed("n1"), NOW)).toBe(
      false,
    );
  });

  it("stays still when the project focus holds the last card back", () => {
    expect(clearedByPress(stage(), stage([note], [], ["n1"]), pressed("n1"), NOW)).toBe(false);
  });

  it("stays still when the last thing hidden is a view, not a card", () => {
    expect(clearedByPress(stage([], [record]), stage([]), pressed("n1"), NOW)).toBe(false);
  });
});
