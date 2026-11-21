import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { processAlive } from "./lock";
import { endRunByForce, RUN_FORCE_FILE, RUN_FORCE_WATCH_SOURCE } from "./runForce";

/**
 * Ending a run that does not answer by force (docs/run.md, "When the command
 * does not answer"; the review of INF-5409): the run ends itself, on a
 * thread its stuck first mate does not hold up, where a stop names it by its
 * process and start. Each run here is a real process of its own whose main
 * thread never yields, as a stuck first mate's would not, with the run's own
 * reading on a thread beside it; a bystander shares the folder.
 */

vi.setConfig({ testTimeout: 10_000 });

const STARTED = "2026-10-25T17:00:00.000Z";
const OTHER_START = "2026-10-25T17:05:00.000Z";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** A run whose main thread is stuck, reading force stops for `startedAt` beside it once it says ready. */
async function stuckRun(dataDir: string, startedAt: string): Promise<ChildProcess> {
  const program = `
    const { Worker } = require("node:worker_threads");
    new Worker(process.env.WATCH, {
      eval: true,
      workerData: { file: process.env.FILE, startedAt: process.env.STARTED, every: 50 },
    });
    process.stdout.write("ready\\n", () => { for (;;) {} });
  `;
  const child = spawn(process.execPath, ["-e", program], {
    env: {
      PATH: process.env.PATH ?? "",
      WATCH: RUN_FORCE_WATCH_SOURCE,
      FILE: join(dataDir, RUN_FORCE_FILE),
      STARTED: startedAt,
    },
    stdio: ["ignore", "pipe", "inherit"],
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

describe("a run that does not answer, ended by force", () => {
  it("ends the stuck run its stop names by process and start, and no bystander", async () => {
    const dataDir = scratchDir("run-force-");
    const run = await stuckRun(dataDir, STARTED);
    const bystander = await stuckRun(dataDir, OTHER_START);
    const pid = run.pid ?? -1;
    const gone = exited(run);
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED })).toBe("ended");
    expect(await gone).toBe("SIGKILL");
    expect(processAlive(bystander.pid ?? -1)).toBe(true);
    expect(existsSync(join(dataDir, RUN_FORCE_FILE))).toBe(false);
  });

  // A program that took the named run's process number knows another start: it reads the stop as
  // another's and keeps going, and the stop is reported as lasting, never as ended, then taken away.
  it("leaves a program under the named number that knows another start, and calls it lasting", async () => {
    const dataDir = scratchDir("run-force-");
    const holder = await stuckRun(dataDir, OTHER_START);
    const pid = holder.pid ?? -1;
    expect(await endRunByForce(dataDir, { pid, startedAt: STARTED }, processAlive, 1_000)).toBe(
      "lasts",
    );
    expect(processAlive(pid)).toBe(true);
    expect(holder.exitCode).toBeNull();
    expect(existsSync(join(dataDir, RUN_FORCE_FILE))).toBe(false);
  });
});
