import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
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
 * `<attempt>.taken`, the run has claimed it and is reading its time;
 * `.ended`, the run found it within its time and ends itself at once, the
 * one move that commits it; `.declined`, the run claimed it once its time
 * was over and did not act; `.withdrawn`, the asker took it back, pending
 * or claimed, before the run committed it. On a Mac or Linux the run's own
 * pipe (`runForceWakeFile`) is there too.
 */
export const RUN_FORCE_DIR = "run-force";

/**
 * The thread's own program: once a reading, each force stop in the folder
 * that names this process and the start it wrote of itself is claimed by
 * moving it to `.taken`, which only one of this reading and its asker's
 * withdrawal can do. The claimed stop's own time is then read: within it,
 * the stop is committed by moving it on to `.ended`, which again only one
 * of this reading and a withdrawal past its time can do, and this process
 * ends by force at once; past it, the stop is declined and nothing acts. A
 * stop naming another run is never moved. It says "reading" to the run at
 * its first reading of the folder that succeeds, and "lost" at its first that
 * fails, at the start or after one that read it, and "reading" again once one
 * reads it again: only while its readings succeed can a stop reach it.
 */
const FORCE_WATCH = `
const { parentPort, workerData } = require("node:worker_threads");
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
let reads = null;
const said = (now) => {
  if (reads === now) return;
  reads = now;
  parentPort.postMessage(now ? "reading" : "lost");
};
const scan = () => {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return said(false);
  }
  said(true);
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
    if (request && typeof request.until === "number" && Date.now() < request.until) {
      // Committed only once moved on: an asker that withdrew the claim past its time moved it first.
      try {
        renameSync(taken, taken.slice(0, -".taken".length) + ".ended");
      } catch {
        continue;
      }
      // The process ends while this thread may still run a moment, and nothing after acts.
      process.kill(process.pid, "SIGKILL");
      return;
    }
    try {
      renameSync(taken, taken.slice(0, -".taken".length) + ".declined");
    } catch {}
  }
};
setInterval(scan, every);
scan();
`;

/**
 * The run's own helper on a Mac or Linux, a shell it starts in its own
 * process group, which waits, costing nothing, on a pipe of the run's own
 * (`runForceWakeFile`) that an asker writes a line to once a force stop is
 * written: at each line, wherever a force stop names exactly this run, by
 * its process and start, and is pending or claimed with the whole of the
 * current second still within its time, or the run committed one and has
 * not yet ended, it lets the run's process alone go on, so a run whose
 * whole process is stopped, as a fully frozen first mate's, reads the stop
 * and ends itself. A stop past its time, or in its last second, which the
 * run would decline and its asker withdraws, lets nothing go on, and the
 * stop's file and the time are read again just before the signal, so a
 * reading held up past a stop's time, or a stop taken back meanwhile, lets
 * nothing go on either. Another program in its group is never touched. The run's number cannot pass to another program while it
 * leads a process group with a member alive, and the helper is one, so the
 * signal reaches only the run; the helper does nothing unless the run leads
 * its own group, as a service manager starts it. It says `ready` once it
 * holds the pipe and found the run leading its group, the one point from
 * which it can let the run go on. It ends when the run does, which closes
 * the run's end of the pipe. Letting a program go on ends nothing.
 */
