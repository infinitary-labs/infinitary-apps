import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type KeptLeftovers,
  keptLeftoversSchema,
  type LeftBehind,
  type ProgramOutcome,
  type StopOutcome,
  type TaskStop,
} from "@shared/leftoverPrograms";
import type { LoadRun } from "@shared/load";
import { endHolder } from "../placed/folderHolders";
import { type ProcessReading, readProcesses } from "../placed/processResources";

/**
 * What finished tasks left on this computer (docs/leftover-programs.md,
 * "What a close leaves"): the close keeps each stop it could not finish,
 * with its command, and each program that survived, with its birth, in the
 * task's own folder, readable only by the user. The computer lists them
 * with its finished tasks' runs still in its heavy-run line, and a cleanup
 * look reruns a kept stop or ends a kept program through the app, which
 * checks the program's birth first.
 */

export const KEPT_LEFTOVERS_FILE = "leftovers.json";
/**
 * Beside the task folders, one empty marker per task that keeps something,
 * so the list reads only those tasks, never every folder the computer holds.
 */
export const KEPT_INDEX_DIR = ".left-behind";

const EMPTY: KeptLeftovers = { stops: [], programs: [] };
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the task's close kept; a missing or unreadable file keeps nothing. */
export function readKept(taskFolder: string): KeptLeftovers {
  try {
    const parsed = keptLeftoversSchema.safeParse(
      JSON.parse(readFileSync(join(taskFolder, KEPT_LEFTOVERS_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeKept(taskFolder: string, kept: KeptLeftovers): void {
  const path = join(taskFolder, KEPT_LEFTOVERS_FILE);
  const index = join(dirname(taskFolder), KEPT_INDEX_DIR);
  const marker = join(index, basename(taskFolder));
  if (kept.stops.length === 0 && kept.programs.length === 0) {
    rmSync(path, { force: true });
    rmSync(marker, { force: true });
    return;
  }
  mkdirSync(taskFolder, { recursive: true, mode: 0o700 });
  mkdirSync(index, { recursive: true, mode: 0o700 });
  writeFileSync(marker, "", { mode: 0o600 });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

/**
 * Keeps what a close could not finish, beside what an earlier close of the
 * same task kept: each stop that failed or did not finish, and each program
 * that survived with a known birth.
 */
export function keepLeftovers(
  taskFolder: string,
  stops: readonly { stop: TaskStop; outcome: StopOutcome }[],
  programs: readonly ProgramOutcome[],
): boolean {
  const keptStops = stops.flatMap(({ stop, outcome }) =>
    outcome.outcome === "ran"
      ? []
      : [
          {
            ...stop,
            outcome: outcome.outcome,
            ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          },
        ],
  );
  const keptPrograms = programs.flatMap((program) =>
    program.outcome === "survived" && program.started
      ? [{ pid: program.pid, name: program.name, started: program.started }]
      : [],
  );
  if (keptStops.length === 0 && keptPrograms.length === 0) return false;
  const before = readKept(taskFolder);
  const taken = new Set(before.stops.map((stop) => stop.id));
  writeKept(taskFolder, {
    stops: [...before.stops, ...keptStops.filter((stop) => !taken.has(stop.id))],
    programs: [...before.programs, ...keptPrograms],
  });
  return true;
}

/** A refusal the stops command shows as it is. */
export type LeftBehindRefusal = { text: string; refused: "refused" | "invalid" };

export type LeftBehindOptions = {
  /** The folder holding one folder per task on this computer. */
  tasksDir: string;
  /** Whether the task is finished, as this computer knows it. */
  closed: (task: string) => boolean;
  /** Whether the task's close is still running its own cleanup here. */
  sweeping?: (task: string) => boolean;
  /** This computer's heavy-run line now. */
  runs: () => readonly LoadRun[];
  processes?: () => Promise<ProcessReading[] | null>;
  /** Runs one kept stop again (`runStop`). */
  runStop: (stop: TaskStop, cwd: string) => Promise<StopOutcome>;
  graceMs?: number;
};

/** One computer's record of what its finished tasks left, and the two acts on it. */
export class LeftBehindHere {
  private readonly acting = new Set<string>();
  private readonly sweeps = new Set<string>();

  constructor(private readonly options: LeftBehindOptions) {}

  /**
   * Runs a close's own cleanup of the task; until it ends, the task counts
   * as not finished here, so nothing it is about to end is listed or acted on.
   */
  async sweep<T>(task: string, run: () => Promise<T>): Promise<T> {
    this.sweeps.add(task);
    try {
      return await run();
    } finally {
      this.sweeps.delete(task);
    }
  }

  /** Finished here, and its close's own cleanup done. */
  private finished(task: string): boolean {
    return (
      this.options.closed(task) &&
      !this.sweeps.has(task) &&
      !(this.options.sweeping?.(task) ?? false)
    );
  }

  /** The tasks that kept something here, finished or not, read from the index alone. */
  private indexed(): string[] {
    let names: string[];
    try {
      names = readdirSync(join(this.options.tasksDir, KEPT_INDEX_DIR));
    } catch {
      return [];
    }
    return names
      .filter((task) => {
        if (!TASK_ID.test(task)) return false;
        if (existsSync(join(this.options.tasksDir, task, KEPT_LEFTOVERS_FILE))) return true;
        // The task's folder went with retention: its marker goes too.
        rmSync(join(this.options.tasksDir, KEPT_INDEX_DIR, task), { force: true });
        return false;
      })
      .sort();
  }

  /**
   * The list: kept stops without their commands, kept programs still running
   * with the same birth, and finished tasks' runs in the line. A program is
   * left out when the process table cannot be read, never guessed alive.
   */
  async list(options: { commands?: boolean } = {}): Promise<LeftBehind> {
    const indexed = this.indexed();
    const tasks = indexed.filter((task) => this.finished(task));
    const kept = tasks.map((task) => ({
      task,
      kept: readKept(join(this.options.tasksDir, task)),
    }));
    const rows =
      kept.some((entry) => entry.kept.programs.length > 0) &&
      ((await (this.options.processes ?? readProcesses)()) ?? []);
    const alive = new Map((rows || []).filter((row) => !row.exited).map((row) => [row.pid, row]));
    return {
      stops: kept.flatMap(({ task, kept }) =>
        kept.stops.map((stop) => ({
          task,
          id: stop.id,
          label: stop.label,
          outcome: stop.outcome,
          ...(stop.exitCode !== undefined ? { exitCode: stop.exitCode } : {}),
          ...(options.commands
            ? { command: stop.command, ...(stop.cwd !== undefined ? { cwd: stop.cwd } : {}) }
            : {}),
        })),
      ),
      programs: kept.flatMap(({ task, kept }) =>
        kept.programs
          .filter((program) => alive.get(program.pid)?.started === program.started)
          .map((program) => ({ task, ...program })),
      ),
      runs: this.options
        .runs()
        .filter((run) => TASK_ID.test(run.taskId) && this.finished(run.taskId))
        .map((run) => ({ task: run.taskId, id: run.id, state: run.state, demand: run.demand })),
      kept: indexed,
    };
  }

  private refusal(task: string): LeftBehindRefusal | undefined {
    if (!TASK_ID.test(task)) return { text: "Name a task by its id.", refused: "invalid" };
    if (!this.finished(task))
      return {
        text: `Task ${task} is not finished here, or its close is still cleaning up: nothing was done.`,
        refused: "refused",
      };
    return undefined;
  }

  private async once<T>(key: string, act: () => Promise<T>): Promise<T | LeftBehindRefusal> {
    if (this.acting.has(key)) return { text: "That is already being done.", refused: "refused" };
    this.acting.add(key);
    try {
      return await act();
    } finally {
      this.acting.delete(key);
    }
  }

  /**
   * Runs a kept stop again, once; it leaves the record when it runs cleanly,
   * and keeps its new outcome otherwise.
   */
  async rerun(task: string, id: string): Promise<StopOutcome | LeftBehindRefusal> {
    const refused = this.refusal(task);
    if (refused) return refused;
    const folder = join(this.options.tasksDir, task);
    const stop = readKept(folder).stops.find((candidate) => candidate.id === id);
    if (!stop) return { text: `Task ${task} keeps no stop ${id} here.`, refused: "refused" };
    return this.once(`${task}:${id}`, async () => {
      const { outcome: _was, exitCode: _code, ...registered } = stop;
      const outcome = await this.options.runStop(registered, folder);
      const now = readKept(folder);
      const was = outcome.outcome;
      writeKept(folder, {
        ...now,
        stops:
          was === "ran"
            ? now.stops.filter((candidate) => candidate.id !== id)
            : now.stops.map((candidate) =>
                candidate.id === id
                  ? {
                      ...registered,
                      outcome: was,
                      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
                    }
                  : candidate,
              ),
      });
      return outcome;
    });
  }

  /**
   * Drops a kept stop without running it, for one whose target a cleanup
   * look found already gone.
   */
  async drop(task: string, id: string): Promise<{ label: string } | LeftBehindRefusal> {
    const refused = this.refusal(task);
    if (refused) return refused;
    const folder = join(this.options.tasksDir, task);
    const stop = readKept(folder).stops.find((candidate) => candidate.id === id);
    if (!stop) return { text: `Task ${task} keeps no stop ${id} here.`, refused: "refused" };
    return this.once(`${task}:${id}`, async () => {
      const now = readKept(folder);
      writeKept(folder, { ...now, stops: now.stops.filter((candidate) => candidate.id !== id) });
      return { label: stop.label };
    });
  }

  /**
   * Ends a kept program: an end request, then a kill after the grace
   * period, each only while the program still has its kept birth. One gone
   * or replaced by a new program of the same number leaves the record.
   */
  async end(task: string, pid: number): Promise<ProgramOutcome | LeftBehindRefusal> {
    const refused = this.refusal(task);
    if (refused) return refused;
    const folder = join(this.options.tasksDir, task);
    const program = readKept(folder).programs.find((candidate) => candidate.pid === pid);
    if (!program) return { text: `Task ${task} keeps no program ${pid} here.`, refused: "refused" };
    return this.once(`${task}:${pid}`, async (): Promise<ProgramOutcome | LeftBehindRefusal> => {
      const rows = await (this.options.processes ?? readProcesses)();
      if (!rows)
        return {
          text: `The process table could not be read, so program ${pid} was not checked and nothing was signalled. Try again later.`,
          refused: "refused",
        };
      const outcome = await endHolder(program, {
        onlyWhenRead: true,
        ...(this.options.graceMs !== undefined ? { graceMs: this.options.graceMs } : {}),
      });
      if (outcome.outcome !== "survived") {
        const now = readKept(folder);
        writeKept(folder, {
          ...now,
          programs: now.programs.filter(
            (candidate) => candidate.pid !== pid || candidate.started !== program.started,
          ),
        });
      }
      return outcome;
    });
  }
}
