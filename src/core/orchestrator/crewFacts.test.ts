/**
 * The crew's facts as `CrewFacts` reads them (docs/report-sort.md): the
 * crew status the first mate is served and the counts the window shows,
 * read from the record, and the task record that keeps them.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { queryTasks } from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import { discardedText } from "./settleWords";

fakeCrewTimersEachTest();

describe("CrewSupervisor", () => {
  it("reports fresh crew status from the store, not memory", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Status check",
      intent: intentOf("do stuff"),
    });
    await tick();
    const running = supervisor.facts.crewStatus();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ taskId, title: "Status check", status: "running" });
    crewmate.finishPrompt();
    await tick();
    expect(supervisor.facts.crewStatus()[0]?.status).toBe("idle");
    expect(supervisor.facts.crewStatus("missing")).toEqual([]);
  });

  it("counts a live idle runtime as one idle crewmate on both surfaces", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Live idle",
      intent: intentOf("do stuff"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    const live = supervisor.facts.crewStatus().filter((entry) => entry.status === "idle");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ taskId, status: "idle" });
    expect(live[0]?.crewmate).toBeDefined();
  });

  it("carries the app's recorded CI reading in crew_status once one exists, and none before", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Ship it",
      intent: intentOf("do stuff"),
    });
    await tick();
    expect(supervisor.facts.crewStatus(taskId)[0]?.ci).toBeUndefined();
    const at = Date.now() - 4 * 60_000;
    seedDelivery(
      tasks,
      taskId,
      { ci: "red", ciAt: at, headSha: "feedbeef00" },
      { kind: "ci", text: "CI red", feed: false },
    );
    expect(supervisor.facts.crewStatus(taskId)[0]?.ci).toEqual({
      overall: "red",
      readAt: new Date(at).toISOString(),
      ageMinutes: 4,
      head: "feedbeef00",
    });
  });

  it("keeps strip idle aligned with crew_status when a runtime sits beside a store orphan", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Still here",
      intent: intentOf("do stuff"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    seedTask(tasks, {
      id: "edccc9a2",
      title: "Half torn down",
      prompt: "gone",
      repoId: null,
      repoDir: "/tmp/repo",
      worktreeDir: "/tmp/wt",
      branch: "fm/task-edccc9a2",
      sessionFile: null,
      accountId: null,
      status: "idle",
      createdAt: Date.now(),
    });
    // Strip idle and crew_status idle agree: the live runtime plus the
    // resumable record a previous process left.
    expect(supervisor.facts.crewCounts()).toMatchObject({ working: 0, idle: 2 });
    const idle = supervisor.facts.crewStatus().filter((entry) => entry.status === "idle");
    expect(idle.map((entry) => entry.taskId).sort()).toEqual([taskId, "edccc9a2"].sort());
  });
});

describe("the task record (task-system P0)", () => {
  it("keeps the last report on the record so crew_status answers after a restart", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, db, paths, workspace } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Stabilize the flaky test",
      intent: intentOf("make the flaky test green"),
    });
    await tick();
    crewmate.emit({ type: "assistant_delta", taskId, text: "Green now. " });
    crewmate.emit({ type: "assistant_delta", taskId, text: "Two files changed." });
    crewmate.emit({ type: "turn_end", taskId, usage: { input: 10, output: 2 } });
    crewmate.finishPrompt();
    await tick();
    expect(supervisor.facts.crewStatus()[0]).toMatchObject({
      taskId,
      key: "SCR-1",
      status: "idle",
      lastReport: "Green now. Two files changed.",
    });
    supervisor.disposeAll();

    // A fresh process over the same database: no runtime remembers the
    // report, the record does. The crewmate is listed idle, steerable by
    // resume, with the same report and key.
    const rebooted = new TaskService({ db, strict: true });
    const fresh = reboot(
      { paths, db, workspace },
      vi.fn(async () => crewmate),
      { tasks: rebooted },
    );
    expect(fresh.facts.crewStatus()).toEqual([
      expect.objectContaining({
        taskId,
        key: "SCR-1",
        status: "idle",
        title: "Stabilize the flaky test",
        lastReport: "Green now. Two files changed.",
      }),
    ]);
    expect(fresh.facts.crewStatus()[0]?.crewmate).toBeUndefined();
    expect(fresh.facts.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    expect(rebooted.get(taskId)).toMatchObject({
      status: "active",
      activity: "idle",
      outcome: "Green now. Two files changed.",
      outcomeSummary: "Green now.",
      assignee: "crewmate 1",
      model: "fm-mock/mock-1",
    });
    expect(rebooted.timeline(taskId).map((event) => event.kind)).toEqual([
      "created",
      "dispatched",
      "briefed",
      "report",
    ]);
  });

  it("a confirmed discard of a streaming crewmate closes the record once, as discarded", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, workspace } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Mid-flight",
      intent: intentOf("go"),
    });
    await tick();
    const result = await supervisor.settling.settle.settleTask(taskId, "discard", true);
    expect(result).toBe(discardedText());
    // The abort resolves the turn; its finish path sees a closed record and
    // leaves the discard reason alone.
    crewmate.failPrompt("aborted");
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "dropped", closedReason: "discarded" });
    const closes = tasks.timeline(taskId).filter((event) => event.kind === "status");
    expect(closes).toHaveLength(1);
    expect(workspace.removeTaskWorktree).toHaveBeenCalledTimes(1);
  });

  it("records the structured intent, the account, and a failed turn on the record", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, {
      accounts: {
        selectForSpawn: () => "acct_1",
        reselectForResume: () => ({ changed: false }),
        labelOf: () => "Work",
      },
      routedModel: { provider: "openai-codex", id: "gpt-5.5" },
    });
    const intent = intentOf("carefully");
    const { taskId } = await supervisor.intake.commission({ title: "Careful work", intent });
    await tick();
    expect(tasks.get(taskId)).toMatchObject({
      kind: "work",
      intent,
      goal: intent.goal,
      accountId: "acct_1",
      // The transport's own model, not the routing choice it came from.
      model: "fm-mock/mock-1",
      activity: "running",
      startedAt: expect.any(Number),
    });
    crewmate.emit({ type: "turn_failed", taskId, error: "provider melted" });
    crewmate.finishPrompt();
    await tick();
    expect(tasks.get(taskId)).toMatchObject({ status: "active", activity: "idle", outcome: null });
    expect(tasks.timeline(taskId).at(-1)).toMatchObject({
      kind: "failed",
      text: "hit a problem: provider melted",
      data: { error: "provider melted", fatal: false },
    });
  });

  it("a queued row waits on a blocks edge and starts when the blocker delivers", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate);
    const first = await supervisor.intake.commission({ title: "First", intent: intentOf("one") });
    await tick();
    const second = await supervisor.intake.commission({
      title: "Second",
      intent: intentOf("two"),
      startAfter: { afterTask: first.taskId },
    });
    expect(tasks.get(second.taskId)).toMatchObject({ status: "open", gate: null });
    expect(tasks.graph.blockers(second.taskId).map((record) => record.id)).toEqual([first.taskId]);
    // INF-1605: the crew line reads the same dated wait as the task query.
    expect(
      supervisor.facts.crewStatus().find((entry) => entry.taskId === second.taskId)?.gate,
    ).toBe(queryTasks(tasks, { key: second.taskId }, () => undefined).rows[0]?.waiting);
    expect(events.at(-2)).toMatchObject({
      type: "firstmate_note",
      text: `Queued "Second" - starts when ${tasks.get(first.taskId)?.key} finishes.`,
    });
    await supervisor.watch.sweepGates(Date.now());
    expect(tasks.get(second.taskId)?.status).toBe("open");

    crewmate.finishPrompt();
    await tick();
    await supervisor.settling.settle.settleTask(first.taskId, "land", undefined, "captain");
    await tick();
    expect(tasks.get(second.taskId)).toMatchObject({ status: "active" });
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: `Starting "Second" - task ${first.taskId} finished.`,
    });
  });
});
