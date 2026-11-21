import { readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_RECORD_FILE, requestRunStop, windowsLockHeld } from "@core/helper/windowsTask";
import { captureLoginPath } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import type { DataRefusal } from "@core/storage/dataFolderRefusal";
import { APP_IDENTITIES } from "@shared/codeNames";
import { COMPUTER } from "@shared/deviceNames";
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

/**
 * What a run was asked for: the settings file it names, if any
 * (./runSettings.ts), and the label of this app's own agent that started
 * it, where its service manager sets no variable (Windows' Task Scheduler,
 * `runTaskXml`): the same mark `RUN_AGENT_ENV` carries elsewhere.
 */
export type RunOptions = { settings?: string; agent?: string };

/**
 * The words after `run`: nothing, `--settings <file>`, or with `--agent
 * <label>` after it, which only this app's own task writes. Anything else is
 * a mistake, answered with the usage, so a misspelled word never starts a run
 * that ignores it.
 */
export function runOptions(args: readonly string[]): RunOptions | null {
  const options: RunOptions = {};
  for (let at = 0; at < args.length; at += 2) {
    const [word, value] = [args[at], args[at + 1]];
    if (!value) return null;
    if (word === "--settings" && options.settings === undefined) options.settings = value;
    else if (word === "--agent" && options.agent === undefined) options.agent = value;
    else return null;
  }
  return options;
}

/**
 * A run with no settings file asks the person's login shell for its search
 * path as soon as it starts, while the app's code loads, rather than when
 * its core starts (docs/run.md): the core awaits the same one answer
 * (`captureLoginPath`), so a shell whose startup files take a while to
 * answer no longer holds the first mate's start. A run with a settings file
 * asks no shell, and words that end the run with its usage ask nothing.
 * Answers whether it asked.
 */
export function askLoginShellEarly(
  args: readonly string[],
  ask: () => unknown = captureLoginPath,
): boolean {
  const options = runOptions(args);
  if (!options || options.settings !== undefined) return false;
  ask();
  return true;
}

/** What the command says to whoever reads its output, and why it ended when it did. */
export const RUN_WORDS = {
  started: "Infinitary is running here with no window, started by a command.",
  stopped: "Infinitary stopped.",
  movedAway: "Your first mate moved to another computer, so this run ends for good.",
  /** Why a run on Windows stopped: a stop asked through its data folder, where no signal can ask one. */
  stopAsked: "Infinitary stopped when asked.",
  usage: [
    "Usage: infinitary run [--settings <file>]",
    "Starts Infinitary here with no window, until it is stopped.",
    "With --settings, programs are found in the folders the file lists, and no login shell is asked:",
    '  { "path": ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] }',
  ],
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
  restart: [
    "Your first mate starts again here, so this run ends.",
    "Start it again if nothing starts it for you.",
  ],
  updated: [
    "Infinitary here was updated, so this run ends.",
    "Start it again to run the new version.",
  ],
  settings: (file: string, reason: string) => [
    `Infinitary could not use the settings file ${file}: ${reason}.`,
    "Fix the file, then run this again.",
  ],
  couldNotStart: (reason: string) => [`Infinitary could not start: ${reason}`],
  /** A refusal the window would show as a page of its own, as two lines. */
  refusal: (refusal: Pick<DataRefusal, "title" | "message">) => [
    `${refusal.title}.`,
    refusal.message,
  ],
} as const;

/**
 * The window opened while the command runs here joins it as a view of its
 * first mate (docs/run.md, "The window opened beside it"; INF-1352's plan,
 * the captain's answer window_joins=join). Two programs cannot share one
 * browser profile, so the window keeps its own in this folder inside the
 * data folder, and holds its single-instance lock there.
 */
export const WINDOW_PROFILE_FOLDER = "window-profile";

/** The window's own browser profile beside a run (`WINDOW_PROFILE_FOLDER`). */
export function windowProfileDir(dataDir: string): string {
  return join(dataDir, WINDOW_PROFILE_FOLDER);
}

/**
 * The code a run ends with once the installed app was updated: "try again"
 * (`EX_TEMPFAIL`), so a starter that starts it again only after a failure
 * starts the new version too; a stop ends with 0.
 */
export const RUN_UPDATED_EXIT = 75;

/**
 * The code a run ends with when its settings file cannot be used: "a
 * configuration error" (`EX_CONFIG`), so a starter can tell a file to fix
 * from a start that failed for another reason.
 */
export const RUN_SETTINGS_EXIT = 78;

/** The file in the data folder that says a command runs Infinitary on it, and which process. */
export const RUN_MARKER = RUN_RECORD_FILE;

