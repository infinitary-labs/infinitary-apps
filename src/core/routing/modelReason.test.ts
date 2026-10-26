import { modelReasonLine } from "@shared/modelReason";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it } from "vitest";
import type { QuotaService } from "../quota/quotaService";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { modelReasonOf } from "./modelReason";
import { Router } from "./router";

const MODEL = { provider: "openai-codex", id: "gpt-5.5" };
const KEYS: Record<string, string> = { "basis-task": "FI3-419", "builder-task": "FI3-423" };

/** One signed-in model, which with no slot record routes at medium. */
function setup() {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const decisions = new DecisionStore(db);
  const router = new Router({
    decisions,
    settings,
    quota: {
      latestModels: () => ({
        generatedAt: "now",
        models: [
          { provider: "codex", id: MODEL.id, label: MODEL.id, effectivePercentRemaining: 80 },
        ],
      }),
      latest: () => undefined,
    } as unknown as QuotaService,
    availableModels: () => [MODEL],
  });
  const reasonOf = (id: string, shape: WorkShape | null, more: { parentId?: string } = {}) =>
    modelReasonOf(
      { id, model: `${MODEL.provider}/${MODEL.id}`, shape, parentId: more.parentId ?? null },
      { decisions, pins: () => settings.getRoutingSettings().pins, keyOf: (ref) => KEYS[ref] },
    );
  return { settings, decisions, router, reasonOf };
}

describe("modelReasonOf", () => {
  it("records a program choice without mislabelling it as kind-based routing (INF-974)", () => {
    const { router, decisions, reasonOf } = setup();
    const shape: WorkShape = {
      kind: "research",
      program_part: { call: 0, hash: "call", label: "read", intelligence: "low" },
    };
    expect(router.decide("part", "Read the meter's output", shape)).toMatchObject({
      rule: "R11",
      bucket: "low",
    });
    expect(decisions.routing({ taskIds: ["part"] }).at(-1)).toMatchObject({
      rule: "R11",
      bucket: "low",
    });
    expect(reasonOf("part", shape)).toBeUndefined();
  });

  it("reads the rule, both slots and the basis key off the decision the router recorded", () => {
    const { router, reasonOf } = setup();
    const shape: WorkShape = { kind: "fix", basis: "basis-task", basis_verified: true };
    router.decide("task-1", "build it", shape);
    const reason = reasonOf("task-1", shape);
    expect(reason).toEqual({ rule: "R6", asked: "medium", served: "medium", basis: "FI3-419" });
    expect(reason && modelReasonLine(reason)).toBe("Fixing a bug already reproduced in FI3-419");
  });

  it("carries the slot that served when the slot asked for could not", () => {
    const { router, reasonOf } = setup();
    const shape: WorkShape = { kind: "research" };
    router.decide("task-1", "find out", shape);
    expect(reasonOf("task-1", shape)).toEqual({
      rule: "R2",
      asked: "high",
      served: "medium",
      kind: "research",
    });
  });

  it("reads R10 from the persisted decision, including an unavailable low slot", () => {
    const { router, decisions, reasonOf } = setup();
    const shape: WorkShape = { kind: "retrieval", kind_source: "classifier:test" };
    router.decide("lookup", "Read the setting", shape);
    expect(reasonOf("lookup", shape)).toEqual({ rule: "R10", asked: "low", served: "medium" });
    decisions.recordRouting({
      taskId: "lookup",
      provider: MODEL.provider,
      model: MODEL.id,
      bucket: "low",
      served: "low",
      rule: "R10",
      reasons: [],
    });
    const reason = reasonOf("lookup", shape);
    expect(reason && modelReasonLine(reason)).toBe("Looking up or explaining from what is here");
  });

  it("knows a named model that served from one that was not available", () => {
    const { router, reasonOf } = setup();
    const named: WorkShape = { kind: "unclear", override_model_id: MODEL.id };
    router.decide("task-1", "do it", named);
    expect(reasonOf("task-1", named)).toMatchObject({ rule: "R0", named: true });
    const qualified: WorkShape = { kind: "unclear", override_model_id: "openai-codex/gpt-5.5" };
    router.decide("task-2", "do it", qualified);
    expect(reasonOf("task-2", qualified)).toMatchObject({ rule: "R0", named: true });
    const missing: WorkShape = { kind: "unclear", override_model_id: "gpt-9" };
    router.decide("task-3", "do it", missing);
    const reason = reasonOf("task-3", missing);
    expect(reason).toMatchObject({ rule: "R0", served: "medium" });
    expect(reason?.named).toBeUndefined();
  });

  it.each(["chore", "retrieval"] as const)("marks a Settings pin above the %s default", (kind) => {
    const { settings, router, reasonOf } = setup();
    settings.setRoutingSettings({
      dynamicRouting: true,
      pins: [{ provider: "codex", id: "gpt-5.5" }],
    });
    const shape: WorkShape = { kind };
    router.decide("task-1", "tidy", shape);
    const reason = reasonOf("task-1", shape);
    expect(reason).toMatchObject({ rule: kind === "retrieval" ? "R10" : "R7", pinned: true });
    expect(reason && modelReasonLine(reason)).toBe("You pinned this model in Settings");
  });

  it("names an escalation's rejected attempt and a review's builder", () => {
    const { decisions, router, reasonOf } = setup();
    const escalated: WorkShape = {
      kind: "fix",
      escalation: { from: "FI3-411", attempt: 1, floor: "medium" },
    };
    router.decide("task-1", "again", escalated);
    expect(reasonOf("task-1", escalated)).toMatchObject({ rule: "R1b", escalatedFrom: "FI3-411" });

    const review: WorkShape = { kind: "review", kind_source: "host:review" };
    const row = { bucket: "high", served: "high", reasons: [] };
    decisions.recordRouting({
      ...row,
      taskId: "builder-task",
      provider: "xai",
      model: "grok",
      rule: "R4",
    });
    decisions.recordRouting({ ...row, ...MODEL, taskId: "review-1", model: MODEL.id, rule: "R9" });
    expect(reasonOf("review-1", review, { parentId: "builder-task" })).toEqual({
      rule: "R9",
      asked: "high",
      served: "high",
      reviewOf: "FI3-423",
      elsewhere: true,
    });
    // The builder's provider served the review after all: nothing claims otherwise.
    decisions.recordRouting({ ...row, ...MODEL, taskId: "review-2", model: MODEL.id, rule: "R9" });
    decisions.recordRouting({ ...row, ...MODEL, taskId: "builder-2", model: MODEL.id, rule: "R4" });
    expect(reasonOf("review-2", review, { parentId: "builder-2" })?.elsewhere).toBeUndefined();
  });

  it("says nothing for a task that never routed or that runs on another model", () => {
    const { decisions, router, reasonOf } = setup();
    expect(reasonOf("task-1", { kind: "chore" })).toBeUndefined();
    router.decide("task-1", "tidy", { kind: "chore" });
    expect(
      modelReasonOf(
        { id: "task-1", model: "anthropic/claude-sonnet-5-5", shape: null, parentId: null },
        { decisions, pins: () => [], keyOf: () => undefined },
      ),
    ).toBeUndefined();
  });
});
