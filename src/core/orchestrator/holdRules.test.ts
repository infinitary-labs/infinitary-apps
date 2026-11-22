/**
 * A started task's hold that an event ends sooner (INF-5145 part 2, the
 * captain's "Approve and build"; docs/automation.md "A rule that ends a
 * hold"): the first mate's update_task hold with on_event makes a one-run
 * Automation rule tied to the task, whose run ends the hold on its own with
 * what arrived, and the rule goes with whatever ends the hold first.
 * Each case drives a real CrewSupervisor through the crew harness, the real
 * update_task tool, a real Scheduler over a migrated store, and the app's
 * own task events as the event source.
 */

import { describe, expect, it, vi } from "vitest";
import { endTurn, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import { freshDatabase } from "../../../tests/helpers/database";
import {
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
} from "../../../tests/helpers/idleLadderHarness";
import { createTaskTools } from "../pi/taskTools";
import { piToolsOf } from "../pi/toolSpec";
import { ScheduleStore } from "../storage/scheduleStore";
import { seedTask } from "../tasks/seedTask";
import type { TaskService } from "../tasks/taskService";
import type { CrewSupervisor } from "./crewSupervisor";
import { type FirstmateTaskToolsHost, firstmateTaskTools } from "./firstmateTaskTools";
import { Scheduler } from "./scheduler";
import { lookOnClose, TASK_CLOSED_EVENT, TASK_EVENTS_ID, withTaskEvents } from "./taskEvents";

fakeCrewTimersEachTest();

/** The first mate's real update_task over this harness's supervisor and record. */
function firstmateUpdateTask(harness: { supervisor: CrewSupervisor; tasks: TaskService }) {
  const delegate = firstmateTaskTools({
    options: { supervisor: harness.supervisor, tasks: harness.tasks },
    turn: { replyFacts: {}, origin: "captain-turn" },
    asks: { attach: () => {} },
    noteDelivery: () => {},
  } as unknown as FirstmateTaskToolsHost);
  const tool = piToolsOf(createTaskTools(delegate)).find(
    (entry) => entry.name === "update_task",
  ) as unknown as {
    execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
  };
  return async (params: unknown) => (await tool.execute("hold", params)).content[0]?.text;
}

describe("a hold an event ends sooner (INF-5145 part 2)", () => {
  const { clock, hostClock, stopped } = idleLadderHarness();
  const reason = "the Windows run installing the alpha";

  /** A stopped crewmate, the run it waits on as another task, and Automation bound as at home. */
  async function heldOnEvent() {
    const harness = await stopped();
    const { supervisor, tasks } = harness;
    const run = seedTask(tasks, {
      id: "windows-run",
      title: "Run the alpha on Windows",
      status: "running",
    });
    const notify = vi.fn();
    const scheduler = new Scheduler({
      store: new ScheduleStore(freshDatabase()),
      notify,
      broadcastEvent: () => {},
      now: hostClock,
      events: withTaskEvents(tasks),
      endHold: (taskId, ruleId, events) => supervisor.holdRules.ran(taskId, ruleId, events),
    });
    supervisor.holdRules.bindRules(scheduler);
    lookOnClose(tasks, scheduler);
    const update = firstmateUpdateTask(harness);
    const onEvent = {
      integration: TASK_EVENTS_ID,
      event: TASK_CLOSED_EVENT,
      filter: { task: run.key || run.id },
    };
    const until = harness.idleSince + minutes(6 * 60);
    /** The task's rules that can still run. */
    const waiting = () =>
      scheduler
        .rules()
        .filter((rule) => rule.task === harness.taskId && rule.state !== "completed");
    /** The run's task closes, and the rules waiting for it look at once. */
    const closeRun = async () => {
      tasks.close(run.id, { status: "done", reason: "finished", actor: "host" });
      await scheduler.settled();
      await settle();
    };
    return { ...harness, run, scheduler, notify, update, onEvent, until, waiting, closeRun };
  }

  it("the event ends the hold once, on its own, telling the crewmate what arrived", async () => {
    const h = await heldOnEvent();
    const text = await h.update({
      task: h.taskId,
      hold: { until: new Date(h.until).toISOString(), reason, on_event: h.onEvent },
    });
    expect(text).toContain("Held");
    expect(text).toContain("ends it sooner");
    const [rule] = h.waiting();
    // One rule, tied to the task, turned on without the captain: it runs once.
    expect(rule).toMatchObject({ state: "enabled", task: h.taskId, spec: { kind: "event" } });
    expect(h.tasks.get(h.taskId)?.gate).toMatchObject({
      kind: "at-time",
      until: h.until,
      reason,
      ref: rule?.id,
    });

    const prompts = h.crewmate.promptCalls.length;
    for (const rung of [10, 20, 50, 80]) {
      await h.at(minutes(rung));
      await h.supervisor.watch.sweepGates(clock.now);
      await settle();
    }
    expect(h.crewmate.promptCalls).toHaveLength(prompts);
    expect(idleWakes(h.ops)).toEqual([]);

    await h.closeRun();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toContain(
      `The event this task was waiting for came (${reason}):`,
    );
    expect(h.crewmate.promptCalls.at(-1)).toContain(`${h.run.key} Run the alpha on Windows closed`);
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    // The first mate heard nothing: the run ended the hold itself.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.waiting()).toEqual([]);
    expect(h.scheduler.rules().find((entry) => entry.id === rule?.id)?.state).toBe("completed");
    expect(h.scheduler.history(rule?.id ?? "")[0]).toMatchObject({ tasks: [h.taskId] });

    // Its time brings nothing more: the hold is already over.
    await endTurn(h.crewmate, h.taskId, "The run finished; carrying on.");
    clock.now = h.until + minutes(1);
    await h.supervisor.watch.sweepGates(clock.now);
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
  });

  it.each([
    [
      "lifted",
      async (h: Awaited<ReturnType<typeof heldOnEvent>>) =>
        h.update({ task: h.taskId, hold: null }),
    ],
    [
      "a turn",
      async (h: Awaited<ReturnType<typeof heldOnEvent>>) => {
        await h.supervisor.steer.steerCrewmate(h.taskId, "the run printed a warning; look at it");
        await settle();
        await endTurn(h.crewmate, h.taskId, "The warning is harmless.");
      },
    ],
    [
      "its time",
      async (h: Awaited<ReturnType<typeof heldOnEvent>>) => {
        clock.now = h.until + minutes(1);
        await h.supervisor.watch.sweepGates(clock.now);
        await settle();
        await endTurn(h.crewmate, h.taskId, "Still waiting on the run.");
      },
    ],
    [
      "a new hold",
      async (h: Awaited<ReturnType<typeof heldOnEvent>>) =>
        h.update({
          task: h.taskId,
          hold: { until: new Date(h.until).toISOString(), reason: "the logs" },
        }),
    ],
    [
      "the task's close",
      async (h: Awaited<ReturnType<typeof heldOnEvent>>) =>
        h.tasks.close(h.taskId, { status: "dropped", reason: "cancelled", actor: "captain" }),
    ],
  ])("the rule goes when %s ends the hold, and the event then ends nothing", async (_end, end) => {
    const h = await heldOnEvent();
    await h.update({
      task: h.taskId,
      hold: { until: new Date(h.until).toISOString(), reason, on_event: h.onEvent },
    });
    expect(h.waiting()).toHaveLength(1);
    await end(h);
    expect(h.waiting()).toEqual([]);
    const prompts = h.crewmate.promptCalls.length;
    const gate = h.tasks.get(h.taskId)?.gate ?? null;
    await h.closeRun();
    expect(h.crewmate.promptCalls).toHaveLength(prompts);
    expect(h.tasks.get(h.taskId)?.gate ?? null).toEqual(gate);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a hold refused, or on an event nothing tells, makes no rule and writes no gate", async () => {
    const h = await heldOnEvent();
    const at = new Date(h.until).toISOString();
    expect(
      await h.update({
        task: h.taskId,
        hold: { until: at, reason, on_event: { integration: "github", event: "nothing-like-it" } },
      }),
    ).toContain("Nothing connected tells");
    expect(
      await h.update({
        task: h.taskId,
        hold: { until: at, reason, on_event: { ...h.onEvent, filter: { task: "NOPE-1" } } },
      }),
    ).toContain('No task is named "NOPE-1"');
    h.tasks.starts.setQueued(h.taskId, "unqueue-task", { actor: "captain" });
    expect(
      await h.update({ task: h.taskId, hold: { until: at, reason, on_event: h.onEvent } }),
    ).toContain("is in the backlog");
    expect(h.scheduler.rules()).toEqual([]);
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
  });

  it("a hold with no event makes no rule", async () => {
    const h = await heldOnEvent();
    expect(
      await h.update({ task: h.taskId, hold: { until: new Date(h.until).toISOString(), reason } }),
    ).toContain("Held");
    expect(h.scheduler.rules()).toEqual([]);
    expect(h.tasks.get(h.taskId)?.gate).toEqual({ kind: "at-time", until: h.until, reason });
  });
});

// INF-5578 finding 4: three tasks stood still for hours after the app update
// their hold waited for was installed, since nothing but its time, an outside
// event or a turn could end it. A hold names the update, and its install ends it.
describe("a hold an app update ends (INF-5578 finding 4)", () => {
  const { clock, stopped } = idleLadderHarness();
  const reason = "an app build carrying the story fix, installed where stories are prepared";

  async function heldForUpdate() {
    const harness = await stopped();
    const update = firstmateUpdateTask(harness);
    const until = new Date(harness.idleSince + minutes(23 * 60)).toISOString();
    return { ...harness, update, until };
  }

  it("ends once, with one steer, when its computer runs a newer app, and not before", async () => {
    const h = await heldForUpdate();
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.6");
    const text = await h.update({
      task: h.taskId,
      hold: { until: h.until, reason, on_update: {} },
    });
    expect(text).toContain("Held");
    expect(text).toContain("newer than 0.8.5-alpha.6");
    expect(h.tasks.get(h.taskId)?.gate).toMatchObject({
      kind: "at-time",
      reason,
      update: { device: null, from: "0.8.5-alpha.6" },
    });

    const prompts = h.crewmate.promptCalls.length;
    // The same version again, or another computer's update, ends nothing.
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.6");
    h.supervisor.holdRules.appRan("mac-mini", "0.8.5-alpha.7");
    await h.at(minutes(60));
    await h.supervisor.watch.sweepGates(clock.now);
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts);
    expect(h.tasks.get(h.taskId)?.gate?.update).toBeDefined();

    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.7");
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toContain(
      `The event this task was waiting for came (${reason}):`,
    );
    expect(h.crewmate.promptCalls.at(-1)).toContain("Infinitary 0.8.5-alpha.7 is installed");
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    await endTurn(h.crewmate, h.taskId, "The refusal is gone; showing the merge card.");
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.8");
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
  });

  it("waits for the version it names, past any earlier update", async () => {
    const h = await heldForUpdate();
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.6");
    await h.update({
      task: h.taskId,
      hold: { until: h.until, reason, on_update: { version: "0.8.5-alpha.8" } },
    });
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.7");
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts);
    h.supervisor.holdRules.appRan(null, "0.8.5");
    await settle();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
  });

  it("refuses a hold no update could end, and writes nothing", async () => {
    const h = await heldForUpdate();
    expect(
      await h.update({ task: h.taskId, hold: { until: h.until, reason, on_update: {} } }),
    ).toContain("is not known now");
    h.supervisor.holdRules.appRan(null, "0.8.5-alpha.7");
    expect(
      await h.update({
        task: h.taskId,
        hold: { until: h.until, reason, on_update: { version: "0.8.5-alpha.7" } },
      }),
    ).toContain("already runs 0.8.5-alpha.7");
    expect(
      await h.update({
        task: h.taskId,
        hold: { until: h.until, reason, on_update: { version: "the next alpha" } },
      }),
    ).toContain("is not one");
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
  });
});
