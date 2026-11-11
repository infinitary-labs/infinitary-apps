import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { LEFTOVERS_DATA_KEY, leftoversOf } from "@shared/leftoverPrograms";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, intentOf, setup } from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PlacedTasks } from "../helper/placedTasks";
import { readProcesses } from "../placed/processResources";
import { processRoots } from "../placed/processRoots";
import type { TaskRecord } from "../storage/taskRecords";
import { KEPT_INDEX_DIR, KEPT_LEFTOVERS_FILE, keepLeftovers } from "./leftBehind";
import { LeftoverPrograms, leftBehindHere, placedLeftovers } from "./leftoverPrograms";
import { legacyStateOf } from "./seedTask";
import { readStops, taskStopsCommand } from "./taskStops";
import { TEMP_DIR_NAME } from "./taskTemp";

const exec = promisify(execFile);

// Measured on the Mac mini: the discard about 1.2 s and the guards about
// 2.5 s, most of it the two-second wait that puts a program before the
// task's start; a 10 s budget covers the slower case several times over.
vi.setConfig({ testTimeout: 10_000 });

/**
 * Each wait names its own window, and every read in it is asynchronous with
 * a time limit of its own: a poll that blocked the test's thread once let a
 * wait that could not pass run to the load clock's wall cap instead of
 * failing at its window with what it saw.
 */
const WAIT = { timeout: 5_000, interval: 100 };
const READ = { encoding: "utf8" as const, timeout: 2_000 };

/** The program's state letters, or "" once it is gone. */
async function stateOf(pid: number): Promise<string> {
  try {
    return (await exec("/bin/ps", ["-o", "stat=", "-p", String(pid)], READ)).stdout.trim();
  } catch {
    return "";
  }
}

/** Whether a program with this number is still running (a zombie counts as gone). */
async function running(pid: number): Promise<boolean> {
  const state = await stateOf(pid);
  return state !== "" && !state.startsWith("Z");
}

/**
 * Starts a program the system adopts, as `qemu -daemonize` or a backgrounded
 * `tart run` is: the shell that starts it exits at once, so ending the
 * crewmate's session and its shell commands never reaches it. `ownGroup`
 * gives it a process group of its own, as a heavy run's is.
 */
async function detached(
  script: string,
  cwd: string,
  pidFile: string,
  ownGroup = false,
): Promise<number> {
  if (ownGroup) {
    // `set -m` gives no group of its own where the shell has no terminal
    // (dash on Linux ignores it), so a short-lived Node starts the program
    // in a session of its own (setsid on both systems) and exits.
    const starter = `const c = require("node:child_process").spawn("/bin/sh", ["-c", process.argv[1]], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(process.argv[2], String(c.pid)); c.unref();`;
    await exec(process.execPath, ["-e", starter, script, pidFile], { cwd, timeout: 2_000 });
  } else {
    const start = `(${script} </dev/null >/dev/null 2>&1 & echo $! > "$1")`;
    await exec("/bin/sh", ["-c", start, "sh", pidFile], { cwd, timeout: 2_000 });
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  // Its number is known before the background shell has run `exec`: the
  // program counts as started once the system names it sleep.
  await vi.waitFor(async () => {
    const { stdout } = await exec("/bin/ps", ["-o", "comm=", "-p", String(pid)], READ);
    expect(stdout.trim()).toMatch(/(^|\/)sleep$/);
  }, WAIT);
  return pid;
}

function killAll(pids: readonly number[]): void {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, as the close left it.
    }
}

