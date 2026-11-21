import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { RUN_AGENT_ENV } from "@core/helper/background";
import { RUN_STOP_FOR_FILE } from "@core/helper/windowsTask";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir, socketScratchDir } from "../../tests/helpers/scratchDirs";
import { runEnd } from "./besideRun";
import {
  answerLaunch,
  askLoginShellEarly,
  bringWindowForward,
  clearWindowAnswers,
  commandHolding,
  commandPipe,
  commandPipeHeld,
  followInstalledProgram,
  holdCommandPipe,
  holderIsWindow,
  keepsStarterBesideGrant,
  lockHolder,
  lockHolderKind,
  markRunning,
  ownedRun,
  ownedRunOf,
  type ProgramWords,
  programIdentity,
  programWords,
  RUN_MARKER,
  runCommand,
  runningByCommand,
  runOptions,
  stopRunningCommand,
  windowAnswerAsked,
  windowAnswerAsker,
  windowAnswerFile,
  windowByWords,
  wordsAfterProgram,
  writeWindowAnswer,
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
    expect(commandHolding(stale, reused)).toEqual({ running: false, owned: null, known: false });
    expect(commandHolding(stale, (pid, birth) => pid === 4242 && birth === "win:1")).toEqual({
      running: true,
      owned: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
      known: true,
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
    // The review of INF-5409: a birth Windows cannot read is not a match. Beside the held lock the
    // status is unknown, the command holds the folder as nobody's own, and a stop for that run
    // alone asks nothing; the person's own Stop still reaches whoever holds it.
    const unread = (pid: number, birth?: string) => (pid !== 4242 ? false : birth ? null : true);
    const unknown = readRunStatus(stale, unread);
    expect(unknown.running).toBeNull();
    expect(ownedRunOf(unknown)).toBeNull();
    expect(runEnd(unknown, null)).toBeNull();
    expect(commandHolding(stale, unread)).toEqual({ running: true, owned: null, known: false });
    signalled.length = 0;
    expect(stopRunningCommand(stale, unread, (pid) => void signalled.push(pid), owned)).toBe(false);
    expect(signalled).toEqual([]);
    expect(stopRunningCommand(stale, unread, (pid) => void signalled.push(pid))).toBe(true);
    expect(signalled).toEqual([4242]);
    expect(ownedRunOf(readRunStatus(earlier, unread))).toEqual(owned);
  });

  // The review of INF-5409: a launch beside a held lock whose note's run cannot be told by its
  // Windows birth (stood in by a lock link that cannot be read, naming no holder) does not take the
  // holder for that run: it may be a window beside a stale note. The launch keeps its starter with a
  // grant waiting, and waits for who holds the lock to show itself: a window's answer, or the note's
  // run once its birth reads as the agent's own, which it then starts again beside as its owner.
  it("waits to learn who holds the lock while a noted run's birth cannot be read", async () => {
    const stale = scratchDir("infinitary-run-unread-start-");
    markRunning(stale, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true, "win:1");
    writeFileSync(join(stale, "SingletonLock"), "held, naming no holder");
    const unread = (pid: number, birth?: string) => (pid !== 4242 ? false : birth ? null : true);
    const same = (pid: number, birth?: string) => pid === 4242 && birth === "win:1";
    expect(runningByCommand(stale, unread)).toBe(false);
    expect(keepsStarterBesideGrant(commandHolding(stale, unread), true)).toBe(true);
    const whoHolds = (reader: () => typeof unread, answered: () => boolean) =>
      lockHolderKind({
        running: () => runningByCommand(stale, reader()),
        answered,
        holder: () => undefined,
        asked: undefined,
        // Nothing names the holder, so no words of it can be read.
        windowHolder: async () => null,
        lockFree: () => false,
        readEveryMs: 60_000,
        everyMs: 20,
      });
    // A window holds the lock beside the stale note: it answers, and is never taken for the run.
    let answered = false;
    setTimeout(() => (answered = true), 300);
    expect(
      await whoHolds(
        () => unread,
        () => answered,
      ),
    ).toBe("window");
    // The agent's own run holds it, its birth readable a moment later.
    let reader = unread;
    setTimeout(() => (reader = same), 300);
    expect(
      await whoHolds(
        () => reader,
        () => false,
      ),
    ).toBe("run");
    const owned = commandHolding(stale, same);
    expect(owned).toEqual({
      running: true,
      owned: { pid: 4242, startedAt: "2026-10-25T17:00:00.000Z" },
      known: true,
    });
    expect(keepsStarterBesideGrant(owned, true)).toBe(true);
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
        // The holder's words cannot be read, so it may be a command that has not noted itself.
        windowHolder: async () => null,
        lockFree: () => {
          asks.push(Date.now());
          return holder === null;
        },
        readEveryMs: 100,
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

    // No link names the holder, as Windows' own lock: it is never asked again while it holds the
    // lock, so a window from before windows answered is not brought forward again after each wait,
    // and is asked once more only once the lock is let go.
    const unnamed = look({}, false);
    let free = false;
    void unnamed.kind.then(() => (free = true));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(free).toBe(false);
    expect(unnamed.asks).toEqual([]);
    unnamed.leave();
    expect(await unnamed.kind).toBe("free");
    expect(unnamed.asks).toHaveLength(1);

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

    // The lock read free: asked for at each look, as when the holder that refused the launch's own
    // ask ended before any look, so the launch never waits beside a free folder.
    // Whatever refused those asks was never read, as a window that took the lock after the read
    // just before the launch's ask and quit before the next look: the launch is told before it
    // acts on the folder free, so it may ask the person rather than reopen what they quit.
    const refusals = [true, true];
    let freeAsks = 0;
    const unknowns: number[] = [];
    let unknownsAtFree = -1;
    expect(
      await lockHolderKind({
        running: () => false,
        answered: () => false,
        holder: () => null,
        asked: null,
        windowHolder: async () => null,
        lockFree: () => {
          freeAsks += 1;
          const free = !refusals.shift();
          if (free) unknownsAtFree = unknowns.length;
          return free;
        },
        readEveryMs: 100,
        everyMs: 20,
        onUnknown: () => unknowns.push(freeAsks),
      }),
    ).toBe("free");
    expect(freeAsks).toBe(3);
    expect(unknownsAtFree).toBe(0);
    expect(unknowns).toEqual([3]);
    // A window answers and the person quits it just as the launch takes the lock: the answer wins,
    // so the launch quits too and never opens the app the person just quit. An answer there before
    // a run notes itself wins as well.
    let quit = false;
    let ended = false;
    setTimeout(() => (ended = true), 100);
    expect(
      await lockHolderKind({
        running: () => false,
        answered: () => quit,
        holder: () => (ended ? null : 4242),
        asked: 4242,
        windowHolder: async () => null,
        // The answer lands between the launch's last look and its taking the lock.
        lockFree: () => {
          quit = true;
          return true;
        },
        readEveryMs: 100,
        everyMs: 20,
      }),
    ).toBe("window");
    expect(
      await lockHolderKind({
        running: () => true,
        answered: () => true,
        holder: () => 4242,
        asked: 4242,
        windowHolder: async () => null,
        lockFree: () => false,
        readEveryMs: 100,
      }),
    ).toBe("window");
  });

  // The review of INF-5409: a window from before windows answered a launch's ask (as one still open
  // across an update) brings itself forward at the ask and never answers. Silence is no evidence of
  // a window: the holder is taken for one only by the words it runs with, which never hold `run`,
  // while a command's always do, whatever its version. A command's words, or words that cannot be
  // read, keep the launch waiting for what the holder shows; words read again only after the wait.
  it("takes a holder for a window only by the words it runs with", async () => {
    const look = (
      words: (pid: number) => Promise<ProgramWords | null>,
      running: () => boolean = () => false,
      holder: () => number | null | undefined = () => 4242,
    ) => {
      const asks: number[] = [];
      const reads: number[] = [];
      const order: string[] = [];
      const kind = lockHolderKind({
        running,
        answered: () => false,
        holder,
        asked: 4242,
        windowHolder: (named) => {
          reads.push(Date.now());
          order.push("read");
          return holderIsWindow(named, { words });
        },
        lockFree: () => {
          asks.push(Date.now());
          order.push("ask");
          return false;
        },
        readEveryMs: 150,
        everyMs: 20,
      });
      return { kind, asks, reads, order };
    };
    const exe = "/Applications/Infinitary.app/Contents/MacOS/Infinitary";
    const mac = (words: string[]): ProgramWords => ({ words, exact: false });
    const linux = (words: string[]): ProgramWords => ({ words, exact: true });
    // A window, one from before windows answered included: taken for one at once, asked nothing.
    const legacy = look(async () => mac([exe, "--enable-features=x"]));
    expect(await legacy.kind).toBe("window");
    expect(legacy.asks).toEqual([]);
    // A command that has not noted itself yet: waited for, its words read once, until it notes.
    let noted = false;
    const command = look(
      async () => linux([exe, "run", "--json"]),
      () => noted,
    );
    let settled: string | null = null;
    void command.kind.then((kind) => (settled = kind));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBeNull();
    expect(command.reads).toHaveLength(1);
    expect(command.asks).toEqual([]);
    noted = true;
    expect(await command.kind).toBe("run");
    // Words that cannot be read: waited for, read again after each wait, and a window once they show one.
    let readable = false;
    const unread = look(async () => (readable ? mac([exe]) : null));
    let unreadKind: string | null = null;
    void unread.kind.then((kind) => (unreadKind = kind));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(unreadKind).toBeNull();
    expect(unread.reads.length).toBeGreaterThanOrEqual(2);
    readable = true;
    expect(await unread.kind).toBe("window");
    // Words read of a holder that let the lock go meanwhile tell nothing of the next one.
    // The window read let the lock go during the read, and a command took it; the command is read
    // anew and waited for, never taken for the window.
    let holder = 4242;
    let commandRead = false;
    const moved = look(
      async (pid) => {
        if (pid === 4242) {
          holder = 5151;
          return mac([exe]);
        }
        commandRead = true;
        return mac([exe, "run"]);
      },
      () => commandRead,
      () => holder,
    );
    expect(await moved.kind).toBe("run");
    expect(moved.reads).toHaveLength(2);
    // The command that took over was asked once, before it was read.
    expect(moved.order).toEqual(["read", "ask", "read"]);
    // A window took the lock after the launch's own ask reached another: it is asked once, so it
    // brings its window forward, before it is taken for the window that takes over.
    const taken = look(
      async () => mac([exe]),
      () => false,
      () => 5151,
    );
    expect(await taken.kind).toBe("window");
    expect(taken.order).toEqual(["ask", "read"]);
    // The review of INF-5409: a command read, then another holder seen in its place that lets the
    // lock go before its ask: that holder was never read, as an older window the person quit, so
    // the launch is told before it acts on the folder free. The command itself letting the lock
    // go is no question.
    const replacedUnread = async (next: number | null) => {
      let current: number | null = 4242;
      const unknowns: number[] = [];
      const kind = await lockHolderKind({
        running: () => false,
        answered: () => false,
        holder: () => current,
        asked: 4242,
        windowHolder: async (pid) => {
          // Read as a command, then replaced before the next look.
          if (pid === 4242) setTimeout(() => (current = next), 0);
          return holderIsWindow(pid, { words: async () => linux([exe, "run"]) });
        },
        // The holder seen next has already let the lock go by its ask.
        lockFree: () => true,
        readEveryMs: 150,
        everyMs: 20,
        onUnknown: () => unknowns.push(1),
      });
      return { kind, unknowns };
    };
    expect(await replacedUnread(5151)).toEqual({ kind: "free", unknowns: [1] });
    expect(await replacedUnread(null)).toEqual({ kind: "free", unknowns: [] });
  });

  it("reads a program's words after its own path, however many spaces it holds", async () => {
    const exe = "/Users/a b/Applications/Infinitary.app/Contents/MacOS/Infinitary";
    expect(wordsAfterProgram(`${exe} run --json`, exe)).toEqual([exe, "run", "--json"]);
    expect(wordsAfterProgram(exe, exe)).toEqual([exe]);
    expect(wordsAfterProgram(`${exe}Helper run`, exe)).toBeNull();
    expect(wordsAfterProgram("/usr/bin/other run", exe)).toBeNull();
    const exact = (words: string[]) => ({ words, exact: true });
    const split = (words: string[]) => ({ words, exact: false });
    // Read exactly, as on Linux, the words are read as a launch reads its own: a command starts as
    // `run`, after any switches, and a window's switch holding the word is still a window.
    expect(windowByWords(exact([exe]))).toBe(true);
    expect(windowByWords(exact([exe, "run", "--agent", "x"]))).toBe(false);
    expect(windowByWords(exact([exe, "--no-sandbox", "run"]))).toBe(false);
    expect(windowByWords(exact([exe, "--user-data-dir=/x/a run folder"]))).toBe(true);
    // Run from source, the app's own folder comes first.
    expect(windowByWords(exact(["electron", "/src/app", "run"]), true)).toBe(false);
    expect(windowByWords(exact(["electron", "/src/app"]), true)).toBe(true);
    // Split at spaces, as a Mac's `ps` gives them: a word that may be part of a switch's value is
    // not known, and only words with no `run` among them tell a window.
    expect(windowByWords(split([exe, "--user-data-dir=/x/a", "run", "folder"]))).toBeNull();
    expect(windowByWords(split([exe, "run", "--json"]))).toBeNull();
    expect(windowByWords(split([exe, "--enable-features=x"]))).toBe(true);
    // The program's own path is never one of its words, even where it ends in `run`.
    expect(windowByWords(split(["run"]))).toBe(true);
    expect(windowByWords(null)).toBeNull();
    expect(await holderIsWindow(1, { words: async () => split([exe]) })).toBe(true);
    expect(await holderIsWindow(1, { words: async () => exact([exe, "run"]) })).toBe(false);
    expect(await holderIsWindow(1, { words: async () => null })).toBeNull();
    // A lock that names no holder has no words to read.
    expect(await holderIsWindow(undefined, { words: async () => split([exe]) })).toBeNull();
  });

  // The review of INF-5409: on Linux a holder's words are read exactly, but read as this launch's
  // own; a program started another way, as a source Electron beside the packaged app, reads them
  // another way, so its words tell nothing and it is left not known.
  it.runIf(process.platform === "linux")(
    "reads a Linux holder's words only where it runs from a program of this one's name",
    async () => {
      const own = await programWords(process.pid, "linux", process.execPath);
      expect(own?.exact).toBe(true);
      expect(own?.words.length).toBeGreaterThan(0);
      expect(await programWords(process.pid, "linux", "/opt/infinitary/infinitary")).toBeNull();
    },
  );

  // The review of INF-5409: on a Windows PC, whose lock names no holder, a command holds a pipe of
  // its own from once it holds the lock until it ends, so a window launch refused the lock
  // waits on a command that has not noted itself. A holder with no such pipe is not known, since a
  // command from before that pipe holds none either: it is waited for, never taken for a window,
  // until it answers, notes itself or lets the lock go, and one that let it go after showing nothing
  // is the person's to judge. A pipe that goes while the lock stays held is a holder that changed
  // unseen, asked once. Read through a real local socket.
  it("tells a command on an unnamed lock by the pipe it holds, and takes no pipe for nothing known", async () => {
    const pipe = join(socketScratchDir("inf-pipe-"), "run.sock");
    expect(await commandPipeHeld(pipe)).toBe(false);
    const look = (
      shows: {
        running?: () => boolean;
        answered?: () => boolean;
        leavesAfterRead?: boolean;
        leavesDuringRead?: boolean;
        leavesAtAsk?: boolean;
      } = {},
    ) => {
      const asks: number[] = [];
      const reads: number[] = [];
      const unknowns: number[] = [];
      let holder: null | undefined;
      const kind = lockHolderKind({
        running: shows.running ?? (() => false),
        answered: shows.answered ?? (() => false),
        holder: () => holder,
        asked: undefined,
        windowHolder: async (named) => {
          reads.push(Date.now());
          // The holder lets the lock go while this read is still on its way.
          if (shows.leavesDuringRead) holder = null;
          const shown = await holderIsWindow(named, { commandPipe: () => commandPipeHeld(pipe) });
          // The holder lets the lock go once this read is taken, before the next look.
          if (shows.leavesAfterRead)
            setTimeout(() => {
              holder = null;
            }, 0);
          return shown;
        },
        lockFree: () => {
          asks.push(Date.now());
          // The holder lets the lock go just before this ask reaches it.
          if (shows.leavesAtAsk) holder = null;
          return holder === null;
        },
        readEveryMs: 60,
        everyMs: 20,
        onUnknown: () => unknowns.push(Date.now()),
      });
      let settled: string | null = null;
      void kind.then((value) => (settled = value));
      return { kind, asks, reads, unknowns, settled: () => settled, leave: () => (holder = null) };
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // A command that has not noted itself yet: read again after each wait, never asked again.
    let letGo = holdCommandPipe(pipe);
    expect(await commandPipeHeld(pipe)).toBe(true);
    let noted = false;
    const command = look({ running: () => noted });
    await wait(400);
    expect(command.settled()).toBeNull();
    expect(command.reads.length).toBeGreaterThanOrEqual(2);
    expect(command.asks).toEqual([]);
    expect(command.unknowns).toEqual([]);
    noted = true;
    expect(await command.kind).toBe("run");

    // The command ends and a window takes the lock between two looks: its pipe gone, the window is
    // asked once and answers.
    let answered = false;
    const handover = look({ answered: () => answered });
    await wait(200);
    letGo();
    await expect.poll(() => commandPipeHeld(pipe)).toBe(false);
    await expect.poll(() => handover.asks.length).toBe(1);
    await wait(300);
    expect(handover.settled()).toBeNull();
    expect(handover.asks).toHaveLength(1);
    answered = true;
    expect(await handover.kind).toBe("window");

    // No pipe from the start: a window from before windows answered, or a command from before the
    // pipe. Waited for and asked nothing, until the lock is let go; the launch is told once that
    // the holder still shows nothing, so it may ask the person what to do when it closes.
    const silent = look();
    await wait(400);
    expect(silent.settled()).toBeNull();
    expect(silent.asks).toEqual([]);
    expect(silent.reads.length).toBeGreaterThanOrEqual(3);
    expect(silent.unknowns).toHaveLength(1);
    silent.leave();
    expect(await silent.kind).toBe("free");
    expect(silent.asks).toHaveLength(1);

    // One that showed nothing and lets the lock go before its second read, as an older window the
    // person quit: the launch is told before it acts on the folder free, as for one read twice.
    const early = look({ leavesAfterRead: true });
    let unknownsAtFree = -1;
    void early.kind.then(() => (unknownsAtFree = early.unknowns.length));
    expect(await early.kind).toBe("free");
    expect(unknownsAtFree).toBe(1);
    expect(early.reads).toHaveLength(1);

    // One that lets the lock go before anything was read of it, or while its first read is on its
    // way, was never shown to be a command: the launch is told before it acts on the folder free.
    const unseen = look();
    unseen.leave();
    expect(await unseen.kind).toBe("free");
    expect(unseen.unknowns).toHaveLength(1);
    const midRead = look({ leavesDuringRead: true });
    expect(await midRead.kind).toBe("free");
    expect(midRead.reads).toHaveLength(1);
    expect(midRead.unknowns).toHaveLength(1);

    // A holder shown to be a command by its pipe that lets the lock go is no question.
    letGo = holdCommandPipe(pipe);
    await expect.poll(() => commandPipeHeld(pipe)).toBe(true);
    const ended = look();
    // A second read starts only once the first was taken.
    await expect.poll(() => ended.reads.length).toBeGreaterThanOrEqual(2);
    ended.leave();
    letGo();
    expect(await ended.kind).toBe("free");
    expect(ended.unknowns).toEqual([]);

    // A holder shown to be a command by its pipe whose pipe goes while the lock stays held, as one
    // replaced unseen by an older window that then quits before the ask: never read, so the launch
    // is told before it acts on the folder free.
    letGo = holdCommandPipe(pipe);
    await expect.poll(() => commandPipeHeld(pipe)).toBe(true);
    const swapped = look({ leavesAtAsk: true });
    await expect.poll(() => swapped.reads.length).toBeGreaterThanOrEqual(1);
    expect(swapped.asks).toEqual([]);
    letGo();
    expect(await swapped.kind).toBe("free");
    expect(swapped.asks).toHaveLength(1);
    expect(swapped.unknowns).toHaveLength(1);

    // The pipe's name follows the folder, whatever its letters' case.
    expect(commandPipe("C:\\Users\\a\\Infinitary")).toBe(commandPipe("c:\\users\\A\\infinitary"));
    expect(commandPipe("C:\\Users\\a\\Infinitary")).not.toBe(
      commandPipe("C:\\Users\\b\\Infinitary"),
    );
    letGo = () => {};
  });

  // The review of INF-5409: the whole handoff to a window, through the window's own handling of a
  // second launch (`answerLaunch`, `bringWindowForward`) and the answer it writes in the folder: the
  // window the person uses comes forward, a minimized refusal restored, a closed last window on a
  // Mac opened again, and the refused launch ends once that window answered. A window that takes
  // the lock after the launch's own ask is asked itself and is the one that comes forward.
  it("hands a refused launch to the window that holds the lock, which comes forward and answers", async () => {
    const dataDir = scratchDir("infinitary-window-handoff-");
    type Win = { minimized: boolean; restored: number; focused: number };
    const windowProgram = (open: Win[], reopen: (() => void) | null) => {
      const asked = new Set<string>();
      const written = new Map<string, number | null>();
      const made: (() => void)[] = [];
      return {
        made,
        // What Electron hands the lock's holder at a second launch's ask.
        secondInstance: (data: unknown) =>
          answerLaunch(windowAnswerAsked(data), {
            asked,
            bringForward: () =>
              bringWindowForward(
                open.map((win) => ({
                  isMinimized: () => win.minimized,
                  restore: () => {
                    win.minimized = false;
                    win.restored += 1;
                  },
                  focus: () => {
                    win.focused += 1;
                  },
                })),
                reopen,
              ),
            shown: () => open.length > 0,
            whenMade: (then) => void made.push(then),
            answer: (word) =>
              writeWindowAnswer(dataDir, word, windowAnswerAsker(data), written, () => true),
            later: () => {},
          }),
      };
    };
    const launch = (
      word: string,
      holders: { current: () => ReturnType<typeof windowProgram> | null },
    ) => {
      const ask = { windowAnswers: word, asker: process.pid };
      let asks = 0;
      const request = () => {
        asks += 1;
        const holder = holders.current();
        holder?.secondInstance(ask);
        return holder === null;
      };
      return { ask, request, asks: () => asks };
    };

    // A refusal shown minimized in place of the main window: restored, focused, and it answers.
    const refusal: Win = { minimized: true, restored: 0, focused: 0 };
    const refusing = windowProgram([refusal], null);
    const first = launch("0123456789abcdef", { current: () => refusing });
    expect(first.request()).toBe(false);
    expect(
      await lockHolderKind({
        running: () => false,
        answered: () => existsSync(join(dataDir, windowAnswerFile("0123456789abcdef"))),
        holder: () => 4242,
        asked: 4242,
        windowHolder: async () => null,
        lockFree: first.request,
        readEveryMs: 100,
        everyMs: 20,
      }),
    ).toBe("window");
    expect(refusal).toEqual({ minimized: false, restored: 1, focused: 1 });
    expect(first.asks()).toBe(1);

    // A Mac app kept working with its last window closed: the ask opens one again, and the launch
    // ends only once that window is there and answered.
    const opened: Win[] = [];
    let reopened = 0;
    const closed = windowProgram(opened, () => {
      reopened += 1;
      setTimeout(() => {
        opened.push({ minimized: false, restored: 0, focused: 0 });
        closed.made.shift()?.();
      }, 150);
    });
    const second = launch("1123456789abcdef", { current: () => closed });
    second.request();
    let ended: string | null = null;
    const closedKind = lockHolderKind({
      running: () => false,
      answered: () => existsSync(join(dataDir, windowAnswerFile("1123456789abcdef"))),
      holder: () => 4343,
      asked: 4343,
      windowHolder: async () => null,
      lockFree: second.request,
      readEveryMs: 100,
      everyMs: 20,
    });
    void closedKind.then((kind) => (ended = kind));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBeNull();
    expect(reopened).toBe(1);
    expect(await closedKind).toBe("window");
    expect(opened).toHaveLength(1);
    expect(second.asks()).toBe(1);

    // The launch's own ask reached a command, which ignores it; a window takes the lock from it
    // before the next look, is asked, and is the window that comes forward.
    const taking: Win = { minimized: false, restored: 0, focused: 0 };
    const takingProgram = windowProgram([taking], null);
    let holder = 5151;
    let program: ReturnType<typeof windowProgram> | null = null;
    const third = launch("2123456789abcdef", { current: () => program });
    third.request();
    setTimeout(() => {
      holder = 6161;
      program = takingProgram;
    }, 100);
    expect(
      await lockHolderKind({
        running: () => false,
        answered: () => existsSync(join(dataDir, windowAnswerFile("2123456789abcdef"))),
        holder: () => holder,
        asked: 5151,
        windowHolder: async () => null,
        lockFree: third.request,
        readEveryMs: 100,
        everyMs: 20,
      }),
    ).toBe("window");
    expect(taking).toEqual({ minimized: false, restored: 0, focused: 1 });
    expect(third.asks()).toBe(2);
  });

  // The review of INF-5409: a launch that told the window from what it runs as quits without
  // reading the answer the window writes a moment later, so the window takes away an answer whose
  // launch is gone as it quits; one whose launch is still there stays for that launch to read,
  // even where the window quits just after it answered.
  it("keeps a window's answer for a launch still there and takes away one whose launch is gone", () => {
    const dataDir = scratchDir("infinitary-window-answers-");
    const written = new Map<string, number | null>();
    const live = new Set([101, 202]);
    const alive = (pid: number) => live.has(pid);
    expect(writeWindowAnswer(dataDir, "waiting", 101, written, alive)).toBe(true);
    expect(writeWindowAnswer(dataDir, "late", 202, written, alive)).toBe(true);
    // A launch already gone is answered with nothing written.
    expect(writeWindowAnswer(dataDir, "gone", 303, written, alive)).toBe(true);
    expect(() => readFileSync(join(dataDir, windowAnswerFile("gone")))).toThrow();
    // The launch asking "late" quit before the answer came; "waiting" is still reading.
    live.delete(202);
    clearWindowAnswers(written, alive);
    expect(readFileSync(join(dataDir, windowAnswerFile("waiting")), "utf8")).toBe("");
    expect(() => readFileSync(join(dataDir, windowAnswerFile("late")))).toThrow();
    expect(written.size).toBe(0);
    expect(() =>
      writeWindowAnswer(join(dataDir, "missing"), "lost", 101, written, alive),
    ).toThrow();
    expect(written.size).toBe(0);
    expect(windowAnswerAsker({ windowAnswers: "a", asker: 101 })).toBe(101);
    expect(windowAnswerAsker({ windowAnswers: "a", asker: "101" })).toBeNull();
    expect(windowAnswerAsker(null)).toBeNull();
  });

  // The review of INF-5409: Restart it is offered over a run only while a force stop can end it.
  // The run notes that it holds the folder at once, with its agent's mark, that it can be ended by
  // force only once its own reading and helper work, and no longer once either stopped; a run that
  // ended first never says so.
  it("notes that a force stop can end the run only while it can", () => {
    const note = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8"));
    const dataDir = scratchDir("infinitary-run-recovers-");
    let ready: (can: boolean, pipes?: { wake: Seen; life: Seen }) => void = () => {};
    type Seen = { ino: number; dev: number };
    markRunning(dataDir, 4242, new Date("2026-10-25T17:00:00Z"), undefined, true, null, (set) => {
      ready = set;
    });
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true });
    expect(note(dataDir).recovers).toBeUndefined();
    // With the pipes it holds then, which a stop asks only through.
    const pipes = { wake: { ino: 11, dev: 1 }, life: { ino: 12, dev: 1 } };
    ready(true, pipes);
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true, recovers: true, pipes });
    ready(false);
    expect(note(dataDir)).toMatchObject({ pid: 4242, agent: true });
    expect(note(dataDir).recovers).toBeUndefined();
    expect(note(dataDir).pipes).toBeUndefined();

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
