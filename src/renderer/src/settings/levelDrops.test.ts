import { describe, expect, it } from "vitest";
import { dropPlan, levelList, providerPrefix, usedLine } from "./levelDrops";

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
    expect(usedLine({ slots: [], isNew: true })).toBe(
      "New here. It is not in use until you give it a level.",
    );
  });
});
