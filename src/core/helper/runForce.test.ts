import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { processAlive } from "./lock";
import {
  endRunByForce,
  RUN_FORCE_DIR,
  RUN_FORCE_WAKE_SOURCE,
  RUN_FORCE_WATCH_SOURCE,
  runForceNeedle,
  runForceWakeFile,
  runPipeThere,
  wakeRun,
} from "./runForce";

/**
 * Ending a run that does not answer by force (docs/run.md, "When the command
 * does not answer"; the review of INF-5409): the run ends itself, on a
 * thread its stuck first mate does not hold up, where a stop names it by its
 * process and start, and on a Mac or Linux its own helper lets it go on when
 * its whole process is stopped. Each run here is a real process of its own,
 * leading its own process group as a service manager starts one, whose main
 * thread never yields, as a stuck first mate's would not, with the run's own
 * reading on a thread beside it; a bystander shares the folder.
 */

vi.setConfig({ testTimeout: 15_000 });

const STARTED = "2026-10-25T17:00:00.000Z";
const OTHER_START = "2026-10-25T17:05:00.000Z";
const POSIX = process.platform !== "win32";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    // Only a child not yet reaped is still this test's: its number, and its group's, are its own
    // until then. One reaped already is never signalled, by its number or its group's.
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (POSIX) process.kill(-ownedPid(child), "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
});

/** The process number of a child this test started, which it signals only once it is shown to run. */
function ownedPid(child: ChildProcess): number {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) throw new Error("the child did not start");
  return pid;
}

/** A child this test starts, once it is shown to have started. */
async function started(child: ChildProcess): Promise<ChildProcess> {
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  ownedPid(child);
  return child;
}

/**
 * A run whose main thread is stuck, reading force stops for `startedAt`
 * beside it once it says ready; with `helper`, also the pipe and shell that
 * let it go on, as `watchRunForce` starts them, and whether that helper said
 * it is ready; with `sibling`, a program it starts in its own process group,
 * whose number it says; with `program`, a reading of its own in place of the
 * run's; with `path`, the search path its helper finds its programs on.
 */
async function stuckRun(
  dataDir: string,
  startedAt: string,
  options: {
    helper?: boolean;
    sibling?: boolean;
    every?: number;
    program?: string;
    path?: string;
  } = {},
): Promise<{ run: ChildProcess; pid: number; sibling: number | null; helperReady: boolean }> {
  const program = `
    const { Worker } = require("node:worker_threads");
    const { spawn, spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const { join } = require("node:path");
    fs.mkdirSync(process.env.DIR, { recursive: true });
    new Worker(process.env.WATCH, {
      eval: true,
      workerData: { dir: process.env.DIR, startedAt: process.env.STARTED, every: Number(process.env.EVERY) },
    });
    let helperReady = false;
    let say = (fn) => setTimeout(fn, 300);
    // On a Mac or Linux the run holds its own pipe, as one that says a force stop can end it does.
    const pipe = process.env.PIPE ? join(process.env.DIR, process.env.PIPE.replace("wake-0-", "wake-" + process.pid + "-")) : null;
    if (pipe) {
      spawnSync("mkfifo", ["-m", "600", pipe]);
      fs.openSync(pipe, fs.constants.O_RDWR);
    }
    if (process.env.HELPER) {
      const helper = spawn("/bin/sh", ["-c", process.env.HELPER, "sh", pipe, String(process.pid), process.env.NEEDLE.replace("PID", String(process.pid)), process.env.DIR], { stdio: ["ignore", "pipe", "ignore"] });
      say = (fn) => {
        const fallback = setTimeout(fn, 5000);
        helper.stdout.on("data", (data) => {
          if (helperReady || !String(data).includes("ready")) return;
          helperReady = true;
          clearTimeout(fallback);
          fn();
        });
      };
    }
    const sibling = process.env.SIBLING ? spawn("sleep", ["30"], { stdio: "ignore" }).pid : 0;
    say(() => process.stdout.write("ready " + sibling + " " + (helperReady ? 1 : 0) + "\\n", () => { for (;;) {} }));
  `;
  const run = spawn(process.execPath, ["-e", program], {
    env: {
      PATH: options.path ?? process.env.PATH ?? "",
      WATCH: options.program ?? RUN_FORCE_WATCH_SOURCE,
      DIR: join(dataDir, RUN_FORCE_DIR),
      STARTED: startedAt,
      EVERY: String(options.every ?? 50),
      ...(POSIX ? { PIPE: runForceWakeFile(0, startedAt) } : {}),
      ...(options.helper
        ? {
            HELPER: RUN_FORCE_WAKE_SOURCE,
            NEEDLE: runForceNeedle(0, startedAt).replace("0", "PID"),
          }
        : {}),
      ...(options.sibling ? { SIBLING: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
    detached: POSIX,
  });
  await started(run);
  const said = await new Promise<string>((resolve, reject) => {
    run.stdout?.once("data", (data: Buffer) => resolve(String(data)));
    run.once("exit", () => reject(new Error("the run ended before it was ready")));
  });
  const [, siblingSaid, helperSaid] = said.trim().split(" ");
  const sibling = Number(siblingSaid);
  return {
    run,
    pid: ownedPid(run),
    sibling: sibling > 0 ? sibling : null,
    helperReady: helperSaid === "1",
  };
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.signalCode);
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

/** What is left in the folder of force stops, besides each run's own pipe. */
function left(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, RUN_FORCE_DIR)).filter((name) => !name.startsWith("wake-"));
  } catch {
    return [];
  }
}

