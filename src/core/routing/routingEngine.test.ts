import type { CatalogModelView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { route } from "./routingEngine";

const catalog: CatalogModelView[] = [
  // quota catalog order: spend priority first, runway as the fallback.
  {
    provider: "codex",
    id: "gpt-5.5",
    label: "gpt-5.5",
    effectivePercentRemaining: 88,
    paceStatus: "on_pace",
    spendPriority: 0.9,
  },
  {
    provider: "grok",
    id: "grok-4.5",
    label: "grok 4.5",
    effectivePercentRemaining: 40,
    paceStatus: "ahead",
    spendPriority: 2.5,
  },
  {
    provider: "claude",
    id: "gpt-4.1",
    label: "gpt 4.1",
    effectivePercentRemaining: 70,
    paceStatus: "on_pace",
  },
  {
    provider: "openrouter",
    id: "kimi-k2",
    label: "kimi k2",
    effectivePercentRemaining: 0,
    paceStatus: "behind",
  },
];

const available = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "xai", id: "grok-4.5" },
  { provider: "anthropic-claude", id: "gpt-4.1" },
  { provider: "openrouter", id: "kimi-k2" },
];

const slotted = [
  { provider: "openai-codex", id: "gpt-5.5", slot: "high" as const },
  { provider: "xai", id: "grok-4.5", slot: "high" as const },
  { provider: "anthropic-claude", id: "gpt-4.1", slot: "medium" as const },
  { provider: "openrouter", id: "kimi-k2", slot: "low" as const },
];

describe("route - the reasoning class is the caller's judgment", () => {
  it("takes the class Firstmate judged and says so in the audit trail", () => {
    const decision = route({ catalog, available, slotted, pins: [], bucket: "low" });
    expect(decision.bucket).toBe("low");
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "gpt-4.1" });
    expect(decision.reasons[0]).toBe("bucket low (the first mate's judgment)");
  });

  it("defaults to medium when no class was judged", () => {
    const decision = route({ catalog, available, slotted, pins: [] });
    expect(decision.bucket).toBe("medium");
    expect(decision.reasons[0]).toBe("bucket medium (default)");
  });
});