// i18n-exempt: a shell program the run starts, never shown to a person.
const FORCE_WAKE = `
exec 3<"$1" || exit 0
[ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$2" ] || exit 0
echo ready
while read -r _ <&3; do
  for f in "$4"/*.json "$4"/*.taken "$4"/*.ended; do
    [ -f "$f" ] || continue
    c=$(cat "$f" 2>/dev/null) || continue
    case "$c" in "$3"*) ;; *) continue ;; esac
    t=\${c#"$3"}
    t=\${t%\\}}
    case "$t" in ''|*[!0-9]*) continue ;; esac
    case "$f" in
      *.ended) if [ -f "$f" ]; then kill -CONT "$2" 2>/dev/null; break; fi ;;
      *) now=$(date +%s); if [ -f "$f" ] && [ "$(((now + 1) * 1000))" -le "$t" ]; then kill -CONT "$2" 2>/dev/null; break; fi ;;
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
 * what ends them. `ready(true)` is called once both work, the reading
 * saying it is in place and, on a Mac or Linux, the helper saying it holds the pipe
 * and leads nothing but the run's own group: only then can a force stop end
 * this run however stuck it is, so only then does the run say it can be
 * ended so (`markRunning`'s `recovers`). A reading or helper that cannot
 * start, or fails or ends before the run does, ends only itself: `ready` is
 * never called with true, or is called with false once it was, so the run
 * no longer says so; a reading that fails to read the folder calls it with
 * false too, and with true again once it reads it again, and so does a
 * helper no longer reached at its own pipe, looked at as often as the folder
 * is read. The run goes on, and a force stop asked of it is withdrawn when
 * its wait is over.
 */
export function watchRunForce(
  dataDir: string,
  startedAt: string,
  every: number = RUN_STOP_READ_MS,
  ready: (can: boolean) => void = () => {},
): () => void {
  const dir = join(dataDir, RUN_FORCE_DIR);
  let worker: Worker | null = null;
  let helper: ChildProcess | null = null;
  let held: number | null = null;
  let ended = false;
  let online = false;
  let helperUp = hostPlatformProfile().windows;
  let failed = false;
  let said = false;
  const pipe = join(dir, runForceWakeFile(process.pid, startedAt));
  // The helper is reached through the pipe it holds at its own path: a folder made again since the
  // pipe was made keeps no pipe of this run's, so its helper can be reached no more.
  const reachable = () => hostPlatformProfile().windows || (held !== null && sameFile(held, pipe));
  const settled = () => {
    if (said || !online || !helperUp || failed || ended || !reachable()) return;
    said = true;
    ready(true);
  };
  const lost = (why: string) => {
    if (ended || failed) return;
    failed = true;
    console.warn(`[run] ${why}`);
    if (said) ready(false);
  };
  // The helper's pipe is looked at as often as the folder is read, whether or not a reading failed:
  // a folder made again between two readings, or the pipe alone taken away, says nothing to the
  // reading, and the run says no more that a force stop can end it until the helper is reached
  // at its own pipe again.
  const look = setInterval(() => {
    if (!said) return settled();
    if (reachable()) return;
    said = false;
    // i18n-exempt: the run's own log, never shown to a person.
    console.warn("[run] cannot reach the force helper at its pipe");
    ready(false);
  }, every);
  look.unref();
  try {
    // The folder is there before the reading starts, on every platform, so a first reading finds it.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // i18n-exempt: the run's own log, never shown to a person.
    console.warn(`[run] could not make the folder of force stops: ${(error as Error).message}`);
  }
  try {
    worker = new Worker(FORCE_WATCH, { eval: true, workerData: { dir, startedAt, every } });
    // i18n-exempt: the run's own log, never shown to a person.
    worker.on("error", (error) => lost(`stopped reading force stops: ${(error as Error).message}`));
    // i18n-exempt: the run's own log, never shown to a person.
    worker.on("exit", () => lost("stopped reading force stops"));
    // Ready once the reading itself says it read the folder, never only once its thread came
    // online; no longer while its readings fail, and again once one succeeds.
    worker.on("message", (word: unknown) => {
      if (word === "reading") {
        online = true;
        settled();
      } else if (word === "lost" && online) {
        online = false;
        // i18n-exempt: the run's own log, never shown to a person.
        console.warn("[run] cannot read the folder of force stops");
        if (said) {
          said = false;
          ready(false);
        }
      }
    });
    worker.unref();
  } catch (error) {
    console.warn(`[run] could not read force stops: ${(error as Error).message}`);
  }
  const helperFailed = (error: Error) => {
    // A pipe the run does not hold is never left behind: an asker would read nobody holding it as
    // the run gone. One that cannot be removed only stays: nothing holds it, so no asker reads it
    // as held, and the run goes on without its helper.
    if (held === null) removeQuietly(pipe);
    // i18n-exempt: the run's own log, never shown to a person.
    lost(`the force helper stopped: ${error.message}`);
  };
  if (worker && !hostPlatformProfile().windows) {
    try {
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
            { stdio: ["ignore", "pipe", "ignore"], env: hostEnv() },
          );
          helper.on("error", helperFailed);
          helper.once("exit", () => helperFailed(new Error("it ended")));
          // Ready only once the helper itself says it can let the run go on, never at its spawn.
          helper.stdout?.on("data", (data: Buffer) => {
            if (helperUp || !String(data).includes("ready")) return;
            helperUp = true;
            settled();
          });
          (helper.stdout as { unref?: () => void } | null)?.unref?.();
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
    clearInterval(look);
    void worker?.terminate();
    helper?.kill();
    if (held !== null) {
      // Only while this run's own pipe is still the one it held: a folder made again since keeps none of its own.
      const own = sameFile(held, pipe);
      try {
        closeSync(held);
      } catch {}
      if (own) removeQuietly(pipe);
    }
  };
}

/** Removes `path`, ignoring a failure: what removes it is never held up by it. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // i18n-exempt: the run's own log, never shown to a person.
    console.warn(`[run] could not remove ${path}`);
  }
}

/** Whether the file open as `fd` is the one at `path` now. */
function sameFile(fd: number, path: string): boolean {
  try {
    const open = fstatSync(fd);
    const there = lstatSync(path);
    return open.ino === there.ino && open.dev === there.dev;
  } catch {
    return false;
  }
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
 * What a force stop did: `ended` once the run committed it, finding it
 * within its time, and the run is gone; `gone` where the run is gone and
 * never committed it, pending, claimed and still reading its time, or
 * declined, so nothing shows the stop ended it; `withdrawn` where the run
 * still runs and the stop never acts, taken back pending or claimed once
 * its time was over, or declined by the run; `unasked` where nothing was
 * asked: the run already gone before its stop was written, or a stop that
 * could not be written. A stop the run committed is waited for until the
 * run is gone.
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
 * waits for a stopped run to let its folder go, until the run is gone, as
 * `alive` reads that one run (on Windows by its process's birth, so a later
 * program under its number is not it) and, on a Mac or Linux, as its own
 * pipe shows once nobody holds it, so a program that took its number is not
 * waited for either. The stop is this attempt's own file,
 * carrying the end of that wait, so another attempt's stop is never moved by
 * this one, and one left behind by an asker that quit is past its time and
 * never acts. While the stop can still act, pending or claimed within its
 * time, or committed, `wake` lets a suspended run go on to read it
 * (`wakeRun`); past its time nothing is woken. A stop the run did not commit
 * in time is withdrawn, pending or claimed; one it committed is waited for
 * until the run is gone. The run is read before its stop is written: one
 * already gone then is asked nothing (`unasked`), so only an exit after the
 * ask is told as the stop's end. Its pipe is found before then (`piped`,
 * `runPipeSeen`), by an asker before it reads the run's record, since a run
 * that took the folder since clears an earlier run's pipe only once it
 * noted itself: a pipe found and gone since is the run gone too. A run that
 * says a force stop can end it holds its pipe, so on a Mac or Linux a run
 * whose pipe was not found, or that no program is seen holding (one that
 * cannot be told included), is asked nothing either, whatever holds its
 * number now. The pipe is told by the file it was found as, never by its
 * name alone: another file put in its place, a pipe included, tells
 * nothing, and is never read as the run held or gone. Once asked, only that
 * same pipe found there with nobody holding it is the run gone; one no
 * longer found tells nothing, as where the run or anything else took it
 * away. A stop none of whose files is there any more past its time, as
 * where the folder was made again, is not known to be withdrawn: the run
 * may have committed it before it went, and acts on it once it goes on, so
 * the run is waited for until it is gone, and nothing is woken for it; one
 * the run was seen to commit is waited for the same way and called ended.
 * `held`, for a test, stands in for whether a program holds it.
 * The attempt's files go once its end is known, and one that cannot be
 * removed changes nothing of what it answers.
 */
export async function endRunByForce(
  dataDir: string,
  run: RunInstance,
  alive: (pid: number) => boolean = processAlive,
  waitMs: number = STOPPED_RUN_WAIT_MS,
  wake: () => void = () => {},
  piped: PipeSeen | boolean | null = runPipeSeen(dataDir, run),
  held?: () => boolean,
): Promise<ForceEnd> {
  const dir = join(dataDir, RUN_FORCE_DIR);
  // On a Mac or Linux the run and its helper hold the run's own pipe open while either runs, and no
  // other program ever holds it: the same pipe found with nobody holding it is the run gone, whoever
  // has its number now.
  // A run that says a force stop can end it holds its pipe there: one not found is no proof the
  // named run is still there, so nothing is asked of whatever holds its number.
  const pipe = join(dir, runForceWakeFile(run.pid, run.startedAt));
  const posix = !hostPlatformProfile().windows;
  if (posix && !piped) return "unasked";
  // Read by the file it was found as, unless a test stands in for whether it is held.
  const seen = typeof piped === "object" ? piped : null;
  const state = () => {
    if (held) return held() ? "held" : "unheld";
    return seen === null ? "unknown" : pipeState(pipe, seen);
  };
  // Asked only once a program is seen holding the pipe; once asked, a pipe that cannot be told is
  // no proof the run ended, and only one nobody holds is.
  if (!alive(run.pid) || (posix && state() !== "held")) return "unasked";
  const runs = (pid: number) => alive(pid) && (!posix || state() !== "unheld");
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
  const outcome = await settle(attempt, run, runs, until, wake);
  for (const end of ATTEMPT_ENDS)
    try {
      rmSync(`${attempt}${end}`, { force: true });
    } catch {
      // Left behind, it names a run that is gone or is past its time: it never acts.
    }
  return outcome;
}

/** Each file one attempt's stop can be, as it moves on. */
const ATTEMPT_ENDS = [".json", ".taken", ".ended", ".declined", ".withdrawn"] as const;

/** A run's pipe as it was found, by its file number, which a later reading must find it still is. */
export type PipeSeen = { ino: number; dev: number };

/** `run`'s own pipe, on a Mac or Linux, as it is found now: null where none is, and on Windows, which keeps none. */
export function runPipeSeen(dataDir: string, run: RunInstance): PipeSeen | null {
  if (hostPlatformProfile().windows) return null;
  try {
    const found = lstatSync(join(dataDir, RUN_FORCE_DIR, runForceWakeFile(run.pid, run.startedAt)));
    return found.isFIFO() ? { ino: found.ino, dev: found.dev } : null;
  } catch {
    return null;
  }
}

/** Whether `run`'s own pipe is there, on a Mac or Linux: false on Windows, which keeps none. */
export function runPipeThere(dataDir: string, run: RunInstance): boolean {
  return runPipeSeen(dataDir, run) !== null;
}

/** Whether `stats` is the pipe `seen` found. */
function isSeen(
  stats: { ino: number; dev: number; isFIFO: () => boolean },
  seen: PipeSeen,
): boolean {
  return stats.isFIFO() && stats.ino === seen.ino && stats.dev === seen.dev;
}

/** Whether the file at `path` now is the pipe `seen` found. */
function seenAt(path: string, seen: PipeSeen): boolean {
  try {
    return isSeen(lstatSync(path), seen);
  } catch {
    return false;
  }
}

/**
 * Whether a program holds the pipe `seen` found at `path` open to read it:
 * `held` once the file opened to write is that same pipe, found with a
 * reader; `unheld` once opening it finds nobody reading (`ENXIO`) while that
 * same pipe is found there just before and just after; `unknown` otherwise,
 * as where no pipe is there, another file is, a pipe included, or a pipe
 * this account may not open. Opening and closing it writes nothing, so its
 * helper lets nothing go on.
 */
function pipeState(path: string, seen: PipeSeen): "held" | "unheld" | "unknown" {
  const before = seenAt(path, seen);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENXIO" && before && seenAt(path, seen) ? "unheld" : "unknown";
  }
  try {
    return isSeen(fstatSync(fd), seen) ? "held" : "unknown";
  } catch {
    return "unknown";
  } finally {
    closeSync(fd);
  }
}

async function settle(
  attempt: string,
  run: RunInstance,
  alive: (pid: number) => boolean,
  until: number,
  wake: () => void,
): Promise<Exclude<ForceEnd, "unasked">> {
  let woke = 0;
  // A commitment once seen stays seen: its file going with its folder takes nothing back of it, so
  // the run is waited for until it is gone, and called ended.
  let committed = false;
  for (;;) {
    // Only a stop the run committed, which it acts on at once, ended it: read once the run is gone.
    if (!alive(run.pid)) return committed || existsSync(`${attempt}.ended`) ? "ended" : "gone";
    committed ||= existsSync(`${attempt}.ended`);
    if (existsSync(`${attempt}.declined`)) return "withdrawn";
    if (!committed && Date.now() >= until) {
      // Pending or claimed and not yet committed: whichever move comes first, this one or the run's
      // commitment, decides, so a claim past its time never acts once taken back.
      for (const from of [".json", ".taken"])
        try {
          renameSync(`${attempt}${from}`, `${attempt}.withdrawn`);
          return "withdrawn";
        } catch {}
      // Committed meanwhile, or declined: read again. None of the attempt's files there at all, as
      // where the folder was removed and made again since it was written, is no withdrawal: the run
      // may have committed it before it went, and ends on it once it goes on, so the run is waited
      // for until it is gone, and called gone, as nothing shows the stop ended it.
    } else if (
      (committed ||
        (Date.now() + WAKE_EVERY_MS <= until &&
          (existsSync(`${attempt}.json`) || existsSync(`${attempt}.taken`)))) &&
      Date.now() >= woke + WAKE_EVERY_MS
    ) {
      // A stop that can still act lets a suspended run go on to read it, as the helper does: while
      // it is there to read, pending or claimed, with a whole second of its time left, or once
      // committed; one about to pass its time, or whose file went with its folder, never.
      woke = Date.now();
      wake();
    }
    await new Promise((resolve) => setTimeout(resolve, ENDED_READ_MS));
  }
}
