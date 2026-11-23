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
import { heldSteerText } from "../pi/crewTools";
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
    expect(card?.body).toContain("Its crewmate stopped at a safe point");
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
    h.respond(1);
    await tick();
    expect(h.cards().filter((each) => each.id === costCardId(h.taskId))).toHaveLength(1);
    await h.supervisor.disposeAll();
  });

  // INF-4165 finding 2: four messages kept behind spending-limit cards were
  // each reported as "account is not answering".
  it("answers a message kept behind the limit with the limit and its card, not the account", async () => {
    const h = await heldTask();
    h.crewmate.stops[0]?.();
    await tick();
    expect(await h.supervisor.steer.steerCrewmate(h.taskId, "and the tests")).toBe("recorded-held");
    const hold = h.supervisor.facts.laneHold(h.taskId);
    expect(hold).toMatchObject({
      kind: "cost-limit",
      holder: h.taskId,
      limitUsd: 50,
      cardId: costCardId(h.taskId),
    });
    const answer = heldSteerText(h.taskId, hold);
    expect(answer).toContain("passed its $50 cost limit");
    expect(answer).toContain(costCardId(h.taskId));
    expect(answer).not.toContain("account is not answering");
    h.supervisor.cardActions.act(costCardId(h.taskId), "allow-more");
    await tick();
    expect(h.supervisor.facts.laneHold(h.taskId)).toBeUndefined();
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

  // Accepted session-audit finding 1: one spending answer covers the task's parts.
  it.each(["allow-more", "no-limit"] as const)(
    "applies the parent's %s answer to a part instead of asking twice",
    async (answer) => {
      const h = costSetup();
      h.tasks.create({
        id: "plan",
        kind: "work",
        title: "Ship the importer",
        prompt: "",
        repoId: null,
        status: "open",
        actor: "host",
      });
      const part = h.tasks.create({
        id: "part",
        kind: "work",
        title: "Importer tests",
        prompt: "",
        repoId: null,
        parentId: "plan",
        status: "open",
        actor: "host",
      });
      h.usage().record({
        taskId: "part",
        usage: { input: 90_000, output: 3_000, cost: 51.42 },
        at: Date.now(),
      });
      h.supervisor.costLimits.recorded("part");
      await tick();
      const card = h.cards().find((each) => each.id === costCardId("plan"));
      expect(card?.body).toContain("Work under this task stops at a safe point");
      expect(card?.body).not.toContain("Its crewmate stopped");
      expect(h.store().hold("plan")).toBeDefined();
      h.supervisor.cardActions.act(costCardId("plan"), answer);
      await tick();
      h.supervisor.costLimits.recorded("part");
      expect(h.supervisor.costLimits.limitFor(part)?.limit).toEqual(
        answer === "allow-more" ? { usd: 100 } : { none: true },
      );
      expect(h.store().hold("plan")).toBeUndefined();
      expect(h.store().hold("part")).toBeUndefined();
      expect(h.cards().filter((each) => each.id.startsWith("card-cost-"))).toHaveLength(0);
      if (answer === "allow-more") {
        h.usage().record({
          taskId: "part",
          usage: { input: 90_000, output: 3_000, cost: 51.42 },
          at: Date.now(),
        });
        h.supervisor.costLimits.recorded("part");
        expect(h.store().hold("plan")?.limitUsd).toBe(100);
        expect(h.store().hold("part")).toBeUndefined();
      }
      await h.supervisor.disposeAll();
    },
  );

  it("releases a part's existing hold when the nearest answer above it now clears it", async () => {
    const h = costSetup();
    h.tasks.create({
      id: "plan",
      kind: "work",
      title: "Ship the importer",
      prompt: "",
      repoId: null,
      status: "open",
      actor: "host",
    });
    const part = h.tasks.create({
      id: "part",
      kind: "work",
      title: "Importer tests",
      prompt: "",
      repoId: null,
      parentId: "plan",
      status: "open",
      actor: "host",
    });
    h.supervisor.costLimits.setTaskLimit("plan", { none: true });
    h.supervisor.costLimits.setTaskLimit("part", { usd: 50 });
    h.usage().record({
      taskId: "part",
      usage: { input: 90_000, output: 3_000, cost: 51.42 },
      at: Date.now(),
    });
    h.supervisor.costLimits.recorded("part");
    expect(h.store().hold("part")).toBeDefined();
    // A part's explicit answer still wins over a changed parent's answer.
    h.supervisor.costLimits.setTaskLimit("plan", { usd: 100 });
    expect(h.store().hold("part")).toBeDefined();
    h.supervisor.costLimits.setTaskLimit("part", null);
    await tick();
    expect(h.store().hold("part")).toBeUndefined();
    expect(h.supervisor.costLimits.limitFor(part)?.limit).toEqual({ usd: 100 });
    await h.supervisor.disposeAll();
  });

  it("falls back to project then app only when no task above has answered", async () => {
    const h = costSetup();
    const plan = h.tasks.create({
      id: "plan",
      kind: "work",
      title: "Ship the importer",
      prompt: "",
      repoId: "repo-fm",
      status: "open",
      actor: "host",
    });
    const part = h.tasks.create({
      id: "part",
      kind: "work",
      title: "Importer tests",
      prompt: "",
      repoId: "repo-fm",
      parentId: plan.id,
      status: "open",
      actor: "host",
    });
    expect(h.supervisor.costLimits.limitFor(part)).toEqual({
      limit: DEFAULT_COST_LIMIT,
      source: "app",
    });
    h.store().setLimit("project", "repo-fm", { usd: 75 }, Date.now());
    expect(h.supervisor.costLimits.limitFor(part)).toEqual({
      limit: { usd: 75 },
      source: "project",
    });
    h.supervisor.costLimits.setTaskLimit(plan.id, { none: true });
    expect(h.supervisor.costLimits.limitFor(part)).toEqual({
      limit: { none: true },
      source: "task",
    });
    h.supervisor.costLimits.setTaskLimit(plan.id, null);
    expect(h.supervisor.costLimits.limitFor(part)).toEqual({
      limit: { usd: 75 },
      source: "project",
    });
    await h.supervisor.disposeAll();
  });

  it("takes down an old inherited-default hold after an answer above it", async () => {
    const h = costSetup();
    const plan = h.tasks.create({
      id: "plan",
      kind: "work",
      title: "Ship the importer",
      prompt: "",
      repoId: null,
      status: "open",
      actor: "host",
    });
    const part = h.tasks.create({
      id: "part",
      kind: "work",
      title: "Importer tests",
      prompt: "",
      repoId: null,
      parentId: plan.id,
      status: "open",
      actor: "host",
    });
    // A saved hold from before the parent answered: it used the old app default.
    h.store().placeHold({ taskId: part.id, limitUsd: 50, spentUsd: 51.42, at: Date.now() });
    h.usage().record({
      taskId: part.id,
      usage: { input: 90_000, output: 3_000, cost: 51.42 },
      at: Date.now(),
    });
    h.supervisor.costLimits.setTaskLimit(plan.id, { usd: 100 });
    await tick();
    expect(h.supervisor.costLimits.heldBy(part.id)).toBeUndefined();
    expect(h.supervisor.costLimits.limitFor(part)?.limit).toEqual({ usd: 100 });
    await h.supervisor.disposeAll();
  });
});