describe("route", () => {
  it("prefers the higher spend priority within the bucket (quota-axi ranking)", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "high",
    });
    // Both high models serve; grok's allowance is more on track to expire
    // unused (2.5 vs 0.9), so it wins despite worse runway rank.
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(decision.reasons.join(" ")).toContain("spend priority 2.50");
  });

  it("keeps runway order when no candidate has a measurable spend priority", () => {
    const flat = catalog.map(({ spendPriority: _unused, ...m }) => ({
      ...m,
      paceStatus: "on_pace" as const,
    }));
    const decision = route({
      catalog: flat,
      available,
      slotted,
      pins: [],
      bucket: "high",
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(decision.reasons.join(" ")).toContain("runway order");
  });

  it("ranks a known spend priority above unknown - even a negative one - never as zero", () => {
    const cat: CatalogModelView[] = [
      {
        provider: "codex",
        id: "gpt-5.5",
        label: "gpt-5.5",
        effectivePercentRemaining: 88,
        // No spendPriority: unmeasurable, which is not zero.
      },
      {
        provider: "grok",
        id: "grok-4.5",
        label: "grok 4.5",
        effectivePercentRemaining: 40,
        // Overdrawn, but measured: the known signal still ranks first.
        spendPriority: -0.4,
      },
    ];
    const decision = route({
      catalog: cat,
      available,
      slotted,
      pins: [],
      bucket: "high",
    });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
  });

  it("pins always win", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [{ provider: "claude", id: "gpt-4.1" }],
    });
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "gpt-4.1" });
    expect(decision.reasons.join(" ")).toContain("pinned");
  });

  it("skips a saved pin onto a provider this build no longer offers", () => {
    // A Cursor pin written before Cursor left the catalog: even were a
    // leftover model still in the pool, the pin never routes to it.
    const decision = route({
      catalog,
      available: [...available, { provider: "cursor", id: "composer-2.5" }],
      slotted,
      pins: [{ provider: "cursor", id: "composer-2.5" }],
      bucket: "high",
    });
    expect(decision.choice).not.toEqual({ provider: "cursor", id: "composer-2.5" });
    expect(decision.reasons.join(" ")).not.toContain("pinned");
  });

  it("filters exhausted scopes and models Pi cannot serve", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "low",
    });
    // The only low model is exhausted (0% remaining), so low falls back to
    // medium.
    expect(decision.bucket).toBe("low");
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "gpt-4.1" });
    expect(decision.reasons.join(" ")).toContain("fell back to medium");
    // The fallback is structural, not only prose (P7 consumes it).
    expect(decision.servedBucket).toBe("medium");
  });

  it("carries no servedBucket when the requested bucket serves", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
    });
    expect(decision.servedBucket).toBeUndefined();
  });

  it("defers to the runtime default when nothing is serveable", () => {
    const decision = route({
      catalog,
      available: [],
      pins: [],
    });
    expect(decision.choice).toBeUndefined();
    expect(decision.reasons.join(" ")).toContain("deferring to the runtime default");
  });

  it("does not route leftover Claude catalog, pins, or Anthropic availability", () => {
    const decision = route({
      catalog: [
        {
          provider: "claude",
          id: "claude-opus-4-5",
          label: "opus 4.5",
          effectivePercentRemaining: 90,
          paceStatus: "ahead",
        },
      ],
      available: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      pins: [
        { provider: "claude", id: "claude-opus-4-5" },
        { provider: "anthropic", id: "claude-opus-4-5" },
      ],
    });
    expect(decision.choice).toBeUndefined();
    expect(decision.reasons.join(" ")).toContain("deferring to the runtime default");
  });

  it("prefers newer model id within same tier even when older has higher remaining quota", () => {
    const cat = [
      {
        provider: "grok",
        id: "grok-4.3",
        label: "grok 4.3",
        effectivePercentRemaining: 80,
        paceStatus: "on_pace" as const,
      },
      {
        provider: "grok",
        id: "grok-4.6",
        label: "grok 4.6",
        effectivePercentRemaining: 30,
        paceStatus: "on_pace" as const,
      },
    ];
    const av = [
      { provider: "xai", id: "grok-4.3" },
      { provider: "xai", id: "grok-4.6" },
    ];
    const decision = route({ catalog: cat, available: av, pins: [] });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.6" });
    expect(decision.reasons.join(" ")).toContain("same-line recency");
  });

  it("never compares different model lines that share a prefix", () => {
    // gpt-5.6-luna and gpt-5.3-codex-spark are different lines: the higher
    // version number must NOT outrank the other line's runway order.
    const cat = [
      {
        provider: "codex",
        id: "gpt-5.3-codex-spark",
        label: "codex spark",
        effectivePercentRemaining: 80,
        paceStatus: "on_pace" as const,
      },
      {
        provider: "codex",
        id: "gpt-5.6-luna",
        label: "luna",
        effectivePercentRemaining: 30,
        paceStatus: "on_pace" as const,
      },
    ];
    const av = [
      { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ];
    const decision = route({ catalog: cat, available: av, pins: [] });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.3-codex-spark" });
    expect(decision.reasons.join(" ")).toContain("runway order");
  });

  it("compares dashed version tokens within a line", () => {
    const cat = [
      {
        provider: "claude",
        id: "gpt-4-1",
        label: "gpt 4.1",
        effectivePercentRemaining: 90,
        paceStatus: "on_pace" as const,
      },
      {
        provider: "claude",
        id: "gpt-4-3",
        label: "gpt 4.3",
        effectivePercentRemaining: 20,
        paceStatus: "on_pace" as const,
      },
    ];
    const av = [
      { provider: "anthropic-claude", id: "gpt-4-1" },
      { provider: "anthropic-claude", id: "gpt-4-3" },
    ];
    const decision = route({
      catalog: cat,
      available: av,
      pins: [],
    });
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "gpt-4-3" });
  });

  it("flags nothing-serveable only when the catalog actually had models (P7)", () => {
    // Every catalog model exhausted or unavailable: structurally unserveable.
    const exhausted = route({
      catalog: catalog.map((model) => ({ ...model, effectivePercentRemaining: 0 })),
      available,
      slotted,
      pins: [],
    });
    expect(exhausted.choice).toBeUndefined();
    expect(exhausted.unserveable).toBe(true);

    // An empty catalog means no quota data - unknown, not exhausted.
    const unknown = route({ catalog: [], available, pins: [] });
    expect(unknown.choice).toBeUndefined();
    expect(unknown.unserveable).toBeUndefined();
  });
});

