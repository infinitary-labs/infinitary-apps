import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { type LaunchRecord, SettingsStore } from "../storage/settingsStore";
import { EARLY_LAUNCH_MS, LaunchWatch, SAFE_MODE_AFTER_CRASHES } from "./safeMode";

/**
 * Safe-mode boot (talk-to-personalize Step 5): the crash-looping fixture,
 * driven over the real settings row the app uses. A "crash" here is what a
 * crash actually leaves behind - a launch that wrote its marker and never
 * settled - which is the only evidence the next launch has.
 */
function store() {
  const settings = new SettingsStore(openInMemoryDatabase());
  return {
    settings,
    options: {
      read: () => settings.getLaunchRecord(),
      write: (record: LaunchRecord) => settings.setLaunchRecord(record),
    },
  };
}

/** One launch that dies before settling: begin, then nothing. */
function crash(options: ReturnType<typeof store>["options"]): void {
  new LaunchWatch({ ...options, schedule: () => () => {} }).begin();
}

describe("LaunchWatch", () => {
  it("comes up in safe mode after two launches that never settled, and not before", () => {
    const { settings, options } = store();
    const scheduled: { run: () => void; ms: number }[] = [];
    const schedule = (run: () => void, ms: number) => {
      scheduled.push({ run, ms });
      return () => {};
    };

    // A first, clean launch on a fresh install: nothing pending, nothing counted.
    const first = new LaunchWatch({ ...options, schedule }).begin();
    expect(first).toEqual({ earlyCrashes: 0, safeMode: false });
    expect(settings.getLaunchRecord()).toEqual({ pending: true, earlyCrashes: 0 });
    expect(scheduled[0]?.ms).toBe(EARLY_LAUNCH_MS);

    // It dies. The next launch counts one, and one is not enough.
    const second = new LaunchWatch({ ...options, schedule }).begin();
    expect(second).toEqual({ earlyCrashes: 1, safeMode: false });

    // It dies again. The third counts two, which is the threshold.
    const third = new LaunchWatch({ ...options, schedule }).begin();
    expect(third).toEqual({ earlyCrashes: SAFE_MODE_AFTER_CRASHES, safeMode: true });
    // Safe mode starts the count over: the panels are off now, so a crash
    // after this one is about something else and must not compound.
    expect(settings.getLaunchRecord()).toEqual({ pending: true, earlyCrashes: 0 });
  });

  it("a launch that stays up long enough clears the count, so one bad crash never accumulates", () => {
    const { settings, options } = store();
    crash(options);
    let settle = () => {};
    const watch = new LaunchWatch({
      ...options,
      schedule: (run) => {
        settle = run;
        return () => {};
      },
    });
    expect(watch.begin()).toEqual({ earlyCrashes: 1, safeMode: false });
    settle();
    expect(settings.getLaunchRecord()).toEqual({ pending: false, earlyCrashes: 0 });
    // The launch after a good one starts clean, whatever came before it.
    expect(new LaunchWatch({ ...options, schedule: () => () => {} }).begin()).toEqual({
      earlyCrashes: 0,
      safeMode: false,
    });
  });

  it("a clean quit is not a crash, however early it comes", () => {
    const { settings, options } = store();
    crash(options);
    const watch = new LaunchWatch({ ...options, schedule: () => () => {} });
    expect(watch.begin().earlyCrashes).toBe(1);
    watch.dispose();
    expect(settings.getLaunchRecord()).toEqual({ pending: false, earlyCrashes: 0 });
    expect(new LaunchWatch({ ...options, schedule: () => () => {} }).begin().safeMode).toBe(false);
  });

  it("logs a launch-record write failure instead of crashing", () => {
    const logs: string[] = [];
    const watch = new LaunchWatch({
      read: () => ({ pending: false, earlyCrashes: 0 }),
      write: () => {
        throw new Error("database unavailable");
      },
      log: (message) => logs.push(message),
      schedule: () => () => {},
    });

    expect(() => watch.begin()).not.toThrow();
    expect(() => watch.dispose()).not.toThrow();
    expect(logs).toEqual([
      "launch record write failed: database unavailable",
      "launch record write failed: database unavailable",
    ]);
  });
});
