import { describe, expect, it } from "vitest";
import { frozenClassify } from "./migrateModelSlots";

/**
 * The frozen classifier is a snapshot of the deleted editorial table. An
 * upgrade must classify the same way the old catalog did, so these pins
 * stay even though the live function is gone.
 */
describe("frozenClassify", () => {
  it("reads the pinned tiers rather than guessing", () => {
    expect(frozenClassify("kimi-k3", "Kimi K3")).toBe("high");
    expect(frozenClassify("k3", "K3")).toBe("high");
    expect(frozenClassify("gpt-5.2", "GPT-5.2")).toBe("high");
    expect(frozenClassify("claude-sonnet-4", "Claude Sonnet 4")).toBe("medium");
    expect(frozenClassify("gpt-4.1", "GPT-4.1")).toBe("low");
    expect(frozenClassify("claude-fable-5", "Claude Fable 5")).toBe("premium");
    expect(frozenClassify("claude.fable.5", "")).toBe(frozenClassify("claude-fable-5", ""));
  });

  it("falls through the old heuristic, then medium", () => {
    expect(frozenClassify("gemini-3.5-flash", "Gemini 3.5 Flash")).toBe("low");
    expect(frozenClassify("future-sonnet-9", "Future Sonnet 9")).toBe("medium");
    expect(frozenClassify("mystery-mini", "Mystery Mini")).toBe("low");
    expect(frozenClassify("brand-new-thing", "Brand New")).toBe("medium");
  });
});
