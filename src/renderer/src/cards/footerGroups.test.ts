import type { CardAction } from "@shared/cards";
import { describe, expect, it } from "vitest";
import { choiceOrder, footerGroups } from "./footerGroups";

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

const drawn = (actions: readonly CardAction[]) =>
  footerGroups(actions).map((group) => [group.key, group.actions.map((action) => action.label)]);

// The design skill's footer rule (ResponseCard): the other choices, then the
// default at the right edge, on every card, including the ones the app writes
// itself, which list their default first (INF-404).
describe("the order a card's footer draws its buttons", () => {
  it("draws the default last on a card the app lists default first", () => {
    // The stuck-task card, as the idle ladder lists it.
    expect(
      drawn([
        { id: "continue", label: "Continue", variant: "primary", default: true },
        { id: "stop", label: "Drop task", variant: "secondary" },
        { id: "discard", label: "Discard", variant: "danger", danger: true },
      ]),
    ).toEqual([["choices", ["Drop task", "Discard", "Continue"]]]);
  });

  it("keeps a quiet action at the left, and the default at the right of the choices", () => {
    // The card that finishes setting up another computer.
    expect(
      drawn([
        { id: "subscription", label: "Add a subscription", default: true },
        { id: "github", label: "Sign in to GitHub on Mac mini" },
        { id: "project", label: "Choose a project" },
        { id: "not-now", label: "Not now", variant: "ghost" },
      ]),
    ).toEqual([
      ["quiet", ["Not now"]],
      ["choices", ["Sign in to GitHub on Mac mini", "Choose a project", "Add a subscription"]],
    ]);
  });

  it("leaves a footer already in order, or with no default, as it is listed", () => {
    // A planner's card as the host sorts an agent's actions.
    expect(
      drawn([
        { id: "abandon", label: "Abandon", variant: "secondary" },
        { id: "defer", label: "Save and defer", variant: "secondary" },
        { id: "build", label: "Approve and build", variant: "primary", default: true },
      ]),
    ).toEqual([["choices", ["Abandon", "Save and defer", "Approve and build"]]]);
    expect(
      drawn([
        { id: "keep", label: "Keep it", variant: "secondary" },
        { id: "drop", label: "Drop it", variant: "secondary" },
      ]),
    ).toEqual([["choices", ["Keep it", "Drop it"]]]);
  });
});
