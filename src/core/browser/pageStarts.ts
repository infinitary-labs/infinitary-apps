import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hostEnv } from "../hostEnv";
import { killGroup } from "../jobs/jobManager";
import { windowsBash } from "../pi/windowsBash";
import { processRoots } from "../placed/processRoots";
import { hostPlatform } from "../platform";
import { atUtilityQos } from "../utilityQos";
import { type AnswerProbe, type AnswerTarget, probeLoopback } from "./pageAnswers";

/**
 * The command that starts a task's page, as its crewmate saved it with
 * `open <url> --start '<command>' --within <seconds>` (docs/task-browser.md,
 * "Starting a page again"): kept owner-only in the task's own folder on the
 * computer that runs its browser, beside its kept page, one for each task,
 * the newest replacing the last. When nothing answers at its address and
 * the captain waits there, the host runs it itself, and wakes the crewmate
 * only when it fails. Never part of a card or of a fact a view reads.
 */

export const PAGE_START_FILE_NAME = "page-start.json";

/** Where a start's output goes: the task's temporary folder, beside its other bulk output. */
export const PAGE_START_LOG = join("temp", "page-start.log");

const pageStartSchema = z.object({
  /** The command, run by a shell exactly as the crewmate wrote it. */
  command: z.string().min(1),
  /** The shell's folder when the crewmate saved it. */
  folder: z.string().min(1),
  /** The page's origin, the only address it starts. */
  origin: z.string().min(1),
  /** How long the crewmate said the build may take to answer. */
  withinMs: z.number().int().positive(),
});

export type PageStart = z.infer<typeof pageStartSchema>;

/** How one start ended: its address answered, or it failed. */
export type StartOutcome =
  | { kind: "answered"; log: string }
  | { kind: "failed"; exit?: number | null; ranOut?: true; log: string }
  /** It was stopped by the host before it answered (the browser stopped, the task closed). */
  | { kind: "stopped" };

/** A started command as the host holds it: its process and the run's own promise. */
type Running = {
  child: ChildProcess;
  windows: boolean;
  origin: string;
  outcome: Promise<StartOutcome>;
  /** Ends its wait now, with this outcome, and clears its timers. */
  settle: (outcome: StartOutcome) => void;
  stopped: boolean;
  /** Its address answered: the program runs on, and no one waits for it. */
  answered: boolean;
};

/** How often the host tries the address while a start runs. */
const ANSWER_POLL_MS = 250;

export type PageStartsOptions = {
  /** A task's own folder on this computer; a task with none keeps no start. */
  folderOf: (taskId: string) => string | undefined;
  /** Tries a loopback port; the real connection attempt when absent. */
  probe?: AnswerProbe;
  /** The system it runs on (tests); absent reads this computer's. */
  platform?: NodeJS.Platform;
};

export class PageStarts {
  private readonly running = new Map<string, Running>();
  /** Tasks whose crewmate's turn runs now: a build started for them is left alone. */
  private readonly turns = new Set<string>();
  /** Tasks whose browser stopped during that turn: the build stops at its end. */
  private readonly afterTurn = new Set<string>();

  constructor(private readonly options: PageStartsOptions) {}

