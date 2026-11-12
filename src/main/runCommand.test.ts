import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  followInstalledProgram,
  markRunning,
  programIdentity,
  runCommand,
  runningByCommand,
  runOptions,
  stopRunningCommand,
} from "./runCommand";

/**
 * Infinitary started by a command (docs/run.md; INF-1228's approved plan,
 * piece 1), and the window opened beside it, which joins it as a view
 * (INF-1352's plan, piece 6, the captain's answer window_joins=join).
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("starting the app by a command", () => {
  it("reads the words after run, packaged or not, and leaves the work mode's run to it", () => {
    expect(
      runCommand(["/Applications/Infinitary.app/Contents/MacOS/Infinitary", "run"], false),
    ).toEqual([]);
    expect(
      runCommand(["/opt/infinitary/infinitary", "--no-sandbox", "run", "--settings", "x"], false),
    ).toEqual(["--settings", "x"]);
    expect(runCommand(["/repo/node_modules/electron/Electron", "/repo", "run"], true)).toEqual([]);
    expect(
      runCommand(["/Applications/Infinitary.app/Contents/MacOS/Infinitary", "work", "run"], false),
    ).toBeNull();
    expect(
      runCommand(["/Applications/Infinitary.app/Contents/MacOS/Infinitary"], false),
    ).toBeNull();
    // The entry of an unpackaged run is never read as the word.
    expect(runCommand(["/electron", "run"], true)).toBeNull();
  });
});

describe("the words after run", () => {
  // INF-1228's approved plan, piece 4: "`--settings <file>` names a file of settings".
  it("takes nothing, or --settings and one file; any other words get the usage", () => {
    expect(runOptions([])).toEqual({});
    expect(runOptions(["--settings", "/Users/fm/infinitary.json"])).toEqual({
      settings: "/Users/fm/infinitary.json",
    });
    expect(runOptions(["--settings"])).toBeNull();
    expect(runOptions(["--settings", ""])).toBeNull();
    expect(runOptions(["--settings", "a.json", "b.json"])).toBeNull();
    expect(runOptions(["--setting", "a.json"])).toBeNull();
    expect(runOptions(["now"])).toBeNull();
  });
});

describe("a window opened beside a run", () => {
  it("knows a command runs the folder while its process holds Chromium's lock", () => {
    const dataDir = scratchDir("infinitary-run-marker-");
    const leave = markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"));
    symlinkSync(`${hostname()}-4242`, join(dataDir, "SingletonLock"));
    expect(runningByCommand(dataDir, (pid) => pid === 4242)).toBe(true);
    leave();
    expect(runningByCommand(dataDir, () => true)).toBe(false);
  });

  // INF-1352's plan, piece 7: "Quit closes only the window, and Settings → General offers
  // Stop", which signals the command as a terminal's stop does.
  it("stops the command that runs the folder, and signals nothing when none does", () => {
    const dataDir = scratchDir("infinitary-run-marker-");
    const signalled: number[] = [];
    const signal = (pid: number) => void signalled.push(pid);
    expect(stopRunningCommand(dataDir, () => true, signal)).toBe(false);
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"));
    symlinkSync(`${hostname()}-4242`, join(dataDir, "SingletonLock"));
    expect(stopRunningCommand(dataDir, (pid) => pid === 4242, signal)).toBe(true);
    expect(signalled).toEqual([4242]);
    expect(stopRunningCommand(dataDir, () => false, signal)).toBe(false);
    expect(signalled).toEqual([4242]);
  });

  it("reads a note a crashed run left as nothing running", () => {
    const dataDir = scratchDir("infinitary-run-marker-");
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"));
    // Its process is gone.
    expect(runningByCommand(dataDir, () => false)).toBe(false);
    // Its number is another process's now, which holds no lock here.
    expect(runningByCommand(dataDir, () => true)).toBe(false);
    // Or the window that holds the lock now.
    symlinkSync(`${hostname()}-5151`, join(dataDir, "SingletonLock"));
    expect(runningByCommand(dataDir, () => true)).toBe(false);
  });
});

describe("following the installed app", () => {
  it("sees the program's file replaced, as an update replaces the app", () => {
    const dir = scratchDir("infinitary-run-program-");
    const program = join(dir, "Infinitary");
    writeFileSync(program, "this version\n");
    const before = programIdentity(program);
    expect(programIdentity(program)).toBe(before);
    writeFileSync(join(dir, "Infinitary.new"), "the new version\n");
    renameSync(join(dir, "Infinitary.new"), program);
    expect(programIdentity(program)).not.toBe(before);
    expect(programIdentity(join(dir, "gone"))).toBeNull();
  });

  it("ends the run once the program is another, never while an update has it out of place", () => {
    vi.useFakeTimers();
    const readings = ["a", null, "a", "b"];
    const updated = vi.fn();
    followInstalledProgram({
      path: "/Applications/Infinitary.app/Contents/MacOS/Infinitary",
      every: 60_000,
      identity: () => (readings.length > 1 ? (readings.shift() ?? null) : (readings[0] ?? null)),
      updated,
    });
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(updated).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(updated).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180_000);
    expect(updated).toHaveBeenCalledTimes(1);
  });
});
