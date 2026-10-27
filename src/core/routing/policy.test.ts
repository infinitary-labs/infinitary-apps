import {
  CLASSIFIABLE_KINDS,
  DEFAULT_ROUTING_POLICY,
  type WorkShape,
  workShapeSchema,
} from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import { noneKindClassifier, resolveKind } from "./kindClassifier";
import { escalationFloor, legacyShapeFromDifficulty, tierFor } from "./policy";

function shape(over: Partial<WorkShape> = {}): WorkShape {
  return { kind: "unclear", ...over };
}

describe("tierFor: the captain's table", () => {
  // INF-974: a script's declared choice outranks kind, never the captain's choices.
  it.each(["low", "medium", "high"] as const)(
    "routes a program part at %s before its kind",
    (intelligence) => {
      const part = { call: 0, hash: "call", label: "read", intelligence };
      expect(tierFor(shape({ kind: "research", program_part: part }))).toMatchObject({
        rule: "R11",
        bucket: intelligence,
      });
      expect(tierFor(shape({ kind: "chore", program_part: part }))).toMatchObject({
        rule: "R11",
        bucket: intelligence,
      });
      expect(
        tierFor(shape({ program_part: part, override_model_id: "captain-model" })),
      ).toMatchObject({ rule: "R0", pin: "captain-model" });
      expect(tierFor(shape({ program_part: part, premium_ask: true }))).toMatchObject({
        rule: "R1a",
        bucket: "premium",
      });
      expect(
        tierFor(
          shape({ program_part: part, escalation: { from: "prior", attempt: 1, floor: "high" } }),
        ),
      ).toMatchObject({ rule: "R1b", bucket: "high" });
    },
  );

  it("does not treat a script's premium choice as premium consent", () => {
    const part = { call: 0, hash: "call", label: "read", intelligence: "premium" as const };
    expect(tierFor(shape({ program_part: part }))).toMatchObject({ rule: "R8", bucket: "high" });
    expect(tierFor(shape({ program_part: part, premium_ask: true }))).toMatchObject({
      rule: "R1a",
      bucket: "premium",
    });
  });

  it("defines the approved reasoning effort for each tier", () => {
    expect(DEFAULT_ROUTING_POLICY.effort).toEqual({
      premium: "xhigh",
      high: "xhigh",
      medium: "medium",
      low: "medium",
    });
  });
  // One row per rule of report section 3.2, in precedence order.
  const table: Array<{ rule: string; why: string; shape: WorkShape; bucket?: string }> = [
    {
      rule: "R0",
      why: "the captain named a model: the tier is that model's own slot",
      shape: shape({ kind: "chore", override_model_id: "gpt-6-astra" }),
    },
    {
      rule: "R1a",
      why: "a user ask reaches premium",
      shape: shape({ kind: "chore", premium_ask: true }),
      bucket: "premium",
    },
    {
      rule: "R1b",
      why: "an escalation runs at the floor the host stamped",
      shape: shape({
        kind: "fix",
        escalate_from: "FM3K-12",
        escalation: { from: "FM3K-12", attempt: 1, floor: "high" },
      }),
      bucket: "high",
    },
    { rule: "R2", why: "a complex plan", shape: shape({ kind: "plan" }), bucket: "high" },
    { rule: "R2", why: "complex research", shape: shape({ kind: "research" }), bucket: "high" },
    { rule: "R2", why: "a bug reproduction", shape: shape({ kind: "reproduce" }), bucket: "high" },
    {
      rule: "R2",
      why: "an independent review reads like research (delivery rigor phase 2, Q5)",
      shape: shape({ kind: "review", kind_source: "host:review" }),
      bucket: "high",
    },
    {
      rule: "R3",
      why: "implementing an unplanned feature",
      shape: shape({ kind: "implement" }),
      bucket: "high",
    },
    {
      rule: "R4",
      why: "implementing from a verified plan or spec",
      shape: shape({ kind: "implement", basis: "FM3K-7", basis_verified: true }),
      bucket: "medium",
    },
    {
      rule: "R5",
      why: "fixing a bug not yet reproduced or understood",
      shape: shape({ kind: "fix" }),
      bucket: "high",
    },
    {
      rule: "R6",
      why: "fixing a bug already reproduced with a clear solution",
      shape: shape({ kind: "fix", basis: "FM3K-9", basis_verified: true }),
      bucket: "medium",
    },
    {
      rule: "R7",
      why: "simple config, docs or cosmetics",
      shape: shape({ kind: "chore" }),
      bucket: "low",
    },
    { rule: "R10", why: "bounded fact lookup", shape: shape({ kind: "retrieval" }), bucket: "low" },
    { rule: "R8", why: "unclear defaults high", shape: shape(), bucket: "high" },
  ];

  for (const row of table) {
    it(`${row.rule}: ${row.why}`, () => {
      const decision = tierFor(row.shape);
      expect(decision.rule).toBe(row.rule);
      expect(decision.bucket).toBe(row.bucket);
      expect(decision.reason).toContain(`rule ${row.rule}`);
    });
  }

  it("R0 hands the named model back rather than guessing its slot", () => {
    const decision = tierFor(
      shape({ kind: "fix", override_model_id: "anthropic-claude/claude-fable-5" }),
    );
    expect(decision.pin).toBe("anthropic-claude/claude-fable-5");
    expect(decision.bucket).toBeUndefined();
  });

  it("an override wins over a premium ask, which wins over an escalation", () => {
    const all = shape({
      kind: "retrieval",
      override_model_id: "gpt-6-astra",
      premium_ask: true,
      escalation: { from: "FM3K-1", attempt: 1, floor: "high" },
    });
    expect(tierFor(all).rule).toBe("R0");
    const { override_model_id: _dropped, ...withoutOverride } = all;
    expect(tierFor(withoutOverride).rule).toBe("R1a");
    const { premium_ask: _alsoDropped, ...escalationOnly } = withoutOverride;
    expect(tierFor(escalationOnly).rule).toBe("R1b");
  });

  it("retrieval stays low with or without a basis while investigative answers stay high", () => {
    for (const basis of [{}, { basis: "FM3K-7", basis_verified: true }]) {
      expect(tierFor(shape({ kind: "retrieval", ...basis }))).toMatchObject({
        rule: "R10",
        bucket: "low",
      });
      for (const kind of ["research", "reproduce", "unclear"] as const)
        expect(tierFor(shape({ kind, ...basis })).bucket).toBe("high");
    }
  });

  it("an unverified basis never buys the cheaper tier", () => {
    expect(tierFor(shape({ kind: "implement", basis: "FM3K-7" })).rule).toBe("R3");
    expect(tierFor(shape({ kind: "fix", basis: "FM3K-9", basis_verified: false })).rule).toBe("R5");
  });

  it("never reaches premium without a captain ask or an escalation", () => {
    const automatic = (
      [
        "plan",
        "research",
        "retrieval",
        "reproduce",
        "implement",
        "fix",
        "chore",
        "review",
        "unclear",
      ] as const
    ).map((kind) => tierFor(shape({ kind })).bucket);
    expect(automatic).not.toContain("premium");
  });

  it("keeps review out of the classifier's vocabulary: the host alone asserts it", () => {
    // `review` is a kind the table routes, never one a classifier may
    // answer (delivery rigor phase 2): a verdict of `review` resolves to
    // the abstention like any other word outside CLASSIFIABLE_KINDS.
    expect(CLASSIFIABLE_KINDS).not.toContain("review");
    expect(resolveKind({ kind: "review", source: "classifier:test", version: "v" })).toBe(
      "unclear",
    );
  });
});

