/**
 * The close's order around what a task left running (INF-3447's approved
 * plan, piece 1; docs/leftover-programs.md, "At the close"): the sweep
 * begins once the record has closed and the crewmate's session has ended,
 * and the working copy goes only after it settles; a stronger-model
 * retry's earlier attempt hands its stops to the retry while the retry is
 * open, and a retry dropped before it started still begins its own sweep
 * (review findings on INF-3447's piece 1). Drives a real CrewSupervisor
 * through the crew harness.
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { LeftoverPrograms, openSuccessor } from "../tasks/leftoverPrograms";
import { legacyStateOf, seedTask } from "../tasks/seedTask";
import { readStops, taskStopsCommand } from "../tasks/taskStops";

fakeCrewTimersEachTest();

describe("the close's sweep of leftover programs", () => {
  it("begins after the record closes and holds the working copy until it settles", async () => {
    const crewmate = fakeCrewmate();
    let finishSweep = () => {};
    const sweep = new Promise<void>((resolve) => {
      finishSweep = resolve;
    });
    const statusAtBegin: string[] = [];
    const leftovers = {
      begin: vi.fn((taskId: string, _after?: Promise<unknown>) => {
        statusAtBegin.push(String(harness.tasks.get(taskId)?.status));
        return sweep;
      }),
      settled: vi.fn(() => sweep),
    };
    const harness = setup(crewmate, { leftovers });
    const { supervisor, tasks, workspace } = harness;
    const { taskId } = await supervisor.intake.commission({
      title: "boot a scratch machine",
      intent: intentOf("check the installer on a scratch machine"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");

    const discarded = supervisor.settling.settle.settleTask(taskId, "discard");
    await vi.waitFor(() => expect(leftovers.begin).toHaveBeenCalledWith(taskId, expect.anything()));
    // The record closed before the sweep began, so no new work reaches the task.
    expect(statusAtBegin).toEqual(["dropped"]);
    await tick();
    // The working copy stays while the stops and holders are still being handled.
    expect(workspace.removeTaskWorktree).not.toHaveBeenCalled();

    finishSweep();
    expect(await discarded).toBe("Discarded.");
    expect(workspace.removeTaskWorktree).toHaveBeenCalledWith(expect.objectContaining({ taskId }));
    expect(leftovers.begin).toHaveBeenCalledTimes(1);
  });

  it("hands a retried attempt's stops to its open retry, and begins the retry's own sweep when it is dropped unstarted", async () => {
    const begun: string[] = [];
    let sweeps: LeftoverPrograms | undefined;
    let previousId = "";
    const harness = setup(fakeCrewmate(), {
      leftovers: {
        // The earlier attempt's sweep is the real one: it only hands over,
        // so nothing is run here. The retry's is only recorded.
        begin: (taskId, after) => {
          begun.push(taskId);
          return taskId === previousId && sweeps ? sweeps.begin(taskId, after) : Promise.resolve();
        },
        settled: (taskId) => sweeps?.settled(taskId) ?? Promise.resolve(),
      },
    });
    const { supervisor, tasks, paths } = harness;
    sweeps = new LeftoverPrograms({ crewmatesDir: paths.crewmatesDir, tasks });
    const previous = seedTask(tasks, {
      id: "attempt1",
      title: "Check the installer on a scratch machine",
      status: "idle",
      worktreeDir: join(paths.worktreesDir, "attempt1"),
    });
    previousId = previous.id;
    taskStopsCommand(join(paths.crewmatesDir, previous.id), () => 0).add({
      label: "scratch macOS machine",
      command: "tart stop inf-scratch && tart delete inf-scratch",
    });

    const retry = await supervisor.intake.commission({
      title: "Check the installer again",
      intent: intentOf("check the installer with a stronger model"),
      shape: { escalate_from: previous.key },
      startAfter: { at: Date.UTC(2031, 0, 2) },
    });
    await tick();
    expect(tasks.get(previous.id)).toMatchObject({ status: "dropped", closedReason: "superseded" });
    await sweeps.settled(previous.id);
    expect(begun).toEqual([previous.id]);
    const key = tasks.get(retry.taskId)?.key;
    expect(readStops(join(paths.crewmatesDir, previous.id)).stops).toEqual([]);
    expect(
      readStops(join(paths.crewmatesDir, retry.taskId)).stops.map((stop) => stop.label),
    ).toEqual(["scratch macOS machine"]);
    expect(tasks.timeline(previous.id).map((event) => event.text)).toContain(
      `Leftovers at close: its stop went to ${key}.`,
    );

    // Dropped before it ever started, the retry's own close sweeps, and it
    // no longer counts as carrying the work on.
    supervisor.intake.dropTask(retry.taskId, { reason: "changed course", confirm: true });
    await tick();
    expect(tasks.get(retry.taskId)?.status).toBe("dropped");
    expect(begun).toEqual([previous.id, retry.taskId]);
    const closedPrevious = tasks.get(previous.id);
    expect(closedPrevious && openSuccessor(tasks, closedPrevious)).toBeUndefined();
  });
});
