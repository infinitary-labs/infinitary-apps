import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { writePrivate } from "../devices/identity";
import { processAlive, STOPPED_RUN_WAIT_MS } from "./lock";
import { RUN_STOP_READ_MS, type RunInstance } from "./windowsTask";

/**
 * Ending a run that does not answer by force (docs/run.md, "When the
 * command does not answer"). A signal or Windows' own end goes to a process
 * number, which another program may have taken by the time it arrives, and
 * a service manager's job ends whichever run it holds by then. So the run
 * ends itself: it reads, on a thread of its own that a stuck first mate does
 * not hold up, whether a force stop names it by its process and start, and
 * ends its own process at once where one does. A run is the one program
 * whose number cannot pass to another while it reads that.
 */

/** The force stop for one run, naming it by its process and start. */
export const RUN_FORCE_FILE = "run-force-for.json";

/**
 * The thread's own program: once a reading, a force stop in the folder that
 * names this process and the start it wrote of itself ends this process by
 * force, and is taken away first. One naming another run is left for it.
 */
const FORCE_WATCH = `
const { workerData } = require("node:worker_threads");
const { readFileSync, rmSync } = require("node:fs");
const { file, startedAt, every } = workerData;
setInterval(() => {
  let request;
  try {
    request = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!request || request.pid !== process.pid || request.startedAt !== startedAt) return;
  try {
    rmSync(file, { force: true });
  } catch {}
  process.kill(process.pid, "SIGKILL");
}, every);
`;

/**
 * Starts the run's own reading of force stops for `startedAt`, the start it
 * wrote of itself in its record. Answers what ends the reading.
 */
export function watchRunForce(
  dataDir: string,
  startedAt: string,
  every: number = RUN_STOP_READ_MS,
): () => void {
  const worker = new Worker(FORCE_WATCH, {
    eval: true,
    workerData: { file: join(dataDir, RUN_FORCE_FILE), startedAt, every },
  });
  worker.unref();
  return () => void worker.terminate();
}

/** The source of the run's reading, for a test that runs it in a process of its own. */
export const RUN_FORCE_WATCH_SOURCE = FORCE_WATCH;

/**
 * What a force stop did: `ended` once no program runs under the run's
 * number, which only its end leaves; `lasts` where one still does when the
 * wait is over, the run or a program that took its number, so it is never
 * called ended; `unasked` where the stop could not be written.
 */
export type ForceEnd = "ended" | "lasts" | "unasked";

/** How often `endRunByForce` reads whether the run has ended. */
const ENDED_READ_MS = 100;

/**
 * Asks `run` to end itself by force, and waits, for as long as a command
 * waits for a stopped run to let its folder go, until no program runs under
 * its number. A stop it did not act on in time is taken away, so the run
 * never ends later, after the window was told it did not.
 */
export async function endRunByForce(
  dataDir: string,
  run: RunInstance,
  alive: (pid: number) => boolean = processAlive,
  waitMs: number = STOPPED_RUN_WAIT_MS,
): Promise<ForceEnd> {
  const file = join(dataDir, RUN_FORCE_FILE);
  try {
    writePrivate(file, `${JSON.stringify({ pid: run.pid, startedAt: run.startedAt })}\n`);
  } catch {
    return "unasked";
  }
  const until = Date.now() + waitMs;
  while (alive(run.pid)) {
    if (Date.now() >= until) {
      takeAway(file, run);
      return "lasts";
    }
    await new Promise((resolve) => setTimeout(resolve, ENDED_READ_MS));
  }
  return "ended";
}

/** Takes away the force stop for `run`, where it is still that one's. */
function takeAway(file: string, run: RunInstance): void {
  try {
    const request = JSON.parse(readFileSync(file, "utf8"));
    if (request?.pid === run.pid && request.startedAt === run.startedAt)
      rmSync(file, { force: true });
  } catch {
    // None there, or none to read.
  }
}
