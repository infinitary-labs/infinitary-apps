import { describe, expect, it } from "vitest";
import type { Slot } from "../../../shared/modelSlots";
import { dropPlan, levelList, newModelNote, providerPrefix, usedLine } from "./levelDrops";

describe("what a drop on the Models board does", () => {
  const sol = { slots: ["high", "medium"] as const };

  it("moves a model to another level on a plain drop", () => {
    expect(dropPlan({ slots: ["high"] }, "high", "low", false)).toEqual({
      kind: "move",
      from: "high",
      to: "low",
      label: "Move to low",
    });
  });

  it("keeps both levels when ⌥ is held at the drop", () => {
    expect(dropPlan({ slots: ["high"] }, "high", "low", true)).toEqual({
      kind: "add",
      to: "low",
      label: "Also use at low",
    });
  });

  it("places a model that is not in use, whatever the key", () => {
    for (const keepBoth of [false, true]) {
      expect(dropPlan({ slots: [] }, "off", "premium", keepBoth)).toEqual({
        kind: "add",
        to: "premium",
        label: "Use at premium",
      });
    }
  });

  it("takes a model out of every level on Not in use, and names them first", () => {
    expect(dropPlan({ slots: ["medium", "high"] }, "high", "off", false)).toEqual({
      kind: "remove-all",
      label: "Remove from high and medium",
    });
  });

  it("does nothing over a level the model is already at, and says so", () => {
    expect(dropPlan({ slots: [...sol.slots] }, "high", "medium", false)).toEqual({
      kind: "none",
      label: "Already at medium",
    });
  });

  it("has no plan over the place the model was picked up from", () => {
    expect(dropPlan({ slots: ["high"] }, "high", "high", false)).toBeNull();
    expect(dropPlan({ slots: [] }, "off", "off", false)).toBeNull();
  });
});

describe("the words the Models board uses for a model", () => {
  it("lists levels strongest first, however they were stored", () => {
    expect(levelList([])).toBe("");
    expect(levelList(["low"])).toBe("low");
    expect(levelList(["medium", "high"])).toBe("high and medium");
    expect(levelList(["low", "premium", "high"])).toBe("premium, high and low");
  });

  it("names the provider on a pill only where the label does not already", () => {
    expect(providerPrefix({ providerLabel: "Claude", label: "Claude Opus 5.5" })).toBe("");
    expect(providerPrefix({ providerLabel: "Grok", label: "Grok 4.7" })).toBe("");
    expect(providerPrefix({ providerLabel: "Codex", label: "GPT-6.1 Sol" })).toBe("Codex");
    expect(providerPrefix({ providerLabel: "OpenRouter", label: "Claude Opus (latest)" })).toBe(
      "OpenRouter",
    );
  });

  it("says where a model is used, or that it is not", () => {
    expect(usedLine({ slots: ["medium", "high"] })).toBe("Used at high and medium.");
    expect(usedLine({ slots: [] })).toBe("Not in use. It is never picked on its own.");
  });

  // INF-94: a new model's note is true wherever its pill sits. The starter
  // levels already use an arrival they place, so only one with no level
  // waits for one; its panel reads the same note as its pill.
  it("says where a new model is used, or that it waits for a level", () => {
    expect(newModelNote({ slots: ["medium"] })).toBe("New here - it is used at medium.");
    expect(newModelNote({ slots: ["medium", "high"] })).toBe(
      "New here - it is used at high and medium.",
    );
    expect(newModelNote({ slots: [] })).toBe(
      "New here - it is not in use until you give it a level.",
    );
    const placements: Slot[][] = [["medium"], []];
    for (const slots of placements) {
      expect(usedLine({ slots, isNew: true })).toBe(newModelNote({ slots }));
    }
  });
});
