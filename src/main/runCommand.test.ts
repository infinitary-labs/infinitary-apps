import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { RUN_AGENT_ENV } from "@core/helper/background";
import { RUN_STOP_FOR_FILE } from "@core/helper/windowsTask";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { runEnd } from "./besideRun";
import {
  answerLaunch,
  askLoginShellEarly,
  commandHolding,
  followInstalledProgram,
  keepsStarterBesideGrant,
  lockHolder,
  lockHolderKind,
  markRunning,
  ownedRun,
  ownedRunOf,
  programIdentity,
  RUN_MARKER,
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
    const alive = (pid: number): boolean => pid === 4242;
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
    const holding = (dataDir: string, isAlive = alive) => commandHolding(dataDir, isAlive);
    expect(keepsStarterBesideGrant(holding(runs(byAgent)), true)).toBe(true);
    expect(keepsStarterBesideGrant(holding(runs(byHand)), true)).toBe(false);
    // With no grant waiting, the window keeps its starter as it always has.
    expect(keepsStarterBesideGrant(holding(runs(byHand)), false)).toBe(true);
    // The review of INF-5409: with no command running, a grant waiting leaves the starter too,
    // so a home that keeps its own first mate still starts it in the background.
    expect(
      keepsStarterBesideGrant(
        holding(runs(byHand), () => false),
        true,
      ),
    ).toBe(true);
    expect(keepsStarterBesideGrant(holding(scratchDir("infinitary-run-none-")), true)).toBe(true);
    // The review of INF-5409: the window opens beside a command and keeps its starter from one
    // reading, so a note that changes after it, either way, never splits the two.
    const owned = runs(byAgent);
    const before = holding(owned);
    writeFileSync(join(owned, RUN_MARKER), "not a note");
    expect([before.running, keepsStarterBesideGrant(before, true)]).toEqual([true, true]);
    const empty = scratchDir("infinitary-run-none-");
    const none = holding(empty);
    markRunning(empty, 4242, new Date("2026-10-25T17:00:00Z"), undefined, false);
    symlinkSync(`${hostname()}-4242`, join(empty, "SingletonLock"));
    expect([none.running, keepsStarterBesideGrant(none, true)]).toEqual([false, true]);
    // The review of INF-5409: on Windows, whose lock names no holder, an agent's run that ended
    // without taking its note away, its number taken since by another program while a window holds
    // the folder, is told by the birth its note keeps (stood in by a reading that says which birth
    // holds the number now): no command holds the folder, and none is the agent's. A note from an
    // earlier run keeps no birth and is read by its number alone, as before.
    const stale = scratchDir("infinitary-run-stale-");
    markRunning(stale, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true, "win:1");
    symlinkSync(`${hostname()}-4242`, join(stale, "SingletonLock"));
    const reused = (pid: number, birth?: string) => pid === 4242 && (!birth || birth === "win:2");
    expect(commandHolding(stale, reused)).toEqual({ running: false, owned: null });
    expect(commandHolding(stale, (pid, birth) => pid === 4242 && birth === "win:1")).toEqual({
      running: true,
      owned: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
    });
    const earlier = scratchDir("infinitary-run-earlier-");
    markRunning(earlier, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true);
    symlinkSync(`${hostname()}-4242`, join(earlier, "SingletonLock"));
    expect(commandHolding(earlier, reused).running).toBe(true);
  });

  // The review of INF-5409: the open window reads the run by the same identity its startup does.
  // On Windows a lock names no holder (stood in here by a lock link that cannot be read): an
  // agent's run that ended without taking its note away, its number taken since by another
  // program, is not that run, and a folder another process holds is unknown, so the window neither
  // joins as if nothing ran nor as the owner of that run, offers no stopped notice, and asks no
  // stop of it. The run whose birth matches is owned and stopped; an earlier note with no birth is
  // read by its number alone.
  it("reads a stale Windows run in the open window by its birth, as unknown beside another holder", () => {
    const stale = scratchDir("infinitary-run-stale-window-");
    markRunning(stale, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true, "win:1");
    writeFileSync(join(stale, "SingletonLock"), "held, naming no holder");
    expect(lockHolder(stale, "darwin")).toBeUndefined();
    const reused = (pid: number, birth?: string) => pid === 4242 && (!birth || birth === "win:2");
    const status = readRunStatus(stale, reused);
    expect(status.running).toBeNull();
    expect(ownedRunOf(status)).toBeNull();
    expect(runEnd(status, null)).toBeNull();
    const signalled: number[] = [];
    const owned = { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" };
    expect(stopRunningCommand(stale, reused, (pid) => void signalled.push(pid), owned)).toBe(false);
    expect(ownedRun(stale, reused)).toBeNull();
    expect(signalled).toEqual([]);
    const same = (pid: number, birth?: string) => pid === 4242 && birth === "win:1";
    expect(ownedRunOf(readRunStatus(stale, same))).toEqual(owned);
    expect(stopRunningCommand(stale, same, (pid) => void signalled.push(pid), owned)).toBe(true);
    expect(signalled).toEqual([4242]);
    const earlier = scratchDir("infinitary-run-earlier-window-");
    markRunning(earlier, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true);
    writeFileSync(join(earlier, "SingletonLock"), "held, naming no holder");
    expect(ownedRunOf(readRunStatus(earlier, reused))).toEqual(owned);
  });

  // The review of INF-5409: Start it here refused the lock reads who holds it from what the holder
  // shows of itself, never from silence: a run notes that it holds the folder, a window answers
  // the launch's ask, a holder that ends lets the lock go. One that shows none of these, as a run
  // stopped before it noted itself, is waited for however long that lasts, and the lock is asked
  // for again only once the holder its link names changes, so a window is not shown at every look;
  // a holder no link names, as Windows' own lock, is asked again after a while, with the same word.
  // The review of INF-5409: a window answers a Start it here launch's ask only once one of its
  // windows is there to take over. A Mac app kept working after its last window closed opens it
  // again and answers once it is made; an ask it already took brings nothing forward again, and an
  // answer that could not be written is written again later, with no window brought forward.
  it("answers a launch's ask only once a window is there, opening one again on a Mac", () => {
    const word = "0123456789abcdef";
    const made: (() => void)[] = [];
    const retries: (() => void)[] = [];
    let windows = 0;
    let writable = false;
    const seen = { forward: 0, answers: [] as string[] };
    const window = {
      asked: new Set<string>(),
      bringForward: () => {
        seen.forward += 1;
      },
      shown: () => windows > 0,
      whenMade: (then: () => void) => void made.push(then),
      answer: (asked: string) => writable && seen.answers.push(asked) > 0,
      later: (then: () => void) => void retries.push(then),
    };
    // Its last window closed: the launch's ask opens one again and waits for it.
    answerLaunch(word, window);
    expect(seen).toEqual({ forward: 1, answers: [] });
    // A hidden page made first is no window of its own: it keeps waiting.
    made.shift()?.();
    expect(seen.answers).toEqual([]);
    expect(made).toHaveLength(1);
    // The window is made, and its answer cannot be written yet: it is written again later.
    windows = 1;
    made.shift()?.();
    expect(seen).toEqual({ forward: 1, answers: [] });
    expect(retries).toHaveLength(1);
    // The launch asks again meanwhile: nothing comes forward, and nothing else is written.
    answerLaunch(word, window);
    expect(seen).toEqual({ forward: 1, answers: [] });
    expect(retries).toHaveLength(1);
    writable = true;
    retries.shift()?.();
    expect(seen).toEqual({ forward: 1, answers: [word] });
    expect(retries).toEqual([]);
    answerLaunch(word, window);
    expect(seen).toEqual({ forward: 1, answers: [word] });
    // A launch with no ask still brings the window forward.
    answerLaunch(null, window);
    expect(seen).toEqual({ forward: 2, answers: [word] });
  });

  it("tells a run, a window and a lock let go apart from what each shows, and waits on a silent holder", async () => {
    const look = (
      shown: { running?: () => boolean; answered?: () => boolean },
      named = true,
      reached: number | null | undefined = named ? 4242 : undefined,
    ) => {
      const asks: number[] = [];
      let holder: number | null | undefined = named ? 4242 : undefined;
      const kind = lockHolderKind({
        running: shown.running ?? (() => false),
        answered: shown.answered ?? (() => false),
        holder: () => holder,
        asked: reached,
        lockFree: () => {
          asks.push(Date.now());
          return holder === null;
        },
        askEveryMs: 100,
        everyMs: 20,
      });
      return { kind, asks, leave: () => (holder = null) };
    };
    let noted = false;
    setTimeout(() => (noted = true), 300);
    const run = look({ running: () => noted });
    expect(await run.kind).toBe("run");
    expect(run.asks).toEqual([]);

    let answered = false;
    setTimeout(() => (answered = true), 300);
    const window = look({ answered: () => answered });
    expect(await window.kind).toBe("window");
    expect(window.asks).toEqual([]);

    // Silent well past the wait between asks: a holder its link names unchanged is only watched,
    // asked nothing and never taken for a window.
    const silent = look({});
    let settled: string | null = null;
    void silent.kind.then((kind) => (settled = kind));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toBeNull();
    expect(silent.asks).toEqual([]);
    // The holder ends before noting anything: its link changes, the lock is asked for once and taken.
    silent.leave();
    expect(await silent.kind).toBe("free");
    expect(silent.asks).toHaveLength(1);

    // No link names the holder: the lock is asked for again after each wait until it is let go.
    const unnamed = look({}, false);
    let free = false;
    void unnamed.kind.then(() => (free = true));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(free).toBe(false);
    expect(unnamed.asks.length).toBeGreaterThanOrEqual(2);
    unnamed.leave();
    expect(await unnamed.kind).toBe("free");

    // The holder took the lock after the launch's own ask reached none: it is asked once, then
    // only watched.
    const later = look({}, true, null);
    let late: string | null = null;
    void later.kind.then((kind) => (late = kind));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(late).toBeNull();
    expect(later.asks).toHaveLength(1);
    later.leave();
    expect(await later.kind).toBe("free");
  });

  // The review of INF-5409: Restart it is offered over a run only while a force stop can end it.
  // The run notes that it holds the folder at once, with its agent's mark, that it can be ended by
  // force only once its own reading and helper work, and no longer once either stopped; a run that
  // ended first never says so.
  it("notes that a force stop can end the run only while it can", () => {
    const note = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8"));
    const dataDir = scratchDir("infinitary-run-recovers-");
    let ready: (can: boolean) => void = () => {};
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true, null, (set) => {
      ready = set;
    });
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true });
    expect(note(dataDir).recovers).toBeUndefined();
    ready(true);
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true, recovers: true });
    ready(false);
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true });
    expect(note(dataDir).recovers).toBeUndefined();

    const ended = scratchDir("infinitary-run-recovers-");
    let late: (can: boolean) => void = () => {};
    const finish = markRunning(ended, 4242, new Date(), undefined, true, null, (set) => {
      late = set;
    });
    finish();
    late(true);
    expect(() => note(ended)).toThrow();
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
    const alive = (pid: number): boolean => pid === 4242;
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
