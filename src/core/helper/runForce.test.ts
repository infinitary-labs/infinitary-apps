import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * let it go on, as `watchRunForce` starts them; with `sibling`, a program it
 * starts in its own process group, whose number it says; with `program`, a
 * reading of its own in place of the run's.
 */
async function stuckRun(
  dataDir: string,
  startedAt: string,
  options: { helper?: boolean; sibling?: boolean; every?: number; program?: string } = {},
): Promise<{ run: ChildProcess; pid: number; sibling: number | null }> {
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
    if (process.env.HELPER) {
      const pipe = join(process.env.DIR, process.env.PIPE.replace("wake-0-", "wake-" + process.pid + "-"));
      spawnSync("mkfifo", ["-m", "600", pipe]);
      fs.openSync(pipe, fs.constants.O_RDWR);
      spawn("/bin/sh", ["-c", process.env.HELPER, "sh", pipe, String(process.pid), process.env.NEEDLE.replace("PID", String(process.pid)), process.env.DIR], { stdio: "ignore" });
    }
    const sibling = process.env.SIBLING ? spawn("sleep", ["30"], { stdio: "ignore" }).pid : "";
    setTimeout(() => process.stdout.write("ready " + sibling + "\\n", () => { for (;;) {} }), 300);
  `;
  const run = spawn(process.execPath, ["-e", program], {
    env: {
      PATH: process.env.PATH ?? "",
      WATCH: options.program ?? RUN_FORCE_WATCH_SOURCE,
      DIR: join(dataDir, RUN_FORCE_DIR),
      STARTED: startedAt,
      EVERY: String(options.every ?? 50),
      ...(options.helper
        ? {
            HELPER: RUN_FORCE_WAKE_SOURCE,
            PIPE: runForceWakeFile(0, startedAt),
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
  const sibling = Number(said.trim().split(" ")[1]);
  return { run, pid: ownedPid(run), sibling: sibling > 0 ? sibling : null };
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.signalCode);
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

/** What is left in the folder of force stops. */
function left(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, RUN_FORCE_DIR));
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

/** What a POSIX run ended by its own force stop ends with: its own SIGKILL, never an ordinary exit. */
async function endedByForce(gone: Promise<NodeJS.Signals | null>, pid: number): Promise<void> {
  const signal = await gone;
  if (POSIX) expect(signal).toBe("SIGKILL");
  expect(processAlive(pid)).toBe(false);
}

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

  // A program that took the named run's process number knows another start: it reads the stop as
  // another's and keeps going, and the stop is reported as withdrawn, never as ended, then taken away.
  it("leaves a program under the named number that knows another start, and withdraws the stop", async () => {
    const dataDir = scratchDir("run-force-");
    const holder = await stuckRun(dataDir, OTHER_START);
    expect(
      await endRunByForce(dataDir, { pid: holder.pid, startedAt: STARTED }, processAlive, 1_000),
    ).toBe("withdrawn");
    expect(processAlive(holder.pid)).toBe(true);
    expect(holder.run.exitCode).toBeNull();
    expect(left(dataDir)).toEqual([]);
  });

  // Two attempts at once, for two runs: each moves only its own stop, so withdrawing one never
  // takes the other's away, and each is answered for its own run.
  it("keeps overlapping attempts apart", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED);
    const holder = await stuckRun(dataDir, OTHER_START);
    const [ended, withdrawn] = await Promise.all([
      endRunByForce(dataDir, { pid: run.pid, startedAt: STARTED }, processAlive, 2_000),
      endRunByForce(dataDir, { pid: holder.pid, startedAt: STARTED }, processAlive, 300),
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
      const { run, pid, sibling } = await stuckRun(dataDir, STARTED, {
        helper: true,
        sibling: true,
      });
      if (sibling === null) throw new Error("the run did not start its sibling");
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
        expect(left(dataDir).filter((name) => !name.startsWith("wake-"))).toEqual([]);
      } finally {
        // A stopped program cannot end on its own, so its number is still its own here.
        if (stopped(sibling)) process.kill(sibling, "SIGKILL");
      }
    },
  );

  // A force stop left by an asker that quit is past its time: waking the run on its pipe then
  // lets nothing go on, so a run stopped on purpose stays stopped.
  it.skipIf(!POSIX)("leaves a stopped run stopped for a stop past its time", async () => {
    const dataDir = scratchDir("run-force-");
    const { pid } = await stuckRun(dataDir, STARTED, { helper: true });
    writeStop(dataDir, "stale", { pid, startedAt: STARTED, until: Date.now() - 1_000 });
    process.kill(pid, "SIGSTOP");
    await expect.poll(() => stopped(pid)).toBe(true);
    wakeRun(dataDir, { pid, startedAt: STARTED });
    await pause(1_000);
    expect(stopped(pid)).toBe(true);
  });

  // A stopped run with no helper to let it go on cannot read in time: its stop is withdrawn when
  // the wait is over, and the run, going on again, never acts on it later.
  it.skipIf(!POSIX)(
    "withdraws a stop the run could not read in time, so the run never ends on it later",
    async () => {
      const dataDir = scratchDir("run-force-");
      const { run, pid } = await stuckRun(dataDir, STARTED);
      process.kill(pid, "SIGSTOP");
      try {
        expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 500)).toBe(
          "withdrawn",
        );
      } finally {
        process.kill(pid, "SIGCONT");
      }
      await pause(500);
      expect(run.exitCode).toBeNull();
      expect(run.signalCode).toBeNull();
      expect(left(dataDir)).toEqual([]);
    },
  );

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

  // A run that claimed its stop and has not acted on it, as one held up between its claim and its
  // end: the stop is never called withdrawn or ended while that lasts, and once the run declines
  // it, the attempt answers so and its files go.
  it("waits on a stop the run claimed until the run declines it", async () => {
    const dataDir = scratchDir("run-force-");
    const claimsOnly = `
      const { workerData } = require("node:worker_threads");
      const { readdirSync, renameSync } = require("node:fs");
      const { join } = require("node:path");
      setInterval(() => {
        for (const name of readdirSync(workerData.dir).filter((n) => n.endsWith(".json")))
          renameSync(join(workerData.dir, name), join(workerData.dir, name.replace(/\\.json$/, ".taken")));
      }, 50);
    `;
    const { run, pid } = await stuckRun(dataDir, STARTED, { program: claimsOnly });
    let answer: string | null = null;
    const asked = endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 300).then(
      (end) => {
        answer = end;
        return end;
      },
    );
    await pause(1_500);
    expect(answer).toBeNull();
    const [taken] = left(dataDir).filter((name) => name.endsWith(".taken"));
    if (!taken) throw new Error("the run did not claim its stop");
    renameSync(
      join(dataDir, RUN_FORCE_DIR, taken),
      join(dataDir, RUN_FORCE_DIR, taken.replace(/\.taken$/, ".declined")),
    );
    expect(await asked).toBe("withdrawn");
    expect(left(dataDir)).toEqual([]);
    expect(run.exitCode).toBeNull();
  });
});