export const RUN_LAST_STOP = "run-last-stop.json";
export const RunMarkerSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  environment: RunEnvironmentSchema.optional(),
  /** The run saw it was started by this app's own agent (`startedByAgent`); absent from earlier runs. */
  agent: z.literal(true).optional(),
});
export type RunMarker = z.infer<typeof RunMarkerSchema>;
export const RunStopSchema = RunMarkerSchema.extend({
  stoppedAt: z.string().datetime(),
  reason: z.enum(["quit", "signal", "updated", "restart", "start-failed"]),
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
 *
 * An environment still being read is added to the note once it arrives,
 * unless the run has ended: a Mac's Keychain is read by a utility process,
 * which waits for the app to be ready, and the app is ready only once the
 * start that writes this note has returned (./index.ts).
 */
export function markRunning(
  dataDir: string,
  pid: number,
  now: Date,
  environment?: RunEnvironment | Promise<RunEnvironment>,
  agent = false,
): (end?: RunEnd) => void {
  const path = join(dataDir, RUN_MARKER);
  let marker: RunMarker = { pid, startedAt: now.toISOString(), ...(agent ? { agent } : {}) };
  let ended = false;
  if (environment instanceof Promise)
    void environment.then(
      (observed) => {
        if (ended) return;
        marker = { ...marker, environment: observed };
        writeRunRecord(path, marker);
      },
      // No reading is recorded rather than a guessed one.
      () => {},
    );
  else if (environment) marker = { ...marker, environment };
  writeRunRecord(path, marker);
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

/**
 * Whether a window reopened on this folder keeps its starter while a grant
 * waits in the work folder (docs/view.md, "Following along"): with no grant
 * or no command running it always does, so a home that keeps its own first
 * mate still runs it in the background; beside a running command, only when
 * this app's own agent started it, so following along stops that command
 * and never one the person started by hand.
 */
export function keepsStarterBesideGrant(
  dataDir: string,
  grant: boolean,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  return !grant || !runningByCommand(dataDir, alive) || runByOwnAgent(dataDir, alive);
}

/** Whether the command running on this folder now says this app's own agent started it. */
export function runByOwnAgent(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  return ownedRun(dataDir, alive) !== null;
}

/** One run, by its process and the start its own note keeps, so a reused process number is another. */
export type OwnedRun = Pick<RunMarker, "pid" | "startedAt">;

/** Whether two readings name the same run. */
export function sameRun(a: OwnedRun | null | undefined, b: OwnedRun | null | undefined): boolean {
  return Boolean(a && b && a.pid === b.pid && a.startedAt === b.startedAt);
}

/**
 * The run a reading of the command's records names as running, when this
 * app's own agent started it, by that same reading: the run wrote so in its
 * note (`startedByAgent`). Null while none runs, while the records cannot be
 * read, and for a run started any other way.
 */
export function ownedRunOf(status: {
  running: boolean | null;
  run: RunMarker | null;
}): OwnedRun | null {
  const run = status.running === true ? status.run : null;
  return run?.agent === true ? { pid: run.pid, startedAt: run.startedAt } : null;
}

/**
 * The command running on this folder now, when this app's own agent started
 * it: the run itself wrote so in its note, from the mark its agent gave it
 * (`startedByAgent`). Null for any other, a command started by hand after
 * this window's own ended included, and one an agent from before that mark.
 */
export function ownedRun(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): OwnedRun | null {
  if (!runningByCommand(dataDir, alive)) return null;
  try {
    const marker = RunMarkerSchema.parse(
      JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8")),
    );
    return marker.agent === true ? { pid: marker.pid, startedAt: marker.startedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Stop, in Settings -> General beside a command (docs/run.md, "Quit and
 * Stop"): asks the command running on this folder to stop as a signal stops
 * it, so it ends cleanly with 0 and no starter starts it again. False when
 * no command runs here.
 */
export function stopRunningCommand(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
  signal: (pid: number, only?: OwnedRun) => void = hostPlatform() === "win32"
    ? (_pid, only) => {
        // Windows ends a signalled program at once, so the run is asked
        // through its folder: by its process and start where only that run
        // stops, which another run there ignores, and for whichever runs
        // there on Stop, which a run from an earlier version reads too.
        if (!requestRunStop(dataDir, new Date(), only))
          throw new Error("The stop could not be asked.");
      }
    : (pid) => process.kill(pid, "SIGTERM"),
  /** Stops only this run: another the folder's note names now is left running. */
  only?: OwnedRun,
): boolean {
  if (!runningByCommand(dataDir, alive)) return false;
  let marker: RunMarker;
  try {
    marker = RunMarkerSchema.parse(JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8")));
  } catch {
    return false;
  }
  if (only !== undefined && !sameRun(only, marker)) return false;
  try {
    signal(marker.pid, only);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process Chromium's lock link names; undefined where there is no link
 * to read, null for none. On Windows Chromium keeps no link but a file it
 * holds open (`lockfile`, removed when its holder ends): held reads as
 * undefined, a holder this cannot name, and free as null.
 */
export { windowsLockHeld };

export function lockHolder(
  dataDir: string,
  platform: string = hostPlatform(),
): number | null | undefined {
  if (platform === "win32") return windowsLockHeld(join(dataDir, "lockfile")) ? undefined : null;
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