describe("route - the premium boundary (captain decision A)", () => {
  const premiumCatalog: CatalogModelView[] = [
    {
      provider: "claude",
      id: "claude-fable-5",
      label: "Fable 5",
      effectivePercentRemaining: 99,
      paceStatus: "ahead",
    },
    {
      provider: "codex",
      id: "gpt-5.6-sol",
      label: "sol",
      effectivePercentRemaining: 12,
      paceStatus: "behind",
    },
  ];
  const premiumAvailable = [
    { provider: "anthropic-claude", id: "claude-fable-5" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  const premiumSlotted = [
    { provider: "anthropic-claude", id: "claude-fable-5", slot: "premium" as const },
    { provider: "openai-codex", id: "gpt-5.6-sol", slot: "high" as const },
  ];

  it("never reaches a premium model for a class the user did not ask for", () => {
    // Fable wins on runway (99 vs 12) AND on pace (ahead vs behind), so
    // nothing but the premium boundary can keep routing off it.
    for (const bucket of [undefined, "low", "medium", "high"] as const) {
      const decision = route({
        catalog: premiumCatalog,
        available: premiumAvailable,
        slotted: premiumSlotted,
        pins: [],
        ...(bucket ? { bucket } : {}),
      });
      expect(decision.choice, `bucket ${bucket ?? "default"}`).toEqual({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
      });
    }
  });

  it("serves a premium request from the premium slot - the user asked for it", () => {
    const decision = route({
      catalog: premiumCatalog,
      available: premiumAvailable,
      slotted: premiumSlotted,
      pins: [],
      bucket: "premium",
    });
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "claude-fable-5" });
    expect(decision.servedBucket).toBeUndefined();
  });

  it("falls to high when a premium request has no serveable premium model", () => {
    const decision = route({
      catalog: premiumCatalog,
      available: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
      slotted: premiumSlotted,
      pins: [],
      bucket: "premium",
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    expect(decision.servedBucket).toBe("high");
    expect(decision.reasons).toContain("no serveable premium model; fell back to high");
  });

  it("selects a premium model when the user pins it - the only way through", () => {
    const decision = route({
      catalog: premiumCatalog,
      available: premiumAvailable,
      slotted: premiumSlotted,
      pins: [{ provider: "claude", id: "claude-fable-5" }],
    });
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "claude-fable-5" });
  });

  it("routes nothing rather than a premium model when the class is not premium", () => {
    const decision = route({
      catalog: [premiumCatalog[0] as CatalogModelView],
      available: [{ provider: "anthropic-claude", id: "claude-fable-5" }],
      slotted: [{ provider: "anthropic-claude", id: "claude-fable-5", slot: "premium" as const }],
      pins: [],
    });
    expect(decision.choice).toBeUndefined();
    expect(decision.unserveable).toBe(true);
  });
});

describe("route - the slot record", () => {
  it("picks only from the slotted subset and records what it skipped", () => {
    const decision = route({
      catalog,
      available,
      // grok-4.5 wins the high slot on spend priority; slotting only
      // gpt-5.5 takes it out of the running entirely.
      slotted: [{ provider: "openai-codex", id: "gpt-5.5", slot: "high" }],
      slotNote: "1 of 4 available models have a slot",
      pins: [],
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(decision.reasons).toContain("1 of 4 available models have a slot");
    expect(decision.reasons).toContain("skipped xai/grok-4.5: not in a slot");
  });

  it("still honours a pin outside the slot record - naming a model is placing it", () => {
    const decision = route({
      catalog,
      available,
      slotted: [{ provider: "openai-codex", id: "gpt-5.5", slot: "high" }],
      pins: [{ provider: "grok", id: "grok-4.5" }],
    });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
  });

  it("treats an omitted slot record as every available model at medium", () => {
    const decision = route({
      catalog,
      available,
      pins: [],
    });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
  });

  it("reaches the same offering from more than one requested bucket", () => {
    // Two SlottedRef rows for the same offering - one per membership, the
    // shape ModelSlots.routable() produces for a model placed in both.
    const multiSlotted = [
      { provider: "openai-codex", id: "gpt-5.5", slot: "high" as const },
      { provider: "openai-codex", id: "gpt-5.5", slot: "low" as const },
    ];
    const forHigh = route({ catalog, available, slotted: multiSlotted, pins: [], bucket: "high" });
    expect(forHigh.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    const forLow = route({ catalog, available, slotted: multiSlotted, pins: [], bucket: "low" });
    expect(forLow.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
  });
});

describe("route - the capability check", () => {
  const capable = { reasoning: true, input: ["text", "image"], contextWindow: 400_000 };

  it("skips a candidate whose context window cannot hold the turn", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "high",
      needs: { contextTokens: 300_000 },
      capabilityFor: (ref) =>
        ref.id === "grok-4.5" ? { ...capable, contextWindow: 128_000 } : capable,
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(decision.reasons).toContain(
      "skipped xai/grok-4.5: the turn needs ~300k tokens and its context window is 128k",
    );
  });

  it("skips a text-only candidate when the turn carries images", () => {
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "high",
      needs: { images: true },
      capabilityFor: (ref) => (ref.id === "grok-4.5" ? { ...capable, input: ["text"] } : capable),
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(decision.reasons).toContain(
      "skipped xai/grok-4.5: the turn carries images and its def takes text only",
    );
  });

  it("treats a model no runtime knows as unknown, not incapable", () => {
    // Claude models, and custom models.json entries, have no Pi
    // def. Refusing what cannot be read would empty the pool.
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "high",
      needs: { images: true, contextTokens: 900_000 },
      capabilityFor: () => undefined,
    });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
  });
});

describe("route - reviewer placement away from the builder's provider (R9, delivery rigor phase 3)", () => {
  it("prefers another signed-in provider at the same slot, and records it", () => {
    // grok-4.5 outranks gpt-5.5 on spend priority in the high slot; with
    // xai as the builder's provider the reviewer goes to codex instead.
    const decision = route({
      catalog,
      available,
      slotted,
      pins: [],
      bucket: "high",
      avoidProvider: "xai",
    });
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(decision.servedBucket).toBeUndefined();
    expect(decision.reasons).toContain(
      "rule R9: preferred a provider other than xai (the builder's) at high",
    );
  });

  it("falls back to the builder's provider when nothing else can serve the slot, saying so, rather than descending a tier", () => {
    const onlyXaiHigh = slotted.filter(
      (model) => model.slot !== "high" || model.provider === "xai",
    );
    const decision = route({
      catalog,
      available,
      slotted: onlyXaiHigh,
      pins: [],
      bucket: "high",
      avoidProvider: "xai",
    });
    expect(decision.choice).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(decision.servedBucket).toBeUndefined();
    expect(decision.reasons).toContain(
      "rule R9: no other signed-in provider could serve high; falling back to xai",
    );
  });

  it("prefers the other provider even when its quota is unmeasured: unknown is never zero", () => {
    // Claude's gpt-4.1 carries no spend priority; placed in the high slot
    // beside grok it is still the reviewer's model when grok built.
    const withCopilotHigh = [
      ...slotted.filter((model) => model.provider !== "anthropic-claude"),
      { provider: "anthropic-claude", id: "gpt-4.1", slot: "high" as const },
    ];
    const decision = route({
      catalog,
      available: available.filter((model) => model.provider !== "openai-codex"),
      slotted: withCopilotHigh,
      pins: [],
      bucket: "high",
      avoidProvider: "xai",
    });
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "gpt-4.1" });
    expect(decision.reasons).toContain("picked claude/gpt-4.1 by runway order");
  });

  it("changes nothing without avoidProvider, and a pin still wins over it", () => {
    const plain = route({ catalog, available, slotted, pins: [], bucket: "high" });
    expect(plain.choice).toEqual({ provider: "xai", id: "grok-4.5" });
    expect(plain.reasons.some((line) => line.startsWith("rule R9"))).toBe(false);
    const pinned = route({
      catalog,
      available,
      slotted,
      pins: [{ provider: "grok", id: "grok-4.5" }],
      bucket: "high",
      avoidProvider: "xai",
    });
    expect(pinned.choice).toEqual({ provider: "xai", id: "grok-4.5" });
  });
});

