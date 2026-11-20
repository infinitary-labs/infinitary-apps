import { describe, expect, it } from "vitest";
import { claudeCodingReasoning, claudeReasoningCapabilities } from "../claude/reasoning";
import { clampThinkingLevel, piReasoningCapabilities } from "./reasoning";
import type { ModelRuntime } from "./types";

const ref = { provider: "test", id: "model" };
function runtime(def: {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}): ModelRuntime {
  return { getModel: () => def } as unknown as ModelRuntime;
}
describe("backend-owned reasoning choices", () => {
  it("offers only supported app rungs, without the Minimal alias for Low", () => {
    const def = {
      reasoning: true,
      thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null },
    };
    const r = runtime(def);
    expect(piReasoningCapabilities(r.getModel(ref.provider, ref.id))).toEqual({
      levels: ["low", "medium", "high"],
    });
    expect(clampThinkingLevel(ref, r, "xhigh")).toEqual({ level: "high", lower: "capped" });
    expect(clampThinkingLevel(ref, r, "xhigh", true)).toEqual({ level: "medium", lower: "quick" });
    expect(clampThinkingLevel(ref, r, "high", false)).toEqual({ level: "high" });
  });
  it("reports fixed and unknown models without a menu", () => {
    expect(piReasoningCapabilities(undefined)).toBeUndefined();
    expect(
      piReasoningCapabilities(runtime({ reasoning: false }).getModel("test", "model")),
    ).toEqual({ levels: [], fixed: "off" });
    expect(clampThinkingLevel(ref, runtime({ reasoning: false }), "high")).toEqual({
      level: "off",
    });
    expect(claudeReasoningCapabilities("claude-haiku-4-5")).toEqual({
      levels: [],
      fixed: "default",
    });
  });
  it("Claude menus and real coding requests read the same resolver", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-haiku-5-5",
    ]) {
      expect(claudeReasoningCapabilities(id).levels).toEqual(["low", "medium", "high", "xhigh"]);
      expect(
        claudeCodingReasoning({
          model: { provider: "anthropic-claude", id },
          thinking: { level: "high" },
        }),
      ).toEqual({ level: "high" });
      expect(
        claudeCodingReasoning({
          model: { provider: "anthropic-claude", id },
          thinking: { level: "high", quick: true },
        }),
      ).toEqual({ level: "medium", lower: "quick" });
    }
  });
});
