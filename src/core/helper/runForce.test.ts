import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { processAlive } from "./lock";
import { type RunAgentContext, restartRunAgent } from "./runAgent";
import {
  endRunByForce,
  RUN_FORCE_DIR,
  RUN_FORCE_WAKE_SOURCE,
  RUN_FORCE_WATCH_SOURCE,
  runForceLifeFile,
  runForceNeedle,
  runForceWakeFile,
  runPipeSeen,
  runPipeThere,
  wakeRun,
} from "./runForce";
import { RUN_RECORD_FILE } from "./windowsTask";

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
): Promise<{
  run: ChildProcess;
  pid: number;
  sibling: number | null;
  helperReady: boolean;
  helper: number | null;
}> {
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
    // On a Mac or Linux the run holds its own pipes, as one that says a force stop can end it does.
    const pipe = process.env.PIPE ? join(process.env.DIR, process.env.PIPE.replace("wake-0-", "wake-" + process.pid + "-")) : null;
    if (pipe) {
      const life = join(process.env.DIR, process.env.LIFE.replace("life-0-", "life-" + process.pid + "-"));
      spawnSync("mkfifo", ["-m", "600", pipe, life]);
      fs.openSync(life, fs.constants.O_RDWR);
      fs.openSync(pipe, fs.constants.O_RDWR);
    }
    let helperPid = 0;
    if (process.env.HELPER) {
      const helper = spawn("/bin/sh", ["-c", process.env.HELPER, "sh", pipe, String(process.pid), process.env.NEEDLE.replace("PID", String(process.pid)), process.env.DIR], { stdio: ["ignore", "pipe", "ignore"] });
      helperPid = helper.pid;
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
    say(() => process.stdout.write("ready " + sibling + " " + (helperReady ? 1 : 0) + " " + helperPid + "\\n", () => { for (;;) {} }));
  `;
  const run = spawn(process.execPath, ["-e", program], {
    env: {
      PATH: options.path ?? process.env.PATH ?? "",
      WATCH: options.program ?? RUN_FORCE_WATCH_SOURCE,
      DIR: join(dataDir, RUN_FORCE_DIR),
      STARTED: startedAt,
      EVERY: String(options.every ?? 50),
      ...(POSIX
        ? { PIPE: runForceWakeFile(0, startedAt), LIFE: runForceLifeFile(0, startedAt) }
        : {}),
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
  const [, siblingSaid, helperSaid, helperPidSaid] = said.trim().split(" ");
  const sibling = Number(siblingSaid);
  const helper = Number(helperPidSaid);
  return {
    run,
    pid: ownedPid(run),
    sibling: sibling > 0 ? sibling : null,
    helperReady: helperSaid === "1",
    helper: helper > 0 ? helper : null,
  };
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.signalCode);
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

/** What is left in the folder of force stops, besides each run's own pipes. */
function left(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, RUN_FORCE_DIR)).filter(
      (name) => !name.startsWith("wake-") && !name.startsWith("life-"),
    );
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

/** Makes `run`'s own two pipes, mode `mode`, answering their paths in the folder of force stops. */
function makePipes(
  dataDir: string,
  run: { pid: number; startedAt: string },
  mode = "600",
): { wake: string; life: string } {
  const dir = join(dataDir, RUN_FORCE_DIR);
  mkdirSync(dir, { recursive: true });
  const wake = join(dir, runForceWakeFile(run.pid, run.startedAt));
  const life = join(dir, runForceLifeFile(run.pid, run.startedAt));
  expect(spawnSync("mkfifo", ["-m", mode, wake, life]).status).toBe(0);
  return { wake, life };
}

/**
 * Makes `run`'s own pipes and holds its lifetime pipe open as the run does, answering what holds
 * it: closing it is the run's process ending.
 */
function holdPipe(dataDir: string, run: { pid: number; startedAt: string }): number {
  return openSync(makePipes(dataDir, run).life, constants.O_RDWR);
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
  options: { removeFails?: boolean; every?: number; holdAfterStop?: boolean } = {},
): Promise<{ run: ChildProcess; pid: number; words: string[]; logged: () => string }> {
  const program = `
    const { pathToFileURL } = await import("node:url");
    const fs = await import("node:fs");
    const { syncBuiltinESMExports } = await import("node:module");
    const { watchRunForce } = await import(pathToFileURL(process.env.SOURCE).href);
    const say = (word) => process.stdout.write(word + "\\n");
    const stop = watchRunForce(process.env.DATA, process.env.STARTED, Number(process.env.EVERY), (can) => say(can ? "ready" : "unready"));
    say("started");
    process.on("SIGTERM", () => {
      if (process.env.REMOVE_FAILS) {
        fs.default.rmSync = (path) => {
          throw Object.assign(new Error("EACCES: permission denied, unlink " + path), { code: "EACCES" });
        };
        syncBuiltinESMExports();
      }
      stop();
      // Held after its reading and helper ended, as a run still finishing its last words is.
      if (process.env.HOLD_AFTER_STOP) {
        process.stdout.write("stopped\\n");
        process.on("SIGUSR2", () => process.exit(0));
        return;
      }
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
        EVERY: String(options.every ?? 50),
        ...(options.removeFails ? { REMOVE_FAILS: "1" } : {}),
        ...(options.holdAfterStop ? { HOLD_AFTER_STOP: "1" } : {}),
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

  // The review of INF-5409: a run whose reading and helper already ended, their pipes taken from
  // the folder, is still there until its process ends, as a command's last words are written after
  // them. Its number taken by another program once it ends (stood in by a reading that says the
  // number always runs) changes nothing: the stop asked of it is called gone only once the process
  // has ended, never while it is still there.
  it("calls an asked run gone only once its process ends, after its reading and helper ended", async () => {
    const dataDir = scratchDir("run-force-");
    // Its reading reads the folder at its start and then not again within this test, so the stop
    // asked of it is never acted on.
    const { run, pid, words } = await watchingRun(dataDir, STARTED, {
      every: 60_000,
      holdAfterStop: true,
    });
    await expect.poll(() => words, { timeout: 10_000 }).toEqual(["started", "ready"]);
    let answer: string | null = null;
    const asked = endRunByForce(dataDir, { pid, startedAt: STARTED }, () => true, 4_000).then(
      (end) => {
        answer = end;
      },
    );
    await pause(300);
    process.kill(pid, "SIGTERM");
    await expect.poll(() => words).toContain("stopped");
    expect(runPipeThere(dataDir, { pid, startedAt: STARTED })).toBe(false);
    await pause(800);
    expect(answer).toBeNull();
    expect(processAlive(pid)).toBe(true);
    const gone = exited(run);
    process.kill(pid, "SIGUSR2");
    await gone;
    await asked;
    expect(answer).toBe("gone");
    expect(left(dataDir)).toEqual([]);
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
        const seen = runPipeSeen(dataDir, named);
        expect(seen).not.toBeNull();
        expect(
          await endRunByForce(dataDir, named, processAlive, undefined, () =>
            wakeRun(dataDir, named, undefined, seen),
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

  // The review of INF-5409: the asker reads whether the run is there through the run's lifetime
  // pipe, never the helper's own. The run holds both (held open here as it holds them, its number
  // stood in by a reading that says it runs); its helper, held up a while, reads its pipe only
  // after many of the asker's readings passed, and still finds the one line it was woken with.
  it.skipIf(!POSIX)(
    "leaves the helper's line for it while the asker reads whether the run is there",
    async () => {
      const dataDir = scratchDir("run-force-");
      const run = { pid: 4242, startedAt: STARTED };
      const life = holdPipe(dataDir, run);
      const wakePipe = join(dataDir, RUN_FORCE_DIR, runForceWakeFile(run.pid, run.startedAt));
      const held = openSync(wakePipe, constants.O_RDWR);
      const seen = runPipeSeen(dataDir, run);
      expect(seen).not.toBeNull();
      let woken = 0;
      try {
        const asked = endRunByForce(
          dataDir,
          run,
          () => true,
          2_500,
          () => {
            // One line only, written at the first wake: a line the asker took is never written again.
            if (woken++ === 0) wakeRun(dataDir, run, undefined, seen);
          },
        );
        // Several of the asker's readings pass before the helper reads.
        await pause(700);
        expect(woken).toBe(1);
        const helper = openSync(wakePipe, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const line = Buffer.alloc(16);
          expect(readSync(helper, line, 0, 16, null)).toBe(1);
          expect(line.toString("utf8", 0, 1)).toBe("\n");
        } finally {
          closeSync(helper);
        }
        expect(await asked).toBe("withdrawn");
      } finally {
        closeSync(held);
        closeSync(life);
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
      wakeRun(
        dataDir,
        { pid, startedAt: STARTED },
        undefined,
        runPipeSeen(dataDir, { pid, startedAt: STARTED }),
      );
      await pause(500);
      expect(stopped(pid)).toBe(true);
      // Early in a second, a stop whose time ends later in that same second.
      while (Date.now() % 1_000 > 300) await pause(20);
      const second = Math.floor(Date.now() / 1_000) * 1_000;
      writeStop(dataDir, "last-second", { pid, startedAt: STARTED, until: second + 950 });
      wakeRun(
        dataDir,
        { pid, startedAt: STARTED },
        undefined,
        runPipeSeen(dataDir, { pid, startedAt: STARTED }),
      );
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
      const pipes = [
        runForceLifeFile(run.pid, run.startedAt),
        runForceWakeFile(run.pid, run.startedAt),
      ];
      const unheld = scratchDir("run-force-");
      makePipes(unheld, run);
      expect(await endRunByForce(unheld, run, () => true, 2_000)).toBe("unasked");
      expect(readdirSync(join(unheld, RUN_FORCE_DIR)).sort()).toEqual(pipes);
      const absent = scratchDir("run-force-");
      mkdirSync(join(absent, RUN_FORCE_DIR), { recursive: true });
      expect(await endRunByForce(absent, run, () => true, 2_000)).toBe("unasked");
      expect(readdirSync(join(absent, RUN_FORCE_DIR))).toEqual([]);
      const pruned = scratchDir("run-force-");
      const made = makePipes(pruned, run);
      const piped = runPipeSeen(pruned, run);
      expect(piped).not.toBeNull();
      rmSync(made.wake);
      rmSync(made.life);
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
      wakeRun(
        dataDir,
        { pid, startedAt: STARTED },
        undefined,
        runPipeSeen(dataDir, { pid, startedAt: STARTED }),
      );
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
    makePipes(dataDir, run, "000");
    expect(runPipeThere(dataDir, run)).toBe(true);
    expect(await endRunByForce(dataDir, run, () => true, 1_000)).toBe("unasked");
    expect(left(dataDir)).toEqual([]);
  });

  // The review of INF-5409: once asked, only the pipe found at the press, there with nobody holding
  // it, is the run gone. The run still runs (stood in by a reading that says its number does) and
  // holds its pipe, held open here as the run holds it: with that pipe alone taken away from its
  // folder, or another pipe nobody holds put in its place, nothing is told of the run, so the stop
  // is never called gone while the run is there, and is withdrawn once its time is over.
  it.skipIf(!POSIX)("never calls a run gone whose pipe alone was taken or replaced", async () => {
    for (const replace of [false, true]) {
      const dataDir = scratchDir("run-force-");
      const run = { pid: 4242, startedAt: STARTED };
      const pipe = join(dataDir, RUN_FORCE_DIR, runForceLifeFile(run.pid, run.startedAt));
      const holding = holdPipe(dataDir, run);
      try {
        let answer: string | null = null;
        const asked = endRunByForce(dataDir, run, () => true, 600).then((end) => {
          answer = end;
          return end;
        });
        expect(left(dataDir)).toHaveLength(1);
        rmSync(pipe);
        if (replace) expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
        await pause(400);
        expect(answer).toBeNull();
        expect(await asked).toBe("withdrawn");
        expect(left(dataDir)).toEqual([]);
      } finally {
        closeSync(holding);
      }
    }
  });

  // The review of INF-5409: the pipe is told by the file it was found as, before the run's record
  // is read, never by its name. Another file put in its place before the stop is asked, a file
  // anyone may open to write or a pipe another program holds, is not the run's pipe held, so
  // nothing is asked of whatever holds the run's number.
  it.skipIf(!POSIX)("asks nothing where another file took the run's pipe's place", async () => {
    for (const other of ["file", "pipe"] as const) {
      const dataDir = scratchDir("run-force-");
      const run = { pid: 4242, startedAt: STARTED };
      const pipe = join(dataDir, RUN_FORCE_DIR, runForceLifeFile(run.pid, run.startedAt));
      const holding = holdPipe(dataDir, run);
      const seen = runPipeSeen(dataDir, run);
      expect(seen).not.toBeNull();
      rmSync(pipe);
      if (other === "file") writeFileSync(pipe, "", { mode: 0o600 });
      else expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
      const holdingOther = other === "pipe" ? openSync(pipe, constants.O_RDWR) : null;
      try {
        expect(
          await endRunByForce(
            dataDir,
            run,
            () => true,
            1_000,
            () => {},
            seen,
          ),
        ).toBe("unasked");
        expect(left(dataDir)).toEqual([]);
      } finally {
        closeSync(holding);
        if (holdingOther !== null) closeSync(holdingOther);
      }
    }
  });

  // The review of INF-5409: a stop whose files went with its folder, made again since it was
  // written, before its asker read any commitment, is not known to be withdrawn: the run may have
  // committed it in the moment before, and ends on it once it goes on, so it is waited for, past
  // its time, until it is gone, whether it committed it there (moved to `.ended` and gone with the
  // folder before the next reading) or never claimed it. Called gone, as nothing shows the stop
  // ended it; a stop still in its folder past its time is withdrawn (above). Its first wake, while
  // it was there to read with time left, is the only one: once its files are gone nothing is woken
  // for it again, though more than a wake interval of its time is left.
  it("waits on a stop whose files went with its folder until the run is gone", async () => {
    for (const committed of [true, false]) {
      const dataDir = scratchDir("run-force-");
      const dir = join(dataDir, RUN_FORCE_DIR);
      const run = { pid: 4242, startedAt: STARTED };
      let running = true;
      let answer: string | null = null;
      let woken = 0;
      const asked = endRunByForce(
        dataDir,
        run,
        () => running,
        2_500,
        () => void woken++,
        true,
        () => true,
      ).then((end) => {
        answer = end;
        return end;
      });
      expect(woken).toBe(1);
      const [pending = ""] = left(dataDir);
      expect(pending.endsWith(".json")).toBe(true);
      if (committed)
        renameSync(join(dir, pending), join(dir, pending.replace(/\.json$/, ".ended")));
      rmSync(dir, { recursive: true });
      mkdirSync(dir);
      await pause(2_800);
      expect(answer).toBeNull();
      expect(woken).toBe(1);
      running = false;
      expect(await asked).toBe("gone");
      expect(left(dataDir)).toEqual([]);
    }
  });

  // The review of INF-5409: a wake goes only to the pipe the run was found holding. Another file put
  // in its place, a pipe someone reads or a file anyone may write, receives nothing; the run's own
  // pipe receives the line.
  it.skipIf(!POSIX)("wakes only the pipe it found, never another file in its place", async () => {
    const dataDir = scratchDir("run-force-");
    const run = { pid: 4242, startedAt: STARTED };
    const pipe = makePipes(dataDir, run).wake;
    // Held as the run holds it, and read here without waiting for a line.
    const holding = openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK);
    const lines = (fd: number) => {
      try {
        return readSync(fd, Buffer.alloc(16), 0, 16, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") return 0;
        throw error;
      }
    };
    try {
      const seen = runPipeSeen(dataDir, run);
      expect(seen).not.toBeNull();
      wakeRun(dataDir, run, undefined, seen);
      expect(lines(holding)).toBe(1);
      rmSync(pipe);
      expect(spawnSync("mkfifo", ["-m", "600", pipe]).status).toBe(0);
      const other = openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK);
      try {
        wakeRun(dataDir, run, undefined, seen);
        expect(lines(other)).toBe(0);
      } finally {
        closeSync(other);
      }
      rmSync(pipe);
      writeFileSync(pipe, "", { mode: 0o600 });
      wakeRun(dataDir, run, undefined, seen);
      expect(readFileSync(pipe, "utf8")).toBe("");
      expect(lines(holding)).toBe(0);
    } finally {
      closeSync(holding);
    }
  });

  // The review of INF-5409: a stop the run committed is waited for through the pipe it was found
  // holding, read through that pipe itself, not its name. With the pipe taken away from its folder,
  // as a later run clears an earlier one's, and its number still taken (stood in by a reading that
  // says it runs), the run still holding it is waited for, and once it lets it go, as it does when it
  // ends, the stop is called ended.
  it.skipIf(!POSIX)(
    "tells a committed run's end through its pipe once that pipe is taken from its folder",
    async () => {
      const dataDir = scratchDir("run-force-");
      const dir = join(dataDir, RUN_FORCE_DIR);
      const run = { pid: 4242, startedAt: STARTED };
      const holding = holdPipe(dataDir, run);
      let released = false;
      try {
        let answer: string | null = null;
        const asked = endRunByForce(dataDir, run, () => true, 300).then((end) => {
          answer = end;
          return end;
        });
        const [pending = ""] = left(dataDir);
        renameSync(join(dir, pending), join(dir, pending.replace(/\.json$/, ".ended")));
        await pause(300);
        rmSync(join(dir, runForceLifeFile(run.pid, run.startedAt)));
        await pause(800);
        expect(answer).toBeNull();
        closeSync(holding);
        released = true;
        expect(await asked).toBe("ended");
        expect(left(dataDir)).toEqual([]);
      } finally {
        if (!released) closeSync(holding);
      }
    },
  );

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

// The review of INF-5409: only the pipes a run said it holds as it said a force stop can end it
// (its record's `pipes`) are its own to ask. Its pipes replaced at their names before the press, by
// pipes another program holds, while its record still says it can be ended, are no run's: the
// window's Restart asks, wakes and reads nothing, and the pipe in the helper's place receives
// nothing. The run's own pipes, as recorded, are asked, and the run (stood in by one that claims
// and commits its stop at its next reading) ends on it.
describe.skipIf(!POSIX)("a force stop the window's Restart asks", () => {
  const run = { pid: 4242, startedAt: STARTED };

  /** Makes `run`'s two pipes and holds each open as the run does: the files they are, and what holds them. */
  function heldPipes(dataDir: string): { pipes: { wake: Seen; life: Seen }; held: number[] } {
    const made = makePipes(dataDir, run);
    const held = [openSync(made.life, constants.O_RDWR), openSync(made.wake, constants.O_RDWR)];
    const seen = (path: string): Seen => {
      const stats = lstatSync(path);
      return { ino: stats.ino, dev: stats.dev };
    };
    return { pipes: { wake: seen(made.wake), life: seen(made.life) }, held };
  }
  type Seen = { ino: number; dev: number };

  /** A Mac's agent context on `dataDir`, its run claiming and committing a stop at its next reading. */
  function restartContext(dataDir: string, asked: string[][]): RunAgentContext {
    const dir = join(dataDir, RUN_FORCE_DIR);
    let gone = false;
    return {
      label: "com.infinitary.app.dev.run",
      dataDir,
      homeDir: scratchDir("run-force-home-"),
      uid: 502,
      unitsDir: "/nowhere",
      launcher: { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] },
      env: {},
      processes: {
        alive: () => {
          for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
            renameSync(join(dir, name), join(dir, name.replace(/\.json$/, ".ended")));
            asked.push(["end", String(run.pid)]);
            gone = true;
          }
          return !gone;
        },
        forceWaitMs: 2_000,
      },
      launchctl: async (args) => {
        asked.push([...args]);
        return { ok: true, output: "" };
      },
    };
  }

  function record(dataDir: string, pipes: { wake: Seen; life: Seen }): void {
    writeFileSync(
      join(dataDir, RUN_RECORD_FILE),
      `${JSON.stringify({ ...run, agent: true, recovers: true, pipes })}\n`,
    );
  }

  it("asks nothing through pipes put in the place of those the run recorded", async () => {
    const dataDir = scratchDir("run-force-");
    const own = heldPipes(dataDir);
    record(dataDir, own.pipes);
    const dir = join(dataDir, RUN_FORCE_DIR);
    const wakeName = runForceWakeFile(run.pid, run.startedAt);
    for (const name of [wakeName, runForceLifeFile(run.pid, run.startedAt)])
      renameSync(join(dir, name), join(dir, `${name}-old`));
    const substitute = heldPipes(dataDir);
    const asked: string[][] = [];
    try {
      expect(await restartRunAgent(restartContext(dataDir, asked), run)).toBe("untouched");
      expect(asked).toEqual([]);
      expect(left(dataDir).filter((name) => !name.endsWith("-old"))).toEqual([]);
      const reader = openSync(join(dir, wakeName), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        expect(() => readSync(reader, Buffer.alloc(16), 0, 16, null)).toThrow(/EAGAIN/);
      } finally {
        closeSync(reader);
      }
    } finally {
      for (const fd of [...own.held, ...substitute.held]) closeSync(fd);
    }
  });

  it("asks the run through the pipes it recorded", async () => {
    const dataDir = scratchDir("run-force-");
    const own = heldPipes(dataDir);
    record(dataDir, own.pipes);
    const asked: string[][] = [];
    try {
      expect(await restartRunAgent(restartContext(dataDir, asked), run)).toBe("restarted");
      expect(asked).toEqual([
        ["end", String(run.pid)],
        ["kickstart", "gui/502/com.infinitary.app.dev.run"],
      ]);
      expect(left(dataDir)).toEqual([]);
    } finally {
      for (const fd of own.held) closeSync(fd);
    }
  });
});
