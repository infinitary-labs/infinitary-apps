import { modelChoiceLine } from "@shared/modelChoice";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { CREW_NEAR_FLOOR_PERCENT } from "@shared/quotaSignals";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import type { QuotaService } from "../quota/quotaService";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { modelChoiceOf } from "./modelChoice";
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
    const result = router.decide("task-1", "add a settings row", UNCLEAR, {
      placed: { work: [], samples: [], charges: {} },
    });
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
      router.decide("task-tier", "work from its recorded shape", shape, {
        placed: { work: [], samples: [], charges: {} },
      });
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
      return router.decide("task-held", "tidy the hull fittings", UNCLEAR, {
        placed: { work: [], samples: [], charges: {} },
      });
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
    const result = router.decide(
      "task-shape",
      "fix the flaky retry test",
      {
        kind: "fix",
        kind_source: "classifier:xai/grok-4.6",
        basis: "FM3K-12",
        basis_verified: true,
      },
      { placed: { work: [], samples: [], charges: {} } },
    );
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
    const result = router.decide(
      "task-unverified",
      "implement the thing",
      {
        kind: "implement",
        basis: "FM3K-99",
        basis_verified: false,
      },
      { placed: { work: [], samples: [], charges: {} } },
    );
    // R3: an unverified spec never buys the cheaper tier.
    expect(result?.rule).toBe("R3");
    expect(result?.bucket).toBe("high");
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-unverified") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain("basis FM3K-99 unverified");
  });

  it("still evaluates and records a route after an older client attempts to turn routing off", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    settings.setRoutingSettings({ dynamicRouting: false, pins: [] });
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota(undefined),
      availableModels: () => [],
    });
    expect(
      router.decide("task-2", "anything", UNCLEAR, {
        placed: { work: [], samples: [], charges: {} },
      }),
    ).toMatchObject({ rule: "R8" });
    expect(db.prepare("SELECT COUNT(*) as n FROM routing_decisions").get()).toEqual({ n: 1 });
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
      { placed: { work: [], samples: [], charges: {} } },
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
    const result = router.decide("task-pin", "use gpt-6-astra for this", override("gpt-6-astra"), {
      placed: { work: [], samples: [], charges: {} },
    });
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
      { placed: { work: [], samples: [], charges: {} } },
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
      { placed: { work: [], samples: [], charges: {} } },
    );
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-no-pin") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain(
      "requested pin anthropic-claude/claude-fable-5 is not available; ignoring it",
    );
  });

  // INF-1389: Automatic places a task the captain named a model for only on
  // a computer whose routing serves it, so each preview says whether it does.
  // INF-5438 finding 5: once every account here said what it serves - the
  // last sign-in removed - an empty pool holds no model but a pin or level;
  // a pool not read yet still holds every model.
  it("holds a model on no level once this Mac's pool is read and empty, and cannot say while it is unread", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const slots = new ModelSlots({ settings, accounts: () => [], quotaModels: () => undefined });
    let read = false;
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota(undefined),
      availableModels: () => [],
      slots,
      poolRead: () => read,
    });
    const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
    // An unread pool is not membership: the answer is unknown, so a caller defers.
    expect(router.holdsAtALevel(sol)).toBeUndefined();
    read = true;
    expect(router.holdsAtALevel(sol)).toBe(false);
  });

  // INF-5438 round 7 finding 10: with no placements of the person's own, the
  // defaults standing in leave a model out only once every account here said
  // what it serves: one account answering first is no exclusion of the rest.
  it("cannot say a model is off the defaults while an account here has not said what it serves", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const slots = new ModelSlots({ settings, accounts: () => [], quotaModels: () => undefined });
    const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const terra = { provider: "openai-codex", id: "gpt-6.1-terra" };
    const available = [terra];
    let read = false;
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota(undefined),
      availableModels: () => available,
      slots,
      poolRead: () => read,
    });
    // Terra's account answered; Sol's has not.
    expect(router.holdsAtALevel(sol)).toBeUndefined();
    available.push(sol);
    read = true;
    expect(router.holdsAtALevel(sol)).toBe(true);
    // Every account answered, and none serves Sol.
    available.splice(available.indexOf(sol), 1);
    expect(router.holdsAtALevel(sol)).toBe(false);
  });

  // INF-5438 finding 11: a routing row an older app wrote before `facts.named`
  // still says whether its model was named - by its selection, then its rule.
  it("reads whether an older routing row named its model, by its selection and then its rule", () => {
    const db = openInMemoryDatabase();
    const decisions = new DecisionStore(db);
    const router = new Router({
      decisions,
      settings: new SettingsStore(db),
      quota: fakeQuota(undefined),
      availableModels: () => [],
    });
    const row = (taskId: string, rule: string, decidedBy?: "named" | "runway-order") =>
      decisions.recordRouting({
        taskId,
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        bucket: "high",
        served: "high",
        rule,
        reasons: ["Use the available model for the work."],
        // As an older app wrote it: the selection, with no named flag.
        ...(decidedBy
          ? {
              facts: {
                kind: "routing-candidates" as const,
                candidates: [],
                selection: { version: 1 as const, decidedBy, floorPercent: 0, computer: "home" },
              },
            }
          : {}),
      });
    // A move to a model the captain named recorded its selection, not its rule.
    row("moved-named", "R8", "named");
    // A routed start recorded its order.
    row("routed", "R8", "runway-order");
    // A start that named its model before selections were recorded.
    row("named-start", "R0");
    expect(router.servedChoice("moved-named")?.named).toBe(true);
    expect(router.servedChoice("routed")?.named).toBe(false);
    expect(router.servedChoice("named-start")?.named).toBe(true);
  });

  it("says whether a preview serves the model the captain named", () => {
    const db = openInMemoryDatabase();
    const router = new Router({
      decisions: new DecisionStore(db),
      settings: new SettingsStore(db),
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.6-luna", label: "luna", effectivePercentRemaining: 80 },
        ],
      }),
      availableModels: () => [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "anthropic-claude", id: "claude-fable-5" },
      ],
    });
    const placed = { placed: { work: [], samples: [], charges: {} } };
    expect(router.preview("build it", override("claude-fable-5"), placed)?.named).toEqual({
      model: "claude-fable-5",
      served: true,
    });
    expect(router.preview("build it", override("claude-nobody-offers"), placed)?.named).toEqual({
      model: "claude-nobody-offers",
      served: false,
    });
    expect(router.preview("build it", UNCLEAR, placed)?.named).toBeUndefined();
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
    const result = router.decide("task-context", "x".repeat(700_000), UNCLEAR, {
      placed: { work: [], samples: [], charges: {} },
    });
    expect(result?.choice).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    const row = db
      .prepare("SELECT reasons_json FROM routing_decisions WHERE task_id = ?")
      .get("task-context") as { reasons_json: string };
    expect(JSON.parse(row.reasons_json) as string[]).toContain(
      "skipped openai-codex/gpt-5.3-codex-spark: the turn needs ~183k tokens and its context window is 128k",
    );
  });

  it("places a Claude-only install's chore on Claude's low model before any allowance is read (INF-2654)", () => {
    // No reading has landed: the quota service has no catalog yet, and the
    // starter map is the only slot record.
    const db = openInMemoryDatabase();
    const settings = new SettingsStore(db);
    const claude = Object.keys(STARTER_SLOTS["anthropic-claude"] ?? {}).map((id) => ({
      provider: "anthropic-claude",
      id,
    }));
    const low = Object.entries(STARTER_SLOTS["anthropic-claude"] ?? {}).find(([, slots]) =>
      slots.includes("low"),
    )?.[0];
    expect(low).toBeDefined();
    const router = new Router({
      decisions: new DecisionStore(db),
      settings,
      quota: fakeQuota(undefined),
      availableModels: () => claude,
      slots: new ModelSlots({
        settings,
        accounts: () => [
          {
            accountId: "acct-claude",
            accountLabel: "personal",
            providerId: "anthropic-claude",
            models: claude,
          },
        ],
        quotaModels: () => undefined,
      }),
    });
    const result = router.decide(
      "task-chore",
      "tidy the rivet gauge",
      {
        kind: "chore",
        kind_source: "classifier:test",
      },
      { placed: { work: [], samples: [], charges: {} } },
    );
    expect(result?.choice).toEqual({ provider: "anthropic-claude", id: low });
    expect(result?.servedBucket).toBeUndefined();
    expect(result?.unserveable).toBeUndefined();
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
    const builder = router.decide("builder", "fix the meter test", UNCLEAR, {
      placed: { work: [], samples: [], charges: {} },
    });
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
      ...{
        avoidProvider: "openai-codex",
      },
      placed: { work: [], samples: [], charges: {} },
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
      ...{
        withoutProvider: "github-copilot",
      },
      placed: { work: [], samples: [], charges: {} },
    });
    expect(moved?.result.choice).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
    expect(moved?.reasons).toContain("left out github-copilot, the provider the task moved off");
    available = [{ provider: "github-copilot", id: "gpt-5.5" }];
    expect(
      router.preview("promote the alpha", UNCLEAR, {
        ...{ withoutProvider: "github-copilot" },
        placed: { work: [], samples: [], charges: {} },
      })?.result.choice,
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
    const there = router.decide("placed", "add a settings row", UNCLEAR, {
      ...{ pool },
      placed: { work: [], samples: [], charges: {} },
    });
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
    expect(
      router.decide("pinned", "add a settings row", UNCLEAR, {
        ...{ pool },
        placed: { work: [], samples: [], charges: {} },
      })?.choice,
    ).toEqual({
      provider: "anthropic-claude",
      id: "claude-sonnet-5-5",
    });
    // A computer signed in to nothing serves nothing, rather than this Mac's model.
    const empty = router.decide("bare", "add a settings row", UNCLEAR, {
      ...{
        pool: { available: [], catalog: [], note: "Mac mini's own sign-ins (none): 0 models" },
      },
      placed: { work: [], samples: [], charges: {} },
    });
    expect(empty?.choice).toBeUndefined();
    // Here, the same task takes this Mac's own.
    expect(
      router.decide("here", "add a settings row", UNCLEAR, {
        placed: { work: [], samples: [], charges: {} },
      })?.choice,
    ).toEqual({
      provider: "openai-codex",
      id: "gpt-5.5",
    });
  });

  // INF-4275: a computer's spent allowance offers its own run-out card, naming that computer.
  it("names the spent providers of a computer's own sign-ins, and that computer, once the decision is committed", () => {
    const db = openInMemoryDatabase();
    const spent: [string[], string | undefined][] = [];
    const router = new Router({
      decisions: new DecisionStore(db),
      settings: new SettingsStore(db),
      quota: fakeQuota({
        generatedAt: "now",
        models: [
          { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 90 },
        ],
      }),
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
      onSpentAt: (providers, deviceId) => spent.push([providers, deviceId]),
    });
    // The computer's own Codex account has used up its allowance there.
    const pool = {
      available: [{ provider: "openai-codex", id: "gpt-5.5" }],
      catalog: [
        { provider: "codex", id: "gpt-5.5", label: "gpt-5.5", effectivePercentRemaining: 0 },
      ],
      note: "Mac mini's own sign-ins (openai-codex): 1 model",
      deviceId: "mini",
    };
    const prepared = { pool, placed: { work: [], samples: [], charges: {} } };
    // The first mate asked for medium, the only level that model sits at.
    const shape: WorkShape = { ...UNCLEAR, intelligence: "medium" };
    expect(router.preview("add a settings row", shape, prepared)?.result.choice).toBeUndefined();
    expect(spent).toEqual([]);
    router.decide("placed", "add a settings row", shape, prepared);
    expect(spent).toEqual([[["openai-codex"], "mini"]]);
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
    router.decide("task-1", "add a settings row", UNCLEAR, {
      placed: { work: [], samples: [], charges: {} },
    });
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

  // INF-3782: a person placed two custom connection models in high and the
  // first listed one won every start. They take turns, read from the saved
  // routing record, so a restart continues the turn and a preview, which
  // writes nothing, never advances it.
  describe("models no allowance is read for take turns (INF-3782)", () => {
    const custom = "fm-custom-0123456789abcdef";
    const opus = { provider: custom, id: "opus-5.5" };
    const sol = { provider: custom, id: "gpt-sol-6.1" };
    const placed = { placed: { work: [], samples: [], charges: {} } };

    function world(place: boolean) {
      const db = openInMemoryDatabase();
      const settings = new SettingsStore(db);
      const slots = new ModelSlots({
        settings,
        accounts: () => [
          {
            accountId: "acct-custom",
            accountLabel: "my connection",
            providerId: custom,
            models: [opus, sol],
          },
        ],
        quotaModels: () => undefined,
      });
      slots.reconcile();
      if (place) {
        for (const ref of [opus, sol]) slots.setSlotMembership(`${custom}/${ref.id}`, "high", true);
      }
      const router = () =>
        new Router({
          decisions: new DecisionStore(db),
          settings,
          quota: fakeQuota({ generatedAt: "now", models: [] }),
          availableModels: () => [opus, sol],
          slots,
        });
      return { db, router };
    }

    it("alternates starts, keeps a preview's answer and continues after a restart", () => {
      const { db, router } = world(true);
      const first = router();
      expect(first.decide("task-1", "build it", UNCLEAR, placed)?.choice).toEqual(opus);
      expect(first.preview("build it", UNCLEAR, placed)?.result.choice).toEqual(sol);
      expect(first.preview("build it", UNCLEAR, placed)?.result.choice).toEqual(sol);
      expect(first.decide("task-2", "build it", UNCLEAR, placed)?.choice).toEqual(sol);
      // A fresh Router over the same saved record is a restart of the app.
      expect(router().decide("task-3", "build it", UNCLEAR, placed)?.choice).toEqual(opus);

      const choice = modelChoiceOf(
        { id: "task-2", model: `${custom}/gpt-sol-6.1` },
        new DecisionStore(db),
      );
      expect(choice?.turns).toBe(true);
      expect(choice?.decidedBy).toBe("runway-order");
      expect(choice?.candidates.map((candidate) => [candidate.model, candidate.picked])).toEqual([
        [`${custom}/opus-5.5`, false],
        [`${custom}/gpt-sol-6.1`, true],
      ]);
      expect(
        modelChoiceLine(
          choice ?? { decidedBy: "band", floorPercent: 0, candidates: [] },
          (model) => model,
        ),
      ).toBe(
        "No allowance is read for these models, so they take turns; it was the one picked least recently.",
      );
    });

    it("keeps today's order among models the app placed only as a fallback", () => {
      // Only OpenRouter signed in, none of its models placed or listed: the
      // slot record's fallback puts each at medium, and they never rotate.
      const db = openInMemoryDatabase();
      const settings = new SettingsStore(db);
      const models = [
        { provider: "openrouter", id: "some/experimental-model" },
        { provider: "openrouter", id: "other/experimental-model" },
      ];
      const router = new Router({
        decisions: new DecisionStore(db),
        settings,
        quota: fakeQuota({ generatedAt: "now", models: [] }),
        availableModels: () => models,
        slots: new ModelSlots({ settings, accounts: () => [], quotaModels: () => undefined }),
      });
      for (const task of ["task-1", "task-2", "task-3"]) {
        expect(router.decide(task, "build it", UNCLEAR, placed)?.choice).toEqual(models[0]);
      }
    });

    it("counts a named model's start as its turn", () => {
      const { router } = world(true);
      const named = router().decide("task-1", "build it", override("opus-5.5"), placed);
      expect(named?.choice).toEqual(opus);
      expect(router().decide("task-2", "build it", UNCLEAR, placed)?.choice).toEqual(sol);
    });
  });
});
