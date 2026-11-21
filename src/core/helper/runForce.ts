import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
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
 * back first. On a Mac or Linux the run's own pipe (`runForceWakeFile`) is
 * there too.
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
    // Within its time the claim stays as it is, so its asker reads it as the end it asked for:
    // the process ends while this thread may still run a moment, and nothing after acts.
    if (request && typeof request.until === "number" && Date.now() <= request.until) {
      process.kill(process.pid, "SIGKILL");
      return;
    }
    try {
      renameSync(taken, taken.slice(0, -".taken".length) + ".declined");
    } catch {}
  }
}, every);
`;

/**
 * The run's own helper on a Mac or Linux, a shell it starts in its own
 * process group, which waits, costing nothing, on a pipe of the run's own
 * (`runForceWakeFile`) that an asker writes a line to once a force stop is
 * written: at each line, wherever a force stop names exactly this run, by
 * its process and start, and is still within its time, or the run has
 * claimed one and not yet acted on it, it lets the run's process alone go
 * on, so a run whose whole process is stopped, as a fully frozen first
 * mate's, reads the stop and ends itself. Another program in its group is
 * never touched. The run's number cannot pass to another program while it
 * leads a process group with a member alive, and the helper is one, so the
 * signal reaches only the run; the helper does nothing unless the run leads
 * its own group, as a service manager starts it. It ends when the run does,
 * which closes the run's end of the pipe. Letting a program go on ends
 * nothing.
 */
// i18n-exempt: a shell program the run starts, never shown to a person.
const FORCE_WAKE = `
exec 3<"$1" || exit 0
[ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$2" ] || exit 0
while read -r _ <&3; do
  now=$(date +%s)
  for f in "$4"/*.json "$4"/*.taken; do
    [ -f "$f" ] || continue
    c=$(cat "$f" 2>/dev/null) || continue
    case "$c" in "$3"*) ;; *) continue ;; esac
    t=\${c#"$3"}
    t=\${t%\\}}
    case "$t" in ''|*[!0-9]*) continue ;; esac
    case "$f" in
      *.taken) kill -CONT "$2" 2>/dev/null; break ;;
      *) if [ "$((t / 1000))" -ge "$now" ]; then kill -CONT "$2" 2>/dev/null; break; fi ;;
    esac
  done
done
`;

/**
 * The pipe a run's helper waits on, named by the run's process and start, in
 * the folder of force stops; it stays out of the stops a reading looks at.
 */
export function runForceWakeFile(pid: number, startedAt: string): string {
  return `wake-${pid}-${Date.parse(startedAt)}`;
}

/**
 * Starts the run's own reading of force stops for `startedAt`, the start it
 * wrote of itself in its record, and on a Mac or Linux its helper that lets
 * a stopped run go on (`FORCE_WAKE`), on a pipe the run holds open. Answers
 * what ends them. A reading or helper that cannot start, or fails, ends only
 * itself: the run goes on, and a force stop asked of it is withdrawn when
 * its wait is over.
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
      console.warn(`[run] stopped reading force stops: ${(error as Error).message}`);
    });
    worker.unref();
  } catch (error) {
    console.warn(`[run] could not read force stops: ${(error as Error).message}`);
  }
  let helper: ChildProcess | null = null;
  let held: number | null = null;
  let ended = false;
  const pipe = join(dir, runForceWakeFile(process.pid, startedAt));
  const helperFailed = (error: Error) => {
    console.warn(`[run] could not start the force helper: ${error.message}`);
  };
  if (worker && !hostPlatformProfile().windows) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Only the run that holds the folder starts a helper: an earlier run's pipe is its own no more.
      for (const name of readdirSync(dir))
        if (name.startsWith("wake-")) rmSync(join(dir, name), { force: true });
      const making = spawn("mkfifo", ["-m", "600", pipe], { stdio: "ignore", env: hostEnv() });
      making.on("error", helperFailed);
      making.on("exit", (code) => {
        if (ended) return;
        if (code !== 0) return helperFailed(new Error("mkfifo did not make the pipe"));
        try {
          // Held open for both reading and writing, so opening it never waits and the helper
          // reads the end of it once this run ends, however it ends.
          held = openSync(pipe, constants.O_RDWR);
          helper = spawn(
            "/bin/sh",
            [
              "-c",
              FORCE_WAKE,
              "sh",
              pipe,
              String(process.pid),
              forceNeedle(process.pid, startedAt),
              dir,
            ],
            { stdio: "ignore", env: hostEnv() },
          );
          helper.on("error", helperFailed);
          helper.unref();
        } catch (error) {
          helperFailed(error as Error);
        }
      });
    } catch (error) {
      helperFailed(error as Error);
    }
  }
  return () => {
    ended = true;
    void worker?.terminate();
    helper?.kill();
    if (held !== null) {
      try {
        closeSync(held);
      } catch {}
      rmSync(pipe, { force: true });
    }
  };
}

/** The words a force stop for this run starts with, up to its time, as `endRunByForce` writes them. */
function forceNeedle(pid: number, startedAt: string): string {
  return `${JSON.stringify({ pid, startedAt }).slice(0, -1)},"until":`;
}

/** The sources of the run's reading and helper, for a test that runs them in a process of its own. */
export const RUN_FORCE_WATCH_SOURCE = FORCE_WATCH;
export const RUN_FORCE_WAKE_SOURCE = FORCE_WAKE;
export const runForceNeedle = forceNeedle;

/**
 * What a force stop did: `ended` once the run claimed it and no program runs
 * under the run's number, which only its own end leaves; `gone` where no
 * program runs under its number and the run never claimed it, or declined
 * it, so it ended on its own; `withdrawn` where one still does and the stop
 * never acts, taken back before the run claimed it or declined by the run
 * as claimed past its time; `unasked` where the stop could not be written.
 * A stop the run claimed and has not yet acted on is waited for until one of
 * these is known.
 */
export type ForceEnd = "ended" | "gone" | "withdrawn" | "unasked";

/**
 * Lets a run whose whole process is suspended go on, so its own reading can
 * act on its force stop (docs/run.md, "When the command does not answer").
 * This ends nothing. On a Mac or Linux it writes a line to the run's own
 * pipe, which its helper waits on (`watchRunForce`), so nothing here signals
 * a process; on Windows it goes only through a handle to the program whose
 * birth is the run's own (`birth`, as its record keeps it), so a later
 * program under its number is never touched, and with no birth recorded the
 * run is left.
 */
export function wakeRun(dataDir: string, run: RunInstance, birth?: string): void {
  if (hostPlatformProfile().windows) {
    if (birth) resumeWindowsRun(run.pid, birth);
    return;
  }
  const pipe = join(dataDir, RUN_FORCE_DIR, runForceWakeFile(run.pid, run.startedAt));
  try {
    if (!lstatSync(pipe).isFIFO()) return;
    // Never waits: with nothing reading it the pipe does not open, and nothing is woken.
    const fd = openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      writeSync(fd, "\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    // No helper waits on this run: a stop it cannot read in time is withdrawn.
  }
}

/** How often `endRunByForce` reads whether the run has ended. */
const ENDED_READ_MS = 100;
/** How often, while it waits, `endRunByForce` lets a suspended run go on again. */
const WAKE_EVERY_MS = 1_000;

/**
 * Asks `run` to end itself by force, and waits, for as long as a command
 * waits for a stopped run to let its folder go, until no program runs under
 * its number. The stop is this attempt's own file, carrying the end of that
 * wait, so another attempt's stop is never moved by this one, and one left
 * behind by an asker that quit is past its time and never acts. While it
 * waits, `wake` lets a suspended run go on to read it (`wakeRun`). A stop
 * the run did not claim in time is withdrawn; one it claimed is waited for
 * until the run ended or declined it. The attempt's files go once its end is
 * known, and one that cannot be removed changes nothing of what it answers.
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
  const outcome = await settle(attempt, run, alive, until, wake);
  for (const end of [".json", ".taken", ".declined", ".withdrawn"])
    try {
      rmSync(`${attempt}${end}`, { force: true });
    } catch {
      // Left behind, it names a run that is gone or is past its time: it never acts.
    }
  return outcome;
}

async function settle(
  attempt: string,
  run: RunInstance,
  alive: (pid: number) => boolean,
  until: number,
  wake: () => void,
): Promise<Exclude<ForceEnd, "unasked">> {
  let woke = 0;
  for (;;) {
    if (Date.now() >= woke + WAKE_EVERY_MS) {
      woke = Date.now();
      wake();
    }
    // Only a stop the run claimed and kept, which within its time it acts on at once, ended it.
    if (!alive(run.pid)) return existsSync(`${attempt}.taken`) ? "ended" : "gone";
    if (existsSync(`${attempt}.declined`)) return "withdrawn";
    if (Date.now() >= until) {
      try {
        renameSync(`${attempt}.json`, `${attempt}.withdrawn`);
        return "withdrawn";
      } catch {
        // Claimed by the run: within its time it ends at once, past it the run declines it.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, ENDED_READ_MS));
  }
}
