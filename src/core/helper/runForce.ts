import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { writePrivate } from "../devices/identity";
import { hostEnv } from "../hostEnv";
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

/**
 * The folder of force stops: each attempt writes one file of its own,
 * `<attempt>.json`, naming its run by process and start with the end of its
 * wait, and only that attempt and the run it names move it on. Moved to
 * `<attempt>.taken`, the run has claimed it; `.declined`, the run claimed it
 * once its time was over and did not act; `.withdrawn`, the asker took it
 * back first.
 */
export const RUN_FORCE_DIR = "run-force";

/**
 * The thread's own program: once a reading, each force stop in the folder
 * that names this process and the start it wrote of itself is claimed by
 * moving it to `.taken`, which only one of this reading and its asker's
 * withdrawal can do. The claimed stop's own time is then read: within it,
 * this process ends by force at once; past it, the stop is declined and
 * nothing acts. A stop naming another run is never moved.
 */
const FORCE_WATCH = `
const { workerData } = require("node:worker_threads");
const { readdirSync, readFileSync, renameSync } = require("node:fs");
const { join } = require("node:path");
const { dir, startedAt, every } = workerData;
const read = (path) => {
  try {
    const request = JSON.parse(readFileSync(path, "utf8"));
    return request && request.pid === process.pid && request.startedAt === startedAt ? request : null;
  } catch {
    return null;
  }
};
setInterval(() => {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pending = join(dir, name);
    if (!read(pending)) continue;
    const taken = pending.slice(0, -".json".length) + ".taken";
    try {
      renameSync(pending, taken);
    } catch {
      continue;
    }
    const request = read(taken);
    if (request && typeof request.until === "number" && Date.now() <= request.until)
      process.kill(process.pid, "SIGKILL");
    try {
      renameSync(taken, taken.slice(0, -".taken".length) + ".declined");
    } catch {}
  }
}, every);
`;

/**
 * The run's own helper on a Mac or Linux, a shell it starts in its own
 * process group: while the run lives, it lets the group go on wherever a
 * force stop names the run, so a run whose whole process is stopped, as a
 * fully frozen first mate's, reads the stop and ends itself. A signal to a
 * process group reaches only that group while one of its members lives, and
 * the helper is one, so it never reaches another program; the helper does
 * nothing unless the run leads its own group, as a service manager starts
 * it. Letting a program go on ends nothing.
 */
// i18n-exempt: a shell program the run starts, never shown to a person.
const FORCE_WAKE = `
[ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$1" ] || exit 0
while kill -0 "$1" 2>/dev/null; do
  if grep -qsF "$2" "$3"/*.json; then kill -CONT -- "-$1" 2>/dev/null; fi
  sleep 1
done
`;

/**
 * Starts the run's own reading of force stops for `startedAt`, the start it
 * wrote of itself in its record, and on a Mac or Linux its helper that lets
 * a stopped run go on (`FORCE_WAKE`). Answers what ends both. A reading or
 * helper that cannot start, or fails, ends only itself: the run goes on, and
 * a force stop asked of it is withdrawn when its wait is over.
 */
export function watchRunForce(
  dataDir: string,
  startedAt: string,
  every: number = RUN_STOP_READ_MS,
): () => void {
  const dir = join(dataDir, RUN_FORCE_DIR);
  let worker: Worker | null = null;
  try {
    worker = new Worker(FORCE_WATCH, { eval: true, workerData: { dir, startedAt, every } });
    worker.on("error", (error) => {
      console.warn(`[run] stopped reading force stops: ${error.message}`);
    });
    worker.unref();
  } catch (error) {
    console.warn(`[run] could not read force stops: ${(error as Error).message}`);
  }
  let helper: ChildProcess | null = null;
  if (worker && !hostPlatformProfile().windows) {
    try {
      helper = spawn(
        "/bin/sh",
        ["-c", FORCE_WAKE, "sh", String(process.pid), forceNeedle(process.pid, startedAt), dir],
        { stdio: "ignore", env: hostEnv() },
      );
      helper.on("error", (error) => {
        console.warn(`[run] could not start the force helper: ${error.message}`);
      });
      helper.unref();
    } catch (error) {
      console.warn(`[run] could not start the force helper: ${(error as Error).message}`);
    }
  }
  return () => {
    void worker?.terminate();
    helper?.kill();
  };
}

