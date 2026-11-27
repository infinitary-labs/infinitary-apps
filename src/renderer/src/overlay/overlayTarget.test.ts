import { describe, expect, it } from "vitest";
import { overlayTarget } from "./overlayTarget";

// Intent: INF-7063's plan, "Find the card": the last notified card that is
// still eligible, otherwise the next eligible decision, then the current
// stack entry; an empty stack shows nothing.

const decision = (id: string) => ({ id, actions: [{ id: "go" }] });
const note = (id: string) => ({ id, actions: [] });

describe("overlayTarget", () => {
  it("shows the notified card while it is on the stack and asks for a choice", () => {
    const stack = [decision("first"), decision("notified")];
    expect(overlayTarget(stack, "first", "notified")).toBe("notified");
  });

  it("passes over a notified card that left the stack, or no longer asks", () => {
    expect(overlayTarget([note("notified"), decision("next")], "notified", "notified")).toBe(
      "next",
    );
    expect(overlayTarget([decision("next")], "next", "gone")).toBe("next");
  });

  it("shows the first decision before the card the stack shows now", () => {
    expect(overlayTarget([note("shown"), decision("asks")], "shown", null)).toBe("asks");
  });

  it("shows the card the stack shows when none asks", () => {
    expect(overlayTarget([note("a"), note("shown")], "shown", null)).toBe("shown");
    expect(overlayTarget([note("a"), note("b")], undefined, null)).toBe("a");
  });

  it("shows nothing when the stack is empty", () => {
    expect(overlayTarget([], undefined, "notified")).toBeNull();
  });
});
