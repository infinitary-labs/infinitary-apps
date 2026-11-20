import { describe, expect, it } from "vitest";
import { modelAddedLead, modelAddedNote, modelGoneLead, modelGoneNote } from "./modelNews";

describe("model news", () => {
  it("says where a new model went, or that it stays off", () => {
    expect(modelAddedNote("Claude", "claude-sonnet-5-6", ["high", "medium"])).toBe(
      "Claude added claude-sonnet-5-6 to high and medium.",
    );
    expect(modelAddedNote("Claude", "claude-sonnet-5-6", [])).toBe(
      "Claude added claude-sonnet-5-6 - it stays off until you place it in a slot.",
    );
    expect(modelAddedLead("Claude")).toBe("Claude added ");
  });

  it("says a model left, and the levels it was in", () => {
    expect(modelGoneNote("Claude", "claude-opus-4-8", ["low"])).toBe(
      "Claude no longer serves claude-opus-4-8 - it was in low.",
    );
    expect(modelGoneNote("Claude", "Claude Opus 4.8", [])).toBe(
      "Claude no longer serves Claude Opus 4.8.",
    );
    expect(modelGoneLead("Claude")).toBe("Claude no longer serves ");
  });
});
