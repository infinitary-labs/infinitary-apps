import { reasoningWord } from "@shared/reasoning";
import { describe, expect, it } from "vitest";
import { claudeCodingReasoning, claudeReasoningCapabilities } from "../claude/reasoning";
import {
  customCapabilities,
  customCatalog,
  customPiModel,
  customStatedCapabilities,
} from "./customApiModels";
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

// INF-7003: GLM-5.3 on a custom connection offers Low, High and Max, and the
// app dropped Max, so requests were held at High. Max is its own choice above
// Extra high (the captain's pick), and Extra high stays off a model without it.
describe("a model whose top reasoning level is Max", () => {
  const limits = { context: 200_000, output: 32_000 };
  const glm = (capabilities: ReturnType<typeof customStatedCapabilities>) =>
    customPiModel({ protocol: "openai-completions", model: "glm-5.3", limits, capabilities });
  for (const [name, model] of [
    [
      "the catalog's zai/glm-5.3 profile",
      () => glm(customCapabilities("openai-completions", "zai/glm-5.3", customCatalog())),
    ],
    [
      "a connection file's stated levels",
      () =>
        glm(
          customStatedCapabilities("openai-completions", {
            thinkingLevelMap: { low: "low", medium: null, high: "high", xhigh: null, max: "max" },
            compat: { thinkingFormat: "zai" },
          }),
        ),
    ],
  ] as const) {
    it(`offers and opens at Max through ${name}`, () => {
      const def = model();
      const r = { getModel: () => def } as unknown as ModelRuntime;
      expect(piReasoningCapabilities(def)).toEqual({ levels: ["low", "high", "max"] });
      expect(clampThinkingLevel(ref, r, "max")).toEqual({ level: "max" });
      expect(clampThinkingLevel(ref, r, "xhigh")).toEqual({ level: "high", lower: "capped" });
      expect(reasoningWord({ level: "max" })).toBe("Max");
    });
  }
});
