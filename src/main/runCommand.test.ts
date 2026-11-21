import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { RUN_AGENT_ENV } from "@core/helper/background";
import { RUN_STOP_FOR_FILE } from "@core/helper/windowsTask";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  askLoginShellEarly,
  followInstalledProgram,
  keepsStarterBesideGrant,
  lockHolder,
  markRunning,
  ownedRun,
  ownedRunOf,
  programIdentity,
  runCommand,
  runningByCommand,
  runOptions,
  stopRunningCommand,
} from "./runCommand";
import { startedByAgent, takeRunAgentMark } from "./runEnvironment";
import { readRunStatus } from "./runStatus";

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

  // The review of INF-5409: Windows' Task Scheduler sets no variable, so this app's own task names
  // its agent with a word, which a run reads as the mark the variable carries elsewhere.
  it("takes --agent and its label, which this app's own task writes after its settings", () => {
    expect(runOptions(["--agent", "com.infinitary.app.run"])).toEqual({
      agent: "com.infinitary.app.run",
    });
    expect(runOptions(["--settings", "a.json", "--agent", "com.infinitary.app.run"])).toEqual({
      settings: "a.json",
      agent: "com.infinitary.app.run",
    });
    expect(runOptions(["--agent"])).toBeNull();
    expect(runOptions(["--agent", "a", "--agent", "b"])).toBeNull();
  });

  // INF-4680's start cuts: a run asks the person's login shell while the
  // app's code loads, never one a settings file replaces or a refused run.
  it("asks the login shell early only for a run that will ask it", () => {
    const ask = vi.fn();
    expect(askLoginShellEarly([], ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(askLoginShellEarly(["--settings", "/Users/fm/infinitary.json"], ask)).toBe(false);
    expect(askLoginShellEarly(["now"], ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
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
    const targets: unknown[] = [];
    const signal = (pid: number, only?: unknown) => {
      signalled.push(pid);
      targets.push(only);
    };
    expect(stopRunningCommand(dataDir, () => true, signal)).toBe(false);
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"));
    symlinkSync(`${hostname()}-4242`, join(dataDir, "SingletonLock"));
    expect(stopRunningCommand(dataDir, (pid) => pid === 4242, signal)).toBe(true);
    expect(signalled).toEqual([4242]);
    // Stop names no run, so on Windows it is asked of whichever runs there, an earlier version's too.
    expect(targets).toEqual([undefined]);
    expect(stopRunningCommand(dataDir, () => false, signal)).toBe(false);
    expect(signalled).toEqual([4242]);
  });

  // The review of INF-4930: a window reopened while a grant waits in the work folder keeps its
  // starter, and follows along stopping the command, only beside the command its own agent started.
  it("keeps its starter beside a grant only while the command running is its own agent's", () => {
    const label = "com.infinitary.app.run";
    const runs = (agent: boolean) => {
      const dataDir = scratchDir("infinitary-run-marker-");
      markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, agent);
      symlinkSync(`${hostname()}-4242`, join(dataDir, "SingletonLock"));
      return dataDir;
    };
    const alive = (pid: number) => pid === 4242;
    // The agent's own definition marks the runs it starts with its label (`runAgentEnv`), and
    // Windows' task with its `--agent` word; a terminal's run carries no mark, or another agent's.
    const env: NodeJS.ProcessEnv = { [RUN_AGENT_ENV]: label, PATH: "/usr/bin" };
    const byAgent = startedByAgent({ mark: takeRunAgentMark(env), label });
    const byHand = startedByAgent({ mark: undefined, label });
    expect([byAgent, byHand]).toEqual([true, false]);
    expect(startedByAgent({ mark: undefined, word: label, label })).toBe(true);
    expect(startedByAgent({ mark: "com.infinitary.app.dev.run", label })).toBe(false);
    // The review of INF-5409: the run takes the mark as it starts, so a run started from inside
    // it - a crewmate's shell, with the environment every program it starts inherits - is not its
    // agent's.
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(startedByAgent({ mark: takeRunAgentMark({ ...env }), label })).toBe(false);
    expect(keepsStarterBesideGrant(runs(byAgent), true, alive)).toBe(true);
    expect(keepsStarterBesideGrant(runs(byHand), true, alive)).toBe(false);
    // With no grant waiting, the window keeps its starter as it always has.
    expect(keepsStarterBesideGrant(runs(byHand), false, alive)).toBe(true);
    // The review of INF-5409: with no command running, a grant waiting leaves the starter too,
    // so a home that keeps its own first mate still starts it in the background.
    expect(keepsStarterBesideGrant(runs(byHand), true, () => false)).toBe(true);
    expect(keepsStarterBesideGrant(scratchDir("infinitary-run-none-"), true, alive)).toBe(true);
  });

  // The review of INF-5409: joining and following along stop only the run this window's starter
  // owns, the one its own agent started as that run's note says, by its process and start; never
  // a run started by hand, whatever process number it has.
  it("owns only the run its agent started, and stops only that run", () => {
    const dataDir = scratchDir("infinitary-run-marker-");
    const running = new Set([4242]);
    const alive = (pid: number) => running.has(pid);
    const holds = (pid: number) => {
      rmSync(join(dataDir, "SingletonLock"), { force: true });
      symlinkSync(`${hostname()}-${pid}`, join(dataDir, "SingletonLock"));
    };
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true);
    holds(4242);
    const owned = ownedRun(dataDir, alive);
    expect(owned).toEqual({ pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" });
    // The window reads the same from one reading of the records (the review of INF-5409).
    expect(ownedRunOf(readRunStatus(dataDir, alive))).toEqual(owned);
    // It ended, and the person started one by hand on the same folder.
    running.clear();
    running.add(5151);
    markRunning(dataDir, 5151, new Date("2026-10-25T17:05:00Z"));
    holds(5151);
    expect(ownedRun(dataDir, alive)).toBeNull();
    expect(ownedRunOf(readRunStatus(dataDir, alive))).toBeNull();
    // A stop for the run it followed along from signals nothing to the one that replaced it.
    const signalled: number[] = [];
    const signal = (pid: number) => void signalled.push(pid);
    expect(stopRunningCommand(dataDir, alive, signal, owned ?? undefined)).toBe(false);
    // Nor to one by hand that came back with the same process number.
    running.add(4242);
    markRunning(dataDir, 4242, new Date("2026-10-25T17:06:00Z"));
    holds(4242);
    expect(ownedRun(dataDir, alive)).toBeNull();
    expect(stopRunningCommand(dataDir, alive, signal, owned ?? undefined)).toBe(false);
    expect(signalled).toEqual([]);
    // The run it owns stops, asked by that run's process and start.
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true);
    const targets: unknown[] = [];
    expect(
      stopRunningCommand(
        dataDir,
        alive,
        (pid, only) => {
          signal(pid);
          targets.push(only);
        },
        owned ?? undefined,
      ),
    ).toBe(true);
    expect(signalled).toEqual([4242]);
    expect(targets).toEqual([owned]);
  });

  // The review of INF-5409: a stop for one run alone is asked through the folder by that run's
  // process and start, on every computer, and no signal goes to its process number, which another
  // program may have taken by the time it arrives; only that run reads the ask as its own.
  it("asks a stop for one run through its folder, by its process and start, sending no signal", () => {
    const dataDir = scratchDir("infinitary-run-marker-");
    const alive = (pid: number) => pid === 4242;
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true);
    symlinkSync(`${hostname()}-4242`, join(dataDir, "SingletonLock"));
    const owned = ownedRun(dataDir, alive);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(stopRunningCommand(dataDir, alive, undefined, owned ?? undefined)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
    expect(JSON.parse(readFileSync(join(dataDir, RUN_STOP_FOR_FILE), "utf8"))).toMatchObject({
      pid: 4242,
      startedAt: "2026-10-25T17:00:00.000Z",
    });
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

// INF-4243's plan, piece 5: the window starts the run on Windows as on Mac and Linux, so it reads
// Chromium's lock there, a file held open for writing rather than a link naming its process.
describe("Chromium's lock on Windows", () => {
  it("reads the folder free with no lock file or one no program holds, and held when it cannot be written", () => {
    const dataDir = scratchDir("infinitary-windows-lock-");
    expect(lockHolder(dataDir, "win32")).toBeNull();
    writeFileSync(join(dataDir, "lockfile"), "");
    expect(lockHolder(dataDir, "win32")).toBeNull();
    // A file this test may not write stands in for one Chromium holds.
    const held = scratchDir("infinitary-windows-lock-");
    writeFileSync(join(held, "lockfile"), "", { mode: 0o444 });
    expect(lockHolder(held, "win32")).toBeUndefined();
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
