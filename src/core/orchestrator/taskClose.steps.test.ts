/**
 * A task's close runs its parts as named steps (docs/freeze-recorder.md,
 * "A task's close"). The app's freeze record held three task closes of 589
 * to 735 ms whose slow part no capture named; each part of the close now
 * marks the stall it is in and keeps its own time, so the record names the
 * part that held the main thread. Drives a real CrewSupervisor through the
 * crew harness, with the recorder's own step runner on a clock the test moves.
 */

import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { PassSteps, type PassTiming, type StepMark } from "../freeze/passSteps";
import { legacyStateOf } from "../tasks/seedTask";

fakeCrewTimersEachTest();

const CLOSE_PARTS = [
  "close-stop",
  "close-approvals",
  "close-record",
  "close-cards",
  "close-asks",
  "close-broadcast",
  "close-worktree",
  "close-children",
  "close-gates",
];

describe("a task's close, timed for the freeze recorder", () => {
  it("runs each part as a named step and keeps the time of the part that held the thread", async () => {
    const clock = { at: 1_000, cpu: 0 };
    const steps = new PassSteps({
      now: () => clock.at,
      wall: () => Date.UTC(2026, 10, 16, 12, 0, 0) + clock.at,
      cpuMicros: () => clock.cpu,
    });
    const marks: StepMark[] = [];
    const passes: PassTiming[] = [];
    steps.listen({ mark: (mark) => marks.push(mark), pass: (pass) => passes.push(pass) });
    const crewmate = fakeCrewmate();
    let slowJobs = 0;
    const { supervisor, tasks } = setup(crewmate, {
      step: (name, run) => steps.run(name, run),
      // The one slow part: the stop's first ending of the task's jobs
      // holds the thread 600 ms; the record's own ending later is quick.
      killJobs: () => {
        if (slowJobs-- <= 0) return;
        clock.at += 600;
        clock.cpu += 590_000;
      },
    });
    const { taskId } = await supervisor.intake.commission({
      title: "tidy the release notes",
      intent: intentOf("tidy the release notes"),
    });
    await tick();
    crewmate.finishPrompt();
    await tick();
    expect(legacyStateOf(tasks.get(taskId))).toBe("idle");

    steps.passStarted();
    slowJobs = 1;
    expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe("Discarded.");
    await tick();
    steps.passStarted();

    const timed = passes.at(-1)?.steps ?? [];
    expect(timed.map((timing) => timing.name)).toEqual(CLOSE_PARTS);
    expect(timed.find((timing) => timing.name === "close-stop")).toMatchObject({
      syncMs: 600,
      cpuMs: 590,
    });
    for (const timing of timed.filter((each) => each.name !== "close-stop")) {
      expect(timing.syncMs).toBe(0);
    }
    // A stall in any part is tagged with that part while it runs.
    const running = marks.map((mark) => mark.running).filter((name) => name !== null);
    expect([...new Set(running)]).toEqual(CLOSE_PARTS);
    expect(marks.at(-1)).toEqual({ running: null, unsettled: [] });
  });
});