describe("a closed task's leftover programs", () => {
  /**
   * INF-3447's approved plan, piece 1, done criterion 8: a discarded task's
   * close ends a real program it left holding a file in its temporary
   * folder, runs its registered stop, which ends a second real program, and
   * names both on the task's timeline.
   */
  it("runs its stop, ends the program holding its temporary folder, and names both", async () => {
    const crewmate = fakeCrewmate();
    let sweeps: LeftoverPrograms | undefined;
    const harness = setup(crewmate, {
      leftovers: {
        begin: (taskId, after) => sweeps?.begin(taskId, after) ?? Promise.resolve(),
        settled: (taskId) => sweeps?.settled(taskId) ?? Promise.resolve(),
      },
    });
    const { supervisor, tasks, paths } = harness;
    sweeps = new LeftoverPrograms({ crewmatesDir: paths.crewmatesDir, tasks, graceMs: 2000 });
    const { taskId } = await supervisor.intake.commission({
      title: "check the installer on a scratch machine",
      intent: intentOf("check the installer on a scratch machine"),
    });
    await vi.waitFor(() => expect(tasks.get(taskId)?.startedAt).not.toBeNull(), WAIT);
    await vi.waitFor(() => expect(crewmate.prompts.length).toBeGreaterThan(0), WAIT);
    crewmate.finishPrompt();
    await vi.waitFor(() => expect(legacyStateOf(tasks.get(taskId))).toBe("idle"), WAIT);

    const taskFolder = join(paths.crewmatesDir, taskId);
    const temp = join(taskFolder, TEMP_DIR_NAME);
    mkdirSync(temp, { recursive: true });
    const elsewhere = scratchDir("infinitary-leftover-elsewhere-");
    const pids: number[] = [];
    try {
      // A program that holds a log in the temporary folder and works there.
      const holder = await detached(
        `exec sleep 300 3>>"${join(temp, "machine.log")}"`,
        temp,
        join(elsewhere, "holder.pid"),
      );
      pids.push(holder);
      // A second program that holds nothing of the task's, stopped only by its registered stop.
      const vmPid = join(elsewhere, "vm.pid");
      const machine = await detached("exec sleep 301", elsewhere, vmPid);
      pids.push(machine);
      expect(await running(holder)).toBe(true);
      expect(await running(machine)).toBe(true);
      taskStopsCommand(taskFolder, Date.now).add({
        label: "scratch machine",
        command: `kill "$(cat '${vmPid}')"`,
        cwd: elsewhere,
      });

      expect(await supervisor.settling.settle.settleTask(taskId, "discard")).toBe("Discarded.");
      await sweeps.settled(taskId);

      // What the sweep saw first, so a miss says what it found.
      const line = tasks
        .timeline(taskId)
        .find((event) => event.data && LEFTOVERS_DATA_KEY in event.data);
      expect(leftoversOf(line?.data)).toEqual({
        stops: [{ label: "scratch machine", outcome: "ran" }],
        programs: [{ pid: holder, name: "sleep", outcome: "ended", started: expect.any(String) }],
        holders: "checked",
      });
      expect(line?.text).toBe(
        `Leftovers at close: stop "scratch machine" ran; sleep (${holder}) ended.`,
      );
      await vi.waitFor(async () => expect(await running(machine)).toBe(false), WAIT);
      await vi.waitFor(async () => expect(await running(holder)).toBe(false), WAIT);
    } finally {
      killAll(pids);
    }
  });

  /**
   * The plan's criterion 3 and the review of piece 1: a holder another
   * task still open declared as its own heavy run, and a program already
   * running before the task started, are never this task's leftovers.
   */
  it("leaves a program another open task owns and one that predates the task", async () => {
    const root = scratchDir("infinitary-leftover-guards-");
    const crewmatesDir = join(root, "crewmates");
    const temp = join(crewmatesDir, "task-closed", TEMP_DIR_NAME);
    mkdirSync(temp, { recursive: true });
    const world = new GuardWorld(temp, root);
    try {
      const { before, owned, left, startedAt } = await world.start();
      const records = new Map<string, TaskRecord>([
        [
          "task-closed",
          {
            id: "task-closed",
            key: "INF-1",
            status: "dropped",
            closedReason: "discarded",
            startedAt,
            worktreeDir: "",
            workspaceState: "removed",
            deviceId: null,
          } as unknown as TaskRecord,
        ],
        ["task-open", { id: "task-open", key: "INF-2", status: "open" } as unknown as TaskRecord],
      ]);
      const notes: { text: string; data?: Record<string, unknown> }[] = [];
      const sweeps = new LeftoverPrograms({
        crewmatesDir,
        graceMs: 2000,
        tasks: {
          get: (id) => records.get(id),
          note: (_id, text, options) =>
            notes.push({ text, ...(options.data ? { data: options.data } : {}) }),
          graph: { carrierOf: (id) => records.get(id), escalatedTo: () => [] },
        },
      });
      await sweeps.begin("task-closed");

      expect(leftoversOf(notes[0]?.data)).toEqual({
        stops: [],
        programs: [{ pid: left, name: "sleep", outcome: "ended", started: expect.any(String) }],
        holders: "checked",
      });
      await vi.waitFor(async () => expect(await running(left)).toBe(false), WAIT);
      expect(await running(before)).toBe(true);
      expect(await running(owned)).toBe(true);
    } finally {
      world.end();
    }
  });

  /**
   * The same guards on a computer that runs work (plan criterion 6 and the
   * review of piece 1): its close order's sweep reads the start time the
   * home sent and the tasks still open there.
   */
  it("leaves the same programs on a computer that runs work", async () => {
    const root = scratchDir("infinitary-leftover-placed-");
    const tasks = new PlacedTasks(join(root, "work"), join(root, "worktrees"));
    const closed = tasks.ensure("task-closed");
    tasks.ensure("task-open");
    tasks.writeState("task-closed", { ...tasks.state("task-closed"), closed: true });
    const world = new GuardWorld(closed.temp, root);
    try {
      const { before, owned, left, startedAt } = await world.start();
      const report = await placedLeftovers(tasks, { graceMs: 2000 })("task-closed", { startedAt });

      expect(report).toEqual({
        stops: [],
        programs: [{ pid: left, name: "sleep", outcome: "ended", started: expect.any(String) }],
        holders: "checked",
      });
      await vi.waitFor(async () => expect(await running(left)).toBe(false), WAIT);
      expect(await running(before)).toBe(true);
      expect(await running(owned)).toBe(true);
    } finally {
      world.end();
    }
  });

  /**
   * The captain's answer on the review of piece 1: a task carried on by
   * another still loses its folders, so what holds them ends, while its
   * registered stops go to the task that carries the work on, here and on
   * a computer that runs work.
   */
  it("ends what holds a carried-on task's folders and hands its stops on", async () => {
    const root = scratchDir("infinitary-leftover-carried-");
    const pids: number[] = [];
    const STOP = { label: "scratch machine", command: "tart stop inf-scratch" };
    try {
      // At the home: the successor is open.
      const crewmatesDir = join(root, "crewmates");
      const temp = join(crewmatesDir, "task-first", TEMP_DIR_NAME);
      mkdirSync(temp, { recursive: true });
      taskStopsCommand(join(crewmatesDir, "task-first"), Date.now).add(STOP);
      const holder = await detached("exec sleep 305", temp, join(root, "home.pid"));
      pids.push(holder);
      const records = new Map<string, TaskRecord>([
        [
          "task-first",
          {
            id: "task-first",
            key: "INF-1",
            status: "done",
            closedReason: "superseded",
            startedAt: Date.now() - 60_000,
            worktreeDir: "",
            workspaceState: "removed",
            deviceId: null,
          } as unknown as TaskRecord,
        ],
        ["task-next", { id: "task-next", key: "INF-2", status: "open" } as unknown as TaskRecord],
      ]);
      const notes: { text: string; data?: Record<string, unknown> }[] = [];
      const sweeps = new LeftoverPrograms({
        crewmatesDir,
        graceMs: 2000,
        tasks: {
          get: (id) => records.get(id),
          note: (_id, text, options) =>
            notes.push({ text, ...(options.data ? { data: options.data } : {}) }),
          graph: {
            carrierOf: (id) => records.get(id === "task-first" ? "task-next" : id),
            escalatedTo: () => [],
          },
        },
      });
      await sweeps.begin("task-first");
      expect(leftoversOf(notes[0]?.data)).toEqual({
        stops: [],
        programs: [{ pid: holder, name: "sleep", outcome: "ended", started: expect.any(String) }],
        holders: "checked",
        handed: 1,
        handedTo: "INF-2",
      });
      expect(notes[0]?.text).toBe(
        `Leftovers at close: its stop went to INF-2; sleep (${holder}) ended.`,
      );
      expect(readStops(join(crewmatesDir, "task-next")).stops.map((stop) => stop.label)).toEqual([
        STOP.label,
      ]);
      await vi.waitFor(async () => expect(await running(holder)).toBe(false), WAIT);

      // On a computer that runs work: the home names the carrying task there.
      const tasks = new PlacedTasks(join(root, "work"), join(root, "worktrees"));
      const first = tasks.ensure("task-first");
      const next = tasks.ensure("task-next");
      tasks.writeState("task-first", { ...tasks.state("task-first"), closed: true });
      taskStopsCommand(first.root, Date.now).add(STOP);
      const there = await detached("exec sleep 306", first.temp, join(root, "there.pid"));
      pids.push(there);
      const report = await placedLeftovers(tasks, { graceMs: 2000 })("task-first", {
        carriedTo: { task: "task-next", key: "INF-2" },
        startedAt: Date.now() - 60_000,
      });
      expect(report).toEqual({
        stops: [],
        programs: [{ pid: there, name: "sleep", outcome: "ended", started: expect.any(String) }],
        holders: "checked",
        handed: 1,
        handedTo: "INF-2",
      });
      expect(readStops(next.root).stops.map((stop) => stop.label)).toEqual([STOP.label]);
      await vi.waitFor(async () => expect(await running(there)).toBe(false), WAIT);
    } finally {
      killAll(pids);
    }
  });

  /**
   * The re-review of piece 1: stops handed to a successor before it started
   * stay in its folder at the home, so when it then ran on a computer that
   * runs work, its close at the home still runs them; its folders there are
   * swept there, not here.
   */
  it("runs stops handed to a successor that then ran on another computer", async () => {
    const root = scratchDir("infinitary-leftover-moved-");
    const crewmatesDir = join(root, "crewmates");
    const marker = join(root, "machine-stopped");
    const records = new Map<string, TaskRecord>([
      [
        "task-first",
        {
          id: "task-first",
          key: "INF-1",
          status: "dropped",
          closedReason: "superseded",
          startedAt: Date.now() - 60_000,
          worktreeDir: "",
          workspaceState: "removed",
          deviceId: null,
        } as unknown as TaskRecord,
      ],
      [
        "task-next",
        { id: "task-next", key: "INF-2", status: "open", deviceId: null } as unknown as TaskRecord,
      ],
    ]);
    const notes: { id: string; text: string; data?: Record<string, unknown> }[] = [];
    const sweeps = new LeftoverPrograms({
      crewmatesDir,
      graceMs: 2000,
      tasks: {
        get: (id) => records.get(id),
        note: (id, text, options) =>
          notes.push({ id, text, ...(options.data ? { data: options.data } : {}) }),
        graph: {
          carrierOf: (id) => records.get(id === "task-first" ? "task-next" : id),
          escalatedTo: () => [],
        },
      },
    });
    taskStopsCommand(join(crewmatesDir, "task-first"), Date.now).add({
      label: "scratch machine",
      command: `touch '${marker}'`,
    });
    await sweeps.begin("task-first");
    expect(readStops(join(crewmatesDir, "task-next")).stops.map((stop) => stop.label)).toEqual([
      "scratch machine",
    ]);

    // The successor starts on a computer that runs work, then closes.
    records.set("task-next", {
      id: "task-next",
      key: "INF-2",
      status: "done",
      closedReason: "finished",
      startedAt: Date.now() - 30_000,
      worktreeDir: "",
      workspaceState: "removed",
      deviceId: "mini",
    } as unknown as TaskRecord);
    await sweeps.begin("task-next");

    const line = notes.find((note) => note.id === "task-next");
    expect(leftoversOf(line?.data)).toEqual({
      stops: [{ label: "scratch machine", outcome: "ran" }],
      programs: [],
      holders: "checked",
    });
    expect(readFileSync(marker, "utf8")).toBe("");
    expect(readStops(join(crewmatesDir, "task-next")).stops).toEqual([]);
  });
});