  /** Keep a task's start, replacing the one it had. */
  keep(taskId: string, start: PageStart): void {
    const folder = this.options.folderOf(taskId);
    if (!folder) return;
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, PAGE_START_FILE_NAME);
      const next = `${path}.next`;
      writeFileSync(next, `${JSON.stringify(start)}\n`, { mode: 0o600 });
      chmodSync(next, 0o600);
      renameSync(next, path);
    } catch (error) {
      // A start not kept leaves the crewmate's wake as the way back, as before.
      console.warn(
        `[task-browser] could not keep a page's start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The task's kept start for this origin; none for any other. */
  kept(taskId: string, origin: string): PageStart | undefined {
    const folder = this.options.folderOf(taskId);
    if (!folder) return undefined;
    try {
      const parsed = pageStartSchema.safeParse(
        JSON.parse(readFileSync(join(folder, PAGE_START_FILE_NAME), "utf8")),
      );
      return parsed.success && parsed.data.origin === origin ? parsed.data : undefined;
    } catch {
      // A missing or unreadable file keeps no start.
      return undefined;
    }
  }

  /** Whether a start the host began for this task still runs and waits for its answer. */
  starting(taskId: string): boolean {
    const run = this.running.get(taskId);
    return run !== undefined && !run.stopped && !run.answered;
  }

  /**
   * Run a task's start and wait until its address answers, its program
   * exits first, or its wait runs out. One start runs for each task at a
   * time: a second call while one waits shares its outcome. A program that
   * answered keeps running until the host stops it (`stop`).
   */
  run(taskId: string, start: PageStart, target: AnswerTarget): Promise<StartOutcome> {
    const current = this.running.get(taskId);
    // One that waits is shared; one that answered and no longer does is started again.
    if (current && !current.answered && current.origin === start.origin) return current.outcome;
    if (current) this.stop(taskId);
    const folder = this.options.folderOf(taskId);
    const log = folder ? join(folder, PAGE_START_LOG) : undefined;
    if (!log) return Promise.resolve({ kind: "failed", exit: null, log: "" });
    const windows = (this.options.platform ?? hostPlatform()) === "win32";
    const sh = windows ? windowsBash() : "/bin/sh";
    if (!sh) return Promise.resolve({ kind: "failed", exit: 127, log });
    let child: ChildProcess;
    try {
      mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
      const fd = openSync(log, "a", 0o600);
      // Below the window's priority, in a process group of its own, with the
      // person's environment and the folder the crewmate saved it in.
      const command = atUtilityQos(sh, ["-c", start.command]);
      try {
        child = spawn(command.file, command.args, {
          cwd: start.folder,
          env: hostEnv(),
          detached: true,
          windowsHide: true,
          stdio: ["ignore", fd, fd],
        });
      } finally {
        closeSync(fd);
      }
    } catch {
      return Promise.resolve({ kind: "failed", exit: null, log });
    }
    const release = child.pid ? processRoots.add(child.pid, taskId) : () => undefined;
    const probe = this.options.probe ?? probeLoopback;
    const run: Running = {
      child,
      windows,
      origin: start.origin,
      stopped: false,
      answered: false,
      outcome: Promise.resolve({ kind: "stopped" }),
      settle: () => undefined,
    };
    run.outcome = new Promise<StartOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: StartOutcome) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(limit);
        resolve(outcome);
      };
      run.settle = settle;
      // A shell that never started (its folder gone) ends the run as an exit does, saying why.
      const ended = (code: number | null, error?: Error) => {
        release();
        if (this.running.get(taskId) === run) this.running.delete(taskId);
        if (error) writeLog(log, `${error.message}\n`);
        settle(run.stopped ? { kind: "stopped" } : { kind: "failed", exit: code, log });
      };
      child.once("error", (error) => ended(null, error));
      child.once("exit", (code) => ended(code));
      const poll = setInterval(() => {
        void probe(target.host, target.port).then((reading) => {
          if (reading !== "answered" || run.stopped || settled) return;
          run.answered = true;
          settle({ kind: "answered", log });
        });
      }, ANSWER_POLL_MS);
      const limit = setTimeout(() => {
        if (run.stopped) return;
        settle({ kind: "failed", ranOut: true, log });
        this.stop(taskId);
      }, start.withinMs);
    });
    this.running.set(taskId, run);
    return run.outcome;
  }

  /** Stop the program the host started for this task, if one runs; never anything else. */
  stop(taskId: string, signal: NodeJS.Signals = "SIGTERM"): void {
    this.afterTurn.delete(taskId);
    const run = this.running.get(taskId);
    if (!run) return;
    run.stopped = true;
    this.running.delete(taskId);
    run.settle({ kind: "stopped" });
    killGroup(run, signal);
  }

  /**
   * The task's browser stopped: the build stops with it, unless its
   * crewmate's turn runs now, when it stops at that turn's end instead.
   */
  stopWithBrowser(taskId: string): void {
    if (this.turns.has(taskId) && this.running.has(taskId)) this.afterTurn.add(taskId);
    else this.stop(taskId);
  }

  /**
   * A turn of the task's crewmate began or ended. At its end, a build whose
   * browser stopped during it stops, unless the browser is open again.
   */
  turn(taskId: string, running: boolean, browserOpen: boolean): void {
    if (running) {
      this.turns.add(taskId);
      return;
    }
    this.turns.delete(taskId);
    if (!this.afterTurn.delete(taskId)) return;
    if (!browserOpen) this.stop(taskId);
  }

  /** The task closed: its program stops and its kept start goes. */
  forget(taskId: string): void {
    this.stop(taskId);
    this.turns.delete(taskId);
    const folder = this.options.folderOf(taskId);
    if (!folder) return;
    try {
      rmSync(join(folder, PAGE_START_FILE_NAME), { force: true });
    } catch {
      // A file that cannot be removed starts nothing once its task closed.
    }
  }

  /** Infinitary quits: every program the host started stops, at once, since the app is going. */
  stopAll(): void {
    for (const taskId of [...this.running.keys()]) this.stop(taskId, "SIGKILL");
  }
}

/** One line more in a start's log; a log that cannot be written loses only that line. */
function writeLog(log: string, line: string): void {
  try {
    appendFileSync(log, line, { mode: 0o600 });
  } catch {
    // The wake still names the log and how the start failed.
  }
}
