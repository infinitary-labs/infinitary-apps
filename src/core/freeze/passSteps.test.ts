import { describe, expect, it } from "vitest";
import { TICK_PERIOD_MS, Ticker } from "../orchestrator/ticker";
import { PassSteps, type PassTiming, type StepMark } from "./passSteps";

// The captain's pick on INF-4076: "Start timing each minute-pass step" - time
// each step of the once-a-minute pass, including the work each step sets off,
// and tag each stall with the step that was running.

function manualClock() {
  const clock = { at: 1_000, cpu: 0 };
  return {
    clock,
    spend(ms: number, cpuMs = ms) {
      clock.at += ms;
      clock.cpu += cpuMs * 1000;
    },
    steps: new PassSteps({
      now: () => clock.at,
      wall: () => Date.UTC(2026, 10, 13, 12, 0, 6, 700) + clock.at,
      cpuMicros: () => clock.cpu,
    }),
  };
}

describe("the minute pass's steps", () => {
  it("times each pass, the work it sets off and the sweep's release, and marks what was running", async () => {
    const { steps, spend } = manualClock();
    const marks: StepMark[] = [];
    const passes: PassTiming[] = [];
    steps.listen({ mark: (mark) => marks.push(mark), pass: (pass) => passes.push(pass) });
    let finishReads: () => void = () => {};
    const ticker = new Ticker({
      steps,
      sweep: () => () => spend(3),
      betweenPasses: () => new Promise((resolve) => setImmediate(resolve)),
    });
    ticker.register("idle-ladder", TICK_PERIOD_MS, () => spend(12, 9));
    ticker.register("check-watch", TICK_PERIOD_MS, () => {
      spend(2);
      return new Promise<void>((done) => {
        finishReads = () => {
          spend(40);
          done();
        };
      });
    });

    await ticker.tickInTurns();
    // The board's push runs in its own turn after the pass, and is a step too.
    steps.run("board-push", () => spend(70, 65));
    finishReads();
    await new Promise((resolve) => setImmediate(resolve));
    await ticker.tickInTurns();

    expect(marks).toEqual([
      { running: "idle-ladder", unsettled: [] },
      { running: null, unsettled: [] },
      { running: "check-watch", unsettled: [] },
      { running: null, unsettled: [] },
      { running: null, unsettled: ["check-watch"] },
      { running: "sweep-release", unsettled: ["check-watch"] },
      { running: null, unsettled: ["check-watch"] },
      { running: "board-push", unsettled: ["check-watch"] },
      { running: null, unsettled: ["check-watch"] },
      { running: null, unsettled: [] },
      { running: "idle-ladder", unsettled: [] },
      { running: null, unsettled: [] },
      { running: "check-watch", unsettled: [] },
      { running: null, unsettled: [] },
      { running: null, unsettled: ["check-watch"] },
      { running: "sweep-release", unsettled: ["check-watch"] },
      { running: null, unsettled: ["check-watch"] },
    ]);
    expect(passes).toEqual([
      {
        at: "2026-11-13T12:00:07.700Z",
        steps: [
          { name: "idle-ladder", startMs: 0, syncMs: 12, cpuMs: 9 },
          { name: "check-watch", startMs: 12, syncMs: 2, cpuMs: 2, workMs: 115 },
          { name: "sweep-release", startMs: 14, syncMs: 3, cpuMs: 3 },
          { name: "board-push", startMs: 17, syncMs: 70, cpuMs: 65 },
        ],
      },
    ]);
  });

  it("hands over a step whose work has not settled by the next pass as unsettled", () => {
    const { steps, spend } = manualClock();
    const passes: PassTiming[] = [];
    steps.listen({ mark: () => {}, pass: (pass) => passes.push(pass) });
    steps.passStarted();
    steps.run("gate-sweep", () => {
      spend(1);
      return new Promise<void>(() => {});
    });
    steps.passStarted();

    expect(passes[0]?.steps).toEqual([
      { name: "gate-sweep", startMs: 0, syncMs: 1, cpuMs: 1, unsettled: true },
    ]);
  });

  it("only runs a step, and returns what it returned, with no recorder listening", () => {
    const { steps, spend } = manualClock();
    const work = Promise.resolve("read");
    expect(steps.run("check-watch", () => work)).toBe(work);

    const marks: StepMark[] = [];
    const detach = steps.listen({ mark: (mark) => marks.push(mark), pass: () => {} });
    detach();
    steps.passStarted();
    steps.run("idle-ladder", () => spend(5));
    expect(marks).toEqual([]);
  });

  it("still throws a step's error, and passes the rest of the tick on, while timed", () => {
    const { steps } = manualClock();
    const marks: StepMark[] = [];
    steps.listen({ mark: (mark) => marks.push(mark), pass: () => {} });
    const broke = new Error("failed sweep");
    const ticker = new Ticker({ steps });
    const order: string[] = [];
    ticker.register("quiet-turns", TICK_PERIOD_MS, () => {
      order.push("quiet-turns");
      throw broke;
    });
    ticker.register("idle-ladder", TICK_PERIOD_MS, () => order.push("idle-ladder"));

    expect(() => ticker.tick()).toThrow(broke);
    expect(order).toEqual(["quiet-turns", "idle-ladder"]);
    expect(marks.at(-1)).toEqual({ running: null, unsettled: [] });
  });
});