describe("checked connection-owned models without a quota catalog", () => {
  const custom = { provider: "fm-custom-0123456789abcdef", id: "operator-model" };
  it("requires explicit placement rather than admitting an available custom model to default pools", () => {
    expect(route({ catalog: [], available: [custom], pins: [] }).choice).toBeUndefined();
    expect(
      route({ catalog: [], available: [custom], slotted: [], pins: [] }).choice,
    ).toBeUndefined();
    expect(
      route({
        catalog: [],
        available: [custom],
        slotted: [{ ...custom, slot: "medium" }],
        pins: [],
      }).choice,
    ).toEqual(custom);
    expect(route({ catalog: [], available: [custom], slotted: [], pins: [custom] }).choice).toEqual(
      custom,
    );
  });
  it("keeps measured subscription priority above unknown custom allowance and never auto-selects premium", () => {
    const builtin = { provider: "openai-codex", id: "gpt-5.5" };
    expect(
      route({
        catalog: [{ provider: "codex", id: builtin.id, label: builtin.id, spendPriority: -10 }],
        available: [custom, builtin],
        slotted: [
          { ...custom, slot: "medium" },
          { ...builtin, slot: "medium" },
        ],
        pins: [],
      }).choice,
    ).toEqual(builtin);
    expect(
      route({
        catalog: [],
        available: [custom],
        slotted: [{ ...custom, slot: "premium" }],
        pins: [],
        bucket: "high",
      }).choice,
    ).toBeUndefined();
    expect(
      route({
        catalog: [],
        available: [custom],
        slotted: [{ ...custom, slot: "premium" }],
        pins: [],
        bucket: "premium",
      }).choice,
    ).toEqual(custom);
  });

  it("admits a computer's catalog-less model only when it is placed", () => {
    const owned = { provider: "openrouter", id: "qwen/qwen3" };
    expect(
      route({
        catalog: [],
        available: [owned],
        unowned: [owned],
        slotted: [{ ...owned, slot: "medium" }],
        pins: [],
        bucket: "medium",
      }).choice,
    ).toEqual(owned);
    expect(
      route({
        catalog: [],
        available: [owned],
        unowned: [owned],
        slotted: [],
        pins: [],
        bucket: "medium",
      }).choice,
    ).toBeUndefined();
  });
});