/**
 * Three programs holding a closed task's folder: one opened there before
 * the task started, one in a group the open task "task-open" declared, and
 * one the task left, which alone is its leftover.
 */
class GuardWorld {
  private readonly pids: number[] = [];
  private release = () => {};

  constructor(
    private readonly folder: string,
    private readonly root: string,
  ) {}

  async start(): Promise<{ before: number; owned: number; left: number; startedAt: number }> {
    // Opened in the folder before the task started, as a terminal would be.
    const before = await this.program("exec sleep 302", "before");
    // Birth stamps count whole seconds: the task starts two seconds later.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const startedAt = Date.now();
    const owned = await this.program("exec sleep 303", "owned", true);
    this.release = processRoots.addGroup(owned, "task-open", "declared");
    const left = await this.program("exec sleep 304", "left");
    return { before, owned, left, startedAt };
  }

  end(): void {
    this.release();
    killAll(this.pids);
  }

  private async program(script: string, name: string, ownGroup = false): Promise<number> {
    const pid = await detached(script, this.folder, join(this.root, `${name}.pid`), ownGroup);
    this.pids.push(pid);
    return pid;
  }
}

describe("what a close leaves, and a look clearing it", () => {
  /**
   * INF-2574's approved plan under direction C, piece 2, done criterion 7:
   * a scratch task's close on a computer that runs work leaves a stop that
   * failed and a program that survived, with a finished task's run in the
   * line; the computer lists all three, and the app's rerun and end clear
   * the stop and the program, checking the program's start time first.
   */
  it("keeps a failed stop and a survivor, lists them, and clears them through the app", async () => {
    const root = scratchDir("infinitary-left-behind-");
    const tasks = new PlacedTasks(join(root, "work"), join(root, "worktrees"));
    const folders = tasks.ensure("task-closed");
    tasks.writeState("task-closed", { ...tasks.state("task-closed"), closed: true });
    const elsewhere = scratchDir("infinitary-left-behind-elsewhere-");
    const pids: number[] = [];
    try {
      // A machine its stop ends only once the machine is ready: at the close it is not, so the stop fails.
      const machine = await detached("exec sleep 302", elsewhere, join(elsewhere, "vm.pid"));
      pids.push(machine);
      taskStopsCommand(folders.root, Date.now).add({
        label: "scratch machine",
        command: `test -f ready && kill "$(cat vm.pid)"`,
        cwd: elsewhere,
      });
      // A program holding its temporary folder, which the close ends.
      mkdirSync(folders.temp, { recursive: true });
      const holder = await detached(
        `exec sleep 303 3>>"${join(folders.temp, "machine.log")}"`,
        folders.temp,
        join(elsewhere, "holder.pid"),
      );
      pids.push(holder);

      const report = await placedLeftovers(tasks, { graceMs: 2000 })("task-closed", {});
      expect(report.stops).toEqual([{ label: "scratch machine", outcome: "failed", exitCode: 1 }]);
      expect(report.programs).toEqual([
        { pid: holder, name: "sleep", outcome: "ended", started: expect.any(String) },
      ]);
      expect(await running(machine)).toBe(true);

      // A test cannot make a program outlive a kill, so the close's record of
      // one that did stands in: a real program with its real start time, and
      // one whose number the record names with another program's start time.
      const survivor = await detached("exec sleep 304", elsewhere, join(elsewhere, "s.pid"));
      const reused = await detached("exec sleep 305", elsewhere, join(elsewhere, "r.pid"));
      pids.push(survivor, reused);
      const started = (await readProcesses())?.find((row) => row.pid === survivor)?.started;
      expect(started).toBeDefined();
      keepLeftovers(
        folders.root,
        [],
        [
          { pid: survivor, name: "sleep", outcome: "survived", started: started ?? "" },
          { pid: reused, name: "sleep", outcome: "survived", started: "Thu Jan  1 00:00:00 1970" },
        ],
      );
      const booked = {
        id: "6f1c2b7e-1f0a-4c55-9d3e-2b8a4f6c9e10",
        taskId: "task-closed",
        demand: { cpu: 4, memoryBytes: 8 * 1024 ** 3 },
        state: "running" as const,
        ahead: 0,
      };
      const here = leftBehindHere({
        tasksDir: tasks.tasksDir,
        closed: (task) => tasks.has(task) && tasks.state(task).closed,
        runs: () => [booked],
        graceMs: 2000,
      });

      expect(await here.list()).toEqual({
        stops: [
          {
            task: "task-closed",
            id: "s1",
            label: "scratch machine",
            outcome: "failed",
            exitCode: 1,
          },
        ],
        programs: [{ task: "task-closed", pid: survivor, name: "sleep", started }],
        runs: [{ task: "task-closed", id: booked.id, state: "running", demand: booked.demand }],
        kept: ["task-closed"],
      });

      // The captain picked all three: the machine is ready now, so its stop runs.
      writeFileSync(join(elsewhere, "ready"), "");
      expect(await here.rerun("task-closed", "s1")).toEqual({
        label: "scratch machine",
        outcome: "ran",
      });
      await vi.waitFor(async () => expect(await running(machine)).toBe(false), WAIT);
      // The independent review of this change found `end` signalled a kept
      // number when the process table could not be read: it must refuse.
      const blind = leftBehindHere({
        tasksDir: tasks.tasksDir,
        closed: (task) => task === "task-closed",
        runs: () => [],
        processes: async () => null,
        graceMs: 2000,
      });
      expect(await blind.end("task-closed", survivor)).toMatchObject({ refused: "refused" });
      expect(await running(survivor)).toBe(true);
      expect(await here.end("task-closed", survivor)).toMatchObject({ outcome: "ended" });
      await vi.waitFor(async () => expect(await running(survivor)).toBe(false), WAIT);
      // A number whose program is not the one the close kept is never signalled.
      expect(await here.end("task-closed", reused)).toMatchObject({ outcome: "gone" });
      expect(await running(reused)).toBe(true);

      expect(await here.list()).toEqual({
        stops: [],
        programs: [],
        runs: [{ task: "task-closed", id: booked.id, state: "running", demand: booked.demand }],
        kept: [],
      });
      expect(existsSync(join(folders.root, KEPT_LEFTOVERS_FILE))).toBe(false);
      expect(readdirSync(join(tasks.tasksDir, KEPT_INDEX_DIR))).toEqual([]);
    } finally {
      killAll(pids);
    }
  });
});
