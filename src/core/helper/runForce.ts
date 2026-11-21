import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { writePrivate } from "../devices/identity";
import { resumeWindowsRun } from "../placed/windowsProcesses";
import { hostPlatformProfile } from "../platform";
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
 * names this process and the start it wrote of itself, and whose time is not
 * over, ends this process by force. The stop is first claimed by moving it
 * aside, which only one of this reading and its asker's withdrawal can do,
 * so a withdrawn stop never acts. One naming another run is left for it.
 */
const FORCE_WATCH = `
const { workerData } = require("node:worker_threads");
const { readFileSync, renameSync, rmSync } = require("node:fs");
const { file, startedAt, every } = workerData;
setInterval(() => {
  let request;
  try {
    request = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (!request || request.pid !== process.pid || request.startedAt !== startedAt) return;
  if (typeof request.until !== "number" || Date.now() > request.until) return;
  const claimed = file + ".claimed-" + process.pid;
  try {
    renameSync(file, claimed);
  } catch {
    return;
  }
  // The stop claimed may have been another's, written in its place since the reading.
  let mine = false;
  try {
    const held = JSON.parse(readFileSync(claimed, "utf8"));
    mine = held && held.pid === process.pid && held.startedAt === startedAt;
  } catch {}
  try {
    rmSync(claimed, { force: true });
  } catch {}
  if (mine) process.kill(process.pid, "SIGKILL");
}, every);
`;

/**
 * Starts the run's own reading of force stops for `startedAt`, the start it
 * wrote of itself in its record. Answers what ends the reading. A reading
 * that cannot start, or fails, ends only itself: the run goes on, and a force
 * stop asked of it is withdrawn when its wait is over.
 */
export function watchRunForce(
  dataDir: string,
  startedAt: string,
  every: number = RUN_STOP_READ_MS,
): () => void {
  let worker: Worker;
  try {
    worker = new Worker(FORCE_WATCH, {
      eval: true,
      workerData: { file: join(dataDir, RUN_FORCE_FILE), startedAt, every },
    });
  } catch (error) {
    console.warn(`[run] could not read force stops: ${(error as Error).message}`);
    return () => {};
  }
  worker.on("error", (error) => {
    console.warn(`[run] stopped reading force stops: ${error.message}`);
  });
  worker.unref();
  return () => void worker.terminate();
}

/** The source of the run's reading, for a test that runs it in a process of its own. */
export const RUN_FORCE_WATCH_SOURCE = FORCE_WATCH;

/**
 * What a force stop did: `ended` once no program runs under the run's
 * number, which only its end leaves; `withdrawn` where one still does when
 * the wait is over and the stop was taken back before the run claimed it, so
 * it never acts later; `uncertain` where the run claimed it, or it could not
 * be taken back, and a program still runs under its number, so the run may
 * yet end; `unasked` where the stop could not be written.
 */
export type ForceEnd = "ended" | "withdrawn" | "uncertain" | "unasked";

/**
 * Lets a run whose whole process is stopped go on, so its own reading can
 * act (docs/run.md, "When the command does not answer"): this ends nothing.
 * On Windows it goes only through a handle to the program whose birth is
 * the run's own (`birth`, as its record keeps it), so a later program under
 * its number is never touched; with no birth recorded, it is left. Elsewhere
 * the continue signal only lets a stopped program go on, and one that runs
 * reads nothing in it.
 */
export function wakeRun(pid: number, birth?: string): void {
  if (hostPlatformProfile().windows) {
    if (birth) resumeWindowsRun(pid, birth);
    return;
  }
  try {
    process.kill(pid, "SIGCONT");
  } catch {
    // Gone already, or not this app's to signal: its reading answers either way.
  }
}

/** How often `endRunByForce` reads whether the run has ended. */
const ENDED_READ_MS = 100;

/**
 * Asks `run` to end itself by force, and waits, for as long as a command
 * waits for a stopped run to let its folder go, until no program runs under
 * its number. The stop carries the end of that wait: a run reads it as over
 * then, so one left behind by an asker that quit never acts later. Once the
 * stop is written, `wake` lets a run whose whole process is stopped go on to
 * read it (`wakeRun`). A stop the run did not claim in time is withdrawn.
 */
export async function endRunByForce(
  dataDir: string,
  run: RunInstance,
  alive: (pid: number) => boolean = processAlive,
  waitMs: number = STOPPED_RUN_WAIT_MS,
  wake: () => void = () => wakeRun(run.pid),
): Promise<ForceEnd> {
  const file = join(dataDir, RUN_FORCE_FILE);
  const until = Date.now() + waitMs;
  try {
    writePrivate(file, `${JSON.stringify({ pid: run.pid, startedAt: run.startedAt, until })}\n`);
  } catch {
    return "unasked";
  }
  wake();
  const ended = await endedBy(run, alive, until);
  if (ended) return "ended";
  if (!withdraw(file)) {
    // Claimed by the run, which ends at once, or not taken back: a last short wait.
    return (await endedBy(run, alive, Date.now() + CLAIMED_WAIT_MS)) ? "ended" : "uncertain";
  }
  return "withdrawn";
}

/** How long a run that claimed its stop is given to end, after the wait. */
const CLAIMED_WAIT_MS = 1_000;

/** Whether no program runs under `run`'s number by `until`. */
async function endedBy(
  run: RunInstance,
  alive: (pid: number) => boolean,
  until: number,
): Promise<boolean> {
  while (alive(run.pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, ENDED_READ_MS));
  }
  return true;
}

/**
 * Takes back the force stop by moving it aside, which the run's
 * claim then cannot. True once it is taken back, or found to be another's
 * that took its place, which this one's run never acts on; false where it is
 * gone, claimed by the run, or could not be moved.
 */
function withdraw(file: string): boolean {
  const aside = `${file}.withdrawn-${process.pid}-${Date.now()}`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  try {
    rmSync(aside, { force: true });
  } catch {
    // Its time is over, so a run never acts on it.
  }
  return true;
}