/** Whether a POSIX process is stopped, by its state as `ps` reads it. */
function stopped(pid: number): boolean {
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.trim()
    .startsWith("T");
}

function writeStop(dataDir: string, name: string, stop: object): void {
  mkdirSync(join(dataDir, RUN_FORCE_DIR), { recursive: true });
  writeFileSync(join(dataDir, RUN_FORCE_DIR, `${name}.json`), `${JSON.stringify(stop)}\n`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes `run`'s own pipe and holds it open as the run does, answering what holds it. */
function holdPipe(dataDir: string, run: { pid: number; startedAt: string }): number {
  const pipe = join(dataDir, RUN_FORCE_DIR, runForceWakeFile(run.pid, run.startedAt));
  mkdirSync(join(dataDir, RUN_FORCE_DIR), { recursive: true });
  expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
  return openSync(pipe, constants.O_RDWR);
}

/** What a POSIX run ended by its own force stop ends with: its own SIGKILL, never an ordinary exit. */
async function endedByForce(gone: Promise<NodeJS.Signals | null>, pid: number): Promise<void> {
  const signal = await gone;
  if (POSIX) expect(signal).toBe("SIGKILL");
  expect(processAlive(pid)).toBe(false);
}

// The review of INF-5409: the run's reading says it reads only at a reading of the folder that
// succeeded, never merely once it started, and says so no longer while its readings fail, so a run
// says a force stop can end it only while one can reach it.
describe("a run's reading of force stops", () => {
  it("says it reads only while it reads the folder", async () => {
    const dir = join(scratchDir("run-force-"), RUN_FORCE_DIR);
    // Something in the folder's place that cannot be read as a folder.
    writeFileSync(dir, "");
    const words: unknown[] = [];
    const reading = new Worker(RUN_FORCE_WATCH_SOURCE, {
      eval: true,
      workerData: { dir, startedAt: STARTED, every: 50 },
    });
    reading.on("message", (word) => words.push(word));
    try {
      await expect.poll(() => words).toEqual(["lost"]);
      rmSync(dir);
      mkdirSync(dir);
      await expect.poll(() => words).toEqual(["lost", "reading"]);
      rmSync(dir, { recursive: true });
      writeFileSync(dir, "");
      await expect.poll(() => words).toEqual(["lost", "reading", "lost"]);
    } finally {
      await reading.terminate();
    }
  });
});

/**
 * A run of its own that starts the run's own reading and helper as a command
 * does (`watchRunForce`, loaded from the source as it is), leading its own
 * process group as a service manager starts one, and says each word of its
 * readiness on a line of its own: `started` once `watchRunForce` returned,
 * `ready` or `unready` as its `ready` is called, and `stopped` once what
 * ends them returned at a SIGTERM, which it then exits 0 after. With
 * `removeFails`, removing a file fails at that SIGTERM, for this account or
 * any other, as where the folder may be read but nothing in it removed; what
 * the run logs is kept in `logged`.
 */
async function watchingRun(
  dataDir: string,
  startedAt: string,
  options: { removeFails?: boolean } = {},
): Promise<{ run: ChildProcess; pid: number; words: string[]; logged: () => string }> {
  const program = `
    const { pathToFileURL } = await import("node:url");
    const fs = await import("node:fs");
    const { syncBuiltinESMExports } = await import("node:module");
    const { watchRunForce } = await import(pathToFileURL(process.env.SOURCE).href);
    const say = (word) => process.stdout.write(word + "\\n");
    const stop = watchRunForce(process.env.DATA, process.env.STARTED, 50, (can) => say(can ? "ready" : "unready"));
    say("started");
    process.on("SIGTERM", () => {
      if (process.env.REMOVE_FAILS) {
        fs.default.rmSync = (path) => {
          throw Object.assign(new Error("EACCES: permission denied, unlink " + path), { code: "EACCES" });
        };
        syncBuiltinESMExports();
      }
      stop();
      process.stdout.write("stopped\\n", () => process.exit(0));
    });
    setInterval(() => {}, 1000);
  `;
  const programFile = join(scratchDir("run-force-program-"), "run.mjs");
  writeFileSync(programFile, program);
  const run = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-transform-types",
      "--import",
      join(__dirname, "..", "..", "..", "tests", "helpers", "sourceImports.preload.mjs"),
      // A file of its own, not words after -e: a module's -e would make the run's own reading one too.
      programFile,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        SOURCE: join(__dirname, "runForce.ts"),
        DATA: dataDir,
        STARTED: startedAt,
        ...(options.removeFails ? { REMOVE_FAILS: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: POSIX,
    },
  );
  await started(run);
  let log = "";
  run.stderr?.on("data", (data: Buffer) => {
    log += String(data);
  });
  const words: string[] = [];
  let partial = "";
  run.stdout?.on("data", (data: Buffer) => {
    const lines = (partial + String(data)).split("\n");
    partial = lines.pop() ?? "";
    words.push(...lines);
  });
  await expect.poll(() => words, { timeout: 10_000 }).toContain("started");
  return { run, pid: ownedPid(run), words, logged: () => log };
}

// The review of INF-5409: what starts and ends a run's reading and helper never holds up the run
// itself. A folder of force stops that cannot be made, read or cleared leaves the run starting,
// going on and stopping as it would, saying no force stop can end it; and a run says one can only
// while its helper is reached at its own pipe: one whose folder failed to read a moment says so
// again once it reads it, while one whose folder was made again since, which keeps no pipe of its
// helper's, says so no more, and is asked no force stop.
describe.skipIf(!POSIX)("a run's reading and helper, as a command starts them", () => {
  it("starts and stops the run whatever its folder of force stops is", async () => {
    const dataDir = scratchDir("run-force-");
    writeFileSync(join(dataDir, RUN_FORCE_DIR), "not a folder");
    const { run, words } = await watchingRun(dataDir, STARTED);
    const gone = new Promise<number | null>((resolve) => run.once("exit", (code) => resolve(code)));
    await pause(500);
    expect(words).toEqual(["started"]);
    process.kill(ownedPid(run), "SIGTERM");
    expect(await gone).toBe(0);
    expect(words).toEqual(["started", "stopped"]);
  });

  // Its pipe is found as its own at the end, and removing it fails: the run says so in its log and
  // stops as it would, and the pipe stays.
  it("stops the run when its pipe cannot be cleared at the end", async () => {
    const dataDir = scratchDir("run-force-");
    const { run, pid, words, logged } = await watchingRun(dataDir, STARTED, { removeFails: true });
    await expect.poll(() => words, { timeout: 10_000 }).toContain("ready");
    const own = join(dataDir, RUN_FORCE_DIR, runForceWakeFile(pid, STARTED));
    expect(runPipeThere(dataDir, { pid, startedAt: STARTED })).toBe(true);
    const gone = new Promise<number | null>((resolve) => run.once("exit", (code) => resolve(code)));
    process.kill(pid, "SIGTERM");
    expect(await gone).toBe(0);
    expect(words).toContain("stopped");
    expect(logged()).toContain(`could not remove ${own}`);
    expect(runPipeThere(dataDir, { pid, startedAt: STARTED })).toBe(true);
  });

  it("says it can be ended by force again after a failed reading, never after its folder was made again", async () => {
    const dataDir = scratchDir("run-force-");
    const dir = join(dataDir, RUN_FORCE_DIR);
    const { run, pid, words } = await watchingRun(dataDir, STARTED);
    await expect.poll(() => words, { timeout: 10_000 }).toEqual(["started", "ready"]);
    // The same folder, out of its place a moment with a file there instead, so reading it fails for
    // any account, then back.
    renameSync(dir, `${dir}-aside`);
    writeFileSync(dir, "");
    await expect.poll(() => words).toEqual(["started", "ready", "unready"]);
    rmSync(dir);
    renameSync(`${dir}-aside`, dir);
    await expect.poll(() => words).toEqual(["started", "ready", "unready", "ready"]);
    // The folder made again at once, between two of its readings, so none of them fails.
    renameSync(dir, `${dir}-old`);
    mkdirSync(dir);
    await expect.poll(() => words).toEqual(["started", "ready", "unready", "ready", "unready"]);
    // Its reading reads the new folder (many times over at every 50 ms), and it says nothing more.
    await pause(1_000);
    expect(words).toEqual(["started", "ready", "unready", "ready", "unready"]);
    // Asked to end, as the window's Restart it would ask: nothing is asked, and it goes on.
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 1_000)).toBe(
      "unasked",
    );
    expect(left(dataDir)).toEqual([]);
    expect(run.exitCode).toBeNull();
    expect(processAlive(pid)).toBe(true);
  });

  it("says it can be ended by force no more once its pipe alone is taken away", async () => {
    const dataDir = scratchDir("run-force-");
    const { pid, words } = await watchingRun(dataDir, STARTED);
    await expect.poll(() => words, { timeout: 10_000 }).toEqual(["started", "ready"]);
    rmSync(join(dataDir, RUN_FORCE_DIR, runForceWakeFile(pid, STARTED)));
    await expect.poll(() => words).toEqual(["started", "ready", "unready"]);
    await pause(500);
    expect(words).toEqual(["started", "ready", "unready"]);
  });
});

