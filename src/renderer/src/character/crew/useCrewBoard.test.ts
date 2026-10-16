import { modelNames } from "@shared/modelDisplayName";
import { type SlotModelView, TRACKED_FAMILIES } from "@shared/modelSlots";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskView } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { crewFacts, crewModelNames } from "./useCrewBoard";

const rule = TRACKED_FAMILIES.openrouter;
if (!rule || rule === "every" || !rule.ids[1]) throw new Error("Missing OpenRouter example");

const model: SlotModelView = {
  provider: "openrouter",
  providerLabel: "OpenRouter",
  id: rule.ids[1],
  label: "Anthropic: Claude Opus Latest",
  slots: [],
};
const task = {
  id: "crew",
  kind: "work" as const,
  status: "active" as const,
  model: `${model.provider}/${model.id}`,
};

describe("crew name projection", () => {
  it("follows the assigned offering without changing the task or catalog", () => {
    expect(crewModelNames([task], modelNames([model]))).toEqual({ crew: "Claude Opus Latest" });
    expect(task.model).toBe(`${model.provider}/${model.id}`);
    expect(model.label).toBe("Anthropic: Claude Opus Latest");
  });
  it("replaces the name on a reroute and follows a late catalog", () => {
    const rerouted = { ...task, model: "custom/new-model" };
    expect(crewModelNames([rerouted], modelNames([model]))).toEqual({ crew: "new-model" });
    const custom = {
      ...model,
      provider: "custom",
      id: "new-model",
      label: "Research: Preview build",
    };
    expect(crewModelNames([rerouted], modelNames([model, custom]))).toEqual({
      crew: "Research: Preview build",
    });
  });
  it("never invents an assignment and excludes non-crew or closed work", () => {
    expect(crewModelNames([{ ...task, model: null }], modelNames([model]))).toEqual({});
    expect(
      crewModelNames(
        [
          { ...task, status: "done" },
          { ...task, id: "question", kind: "question" },
        ],
        modelNames([model]),
      ),
    ).toEqual({});
  });
});

describe("crew summary facts", () => {
  const row = {
    ...task,
    key: "DEMO-14",
    projectId: "demo",
    parentId: null,
    title: "Refactor the sign-in flow",
    goal: null,
    priority: 2,
    activity: "idle" as const,
    tier: null,
    closedReason: null,
    startPolicy: "when-ready" as const,
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 3",
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    closedAt: null,
  } satisfies TaskView;
  const names = modelNames([model]);
  it("carries each crewmate's row and the one name lookup into the shared projection", () => {
    const facts = crewFacts(
      [{ ...row, tier: "high", workPosture: { state: "active", reason: "checks" } }],
      names,
    );
    const crew = facts.crew;
    if (!crew) throw new Error("The crewmate has no summary");
    expect(taskFactsOf(crew.task, crew.modelName)).toEqual({
      key: "DEMO-14",
      title: "Refactor the sign-in flow",
      status: { mark: "working", word: "Working", reason: "Waiting for checks" },
      // The board paints at once; Now waits for the record's read.
      now: undefined,
      model: "Claude Opus Latest",
      tier: "high",
      reasoning: null,
      reason: null,
      delivery: null,
      // The task's own browser is the record's read alone.
      browser: null,
    });
  });
  it("has an entry only for crew in orbit", () => {
    expect(
      crewFacts(
        [
          { ...row, status: "done" },
          { ...row, id: "question", kind: "question" },
        ],
        names,
      ),
    ).toEqual({});
  });
});
