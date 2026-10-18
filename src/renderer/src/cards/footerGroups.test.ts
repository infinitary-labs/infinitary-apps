import type { CardAction } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { choiceOrder } from "./footerGroups";

const labels = (actions: readonly CardAction[]) => choiceOrder(actions).map((a) => a.label);

// The captain's words: "the default should always be cmd+1, and the number
// should grow from the right to the left", so ⌘1 is always the recommended step.
describe("the order the choice keys press a card's buttons", () => {
  it("starts at the default on the right edge and counts leftward", () => {
    // A planner's card as the host sorts it, the default last.
    expect(
      labels([
        { id: "abandon", label: "Abandon", variant: "secondary" },
        { id: "defer", label: "Save and defer", variant: "secondary" },
        { id: "build", label: "Approve and build", variant: "primary", default: true },
      ]),
    ).toEqual(["Approve and build", "Save and defer", "Abandon"]);
  });

  it("keeps ⌘1 on a default drawn first, and counts the rest from the right", () => {
    // The stall card, whose Continue leads its footer.
    expect(
      labels([
        { id: "continue", label: "Continue", variant: "primary", default: true },
        { id: "stop", label: "Drop task", variant: "secondary" },
        { id: "discard", label: "Discard", variant: "danger", danger: true },
      ]),
    ).toEqual(["Continue", "Discard", "Drop task"]);
  });

  it("counts a quiet action, drawn at the left, after the choices", () => {
    // The project setup card: its ghost Not now is drawn before Add.
    expect(
      labels([
        { id: "add", label: "Add project", variant: "primary", default: true },
        { id: "not-now", label: "Not now", variant: "ghost" },
      ]),
    ).toEqual(["Add project", "Not now"]);
  });

  it("starts at the rightmost button on a card with no default", () => {
    expect(
      labels([
        { id: "keep", label: "Keep it", variant: "secondary" },
        { id: "drop", label: "Drop it", variant: "secondary" },
      ]),
    ).toEqual(["Drop it", "Keep it"]);
  });
});