describe("escalationFloor", () => {
  it("climbs one rung, premium included", () => {
    expect(escalationFloor("low", 1)).toEqual({ floor: "medium", attempt: 1 });
    expect(escalationFloor("medium", 1)).toEqual({ floor: "high", attempt: 1 });
    expect(escalationFloor("high", 2)).toEqual({ floor: "premium", attempt: 2 });
  });

  it("refuses past the lineage bound and past premium", () => {
    expect(escalationFloor("medium", 3)).toEqual({
      refused: "this lineage already used its 2 escalations",
    });
    expect(escalationFloor("premium", 1)).toEqual({ refused: "nothing routes above premium" });
  });
});

describe("the kind classifier seam", () => {
  it("the none implementation abstains", async () => {
    const verdict = await noneKindClassifier.classify(
      { taskId: "task-1", title: "t", goal: "g", userWords: "w", deliverable: "change" },
      new AbortController().signal,
    );
    expect(verdict).toEqual({ kind: "unclear", source: "none", version: "none-1" });
    expect(tierFor(shape({ kind: resolveKind(verdict) })).rule).toBe("R8");
  });

  it("takes a verdict at its word, and only a kind the table knows", () => {
    // There is no confidence floor at this layer since S7b: the
    // implementation has already decided whether it was sure enough, and a
    // floor here could only re-judge a number the decision interface
    // deliberately does not carry.
    const base = { kind: "chore" as const, source: "classifier:x", version: "kc1-abc" };
    expect(resolveKind(base)).toBe("chore");
    expect(resolveKind({ ...base, detail: "p=0.41 below 0.6" })).toBe("chore");
    expect(resolveKind({ ...base, kind: "unclear" })).toBe("unclear");
  });

  it("a pre-S7b shape row still parses; its dead confidence is simply dropped", () => {
    const parsed = workShapeSchema.parse({
      kind: "fix",
      kind_source: "classifier:xai/grok-4.6",
      kind_confidence: 0.9,
    });
    expect(parsed).toEqual({ kind: "fix", kind_source: "classifier:xai/grok-4.6" });
  });
});

