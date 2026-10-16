import { describe, expect, it } from "vitest";
import { stageMove } from "./stageMoves";

const stack = (...ids: string[]) => ids.map((id) => ({ id }));

describe("the move that replaces the shown card", () => {
  it("slides with the arrow that paged away from it", () => {
    expect(stageMove("a", stack("a", "b"), { from: "a", dir: 1 })).toEqual({
      kind: "page",
      dir: 1,
    });
    expect(stageMove("b", stack("a", "b"), { from: "b", dir: -1 })).toEqual({
      kind: "page",
      dir: -1,
    });
  });

  it("drops away when the card left the stack, whatever arrow was pressed before", () => {
    expect(stageMove("a", stack("b", "c"), null)).toEqual({ kind: "close" });
    expect(stageMove("a", stack("b"), { from: "a", dir: 1 })).toEqual({ kind: "close" });
  });

  it("crossfades when the card stays on the stack and no arrow moved from it", () => {
    // A reply sends the shown card to the back; a record jumps to the front.
    expect(stageMove("a", stack("b", "a"), null)).toEqual({ kind: "swap" });
    expect(stageMove("a", stack("r", "a", "b"), { from: "b", dir: 1 })).toEqual({ kind: "swap" });
  });
});
