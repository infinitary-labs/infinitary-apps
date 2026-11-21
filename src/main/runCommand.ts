import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runIdentity } from "@core/helper/runAgent";
import { RUN_RECORD_FILE, requestRunStop, windowsLockHeld } from "@core/helper/windowsTask";
import { captureLoginPath, hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import type { DataRefusal } from "@core/storage/dataFolderRefusal";
import { APP_IDENTITIES } from "@shared/codeNames";
import { COMPUTER } from "@shared/deviceNames";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
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
  /**
   * Windows' own birth of the run's process (`windowsBirth`), which no later
   * program under its number shares: a force stop lets only that process go
   * on where it was suspended. Absent elsewhere and from earlier runs.
   */
  birth: z.string().optional(),
  /**
   * The run's own reading of force stops runs, with, on a Mac or Linux, the
   * helper that lets its stopped process go on (`watchRunForce`): only from
   * then can Restart it end it however stuck it is, so only then is it
   * offered. Absent until then and from earlier runs.
   */
  recovers: z.literal(true).optional(),
  /**
   * On a Mac or Linux, the two pipes the run holds as it says a force stop
   * can end it (`watchRunForce`), as the files they are: a stop asks, wakes
   * and reads only these, never another file found at their names. Written
   * and taken away with `recovers`.
   */
  pipes: z
    .object({
      wake: z.object({ ino: z.number(), dev: z.number() }),
      life: z.object({ ino: z.number(), dev: z.number() }),
    })
    .optional(),
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
 * start that writes this note has returned (./index.ts). Whether a force
 * stop can end the run (`recovers`) is added the same way once it can, and
 * taken away again should that stop being so, with the pipes it holds then
 * (`pipes`): `recovers` is handed the setter its reading calls
 * (`watchRunForce`'s `ready`).
 */
export function markRunning(
  dataDir: string,
  pid: number,
  now: Date,
  environment?: RunEnvironment | Promise<RunEnvironment>,
  agent = false,
  birth?: string | null,
  recovers?: (note: (can: boolean, pipes?: RunMarker["pipes"]) => void) => void,
): (end?: RunEnd) => void {
  const path = join(dataDir, RUN_MARKER);
  let marker: RunMarker = {
    pid,
    startedAt: now.toISOString(),
    ...(agent ? { agent } : {}),
    ...(birth ? { birth } : {}),
  };
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
  recovers?.((can, pipes) => {
    if (ended || (marker.recovers === true) === can) return;
    const { recovers: _was, pipes: _held, ...rest } = marker;
    marker = can ? { ...rest, recovers: true, ...(pipes ? { pipes } : {}) } : rest;
    writeRunRecord(path, marker);
  });
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
 * note a crash left names a process that is gone or holds nothing. Only a run
 * known to be the noted one counts (`commandHolding`'s `known`): on Windows a
 * note whose run's birth cannot be read while the lock is held may be a
 * window's lock beside a stale note, so it answers no.
 */
export function runningByCommand(
  dataDir: string,
  alive: (pid: number, birth?: string) => boolean | null = runIdentity,
): boolean {
  const holding = commandHolding(dataDir, alive);
  return holding.running && holding.known;
}

/**
 * Whether a command holds the folder (`runningByCommand`) and, from the same
 * reading of its note, whether this app's own agent started it
 * (`ownedRun`): one reading, so the two never describe different runs. On
 * Windows, whose lock names no holder, a note that keeps the run's birth is
 * read by it (`runIdentity`), so a program that took the number of a run that
 * ended without taking its note away is no command; a note from an earlier
 * run keeps no birth and is read by its number alone, as before. Where the
 * birth cannot be read while the lock is held, a command holds the folder
 * but is not known to be the noted run (`known` false): it is nobody's own,
 * so no window stops it, joins beside it as its owner or asks it to end.
 */
export function commandHolding(
  dataDir: string,
  alive: (pid: number, birth?: string) => boolean | null = runIdentity,
): { running: boolean; owned: OwnedRun | null; known: boolean } {
  const none = { running: false, owned: null, known: false };
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8"));
  } catch {
    return none;
  }
  const pid = (marker as Partial<RunMarker> | null)?.pid;
  const birth = (marker as Partial<RunMarker> | null)?.birth;
  if (typeof pid !== "number" || pid <= 0) return none;
  const holds = alive(pid, typeof birth === "string" ? birth : undefined);
  if (holds === false) return none;
  const holder = lockHolder(dataDir);
  if (holder !== undefined && holder !== pid) return none;
  const parsed = RunMarkerSchema.safeParse(marker);
  const owned =
    holds === true && parsed.success && parsed.data.agent === true
      ? { pid: parsed.data.pid, startedAt: parsed.data.startedAt }
      : null;
  return { running: true, owned, known: holds === true };
}

/**
 * Whether a window reopened on this folder keeps its starter while a grant
 * waits in the work folder (docs/view.md, "Following along"): with no grant
 * or no command running it always does, so a home that keeps its own first
 * mate still runs it in the background; beside a running command, only when
 * this app's own agent started it, so following along stops that command
 * and never one the person started by hand. Read from the one reading of the
 * records (`commandHolding`) the window also opens beside a command by, so
 * the two never describe different runs. Beside a command not known to be
 * the noted run (`known` false) it keeps the starter too: the window waits
 * to learn who holds the folder, and a later reading that finds the agent's
 * own run there finds the window still its starter, while one beside a run
 * started by hand reads it as outside then (`BesideWindow.joinState`).
 */
export function keepsStarterBesideGrant(
  holding: { running: boolean; owned: OwnedRun | null; known: boolean },
  grant: boolean,
): boolean {
  return !grant || !holding.running || !holding.known || holding.owned !== null;
}

/**
 * The file a window that holds the folder's lock writes in its data folder
 * when a launch refused that lock asked it to answer (`windowAnswers`, the
 * launch's own word for it): a run never answers, so only a window does.
 */
export function windowAnswerFile(word: string): string {
  return `window-answer-${word}`;
}

/** Whether a launch's words to the lock's holder ask a window to answer, and with which word. */
export function windowAnswerAsked(data: unknown): string | null {
  const word = (data as { windowAnswers?: unknown } | null)?.windowAnswers;
  return typeof word === "string" && /^[0-9a-f]{16}$/.test(word) ? word : null;
}

/** The process of the launch that asked (`asker` beside `windowAnswers`), for its answer's cleanup; null where not given. */
export function windowAnswerAsker(data: unknown): number | null {
  const pid = (data as { asker?: unknown } | null)?.asker;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * What the window that holds the folder's lock does at a second launch: it
 * brings a window forward - focusing one, or opening one again where the app
 * outlived its last, as on a Mac - and answers a launch's ask
 * (`windowAnswerAsked`) only once one of its windows is there, never from a
 * program showing none. An ask it already took brings nothing forward again;
 * an answer that could not be written is written again a while later, with
 * no window brought forward, so a launch that waits on a holder it does not
 * ask again still hears it.
 */
export function answerLaunch(
  word: string | null,
  window: {
    /** The words this window was already asked, answered or with their answer on its way. */
    asked: Set<string>;
    /** Brings a window forward, opening one again where the app keeps working closed. */
    bringForward: () => void;
    /** Whether one of the app's own windows is there. */
    shown: () => boolean;
    /** Calls `then` once another window is made. */
    whenMade: (then: () => void) => void;
    /** Writes the answer (`windowAnswerFile`); false when it could not. */
    answer: (word: string) => boolean;
    /** Calls `then` a while later, to write an answer that could not be written again. */
    later: (then: () => void) => void;
  },
): void {
  if (word !== null && window.asked.has(word)) return;
  window.bringForward();
  if (word === null) return;
  window.asked.add(word);
  const once = () => {
    if (!window.shown()) window.whenMade(once);
    else if (!window.answer(word)) window.later(once);
  };
  once();
}

/**
 * Writes the answer a window gives a launch's ask (`windowAnswerFile`) and
 * keeps it among `written` with the launch that asked (`windowAnswerAsker`),
 * so the window that wrote it takes away an answer whose launch is gone
 * (`clearWindowAnswers`): a launch that already told the window from what
 * it runs as (`holderIsWindow`) quits without waiting for it. A launch
 * already gone is answered with nothing written. Throws where it cannot be
 * written, keeping nothing.
 */
export function writeWindowAnswer(
  dataDir: string,
  word: string,
  asker: number | null,
  written: Map<string, number | null>,
  alive: (pid: number) => boolean = processAlive,
): boolean {
  if (asker !== null && !alive(asker)) return true;
  const path = join(dataDir, windowAnswerFile(word));
  writeFileSync(path, "", { mode: 0o600 });
  written.set(path, asker);
  return true;
}

/**
 * Takes away, as the window quits, the answers it wrote whose launch is gone
 * (`writeWindowAnswer`): an answer whose launch is still there stays for it
 * to read, which it takes away itself, so a window quitting just after it
 * answered never leaves that launch to take the folder it just gave up.
 */
export function clearWindowAnswers(
  written: Map<string, number | null>,
  alive: (pid: number) => boolean = processAlive,
): void {
  for (const [path, asker] of written)
    if (asker === null || !alive(asker))
      try {
        rmSync(path, { force: true });
      } catch {
        // Left behind, it answers a word no later launch asks.
      }
  written.clear();
}

/**
 * The pipe a command holds on a Windows PC for as long as it runs, from
 * before it asks for the folder's lock (`holdCommandPipe`), by the folder it
 * runs on: Windows' own lock names no holder, so a window launch refused
 * that lock tells a command holding it from a window by this pipe
 * (`commandPipeHeld`). A pipe is no file in the folder and goes with its
 * program, so a command that ended leaves nothing behind.
 */
export function commandPipe(dataDir: string): string {
  const key = createHash("sha256").update(resolve(dataDir).toLowerCase()).digest("hex");
  return `\\\\.\\pipe\\infinitary-run-${key.slice(0, 32)}`;
}

/**
 * Holds the command's pipe (`commandPipe`) until the program ends, or until
 * the returned call lets it go; a pipe it cannot hold is said in its log.
 */
export function holdCommandPipe(path: string): () => void {
  const server = createServer((socket) => socket.destroy());
  server.on("error", (error) =>
    console.warn(`[run] could not hold the command's pipe: ${error.message}`),
  );
  server.listen(path);
  server.unref();
  return () => server.close();
}

/** Whether a command holds its pipe (`commandPipe`): null where that cannot be told. */
export function commandPipeHeld(path: string): Promise<boolean | null> {
  return new Promise((done) => {
    const socket = connect(path);
    const end = (held: boolean | null) => {
      socket.destroy();
      done(held);
    };
    socket.once("connect", () => end(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      end(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? false : null),
    );
    socket.setTimeout(RESOURCE_READ_TIMEOUT_MS, () => end(null));
  });
}

/**
 * The words a program runs with, read from the system by its process: on
 * Linux exactly, from `/proc`; on a Mac from `ps`, only where they start
 * with this program's own path (`execPath`), which tells that path from the
 * words after it however many spaces it holds. Null where they cannot be
 * read, and on Windows.
 */
export async function programWords(
  pid: number,
  platform: string = hostPlatform(),
  execPath: string = process.execPath,
): Promise<string[] | null> {
  try {
    if (platform === "linux") {
      const words = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (words.at(-1) === "") words.pop();
      return words.length > 0 ? words : null;
    }
    if (platform !== "darwin") return null;
    const { stdout } = await promisify(execFile)(
      "/bin/ps",
      ["-ww", "-o", "args=", "-p", String(pid)],
      {
        env: hostEnv({ LC_ALL: "C" }),
        encoding: "utf8",
        timeout: RESOURCE_READ_TIMEOUT_MS,
      },
    );
    return wordsAfterProgram(stdout.trim(), execPath);
  } catch {
    return null;
  }
}

/** A Mac's `ps` line of a program's words, split after this program's own path; null for another program's. */
export function wordsAfterProgram(line: string, execPath: string): string[] | null {
  if (line !== execPath && !line.startsWith(`${execPath} `)) return null;
  return [execPath, ...line.slice(execPath.length).split(" ").filter(Boolean)];
}

/**
 * Whether the program holding the folder's lock is a window rather than a
 * command, from what it runs as: on a Mac or Linux, the words it runs with
 * (`programWords`), since a command always runs with `run` among them,
 * whatever its version, and a window never does; on a Windows PC, whose
 * lock names no holder, whether a command holds its pipe
 * (`commandPipeHeld`). Null where that cannot be read, so it is not known.
 * A window is a program the launch's ask reached, which brings a window
 * forward itself (`answerLaunch`), as every version's does.
 */
export async function holderIsWindow(
  pid: number | undefined,
  read: {
    words?: (pid: number) => Promise<string[] | null>;
    /** On a Windows PC: whether a command holds its pipe. */
    commandPipe?: () => Promise<boolean | null>;
  } = {},
): Promise<boolean | null> {
  if (read.commandPipe) {
    const held = await read.commandPipe();
    return held === null ? null : !held;
  }
  if (pid === undefined) return null;
  const words = await (read.words ?? programWords)(pid);
  return words === null ? null : !words.slice(1).includes("run");
}

/**
 * Who holds the single-instance lock a window launch was refused, from what
 * each holder shows of itself and never from silence: `run` once a command
 * notes that it holds the folder; `window` once the window holding the lock
 * answered the launch's ask (`windowAnswerFile`), which a run never does, or
 * once the holder the ask reached shows it is no command (`windowHolder`,
 * `holderIsWindow`), a window from before that answer included, which
 * brought its window forward at the ask; `free` once the lock can be taken,
 * as when the holder ended before it noted anything. A holder that shows
 * none of these, as a command stopped before it noted itself, is waited for
 * as long as it takes, so the launch never quits with no window to take
 * over. Asking for the lock is a second launch to its holder, which a window
 * brings itself forward on, so a holder is asked once: the one the launch's
 * own ask reached, and once more only each time the holder seen changes,
 * the lock let go of included, before anything it shows is taken, so the
 * window that takes over is always one that was asked. A holder seen
 * unchanged is only watched, never asked again, so nothing is brought
 * forward twice. What it runs as is read once, and again a while later
 * (`askEveryMs`) only where it could not be told, or where the lock names no
 * holder, which may have changed unseen.
 */
export async function lockHolderKind(options: {
  running: () => boolean;
  answered: () => boolean;
  holder: () => number | null | undefined;
  /** The holder read just before the launch's own refused ask, the one that ask reached. */
  asked: number | null | undefined;
  /** Whether the holder is a window, by what it runs as; null where not known. */
  windowHolder: (holder: number | undefined) => Promise<boolean | null>;
  lockFree: () => boolean;
  askEveryMs: number;
  everyMs?: number;
}): Promise<"run" | "free" | "window"> {
  let seen = options.asked;
  let read: number | null | undefined = null;
  let readAgain = 0;
  for (;;) {
    if (options.running()) return "run";
    if (options.answered()) return "window";
    const holder = options.holder();
    if (holder !== seen) {
      // A holder the launch's ask did not reach, or the lock let go: asked once, before anything
      // else, so it brings its window forward if it is one.
      seen = holder;
      read = null;
      if (options.lockFree()) return "free";
    } else if (holder !== null && (holder !== read || Date.now() >= readAgain)) {
      const window = await options.windowHolder(holder);
      // Only while that same holder still holds the lock: what was read of one that let it go
      // since tells nothing of the next, which is asked first.
      if (window === true && options.holder() === holder) return "window";
      read = holder;
      readAgain =
        window === null || holder === undefined
          ? Date.now() + options.askEveryMs
          : Number.POSITIVE_INFINITY;
    }
    await new Promise((resolve) => setTimeout(resolve, options.everyMs ?? 250));
  }
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
  alive: (pid: number, birth?: string) => boolean | null = runIdentity,
): OwnedRun | null {
  return commandHolding(dataDir, alive).owned;
}

/**
 * Stop, in Settings -> General beside a command (docs/run.md, "Quit and
 * Stop"): asks the command running on this folder to stop as a signal stops
 * it, so it ends cleanly with 0 and no starter starts it again. False when
 * no command runs here.
 */
export function stopRunningCommand(
  dataDir: string,
  alive: (pid: number, birth?: string) => boolean | null = runIdentity,
  signal: (pid: number, only?: OwnedRun) => void = (pid, only) => {
    // A stop for one run alone is asked through its folder, by its process
    // and start, and only that run reads it as its own: a signal goes to a
    // process number, which another program may have taken by the time it
    // arrives. Windows ends a signalled program at once, so it asks Stop
    // through the folder too, which a run from an earlier version reads.
    if (only !== undefined || hostPlatform() === "win32") {
      if (!requestRunStop(dataDir, new Date(), only))
        throw new Error("The stop could not be asked.");
      return;
    }
    process.kill(pid, "SIGTERM");
  },
  /** Stops only this run: another the folder's note names now is left running. */
  only?: OwnedRun,
): boolean {
  const holding = commandHolding(dataDir, alive);
  if (!holding.running) return false;
  // A stop for one run alone goes only to a run seen to be it.
  if (only !== undefined && !holding.known) return false;
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
