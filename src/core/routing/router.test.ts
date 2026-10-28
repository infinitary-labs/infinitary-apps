import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import type { QuotaService } from "../quota/quotaService";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { ModelSlots } from "./modelSlots";
import { Router } from "./router";

/** What every spawn carries until S3's classifier lands: R8, high. */
const UNCLEAR: WorkShape = { kind: "unclear", kind_source: "none" };

/** The captain named a model (R0). */
function override(id: string): WorkShape {
  return { ...UNCLEAR, override_model_id: id };
}

function fakeQuota(models: unknown): QuotaService {
  return {
    latestModels: () => models,
    latest: () => undefined,
  } as unknown as QuotaService;
}

describe("Router", () => {
  it("records every decision with its reasons", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          {
            provider: "codex",
            id: "gpt-5.5",
            label: "gpt-5.5",
            effectivePercentRemaining: 80,
          },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    const result = router.decide("task-1", "add a settings row", UNCLEAR);
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(result?.rule).toBe("R8");
    const row = db.prepare("SELECT * FROM routing_decisions WHERE task_id = ?").get("task-1") as {
      provider: string;
      model: string;
      bucket: string;
      rule: string;
      served: string | null;
      reasons_json: string;
    };
    expect(row.provider).toBe("openai-codex");
    expect(row.model).toBe("gpt-5.5");
    expect(row.rule).toBe("R8");
    expect(JSON.parse(row.reasons_json).join(" ")).toContain("picked codex/gpt-5.5");
  });

  it("names one offering for the settle card's crewmate fact: catalog label first, raw id as fallback (review F1)", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const slots = new ModelSlots({
      settings,
      accounts: () => [
        {
          accountId: "acct-codex",
          accountLabel: "personal",
          providerId: "openai-codex",
          models: [{ provider: "openai-codex", id: "gpt-5.5" }],
        },
      ],
      quotaModels: () => ({
        generatedAt: "now",
        models: [{ provider: "codex", id: "gpt-5.5", label: "GPT-5.5" }],
      }),
    });
    const quota = fakeQuota({
      generatedAt: "now",
      models: [
        { provider: "codex", id: "gpt-5.5", label: "GPT-5.5", effectivePercentRemaining: 80 },
      ],
    });
    const availableModels = () => [{ provider: "openai-codex", id: "gpt-5.5" }];
    const labeled = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota,
      availableModels,
      slots,
    });
    expect(labeled.modelLabel({ provider: "openai-codex", id: "gpt-5.5" })).toBe("GPT-5.5");
    // An offering the catalog does not know keeps its raw id...
    expect(labeled.modelLabel({ provider: "fm-mock", id: "mock-1" })).toBe("mock-1");
    // ...and so does every offering when no slot record is wired at all.
    const unlabeled = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota,
      availableModels,
    });
    expect(unlabeled.modelLabel({ provider: "openai-codex", id: "gpt-5.5" })).toBe("gpt-5.5");
  });

  it("records the tier it served beside the tier it asked for (S5)", () => {
    // The downgrade rate is the one S5 number the reasons prose could only
    // ever answer with a regex over English. The column carries it either
    // way, so "nothing fell back" is a recorded fact and not an absence.
    function routerWithSlot(slot: "high" | "medium") {
      const db = openInMemoryDatabase();
      const settings = new SettingsStore(db);
      const slots = new ModelSlots({
        settings,
        accounts: () => [
          {
            accountId: "acct-codex",
            accountLabel: "personal",
            providerId: "openai-codex",
            models: [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
          },
        ],
        quotaModels: () => undefined,
      });
      slots.reconcile();
      for (const other of ["premium", "high", "medium", "low"] as const) {
        slots.setSlotMembership("openai-codex/gpt-5.6-terra", other, other === slot);
      }
      const router = new Router({
        decisions: new DecisionStore(db),
        settings,
        quota: fakeQuota({
          generatedAt: "now",
          models: [
            {
              provider: "codex",
              id: "gpt-5.6-terra",
              label: "terra",
              effectivePercentRemaining: 50,
            },
          ],
        }),
        availableModels: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
        slots,
      });
      return { db, router };
    }
    function decide(
      slot: "high" | "medium",
      shape: WorkShape = UNCLEAR,
    ): { bucket: string; served: string | null } {
      const { db, router } = routerWithSlot(slot);
      router.decide("task-tier", "work from its recorded shape", shape);
      return db
        .prepare("SELECT bucket, served FROM routing_decisions WHERE task_id = ?")
        .get("task-tier") as { bucket: string; served: string | null };
    }
    // R8 asks for high. The high-slotted model serves it as asked.
    expect(decide("high")).toEqual({ bucket: "high", served: "high" });
    // The same ask with only a medium-slotted model: the ladder falls back.
    expect(decide("medium")).toEqual({ bucket: "high", served: "medium" });
    const build: WorkShape = {
      kind: "implement",
      kind_source: "classifier:test",
      basis: "FM3K-7",
      basis_verified: true,
    };
    // R4 asks medium, and only falls back to high when medium cannot serve.
    expect(decide("medium", build)).toEqual({ bucket: "medium", served: "medium" });
    expect(decide("high", build)).toEqual({ bucket: "medium", served: "high" });
    expect(decide("high", { ...build, basis_verified: false })).toEqual({
      bucket: "high",
      served: "high",
    });
  });

  it("names the withheld account that kept a task from the slot it asked for (FI3-1375)", () => {
    // A sign-out mark keeps Claude's high model out of the pool, so a high
    // ask falls to Codex's medium model while Claude's allowance is fine.
    // Only when signing in would bring the slot back is the account why.
    function decideWithOpusAt(percent: number) {
      const db = openInMemoryDatabase();
      const settings = new SettingsStore(db);
      const opus = { provider: "anthropic-claude", id: "claude-opus-5-5" };
      const terra = { provider: "openai-codex", id: "gpt-5.6-terra" };
      const slots = new ModelSlots({
        settings,
        accounts: () => [
          {
            accountId: "acct-codex",
            accountLabel: "work",
            providerId: "openai-codex",
            models: [terra],
          },
          {
            accountId: "acct-claude",
            accountLabel: "personal",
            providerId: "anthropic-claude",
            models: [opus],
          },
        ],
        quotaModels: () => undefined,
      });
      slots.reconcile();
      for (const slot of ["premium", "high", "medium", "low"] as const) {
        slots.setSlotMembership("openai-codex/gpt-5.6-terra", slot, slot === "medium");
        slots.setSlotMembership("anthropic-claude/claude-opus-5-5", slot, slot === "high");
      }
      const router = new Router({
        decisions: new DecisionStore(db),
        settings,
        quota: fakeQuota({
          generatedAt: "now",
          models: [
            { provider: "codex", id: terra.id, label: "terra", effectivePercentRemaining: 60 },
            { provider: "claude", id: opus.id, label: "opus", effectivePercentRemaining: percent },
          ],
        }),
        availableModels: () => [terra],
        slots,
        withheldModels: () => [{ ...opus, reason: "signed_out" }],
      });
      return router.decide("task-held", "tidy the hull fittings", UNCLEAR);
    }
    expect(decideWithOpusAt(64)).toMatchObject({
      bucket: "high",
      servedBucket: "medium",
      choice: { provider: "openai-codex", id: "gpt-5.6-terra" },
      withheld: { provider: "anthropic-claude", reason: "signed_out" },
    });
    // Its allowance spent too: signing in would not serve high, so the
    // fallback is the allowance's, as before.
    const spent = decideWithOpusAt(0);
    expect(spent).toMatchObject({ bucket: "high", servedBucket: "medium" });
    expect(spent?.withheld).toBeUndefined();
  });

  it("leads the record with the shape and the rule that chose the tier", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    const result = router.decide("task-shape", "fix the flaky retry test", {
      kind: "fix",
      kind_source: "classifier:xai/grok-4.6",
      basis: "FM3K-12",
      basis_verified: true,
    });
    // R6: a fix on a verified basis is the captain's medium rule.
    expect(result?.bucket).toBe("medium");
    expect(result?.rule).toBe("R6");
    const row = db
      .prepare("SELECT rule, reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-shape") as { rule: string; reasons_json: string };
    expect(row.rule).toBe("R6");
    expect((JSON.parse(row.reasons_json) as string[]).slice(0, 3)).toEqual([
      "shape kind=fix (classifier:xai/grok-4.6)",
      "basis FM3K-12 verified",
      "rule R6: fix on the verified basis FM3K-12 -> medium",
    ]);
  });

  it("records a claimed basis that did not check out as unverified", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    const result = router.decide("task-unverified", "implement the thing", {
      kind: "implement",
      basis: "FM3K-99",
      basis_verified: false,
    });
    // R3: an unverified spec never buys the cheaper tier.
    expect(result?.rule).toBe("R3");
    expect(result?.bucket).toBe("high");
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-unverified") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain("basis FM3K-99 unverified");
  });

  it("routes nothing when dynamic routing is off", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setRoutingSettings({ dynamicRouting: false, pins: [] });
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota(undefined),
      availableModels: () => [],
    });
    expect(router.decide("task-2", "anything", UNCLEAR)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) as n FROM routing_decisions").get()).toEqual({ n: 0 });
  });

  it("records the slot and capability skips in the audit trail", () => {
    // The routing_decisions row is what made the 2026-09-01 dogfood bug
    // diagnosable at all; the two new boundaries have to land in it too, or
    // "why did it not pick that model" becomes unanswerable again.
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const slots = new ModelSlots({
      settings,
      accounts: () => [
        {
          accountId: "acct-codex",
          accountLabel: "personal",
          providerId: "openai-codex",
          models: [
            { provider: "openai-codex", id: "gpt-5.6-sol" },
            { provider: "openai-codex", id: "gpt-5.6-terra" },
          ],
        },
      ],
      quotaModels: () => undefined,
    });
    slots.reconcile();
    slots.setSlotMembership("openai-codex/gpt-5.6-terra", "medium", true);
    slots.setSlotMembership("openai-codex/gpt-5.6-sol", "high", false);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          {
            provider: "codex",
            id: "gpt-5.6-sol",
            label: "sol",
            effectivePercentRemaining: 90,
          },
          {
            provider: "codex",
            id: "gpt-5.6-terra",
            label: "terra",
            effectivePercentRemaining: 50,
          },
        ],
      }),
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.6-sol" },
        { provider: "openai-codex", id: "gpt-5.6-terra" },
      ],
      slots,
      capabilityFor: () => ({ reasoning: true, input: ["text"], contextWindow: 272_000 }),
    });
    const result = router.decide(
      "task-skips",
      "investigate the race condition in the retry helper",
      UNCLEAR,
    );
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-terra" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-skips") as { reasons_json: string };
    const reasons = JSON.parse(row.reasons_json) as string[];
    expect(reasons).toContain("1 of 2 available models have a slot");
    expect(reasons).toContain("skipped openai-codex/gpt-5.6-sol: not in a slot");
  });

  it("an exact model id override wins over the tier the table would ask for", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.6-luna", label: "luna", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "openai-codex", id: "gpt-6-astra" },
      ],
    });
    const result = router.decide("task-pin", "use gpt-6-astra for this", override("gpt-6-astra"));
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-pin") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain("pinned openai-codex/gpt-6-astra");
  });

  it("binds a provider-qualified spawn pin instead of falling through to another provider", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-6-astra", label: "Astra", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [
        { provider: "anthropic-claude", id: "claude-fable-5" },
        { provider: "github-copilot", id: "claude-fable-5" },
        { provider: "openai-codex", id: "gpt-6-astra" },
      ],
    });
    const result = router.decide(
      "task-fable-pin",
      "use Anthropic Fable for this",
      override("anthropic-claude/claude-fable-5"),
    );
    expect(result?.choice).toEqual({ provider: "anthropic-claude", id: "claude-fable-5" });
  });

  it("silently ignores an unavailable model pin but records the reason", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.6-luna", label: "luna", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    });
    const result = router.decide(
      "task-no-pin",
      "use a model nobody offers",
      override("anthropic-claude/claude-fable-5"),
    );
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-no-pin") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain(
      "requested pin anthropic-claude/claude-fable-5 is not available; ignoring it",
    );
  });

  it("records a capability skip with the def's own numbers", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          {
            provider: "codex",
            id: "gpt-5.3-codex-spark",
            label: "spark",
            effectivePercentRemaining: 90,
          },
          {
            provider: "codex",
            id: "gpt-5.6-luna",
            label: "luna",
            effectivePercentRemaining: 50,
          },
        ],
      }),
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
        { provider: "openai-codex", id: "gpt-5.6-luna" },
      ],
      capabilityFor: (ref) => ({
        reasoning: true,
        input: ["text"],
        contextWindow: ref.id === "gpt-5.3-codex-spark" ? 128_000 : 272_000,
      }),
    });
    // A prompt long enough that the 128k model genuinely cannot hold it
    // (700k characters is ~175k tokens, plus the session's own headroom).
    const result = router.decide("task-context", "x".repeat(700_000), UNCLEAR);
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-context") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain(
      "skipped openai-codex/gpt-5.3-codex-spark: the turn needs ~183k tokens and its context window is 128k",
    );
  });
});

