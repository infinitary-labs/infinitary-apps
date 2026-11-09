/**
 * The per-task cost limit (INF-3112's plan, built by INF-3131;
 * docs/usage.md, "The cost limit"): a task whose spend, with everything
 * under it, reaches its limit stops at a safe point and asks on one card;
 * Allow more, No limit and Stop here each answer it, and so do the
 * captain's words. Each case drives a real CrewSupervisor through the crew
 * harness (tests/helpers/crewHarness.ts) over a real usage ledger.
 */
import { DEFAULT_COST_LIMIT } from "@shared/costLimit";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { FakeSessionOptions } from "../../../tests/helpers/fakeSession";
import { CostLimitStore } from "../storage/costLimitStore";
import { UsageStore } from "../storage/usageStore";
import { costCardId } from "./costLimits";

fakeCrewTimersEachTest();

/** A crewmate that stops at a safe point when asked, as a real session waits for its running call. */
function safelyStoppingCrewmate(options: FakeSessionOptions = {}) {
  const crewmate = fakeCrewmate(options);
  const stops: (() => void)[] = [];
  crewmate.stopSafely = () =>
    new Promise((resolve) => {
      stops.push(() => {
        resolve("stopped");
        crewmate.finishPrompt();
      });
    });
  return Object.assign(crewmate, { stops });
}

function costSetup() {
  const crewmate = safelyStoppingCrewmate({
    model: { provider: "anthropic", id: "claude-opus-5-5" },
  });
  let usage: UsageStore | undefined;
  let store: CostLimitStore | undefined;
  const h = setup(crewmate, {
    costLimits: (db) => {
      usage = new UsageStore(db);
      store = new CostLimitStore(db);
      return { store, appLimit: () => DEFAULT_COST_LIMIT };
    },
    recordUsage: (input) => usage?.record({ ...input, at: Date.now() }),
  });
  /** One model response's priced usage, as a session reports it when a tool call ends. */
  const respond = (cost: number) =>
    crewmate.emit({
      type: "tool_end",
      taskId: "",
      callId: `call-${cost}`,
      toolName: "bash",
      usage: { input: 90_000, output: 3_000, cost },
    } as Parameters<typeof crewmate.emit>[0]);
  const resumeRows = (taskId: string) =>
    h.inbox
      .allFor(taskId)
      .filter((row) => row.facts?.kind === "turn-resumed")
      .map((row) => row.facts);
  return {
    ...h,
    crewmate,
    respond,
    resumeRows,
    store: () => store as CostLimitStore,
    usage: () => usage as UsageStore,
  };
}

async function heldTask() {
  const h = costSetup();
  const { taskId } = await h.supervisor.intake.commission({
    title: "Rewrite the importer",
    intent: intentOf("rewrite the importer"),
  });
  await tick();
  h.respond(30);
  expect(h.cards().find((card) => card.id === costCardId(taskId))).toBeUndefined();
  h.respond(21.5);
  await tick();
  return { ...h, taskId };
}

describe("CostLimits", () => {
  it("stops a task that passed its limit at a safe point and asks on one card", async () => {
    const h = await heldTask();
    const card = h.cards().find((each) => each.id === costCardId(h.taskId));
    expect(card?.title).toBe("Rewrite the importer passed its $50 limit");
    expect(card?.body).toContain("spent about $51.50");
    expect(card?.actions?.map((action) => [action.label, action.default ?? false])).toEqual([
      ["Allow $50 more", true],
      ["No limit for this task", false],
      ["Stop here", false],
    ]);
    expect(h.crewmate.stops).toHaveLength(1);
    expect(h.resumeRows(h.taskId)).toEqual([{ kind: "turn-resumed", stopped: "cost-limit" }]);
    expect(h.store().hold(h.taskId)).toMatchObject({ limitUsd: 50, spentUsd: 51.5 });
    // The running call finishes, and the turn ends paused, never failed.
    h.crewmate.stops[0]?.();
    await tick();
    expect(h.supervisor.costLimits.heldBy(h.taskId)).toBeDefined();
    // A second response in the held family raises no second card.
    h.respond(1);
    await tick();
    expect(h.cards().filter((each) => each.id === costCardId(h.taskId))).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  it("raises the task's limit to $100 on Allow $50 more and carries the turn on", async () => {
    const h = await heldTask();
    h.crewmate.stops[0]?.();
    await tick();
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.cardActions.act(costCardId(h.taskId), "allow-more");
    await tick();
    expect(h.store().limitOf("task", h.taskId)).toEqual({ usd: 100 });
    expect(h.store().hold(h.taskId)).toBeUndefined();
    expect(h.cards().find((card) => card.id === costCardId(h.taskId))).toBeUndefined();
    expect(h.crewmate.promptCalls.length).toBeGreaterThan(prompts);
    expect(h.crewmate.promptCalls.at(-1)).toContain("passed its cost limit");
    await h.supervisor.disposeAll();
  });

  it("lifts the task's limit on No limit for this task", async () => {
    const h = await heldTask();
    h.crewmate.stops[0]?.();
    await tick();
    h.supervisor.cardActions.act(costCardId(h.taskId), "no-limit");
    await tick();
    expect(h.store().limitOf("task", h.taskId)).toEqual({ none: true });
    expect(h.supervisor.costLimits.heldBy(h.taskId)).toBeUndefined();
    // Spending more asks nothing now.
    h.respond(200);
    await tick();
    expect(h.store().hold(h.taskId)).toBeUndefined();
    await h.supervisor.disposeAll();
  });

  it("moves the task to the backlog with its work kept on Stop here", async () => {
    const h = await heldTask();
    h.crewmate.stops[0]?.();
    await tick();
    h.supervisor.cardActions.act(costCardId(h.taskId), "stop-here");
    await tick();
    expect(h.tasks.get(h.taskId)?.backlogSince).not.toBeNull();
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.store().hold(h.taskId)).toBeUndefined();
    expect(h.workspace.removeTaskWorktree).not.toHaveBeenCalled();
    await h.supervisor.disposeAll();
  });

  it("lets the captain's words set another amount, which lifts a hold it now clears", async () => {
    const h = await heldTask();
    h.crewmate.stops[0]?.();
    await tick();
    h.supervisor.costLimits.setTaskLimit(h.taskId, { usd: 51 });
    expect(h.store().hold(h.taskId)).toBeDefined();
    h.supervisor.costLimits.setTaskLimit(h.taskId, { usd: 75 });
    await tick();
    expect(h.store().hold(h.taskId)).toBeUndefined();
    expect(h.cards().find((card) => card.id === costCardId(h.taskId))).toBeUndefined();
    await h.supervisor.disposeAll();
  });

  it("counts a part's spend against the task it sits under", async () => {
    const h = costSetup();
    const { taskId } = await h.supervisor.intake.commission({
      title: "Ship the importer",
      intent: intentOf("ship the importer"),
    });
    await tick();
    h.tasks.create({
      id: "part-1",
      kind: "work",
      title: "Importer tests",
      prompt: "",
      repoId: null,
      parentId: taskId,
      status: "open",
      actor: "host",
    });
    h.respond(40);
    // The part's own response lands in its parent's family.
    h.usage().record({
      taskId: "part-1",
      usage: { input: 10_000, output: 900, cost: 12 },
      at: Date.now(),
    });
    h.supervisor.costLimits.recorded("part-1");
    await tick();
    expect(h.store().hold(taskId)).toMatchObject({ spentUsd: 52 });
    expect(h.supervisor.costLimits.heldBy("part-1")?.taskId).toBe(taskId);
    await h.supervisor.disposeAll();
  });
});
