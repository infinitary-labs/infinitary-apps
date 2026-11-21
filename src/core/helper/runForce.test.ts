import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
    try {
      if (child.pid && POSIX) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
});

/**
 * A run whose main thread is stuck, reading force stops for `startedAt`
 * beside it once it says ready; with `helper`, also the shell that lets it
 * go on, as `watchRunForce` starts it; with `program`, a reading of its own
 * in place of the run's.
 */
async function stuckRun(
  dataDir: string,
  startedAt: string,
  options: { helper?: boolean; every?: number; program?: string } = {},
): Promise<ChildProcess> {
  const program = `
    const { Worker } = require("node:worker_threads");
    const { spawn } = require("node:child_process");
    new Worker(process.env.WATCH, {
      eval: true,
      workerData: { dir: process.env.DIR, startedAt: process.env.STARTED, every: Number(process.env.EVERY) },
    });
    if (process.env.HELPER)
      spawn("/bin/sh", ["-c", process.env.HELPER, "sh", String(process.pid), process.env.NEEDLE.replace("PID", String(process.pid)), process.env.DIR], { stdio: "ignore" });
    setTimeout(() => process.stdout.write("ready\\n", () => { for (;;) {} }), 300);
  `;
  const child = spawn(process.execPath, ["-e", program], {
    env: {
      PATH: process.env.PATH ?? "",
      WATCH: options.program ?? RUN_FORCE_WATCH_SOURCE,
      DIR: join(dataDir, RUN_FORCE_DIR),
      STARTED: startedAt,
      EVERY: String(options.every ?? 50),
      ...(options.helper
        ? {
            HELPER: RUN_FORCE_WAKE_SOURCE,
            NEEDLE: runForceNeedle(0, startedAt).replace("0", "PID"),
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
    detached: POSIX,
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", () => reject(new Error("the run ended before it was ready")));
  });
  return child;
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

describe("a run that does not answer, ended by force", () => {
  it("ends the stuck run its stop names by process and start, and no bystander", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED);
    const bystander = await stuckRun(dataDir, OTHER_START);
    const pid = run.pid ?? -1;
    const gone = exited(run);
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED })).toBe("ended");
    await gone;
    expect(processAlive(pid)).toBe(false);
    expect(processAlive(bystander.pid ?? -1)).toBe(true);
    expect(left(dataDir)).toEqual([]);
  });

  // A program that took the named run's process number knows another start: it reads the stop as
  // another's and keeps going, and the stop is reported as withdrawn, never as ended, then taken away.
  it("leaves a program under the named number that knows another start, and withdraws the stop", async () => {
    const dataDir = scratchDir("run-force-");
    const holder = await stuckRun(dataDir, OTHER_START);
    const pid = holder.pid ?? -1;
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 1_000)).toBe(
      "withdrawn",
    );
    expect(processAlive(pid)).toBe(true);
    expect(holder.exitCode).toBeNull();
    expect(left(dataDir)).toEqual([]);
  });

  // Two attempts at once, for two runs: each moves only its own stop, so withdrawing one never
  // takes the other's away, and each is answered for its own run.
  it("keeps overlapping attempts apart", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED);
    const holder = await stuckRun(dataDir, OTHER_START);
    const [ended, withdrawn] = await Promise.all([
      endRunByForce(dataDir, { pid: run.pid ?? -1, startedAt: STARTED }, processAlive, 2_000),
      endRunByForce(dataDir, { pid: holder.pid ?? -1, startedAt: STARTED }, processAlive, 300),
    ]);
    expect([ended, withdrawn]).toEqual(["ended", "withdrawn"]);
    expect(processAlive(holder.pid ?? -1)).toBe(true);
    expect(left(dataDir)).toEqual([]);
  });

  // A run whose whole process is stopped, as a fully frozen first mate's: its own helper lets its
  // group go on, which ends nothing, and its own reading then ends it. A stopped program in
  // another group stays stopped.
  it.skipIf(!POSIX)("lets a stopped run go on through its own helper and ends it", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED, { helper: true });
    const pid = run.pid ?? -1;
    const bystander = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    children.push(bystander);
    const other = bystander.pid ?? -1;
    process.kill(other, "SIGSTOP");
    await expect.poll(() => stopped(other)).toBe(true);
    process.kill(pid, "SIGSTOP");
    await expect.poll(() => stopped(pid)).toBe(true);
    const gone = exited(run);
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED })).toBe("ended");
    await gone;
    expect(stopped(other)).toBe(true);
    expect(left(dataDir)).toEqual([]);
  });

  // A stopped run with no helper to let it go on cannot read in time: its stop is withdrawn when
  // the wait is over, and the run, going on again, never acts on it later.
  it.skipIf(!POSIX)(
    "withdraws a stop the run could not read in time, so the run never ends on it later",
    async () => {
      const dataDir = scratchDir("run-force-");
      const run = await stuckRun(dataDir, STARTED);
      const pid = run.pid ?? -1;
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

  // A stop is acted on only where the run claimed it within its time. One the run first claims
  // after its time, as a reading held up past it, is declined: the run goes on.
  it("declines a stop the run claims only once its time is over", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED, { every: 800 });
    const pid = run.pid ?? -1;
    writeStop(dataDir, "late", { pid, startedAt: STARTED, until: Date.now() + 100 });
    await expect.poll(() => left(dataDir), { timeout: 5_000 }).toEqual(["late.declined"]);
    await pause(200);
    expect(run.exitCode).toBeNull();
    expect(run.signalCode).toBeNull();
  });

  // A run that claimed its stop and has not ended, as one held up between its claim and its end:
  // the stop is never called withdrawn or ended, and its claim is left in place.
  it("answers uncertain for a stop claimed and not acted on", async () => {
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
    mkdirSync(join(dataDir, RUN_FORCE_DIR), { recursive: true });
    const run = await stuckRun(dataDir, STARTED, { program: claimsOnly });
    const pid = run.pid ?? -1;
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 300)).toBe(
      "uncertain",
    );
    expect(left(dataDir).filter((name) => name.endsWith(".taken"))).toHaveLength(1);
    expect(run.exitCode).toBeNull();
  });
});
