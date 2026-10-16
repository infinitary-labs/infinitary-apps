import { describe, expect, it } from "vitest";
import { type ModelReason, modelFootnote, modelReasonLine, modelReasonSchema } from "./modelReason";
import { reasoningNote, reasoningSchema, reasoningWord } from "./reasoning";

const reason = (
  rule: ModelReason["rule"],
  served: ModelReason["served"],
  more: Partial<ModelReason> = {},
): ModelReason => modelReasonSchema.parse({ rule, asked: served, served, ...more });

describe("modelReasonLine", () => {
  it("says what the rule read about the work, with no level in front", () => {
    expect(modelReasonLine(reason("R2", "high", { kind: "plan" }))).toBe("Planning");
    expect(modelReasonLine(reason("R2", "high", { kind: "research" }))).toBe("Research");
    expect(modelReasonLine(reason("R2", "high", { kind: "reproduce" }))).toBe("Reproducing a bug");
    expect(modelReasonLine(reason("R3", "high"))).toBe("Building with no plan to follow yet");
    expect(modelReasonLine(reason("R4", "medium", { basis: "FI3-419" }))).toBe(
      "Building from the plan in FI3-419",
    );
    expect(modelReasonLine(reason("R5", "high"))).toBe("Fixing a bug not yet reproduced");
    expect(modelReasonLine(reason("R6", "medium", { basis: "FI3-402" }))).toBe(
      "Fixing a bug already reproduced in FI3-402",
    );
    expect(modelReasonLine(reason("R7", "low"))).toBe("Simple upkeep");
    expect(modelReasonLine(reason("R10", "low"))).toBe("Looking up existing facts");
    expect(modelReasonLine(reason("R8", "high"))).toBe("The kind of work was unclear");
  });

  it("names the basis only when the record holds its key", () => {
    expect(modelReasonLine(reason("R4", "medium"))).toBe("Building from a plan");
    expect(modelReasonLine(reason("R6", "medium"))).toBe("Fixing a bug already reproduced");
  });

  it("names the rejected attempt an escalation climbed from", () => {
    expect(modelReasonLine(reason("R1b", "premium", { escalatedFrom: "FI3-411" }))).toBe(
      "A stronger model after FI3-411 fell short",
    );
    expect(modelReasonLine(reason("R1b", "high"))).toBe(
      "A stronger model after an earlier attempt fell short",
    );
  });

  it("says a review is away from the builder's provider only when it is", () => {
    const review = { kind: "review", reviewOf: "FI3-423" } as const;
    expect(modelReasonLine(reason("R9", "high", { ...review, elsewhere: true }))).toBe(
      "Reviewing FI3-423, away from the builder's provider",
    );
    expect(modelReasonLine(reason("R9", "high", review))).toBe("Reviewing FI3-423");
    expect(modelReasonLine(reason("R2", "high", review))).toBe("Reviewing FI3-423");
  });

  it("puts the captain's own choice of model before any level", () => {
    expect(modelReasonLine(reason("R0", "premium", { named: true }))).toBe(
      "You asked for this model",
    );
    expect(modelReasonLine(reason("R4", "medium", { basis: "FI3-419", pinned: true }))).toBe(
      "You pinned this model in Settings",
    );
    expect(modelReasonLine(reason("R1a", "premium"))).toBe("You asked for premium");
  });

  it("says so when the model or the level asked for could not serve", () => {
    expect(modelReasonLine(reason("R0", "medium"))).toBe("The model you named was not available");
    expect(modelReasonLine({ rule: "R2", kind: "plan", asked: "high", served: "medium" })).toBe(
      "No high model could take it",
    );
    expect(modelReasonLine({ rule: "R1a", asked: "premium", served: "high" })).toBe(
      "No premium model could take it",
    );
  });

  it("says nothing when the record cannot name the work", () => {
    expect(modelReasonLine(reason("R2", "high"))).toBeNull();
  });
});

describe("reasoning words", () => {
  it("names every level a session can open at, extra high and the model's own included", () => {
    const words = reasoningSchema.shape.level.options.map((level) => reasoningWord({ level }));
    expect(words).toEqual([
      "None",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Model's own",
    ]);
  });

  it("says why reasoning sits below what its level asks, and nothing when it does not", () => {
    expect(reasoningNote({ level: "high", lower: "quick" })).toBe(
      "Reasoning one step lower for Quick care.",
    );
    expect(reasoningNote({ level: "medium", lower: "capped" })).toBe(
      "Reasoning at the most this model offers.",
    );
    expect(reasoningNote({ level: "xhigh" })).toBeNull();
  });
});

describe("modelFootnote", () => {
  it("joins why the model and why the reasoning is lower as two sentences", () => {
    expect(modelFootnote(reason("R3", "high"), { level: "high", lower: "quick" })).toBe(
      "Building with no plan to follow yet. Reasoning one step lower for Quick care.",
    );
  });

  it("is either half alone, and nothing when neither is known", () => {
    expect(modelFootnote(reason("R3", "high"), { level: "xhigh" })).toBe(
      "Building with no plan to follow yet",
    );
    expect(modelFootnote(undefined, { level: "medium", lower: "capped" })).toBe(
      "Reasoning at the most this model offers.",
    );
    expect(modelFootnote(reason("R2", "high"), { level: "xhigh" })).toBeNull();
    expect(modelFootnote(undefined, undefined)).toBeNull();
  });
});