describe("Router - reviewer placement (R9, delivery rigor phase 3)", () => {
  it("records R9 as the rule on a decision placed away from the builder's provider, and reads that provider off the record", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 80 },
          { provider: "grok", id: "grok-4.6", label: "grok", effectivePercentRemaining: 70 },
        ],
      }),
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "xai", id: "grok-4.6" },
      ],
    });
    // The builder routed to codex (no slot record: everything is medium).
    const builder = router.decide("builder", "fix the meter test", UNCLEAR);
    expect(builder?.choice?.provider).toBe("openai-codex");
    expect(router.servedProvider("builder")).toBe("openai-codex");
    expect(router.servedProvider("never-routed")).toBeUndefined();

    const review: WorkShape = {
      kind: "review",
      kind_source: "host:review",
      basis: "builder",
      basis_verified: true,
    };
    const placed = router.decide("reviewer", "review the PR", review, {
      avoidProvider: "openai-codex",
    });
    expect(placed?.choice).toEqual({ provider: "xai", id: "grok-4.6" });
    expect(placed?.rule).toBe("R9");
    const row = db
      .prepare("SELECT rule, provider, reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("reviewer") as { rule: string; provider: string; reasons_json: string };
    expect(row.rule).toBe("R9");
    expect(row.provider).toBe("xai");
    const reasons = JSON.parse(row.reasons_json) as string[];
    // The tier row it rode on is still on the record, so the rule reads
    // top to bottom: placement, then the tier the kind routed to.
    expect(reasons.join("\n")).toContain(
      "rule R9: reviewer placement away from openai-codex; tier from rule R2: review -> high",
    );
    expect(reasons).toContain(
      "rule R9: preferred a provider other than openai-codex (the builder's) at medium",
    );
  });

  // INF-849: a started task moves off the provider that failed it, never
  // back onto it, where R9's preference would fall back.
  it("leaves a provider out entirely for a move, and finds nothing when only it serves", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    let available = [
      { provider: "github-copilot", id: "gpt-5.5" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ];
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => available,
    });
    const moved = router.preview("promote the alpha", UNCLEAR, {
      withoutProvider: "github-copilot",
    });
    expect(moved?.result.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(moved?.reasons).toContain("left out github-copilot, the provider the task moved off");
    available = [{ provider: "github-copilot", id: "gpt-5.5" }];
    expect(
      router.preview("promote the alpha", UNCLEAR, { withoutProvider: "github-copilot" })?.result
        .choice,
    ).toBeUndefined();
  });

  it("routes a task among the pool it is given - another computer's own sign-ins - and never this Mac's", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    // This Mac is signed in to Codex alone, with allowance to spare.
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 90 },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    // The computer is signed in to Claude alone.
    const pool = {
      available: [{ provider: "anthropic-claude", id: "claude-sonnet-5-5" }],
      catalog: [{ provider: "claude", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
      note: "Mac mini's own sign-ins (anthropic-claude): 1 model",
    };
    const there = router.decide("placed", "add a settings row", UNCLEAR, { pool });
    expect(there?.choice).toEqual({ provider: "anthropic-claude", id: "claude-sonnet-5-5" });
    const row = db
      .prepare("SELECT provider, model, reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("placed") as { provider: string; model: string; reasons_json: string };
    expect(row).toMatchObject({ provider: "anthropic-claude", model: "claude-sonnet-5-5" });
    expect(JSON.parse(row.reasons_json)).toContain(
      "routed among Mac mini's own sign-ins (anthropic-claude): 1 model",
    );
    // A pinned model that computer does not serve is not taken there either.
    settings.setRoutingSettings({
      ...settings.getRoutingSettings(),
      pins: [{ provider: "codex", id: "gpt-5.5" }],
    });
    expect(router.decide("pinned", "add a settings row", UNCLEAR, { pool })?.choice).toEqual({
      provider: "anthropic-claude",
      id: "claude-sonnet-5-5",
    });
    // A computer signed in to nothing serves nothing, rather than this Mac's model.
    const empty = router.decide("bare", "add a settings row", UNCLEAR, {
      pool: { available: [], catalog: [], note: "Mac mini's own sign-ins (none): 0 models" },
    });
    expect(empty?.choice).toBeUndefined();
    // Here, the same task takes this Mac's own.
    expect(router.decide("here", "add a settings row", UNCLEAR)?.choice).toEqual({
      provider: "openai-codex",
      id: "gpt-5.5",
    });
  });

  // INF-443 piece 2: the captain asked why so many tasks went to one
  // provider whose allowance was tight; the record must show every
  // candidate's score and reading, the 0% ones the router skips included.
  it("saves every candidate's score and reading with the decision, skipped ones too", () => {
    const db = openInMemoryDatabase();
    const router = new Router({
      decisions: new DecisionStore(db),
      settings: new SettingsStore(db),
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          {
            provider: "grok",
            id: "grok-4.6",
            label: "Grok 4.6",
            effectivePercentRemaining: 12,
            paceStatus: "ahead",
            spendPriority: 3.5,
          },
          {
            provider: "codex",
            id: "gpt-5.5",
            label: "gpt-5.5",
            effectivePercentRemaining: 80,
            paceStatus: "on_pace",
            spendPriority: 0.4,
          },
          { provider: "claude", id: "opus", label: "Opus", effectivePercentRemaining: 0 },
        ],
      }),
      availableModels: () => [
        { provider: "xai", id: "grok-4.6" },
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "anthropic-claude", id: "opus" },
      ],
    });
    router.decide("task-1", "add a settings row", UNCLEAR);
    const row = db
      .prepare("SELECT facts_json FROM decisions WHERE kind = 'routing' AND task_id = ?")
      .get("task-1") as { facts_json: string };
    expect(JSON.parse(row.facts_json)).toEqual({
      kind: "routing-candidates",
      candidates: [
        {
          provider: "xai",
          model: "grok-4.6",
          percentRemaining: 12,
          pace: "ahead",
          spendPriority: 3.5,
          band: "conserve",
          status: "picked at medium",
        },
        {
          provider: "openai-codex",
          model: "gpt-5.5",
          percentRemaining: 80,
          pace: "on_pace",
          spendPriority: 0.4,
          band: "conserve",
          status: "eligible at medium",
        },
        {
          provider: "anthropic-claude",
          model: "opus",
          percentRemaining: 0,
          band: "near_floor",
          status: "skipped: exhausted at medium",
        },
      ],
      // INF-1714: how the choice was made, under which near-floor, for which computer.
      selection: {
        version: 1,
        decidedBy: "spend-priority",
        floorPercent: CREW_NEAR_FLOOR_PERCENT,
        computer: "home",
      },
    });
  });
});