describe("legacyShapeFromDifficulty", () => {
  it("keeps the facts a pre-S2 judgment carried and drops the judgment itself", () => {
    // low, medium and high were the model's own reading of the work, which
    // the table does not read; unclear (R8, high) is the honest shape. The
    // rigor is quick (delivery rigor phase 2): nothing derived one then.
    expect(legacyShapeFromDifficulty("low")).toEqual({
      kind: "unclear",
      kind_source: "legacy-judgment",
      rigor: "quick",
    });
    expect(legacyShapeFromDifficulty(null)).toEqual({
      kind: "unclear",
      kind_source: "legacy-judgment",
      rigor: "quick",
    });
    // premium was only ever set because the captain asked in words, and a
    // named model is the same override under its old name.
    expect(legacyShapeFromDifficulty("premium")).toEqual({
      kind: "unclear",
      kind_source: "legacy-judgment",
      rigor: "quick",
      premium_ask: true,
    });
    expect(legacyShapeFromDifficulty("high", "gpt-6-astra")).toEqual({
      kind: "unclear",
      kind_source: "legacy-judgment",
      rigor: "quick",
      override_model_id: "gpt-6-astra",
    });
  });

  it("routes a translated premium ask to premium and everything else high", () => {
    expect(tierFor(legacyShapeFromDifficulty("premium")).bucket).toBe("premium");
    expect(tierFor(legacyShapeFromDifficulty("low")).bucket).toBe("high");
    expect(tierFor(legacyShapeFromDifficulty("high", "gpt-6-astra")).pin).toBe("gpt-6-astra");
  });
});

// INF-1430's approved R12: skip the kind, retain every higher-priority choice.
describe("operation routing", () => {
  it("routes every operation medium below the four overrides", () => {
    const operation = shape({ kind: "chore", deliverable: "operation" });
    expect(tierFor(operation)).toMatchObject({ rule: "R12", bucket: "medium" });
    expect(tierFor({ ...operation, kind: "research" })).toMatchObject({
      rule: "R12",
      bucket: "medium",
    });
    expect(tierFor({ ...operation, override_model_id: "chosen" })).toMatchObject({
      rule: "R0",
      pin: "chosen",
    });
    expect(tierFor({ ...operation, premium_ask: true })).toMatchObject({
      rule: "R1a",
      bucket: "premium",
    });
    expect(
      tierFor({ ...operation, escalation: { from: "old", attempt: 1, floor: "high" } }),
    ).toMatchObject({ rule: "R1b", bucket: "high" });
    expect(
      tierFor({
        ...operation,
        program_part: { call: 0, hash: "call", label: "run", intelligence: "low" },
      }),
    ).toMatchObject({ rule: "R11", bucket: "low" });
  });
});
