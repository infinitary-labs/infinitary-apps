import { readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DataRefusal } from "@core/storage/dataFolderRefusal";
import { APP_IDENTITIES } from "@shared/codeNames";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { z } from "zod";
import { type RunEnvironment, RunEnvironmentSchema } from "./runEnvironment";
import { commandWords } from "./workCommand";

/**
 * Infinitary started by a command (docs/run.md): `<app> run` starts the whole
 * app - its record, first mate, crew and scheduler - with no window, for
 * whatever started the command to keep running: a boot entry, a login, a
 * terminal. The app owns only what no starter can do: running with no window,
 * a clean stop, and an exit with its reason; when, as which account and how
 * often it starts again are the starter's.
 */

/**
 * Whether the app was started as `<app> run`, and the words after `run`
 * when it was, read as the work mode's are (`commandWords`). `<app> work run`
 * is the work mode's own command, never this one.
 */
export function runCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "run" ? words.slice(1) : null;
}

/** What the command says to whoever reads its output, and why it ended when it did. */
export const RUN_WORDS = {
  started: "Infinitary is running here with no window, started by a command.",
  stopped: "Infinitary stopped.",
  usage: ["Usage: infinitary run", "Starts Infinitary here with no window, until it is stopped."],
  alreadyOpen: ["Infinitary is already open here, as this user.", "Quit it, then run this again."],
  handOver: [
    `Infinitary has work from ${APP_IDENTITIES.fm.app.release} to bring over first.`,
    "Open Infinitary with its window once to bring it over, then run this again.",
  ],
  controls: [
    `Infinitary here controls your first mate on another ${COMPUTER.one}, so there is nothing for a command to run here.`,
    "Leave it from Infinitary's window here first, then run this again.",
  ],
  needsDisplay: [
    `Infinitary needs Xvfb to run on a ${COMPUTER.one} with no screen.`,
    "Install Xvfb with your system's software, then run this again.",
  ],
  updated: [
    "Infinitary here was updated, so this run ends.",
    "Start it again to run the new version.",
  ],
  couldNotStart: (reason: string) => [`Infinitary could not start: ${reason}`],
  /** A refusal the window would show as a page of its own, as two lines. */
  refusal: (refusal: Pick<DataRefusal, "title" | "message">) => [
    `${refusal.title}.`,
    refusal.message,
  ],
} as const;

/**
 * What Infinitary's window says when it is opened while the command runs
 * here, then it quits (captain's pick on INF-1228: "It says a command started
 * Infinitary here, and quits"): the same page the window shows for any other
 * folder it does not open (./savedDataRefusal.ts).
 */
export const RUNNING_BY_COMMAND: DataRefusal = {
  title: "A command started Infinitary here",
  message: `Infinitary is already running on ${HERE.this} as this user, with no window. Control it from Infinitary on another ${COMPUTER.one}, or stop that command to open Infinitary here.`,
  next: "You can close this window.",
};

/**
 * The code a run ends with once the installed app was updated: "try again"
 * (`EX_TEMPFAIL`), so a starter that starts it again only after a failure
 * starts the new version too; a stop ends with 0.
 */
export const RUN_UPDATED_EXIT = 75;

/** The file in the data folder that says a command runs Infinitary on it, and which process. */
export const RUN_MARKER = "run.json";

export const RUN_LAST_STOP = "run-last-stop.json";
export const RunMarkerSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  environment: RunEnvironmentSchema.optional(),
});
export type RunMarker = z.infer<typeof RunMarkerSchema>;
export const RunStopSchema = RunMarkerSchema.extend({
  stoppedAt: z.string().datetime(),
  reason: z.enum(["quit", "signal", "updated", "start-failed"]),
  exitCode: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});
export type RunStop = z.infer<typeof RunStopSchema>;
export type RunEnd = Pick<RunStop, "reason" | "exitCode" | "lines">;

/**
 * Notes in the data folder that this process runs it by a command, once it
 * holds the folder's single-instance lock; the window opened beside it reads
 * this to say so. The process keeps its last stop separately, then takes
 * the live marker away as it ends. A failed second start owns neither file.
 */
export function markRunning(
  dataDir: string,
  pid: number,
  now: Date,
  environment?: RunEnvironment,
): (end?: RunEnd) => void {
  const path = join(dataDir, RUN_MARKER);
  const marker: RunMarker = {
    pid,
    startedAt: now.toISOString(),
    ...(environment && { environment }),
  };
  writeRunRecord(path, marker);
  let ended = false;
  return (end = { reason: "quit", exitCode: 0, lines: [RUN_WORDS.stopped] }) => {
    if (ended) return;
    ended = true;
    writeRunRecord(join(dataDir, RUN_LAST_STOP), {
      ...marker,
      ...end,
      stoppedAt: new Date().toISOString(),
    } satisfies RunStop);
    rmSync(path, { force: true });
  };
}

/** Readers see either complete reading; every new file is private to the account. */
function writeRunRecord(path: string, value: RunMarker | RunStop): void {
  const pending = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

/**
 * Whether a command runs Infinitary on this data folder now: its note names
 * a process that is still alive and, where Chromium keeps its single-instance
 * lock as a link naming its holder (`SingletonLock`, `<host>-<pid>` on a Mac
 * and on Linux), holds that lock. The window asks before it asks for the lock
 * itself, since a process refused the lock never becomes ready to show why; a
 * note a crash left names a process that is gone or holds nothing.
 */
export function runningByCommand(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  let marker: Partial<RunMarker>;
  try {
    marker = JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8")) as Partial<RunMarker>;
  } catch {
    return false;
  }
  const { pid } = marker;
  if (typeof pid !== "number" || pid <= 0 || !alive(pid)) return false;
  const holder = lockHolder(dataDir);
  return holder === undefined || holder === pid;
}

/** The process Chromium's lock link names; undefined where there is no link to read, null for none. */
export function lockHolder(dataDir: string): number | null | undefined {
  let link: string;
  try {
    link = readlinkSync(join(dataDir, "SingletonLock"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  const pid = Number(link.slice(link.lastIndexOf("-") + 1));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process is alive too, though this one may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Which file the installed app runs from, by the identity of its file: an
 * update replaces the file, whatever the version inside says, so its inode or
 * its time changes. Null when it cannot be read, as while an update is moving
 * the app into place.
 */
export function programIdentity(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Follows the installed program while the command runs: once its file is
 * another than the one this process started from, the run ends, so whatever
 * started it starts the new version. Read on a clock, never by watching the
 * folder, which an update moves away whole. Returns its stop.
 */
export function followInstalledProgram(options: {
  path: string;
  updated: () => void;
  every: number;
  identity?: (path: string) => string | null;
}): () => void {
  const identity = options.identity ?? programIdentity;
  const started = identity(options.path);
  if (started === null) return () => {};
  const timer = setInterval(() => {
    const now = identity(options.path);
    if (now === null || now === started) return;
    clearInterval(timer);
    options.updated();
  }, options.every);
  timer.unref?.();
  return () => clearInterval(timer);
}