/** The words a force stop for this run holds, as `endRunByForce` writes them. */
function forceNeedle(pid: number, startedAt: string): string {
  return `${JSON.stringify({ pid, startedAt }).slice(0, -1)},`;
}

/** The sources of the run's reading and helper, for a test that runs them in a process of its own. */
export const RUN_FORCE_WATCH_SOURCE = FORCE_WATCH;
export const RUN_FORCE_WAKE_SOURCE = FORCE_WAKE;
export const runForceNeedle = forceNeedle;

/**
 * What a force stop did: `ended` once no program runs under the run's
 * number, which only its end leaves; `withdrawn` where one still does and
 * the stop never acts, taken back before the run claimed it or declined by
 * the run as claimed past its time; `uncertain` where the run claimed it
 * within its time and a program still runs under its number, so the run may
 * yet end, or the stop could be neither taken back nor found declined;
 * `unasked` where the stop could not be written.
 */
export type ForceEnd = "ended" | "withdrawn" | "uncertain" | "unasked";

/**
 * Lets a run whose whole process is suspended go on, so its own reading can
 * act, on Windows (docs/run.md, "When the command does not answer"): this
 * ends nothing, and goes only through a handle to the program whose birth is
 * the run's own (`birth`, as its record keeps it), so a later program under
 * its number is never touched; with no birth recorded, it is left. On a Mac
 * or Linux the run's own helper does this (`watchRunForce`), so nothing here
 * signals a process by its number.
 */
export function wakeRun(pid: number, birth?: string): void {
  if (hostPlatformProfile().windows && birth) resumeWindowsRun(pid, birth);
}

/** How often `endRunByForce` reads whether the run has ended. */
const ENDED_READ_MS = 100;

/**
 * Asks `run` to end itself by force, and waits, for as long as a command
 * waits for a stopped run to let its folder go, until no program runs under
 * its number. The stop is this attempt's own file, carrying the end of that
 * wait, so another attempt's stop is never moved by this one, and one left
 * behind by an asker that quit is past its time and never acts. Once it is
 * written, `wake` lets a suspended run go on to read it (`wakeRun`). A stop
 * the run did not claim in time is withdrawn.
 */
export async function endRunByForce(
  dataDir: string,
  run: RunInstance,
  alive: (pid: number) => boolean = processAlive,
  waitMs: number = STOPPED_RUN_WAIT_MS,
  wake: () => void = () => {},
): Promise<ForceEnd> {
  const dir = join(dataDir, RUN_FORCE_DIR);
  const attempt = join(dir, `${process.pid}-${randomBytes(8).toString("hex")}`);
  const until = Date.now() + waitMs;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(
      `${attempt}.json`,
      `${JSON.stringify({ pid: run.pid, startedAt: run.startedAt, until })}\n`,
    );
  } catch {
    return "unasked";
  }
  wake();
  const outcome = await settle(attempt, run, alive, until);
  for (const end of [".json", ".taken", ".declined", ".withdrawn"])
    if (outcome !== "uncertain" || end !== ".taken") rmSync(`${attempt}${end}`, { force: true });
  return outcome;
}

async function settle(
  attempt: string,
  run: RunInstance,
  alive: (pid: number) => boolean,
  until: number,
): Promise<Exclude<ForceEnd, "unasked">> {
  if (await endedBy(run, alive, until)) return "ended";
  try {
    renameSync(`${attempt}.json`, `${attempt}.withdrawn`);
    return "withdrawn";
  } catch {
    // Claimed by the run: within its time it ends at once, past it the run declines it.
  }
  if (await endedBy(run, alive, Date.now() + CLAIMED_WAIT_MS)) return "ended";
  return existsSync(`${attempt}.declined`) ? "withdrawn" : "uncertain";
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