describe("a run that does not answer, ended by force", () => {
  it("ends the stuck run its stop names by process and start, and no bystander", async () => {
    const dataDir = scratchDir("run-force-");
    const { run, pid } = await stuckRun(dataDir, STARTED);
    const bystander = await stuckRun(dataDir, OTHER_START);
    const gone = exited(run);
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED })).toBe("ended");
    await endedByForce(gone, pid);
    expect(processAlive(bystander.pid)).toBe(true);
    expect(left(dataDir)).toEqual([]);
  });

  // A program that took the named run's process number knows another start. On a Mac or Linux it
  // holds no pipe of the named run's, so nothing is asked of it; on Windows, which keeps no pipe, it
  // reads the stop as another's and keeps going, and the stop is reported as withdrawn, never as
  // ended, then taken away.
  it("leaves a program under the named number that knows another start", async () => {
    const dataDir = scratchDir("run-force-");
    const holder = await stuckRun(dataDir, OTHER_START);
    expect(
      await endRunByForce(dataDir, { pid: holder.pid, startedAt: STARTED }, processAlive, 1_000),
    ).toBe(POSIX ? "unasked" : "withdrawn");
    expect(processAlive(holder.pid)).toBe(true);
    expect(holder.run.exitCode).toBeNull();
    expect(left(dataDir)).toEqual([]);
  });

  // Two attempts at once, for two runs: each moves only its own stop, so withdrawing one never
  // takes the other's away, and each is answered for its own run. The second run reads its folder
  // too seldom to read its stop within that stop's time.
  it("keeps overlapping attempts apart", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED);
    const holder = await stuckRun(dataDir, OTHER_START, { every: 60_000 });
    const [ended, withdrawn] = await Promise.all([
      endRunByForce(dataDir, { pid: run.pid, startedAt: STARTED }, processAlive, 2_000),
      endRunByForce(dataDir, { pid: holder.pid, startedAt: OTHER_START }, processAlive, 300),
    ]);
    expect([ended, withdrawn]).toEqual(["ended", "withdrawn"]);
    expect(processAlive(holder.pid)).toBe(true);
    expect(left(dataDir)).toEqual([]);
  });

  // A run whose whole process is stopped, as a fully frozen first mate's: its own helper, woken on
  // its pipe, lets that process alone go on, which ends nothing, and its own reading then ends it.
  // A stopped program in its own process group, and one in another group, both stay stopped.
  it.skipIf(!POSIX)(
    "lets a stopped run alone go on through its own helper and ends it",
    async () => {
      const dataDir = scratchDir("run-force-");
      const { run, pid, sibling, helperReady } = await stuckRun(dataDir, STARTED, {
        helper: true,
        sibling: true,
      });
      if (sibling === null) throw new Error("the run did not start its sibling");
      // The helper says it is ready only once it holds the pipe and found the run leading its group.
      expect(helperReady).toBe(true);
      const bystander = await started(spawn("sleep", ["30"], { stdio: "ignore", detached: true }));
      const other = ownedPid(bystander);
      try {
        process.kill(other, "SIGSTOP");
        process.kill(sibling, "SIGSTOP");
        await expect.poll(() => stopped(other) && stopped(sibling)).toBe(true);
        process.kill(pid, "SIGSTOP");
        await expect.poll(() => stopped(pid)).toBe(true);
        const gone = exited(run);
        const named = { pid, startedAt: STARTED };
        expect(
          await endRunByForce(dataDir, named, processAlive, undefined, () =>
            wakeRun(dataDir, named),
          ),
        ).toBe("ended");
        await endedByForce(gone, pid);
        expect(stopped(other)).toBe(true);
        expect(stopped(sibling)).toBe(true);
        expect(left(dataDir)).toEqual([]);
      } finally {
        // A stopped program cannot end on its own, so its number is still its own here.
        if (stopped(sibling)) process.kill(sibling, "SIGKILL");
      }
    },
  );

  // A force stop left by an asker that quit is past its time, or passes it within the current
  // second, which the helper reads only to the second: waking the run on its pipe then lets nothing
  // go on, so a run stopped on purpose stays stopped.
  it.skipIf(!POSIX)(
    "leaves a stopped run stopped for a stop past its time or in its last second",
    async () => {
      const dataDir = scratchDir("run-force-");
      const { pid } = await stuckRun(dataDir, STARTED, { helper: true });
      process.kill(pid, "SIGSTOP");
      await expect.poll(() => stopped(pid)).toBe(true);
      writeStop(dataDir, "stale", { pid, startedAt: STARTED, until: Date.now() - 1_000 });
      wakeRun(dataDir, { pid, startedAt: STARTED });
      await pause(500);
      expect(stopped(pid)).toBe(true);
      // Early in a second, a stop whose time ends later in that same second.
      while (Date.now() % 1_000 > 300) await pause(20);
      const second = Math.floor(Date.now() / 1_000) * 1_000;
      writeStop(dataDir, "last-second", { pid, startedAt: STARTED, until: second + 950 });
      wakeRun(dataDir, { pid, startedAt: STARTED });
      await pause(500);
      expect(stopped(pid)).toBe(true);
    },
  );

  // A helper whose run does not lead its own process group could signal another program under the
  // group's number, so it says nothing and ends: a run that starts it never says it can be ended by
  // force.
  it.skipIf(!POSIX)(
    "says nothing ready from a helper whose run does not lead its group",
    async () => {
      const dir = join(scratchDir("run-force-"), RUN_FORCE_DIR);
      mkdirSync(dir, { recursive: true });
      const pipe = join(dir, runForceWakeFile(process.pid, STARTED));
      expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
      const held = openSync(pipe, constants.O_RDWR);
      try {
        const helper = await started(
          spawn(
            "/bin/sh",
            ["-c", RUN_FORCE_WAKE_SOURCE, "sh", pipe, "1", runForceNeedle(1, STARTED), dir],
            { stdio: ["ignore", "pipe", "ignore"] },
          ),
        );
        let said = "";
        helper.stdout?.on("data", (data: Buffer) => {
          said += String(data);
        });
        await exited(helper);
        expect(said).toBe("");
      } finally {
        closeSync(held);
      }
    },
  );

  // A run gone after committing its stop, while another program holds its number (stood in by a
  // reading that says the number is alive): its own pipe, which only it and its helper held, is let
  // go, so the stop is called ended, not waited on for as long as that other program runs.
  it.skipIf(!POSIX)(
    "calls a committed run ended once its pipe is let go, though its number is taken",
    async () => {
      const dataDir = scratchDir("run-force-");
      const { run, pid } = await stuckRun(dataDir, STARTED, { helper: true });
      const gone = exited(run);
      expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, () => true, 2_000)).toBe(
        "ended",
      );
      await endedByForce(gone, pid);
    },
  );

  // The review of INF-5409: a run already gone at the press is asked nothing, though another
  // program holds its number by then (stood in by a liveness reading that says the number runs), as
  // Windows tells by the run's birth: its pipe nobody holds, its pipe not there at the first look,
  // as where it ended between its helper's pipe going and its note, or its pipe found and cleared
  // since by a later run. Only an exit after the ask is told as the stop's end (above).
  it.skipIf(!POSIX)(
    "asks nothing of a run already gone at the press, though its number is taken",
    async () => {
      const run = { pid: 4242, startedAt: STARTED };
      const pipe = runForceWakeFile(run.pid, run.startedAt);
      const unheld = scratchDir("run-force-");
      mkdirSync(join(unheld, RUN_FORCE_DIR), { recursive: true });
      expect(spawnSync("mkfifo", ["-m", "600", join(unheld, RUN_FORCE_DIR, pipe)]).status).toBe(0);
      expect(await endRunByForce(unheld, run, () => true, 2_000)).toBe("unasked");
      expect(readdirSync(join(unheld, RUN_FORCE_DIR))).toEqual([pipe]);
      const absent = scratchDir("run-force-");
      mkdirSync(join(absent, RUN_FORCE_DIR), { recursive: true });
      expect(await endRunByForce(absent, run, () => true, 2_000)).toBe("unasked");
      expect(readdirSync(join(absent, RUN_FORCE_DIR))).toEqual([]);
      const pruned = scratchDir("run-force-");
      mkdirSync(join(pruned, RUN_FORCE_DIR), { recursive: true });
      expect(spawnSync("mkfifo", ["-m", "600", join(pruned, RUN_FORCE_DIR, pipe)]).status).toBe(0);
      const piped = runPipeThere(pruned, run);
      expect(piped).toBe(true);
      rmSync(join(pruned, RUN_FORCE_DIR, pipe));
      expect(
        await endRunByForce(
          pruned,
          run,
          () => true,
          2_000,
          () => {},
          piped,
        ),
      ).toBe("unasked");
      expect(readdirSync(join(pruned, RUN_FORCE_DIR))).toEqual([]);
    },
  );

  // A helper held up between finding a stop and letting its run go on, past the stop's time (stood
  // in by a search path whose reading of a file takes longer than the stop has left): it reads the
  // time again just before the signal, so a run stopped on purpose stays stopped.
  it.skipIf(!POSIX)(
    "lets nothing go on for a stop whose time passed while the helper read it",
    async () => {
      const dataDir = scratchDir("run-force-");
      const cat = spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();
      const slow = scratchDir("run-force-path-");
      writeFileSync(join(slow, "cat"), `#!/bin/sh\nsleep 2.5\nexec ${cat} "$@"\n`, { mode: 0o755 });
      const { pid } = await stuckRun(dataDir, STARTED, {
        helper: true,
        path: `${slow}:${process.env.PATH ?? ""}`,
      });
      process.kill(pid, "SIGSTOP");
      await expect.poll(() => stopped(pid)).toBe(true);
      writeStop(dataDir, "slow", { pid, startedAt: STARTED, until: Date.now() + 2_000 });
      wakeRun(dataDir, { pid, startedAt: STARTED });
      await pause(3_500);
      expect(stopped(pid)).toBe(true);
    },
  );

  // A stopped run with no helper to let it go on cannot read in time: its stop is withdrawn when
  // the wait is over, and the run, going on again, never acts on it later.
  it.skipIf(!POSIX)(
    "withdraws a stop the run could not read in time, so the run never ends on it later",
    async () => {
      const dataDir = scratchDir("run-force-");
      const { run, pid } = await stuckRun(dataDir, STARTED);
      process.kill(pid, "SIGSTOP");
      // Less than a second of its time is left from the start, so nothing is ever woken for it.
      let woken = 0;
      try {
        expect(
          await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 500, () => {
            woken++;
          }),
        ).toBe("withdrawn");
        expect(woken).toBe(0);
      } finally {
        process.kill(pid, "SIGCONT");
      }
      await pause(500);
      expect(run.exitCode).toBeNull();
      expect(run.signalCode).toBeNull();
      expect(left(dataDir)).toEqual([]);
    },
  );

  // The review of INF-5409: on a Mac or Linux a stop is written only once a program is seen holding
  // the run's pipe. A pipe whose holding cannot be told, as one this account may not open, is no
  // proof the named run is there, so a reused number alone (stood in by a reading that says the
  // number runs) is asked nothing.
  it.skipIf(!POSIX)("asks nothing where the run's pipe cannot be told to be held", async () => {
    const dataDir = scratchDir("run-force-");
    const run = { pid: 4242, startedAt: STARTED };
    mkdirSync(join(dataDir, RUN_FORCE_DIR));
    const made = spawnSync("mkfifo", [
      "-m",
      "000",
      join(dataDir, RUN_FORCE_DIR, runForceWakeFile(run.pid, run.startedAt)),
    ]);
    expect(made.status).toBe(0);
    expect(runPipeThere(dataDir, run)).toBe(true);
    expect(await endRunByForce(dataDir, run, () => true, 1_000)).toBe("unasked");
    expect(left(dataDir)).toEqual([]);
  });

  // The review of INF-5409: a stop whose files went with its folder, made again since it was
  // written, can no longer be claimed or committed by the run, which still runs (stood in by a
  // reading that says its number does): once its time is over it is withdrawn, never waited on for
  // good, and never told as the stop's end, and nothing is woken for it meanwhile. On a Mac or
  // Linux the run's pipe, held open here as the run holds it, went with that folder too: a pipe
  // gone with its folder is no proof the run ended, so it is not called gone.
  it("withdraws a stop whose files went with its folder, once its time is over", async () => {
    const dataDir = scratchDir("run-force-");
    const dir = join(dataDir, RUN_FORCE_DIR);
    const run = { pid: 4242, startedAt: STARTED };
    const holding = POSIX ? holdPipe(dataDir, run) : null;
    let woken = 0;
    try {
      const asked = endRunByForce(
        dataDir,
        run,
        () => true,
        2_500,
        () => void woken++,
        POSIX,
      );
      await expect.poll(() => left(dataDir).length).toBe(1);
      await expect.poll(() => woken).toBe(1);
      rmSync(dir, { recursive: true });
      mkdirSync(dir);
      expect(await asked).toBe("withdrawn");
      expect(woken).toBe(1);
      expect(left(dataDir)).toEqual([]);
    } finally {
      if (holding !== null) closeSync(holding);
    }
  });

  // The review of INF-5409: a stop the run was seen to commit is waited for until the run is gone,
  // even once its file went with its folder, and then called ended, never withdrawn: the run acts
  // on it, and on Windows its task is started again only once it is gone.
  it("waits on a stop seen committed whose file went with its folder, then calls it ended", async () => {
    const dataDir = scratchDir("run-force-");
    const dir = join(dataDir, RUN_FORCE_DIR);
    const run = { pid: 4242, startedAt: STARTED };
    let running = true;
    let answer: string | null = null;
    const asked = endRunByForce(
      dataDir,
      run,
      () => running,
      300,
      () => {},
      true,
      () => true,
    ).then((end) => {
      answer = end;
      return end;
    });
    await expect.poll(() => left(dataDir)).toHaveLength(1);
    const [pending] = left(dataDir);
    renameSync(join(dir, pending ?? ""), join(dir, (pending ?? "").replace(/\.json$/, ".ended")));
    // Read as committed (at every 100 ms), then gone with its folder, past its time.
    await pause(300);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    await pause(800);
    expect(answer).toBeNull();
    running = false;
    expect(await asked).toBe("ended");
  });

  // A run that ends on its own after its stop was written and before it claimed it was not ended
  // by that stop: the stop answers that it is gone, never that it ended it.
  it("answers gone for a run that ended on its own before claiming its stop", async () => {
    const dataDir = scratchDir("run-force-");
    const { run, pid } = await stuckRun(dataDir, STARTED, { every: 10_000 });
    const asked = endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 5_000);
    await expect.poll(() => left(dataDir).some((name) => name.endsWith(".json"))).toBe(true);
    const gone = exited(run);
    process.kill(pid, "SIGTERM");
    if (POSIX) expect(await gone).toBe("SIGTERM");
    expect(await asked).toBe("gone");
    expect(left(dataDir)).toEqual([]);
  });

  // A stop is acted on only where the run claimed it within its time. One the run first claims
  // after its time, as a reading held up past it, is declined: the run goes on.
  it("declines a stop the run claims only once its time is over", async () => {
    const dataDir = scratchDir("run-force-");
    const { run, pid } = await stuckRun(dataDir, STARTED, { every: 800 });
    writeStop(dataDir, "late", { pid, startedAt: STARTED, until: Date.now() + 100 });
    await expect.poll(() => left(dataDir), { timeout: 5_000 }).toEqual(["late.declined"]);
    await pause(200);
    expect(run.exitCode).toBeNull();
    expect(run.signalCode).toBeNull();
  });

  // A run held up between claiming its stop and committing it, past the stop's time: the asker takes
  // the claim back, and the run, committing only by moving that same claim on, finds it gone and
  // never acts. Nothing is called ended.
  it("withdraws a claim the run has not committed once its time is over, and the run never acts on it", async () => {
    const dataDir = scratchDir("run-force-");
    const heldUp = `
      const { workerData } = require("node:worker_threads");
      const { readdirSync, renameSync } = require("node:fs");
      const { join } = require("node:path");
      setInterval(() => {
        for (const name of readdirSync(workerData.dir).filter((n) => n.endsWith(".json"))) {
          const taken = join(workerData.dir, name.replace(/\\.json$/, ".taken"));
          renameSync(join(workerData.dir, name), taken);
          setTimeout(() => {
            try {
              renameSync(taken, taken.replace(/\\.taken$/, ".ended"));
            } catch {
              return;
            }
            process.kill(process.pid, "SIGKILL");
          }, 900);
        }
      }, 50);
    `;
    const { run, pid } = await stuckRun(dataDir, STARTED, { program: heldUp });
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 300)).toBe(
      "withdrawn",
    );
    await pause(1_200);
    expect(run.exitCode).toBeNull();
    expect(run.signalCode).toBeNull();
    expect(left(dataDir)).toEqual([]);
  });

  // A run that claimed its stop and ended on its own before committing it was not ended by that
  // stop: the attempt answers gone, which never lets a window retire the run's job.
  it("answers gone for a run that ended after claiming its stop and before committing it", async () => {
    const dataDir = scratchDir("run-force-");
    const claimsThenLeaves = `
      const { workerData } = require("node:worker_threads");
      const { readdirSync, renameSync } = require("node:fs");
      const { join } = require("node:path");
      setInterval(() => {
        for (const name of readdirSync(workerData.dir).filter((n) => n.endsWith(".json"))) {
          renameSync(join(workerData.dir, name), join(workerData.dir, name.replace(/\\.json$/, ".taken")));
          process.kill(process.pid, "SIGTERM");
        }
      }, 50);
    `;
    const { run, pid } = await stuckRun(dataDir, STARTED, { program: claimsThenLeaves });
    const gone = exited(run);
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 5_000)).toBe(
      "gone",
    );
    if (POSIX) expect(await gone).toBe("SIGTERM");
    expect(left(dataDir)).toEqual([]);
  });

  // A run that committed its stop is waited for, past the stop's time, until it is gone, and only
  // then called ended: a commitment is never taken back.
  it("waits on a stop the run committed until the run is gone, then calls it ended", async () => {
    const dataDir = scratchDir("run-force-");
    const commitsOnly = `
      const { workerData } = require("node:worker_threads");
      const { readdirSync, renameSync } = require("node:fs");
      const { join } = require("node:path");
      setInterval(() => {
        for (const name of readdirSync(workerData.dir).filter((n) => n.endsWith(".json"))) {
          const taken = join(workerData.dir, name.replace(/\\.json$/, ".taken"));
          renameSync(join(workerData.dir, name), taken);
          renameSync(taken, taken.replace(/\\.taken$/, ".ended"));
        }
      }, 50);
    `;
    const { run, pid } = await stuckRun(dataDir, STARTED, { program: commitsOnly });
    let answer: string | null = null;
    const asked = endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 300).then(
      (end) => {
        answer = end;
        return end;
      },
    );
    await pause(1_000);
    expect(answer).toBeNull();
    expect(left(dataDir).some((name) => name.endsWith(".ended"))).toBe(true);
    const gone = exited(run);
    run.kill("SIGKILL");
    await gone;
    expect(await asked).toBe("ended");
    expect(left(dataDir)).toEqual([]);
  });
});
