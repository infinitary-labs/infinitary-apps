import { describe, expect, it } from "vitest";
import { createModelCapabilityLookup } from "./modelCapability";
import { withHonestReasoning } from "./modelRuntime";
import type { ModelRuntime } from "./types";

type Def = { reasoning: boolean; input: string[]; contextWindow: number };

function runtimeWith(models: Record<string, Def>): ModelRuntime {
  return {
    // Production runtimes come from createModelRuntime, which has already
    // wrapped getModel in withHonestReasoning; this stand-in wraps the same
    // way so the lookup is read through the same correction.
    getModel: (provider: string, id: string) => {
      const def = models[`${provider}/${id}`];
      return def ? withHonestReasoning(def as never) : undefined;
    },
  } as unknown as ModelRuntime;
}

describe("createModelCapabilityLookup", () => {
  it("reads the def out of the first runtime that holds the model", () => {
    const lookup = createModelCapabilityLookup(() => [
      runtimeWith({}),
      runtimeWith({
        "xai/grok-4.6": { reasoning: true, input: ["text", "image"], contextWindow: 500_000 },
      }),
    ]);
    expect(lookup({ provider: "xai", id: "grok-4.6" })).toEqual({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 500_000,
    });
  });

  it("returns undefined for a model no runtime knows", () => {
    // Claude models ride their own client; unknown is not
    // incapable, and refusing what cannot be read would empty the pool.
    const lookup = createModelCapabilityLookup(() => [runtimeWith({})]);
    expect(lookup({ provider: "anthropic-claude", id: "claude-opus-5-5" })).toBeUndefined();
  });

  it("reports the CORRECTED reasoning flag, not the catalog's claim", () => {
    // The dogfood offender: the live def claims reasoning it rejects.
    // withHonestReasoning turns it off at the factory, so routing's high-tier
    // check sees the truth rather than the claim.
    const lookup = createModelCapabilityLookup(() => [
      runtimeWith({
        "xai/grok-build-0.1": {
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null },
          input: ["text", "image"],
          contextWindow: 256_000,
        } as never as Def,
      }),
    ]);
    expect(lookup({ provider: "xai", id: "grok-build-0.1" })?.reasoning).toBe(false);
  });

  it("moves past a runtime that throws instead of failing the whole lookup", () => {
    const broken = {
      getModel: () => {
        throw new Error("account store is unreadable");
      },
    } as unknown as ModelRuntime;
    const lookup = createModelCapabilityLookup(() => [
      broken,
      runtimeWith({
        "openai-codex/gpt-5.6-sol": {
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272_000,
        },
      }),
    ]);
    expect(lookup({ provider: "openai-codex", id: "gpt-5.6-sol" })?.contextWindow).toBe(272_000);
  });
});
