import type { CatalogModelView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { orderCandidates } from "./candidates";

const catalog: CatalogModelView[] = [
  { provider: "claude", id: "claude-fable-5", label: "Fable 5" },
  { provider: "claude", id: "claude-opus-5", label: "Opus 5" },
  { provider: "codex", id: "gpt-5.6-terra", label: "terra" },
  { provider: "codex", id: "gpt-5.6-luna", label: "luna" },
];

const available = [
  { provider: "anthropic-claude", id: "claude-fable-5", slot: "premium" as const },
  { provider: "anthropic-claude", id: "claude-opus-5", slot: "high" as const },
  { provider: "openai-codex", id: "gpt-5.6-terra", slot: "medium" as const },
  { provider: "openai-codex", id: "gpt-5.6-luna", slot: "low" as const },
];

describe("orderCandidates", () => {
  it("walks the buckets in the grain's own order", () => {
    expect(
      orderCandidates({ available, catalog, buckets: ["high", "medium", "low"] }).models,
    ).toEqual([
      { provider: "anthropic-claude", id: "claude-opus-5" },
      { provider: "openai-codex", id: "gpt-5.6-terra" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ]);
    expect(
      orderCandidates({ available, catalog, buckets: ["low", "medium", "high"] }).models[0],
    ).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  });

  it("never offers a premium model - including through the uncatalogued tail", () => {
    // The tail is where a per-bucket filter alone would let one back in: a
    // premium model is not in any walked bucket, so it fell straight through
    // into "everything else available".
    const walk = orderCandidates({ available, catalog, buckets: ["high", "medium", "low"] });
    expect(walk.models.some((model) => model.id === "claude-fable-5")).toBe(false);
    expect(walk.skipped).toContain(
      "skipped anthropic-claude/claude-fable-5: premium models are never chosen automatically",
    );
  });

  it("refuses a premium bucket even when the caller asks for it directly", () => {
    expect(
      orderCandidates({ available, catalog, buckets: ["premium"] }).models.some(
        (model) => model.id === "claude-fable-5",
      ),
    ).toBe(false);
  });

  it("trusts a high-slot placement even when the def carries no reasoning parameter", () => {
    const walk = orderCandidates({
      available,
      catalog,
      buckets: ["high", "medium", "low"],
      capabilityFor: (ref) => ({
        reasoning: ref.id !== "claude-opus-5",
        input: ["text", "image"],
        contextWindow: 200_000,
      }),
    });
    expect(walk.models[0]).toEqual({ provider: "anthropic-claude", id: "claude-opus-5" });
    expect(walk.skipped.join(" ")).not.toMatch(/no reasoning parameter/);
  });

  it("selects only from the pool it is handed - the slot seam", () => {
    // Activation is applied by the caller, by narrowing `available`.
    const walk = orderCandidates({
      available: [{ provider: "openai-codex", id: "gpt-5.6-luna", slot: "low" }],
      catalog,
      buckets: ["high", "medium", "low"],
    });
    expect(walk.models).toEqual([{ provider: "openai-codex", id: "gpt-5.6-luna" }]);
  });

  it("keeps the walk's slot order for models the catalog has no row for", () => {
    // Before the first catalog reading every model is in the tail, in pool
    // order: Claude's pool lists Opus ahead of Haiku.
    const walk = orderCandidates({
      available: [
        { provider: "anthropic-claude", id: "claude-fable-5-1", slot: "premium" },
        { provider: "anthropic-claude", id: "claude-opus-5-5", slot: "high" },
        { provider: "custom", id: "unslotted" },
        { provider: "anthropic-claude", id: "claude-sonnet-5", slot: "medium" },
        { provider: "anthropic-claude", id: "claude-haiku-4-5", slot: "low" },
      ],
      catalog: [],
      buckets: ["low", "medium", "high"],
    });
    expect(walk.models.map((model) => model.id)).toEqual([
      "claude-haiku-4-5",
      "unslotted",
      "claude-sonnet-5",
      "claude-opus-5-5",
    ]);
    expect(walk.skipped).toEqual([
      "skipped anthropic-claude/claude-fable-5-1: premium models are never chosen automatically",
    ]);
  });

  it("considers an offering placed in two buckets once, at the strongest it walks", () => {
    // Two rows for the same offering - one per membership, as
    // ModelSlots.routable() emits for a model placed in more than one slot.
    const multiSlotted = [
      { provider: "openai-codex", id: "gpt-5.6-terra", slot: "medium" as const },
      { provider: "openai-codex", id: "gpt-5.6-terra", slot: "low" as const },
    ];
    const walk = orderCandidates({
      available: multiSlotted,
      catalog,
      buckets: ["medium", "low"],
    });
    expect(walk.models).toEqual([{ provider: "openai-codex", id: "gpt-5.6-terra" }]);
  });
});
