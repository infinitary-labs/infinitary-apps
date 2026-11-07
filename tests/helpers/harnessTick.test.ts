/**
 * The crew and first mate harnesses' `tick()` never waits on the real clock
 * (docs/test-cohorts.md, "The fence"): on fake timers it moves them by its
 * step, and on real timers it refuses rather than sleep.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick as crewTick } from "./crewHarness";
import { tick as firstmateTick } from "./firstmateHarness";

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  { harness: "crew", tick: crewTick, step: 80, fakes: "fakeCrewTimersEachTest()" },
  { harness: "first mate", tick: firstmateTick, step: 100, fakes: "fakeClockEachTest()" },
])("the $harness harness's tick", ({ tick, step, fakes }) => {
  it("moves the fake clock by its step and fires only the timers due", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const start = Date.now();
    const fired: string[] = [];
    setTimeout(() => fired.push("due"), step);
    setTimeout(() => fired.push("after"), step + 1);
    await tick();
    expect(Date.now() - start).toBe(step);
    expect(fired).toEqual(["due"]);
  });

  it("refuses to run on real timers and names the fake clock to call", async () => {
    vi.useRealTimers();
    await expect(tick()).rejects.toThrow(fakes);
  });
});
