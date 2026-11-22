import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type LeftBehind,
  type ProgramOutcome,
  type StopOutcome,
  stopCommandSchema,
  stopLabelSchema,
  type TaskKeep,
  type TaskStop,
  type TaskStopsFile,
  taskStopsFileSchema,
} from "@shared/leftoverPrograms";
import type { LeftBehindHere } from "./leftBehind";

/**
 * A task's registered stops (docs/leftover-programs.md, "Registering a stop"): the
 * command that stops each thing its crewmate started to outlive the
 * command that started it, saved in the task's own folder on the computer
 * that runs the task, readable only by the user, so it survives a restart.
 * The close takes them all (`take`) and runs them; a carried-on task's
 * close hands them to its successor (`handOver`).
 */

export const STOPS_FILE_NAME = "stops.json";

/**
 * The folder beside a computer's task folders that holds the kept folders
 * of the jobs the captain asked to keep (docs/leftover-programs.md, "A job
 * the captain asked to keep"): `<userData>/kept` here, `kept` in the work
 * folder of a computer that runs work. No close and no retention removes it.
 */
export function keptRoot(tasksDir: string): string {
  return join(dirname(tasksDir), "kept");
}

/** The answer the task command gets: the stops now, or why one was refused. */
export type TaskStopsAnswer = {
  stops?: TaskStop[];
  added?: TaskStop;
  /** The task's keeps (docs/leftover-programs.md, "A job the captain asked to keep"). */
  keeps?: TaskKeep[];
  /** The keep just recorded, with the kept folder for the job's files. */
  kept?: TaskKeep;
  dropped?: string;
  /** What finished tasks left on this computer (`left`). */
  left?: LeftBehind;
  /** How a kept stop went when run again (`rerun`). */
  reran?: StopOutcome;
  /** How a kept program went when ended (`end`). */
  ended?: ProgramOutcome;
  /** A finished task's kept stop dropped without running (`drop <task> <stop id>`). */
  droppedKept?: { task: string; id: string; label: string };
  text?: string;
  refused?: "refused" | "invalid";
};

/** What a task's shell reaches through `infinitary-stops-axi`. */
export type TaskStopsCommand = {
  list: () => TaskStopsAnswer;
  add: (input: { label: string; command: string; cwd?: string }) => TaskStopsAnswer;
  /** Records a job the captain asked to keep running past the close, and answers its kept folder. */
  keep: (input: { label: string; check: string; remove: string; cwd?: string }) => TaskStopsAnswer;
  /** Drops a stop, or a keep without running its remove. */
  drop: (id: string) => TaskStopsAnswer;
  /** What finished tasks left on this computer; absent where the computer keeps no such record. */
  left?: () => Promise<TaskStopsAnswer>;
  rerun?: (task: string, id: string) => Promise<TaskStopsAnswer>;
  end?: (task: string, pid: number) => Promise<TaskStopsAnswer>;
  dropKept?: (task: string, id: string) => Promise<TaskStopsAnswer>;
};

const EMPTY: TaskStopsFile = { next: 1, stops: [] };

/** The stops file of a task's folder. */
export function stopsFile(taskFolder: string): string {
  return join(taskFolder, STOPS_FILE_NAME);
}

/** The task's stops, oldest first; a missing or unreadable file holds none. */
export function readStops(taskFolder: string): TaskStopsFile {
  let text: string;
  try {
    text = readFileSync(stopsFile(taskFolder), "utf8");
  } catch {
    return EMPTY;
  }
  try {
    const parsed = taskStopsFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeStops(taskFolder: string, file: TaskStopsFile): void {
  mkdirSync(taskFolder, { recursive: true, mode: 0o700 });
  const path = stopsFile(taskFolder);
  if (file.stops.length === 0 && (file.keeps ?? []).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

/**
 * Takes every stop, newest first, and empties them from the file: each runs
 * once, and a close asked again finds none left to run. The keeps stay for
 * `takeKeeps`.
 */
export function takeStops(taskFolder: string): TaskStop[] {
  const file = readStops(taskFolder);
  if (file.stops.length > 0) writeStops(taskFolder, { ...file, stops: [] });
  return [...file.stops].reverse();
}

/** Takes every keep, newest first, and empties them from the file, so a close asked again takes none. */
export function takeKeeps(taskFolder: string): TaskKeep[] {
  const file = readStops(taskFolder);
  const keeps = file.keeps ?? [];
  if (keeps.length > 0) writeStops(taskFolder, { next: file.next, stops: file.stops });
  return [...keeps].reverse();
}

/**
 * Moves every stop and keep to the task that carries the work on, after its
 * own, and answers how many of each moved. The successor's close runs or
 * keeps them; a keep's kept folder stays where it is.
 */
export function handOverStops(
  fromFolder: string,
  toFolder: string,
): { stops: number; keeps: number } {
  const { stops, keeps = [] } = readStops(fromFolder);
  if (stops.length === 0 && keeps.length === 0) return { stops: 0, keeps: 0 };
  const target = readStops(toFolder);
  let next = target.next;
  const moved = stops.map((stop) => ({ ...stop, id: `s${next++}` }));
  const movedKeeps = keeps.map((keep) => ({ ...keep, id: `s${next++}` }));
  const targetKeeps = [...(target.keeps ?? []), ...movedKeeps];
  writeStops(toFolder, {
    next,
    stops: [...target.stops, ...moved],
    ...(targetKeeps.length > 0 ? { keeps: targetKeeps } : {}),
  });
  rmSync(stopsFile(fromFolder), { force: true });
  return { stops: moved.length, keeps: movedKeeps.length };
}

/**
 * Whether this task's crewmate may record a keep here: refused, with the
 * words why, for a task run as another user on the home's own computer,
 * whose job would run as that user (INF-4381's plan, assumption 4).
 */
export type KeepsHere = { refused: string } | undefined;

export const KEEP_AS_ANOTHER_USER =
  "This task runs as another user on the captain's computer, so a job kept here would run as that user, not as the captain. Say so on your card: the first mate can start the job as a task under the captain's own account.";

/** The refusal on a computer whose home sent no word on keeps, being without the change. */
export const KEEP_NOT_YET =
  "The computer that keeps the record cannot take a kept job from this computer yet. Say so on your card instead of keeping the job.";

/** A computer that runs work's keeps, from the placed spec's `keeps` (`kept-jobs.md`). */
export function keepsThere(granted: boolean | undefined): KeepsHere {
  if (granted === true) return undefined;
  return { refused: granted === false ? KEEP_AS_ANOTHER_USER : KEEP_NOT_YET };
}

/**
 * The task command's view of one task's stops, in its folder, and of what
 * finished tasks left on this computer (`here`), which a cleanup look acts
 * on after the captain's pick.
 */
export function taskStopsCommand(
  taskFolder: string,
  now: () => number,
  here?: LeftBehindHere,
  keepsHere?: KeepsHere,
): TaskStopsCommand {
  return {
    ...(here
      ? {
          // The look on this computer reads each kept stop's command, to say
          // what it deletes and whether its target is gone, never to show it.
          left: async () => ({ left: await here.list({ commands: true }) }),
          dropKept: async (task: string, id: string) => {
            const outcome = await here.drop(task, id);
            return "refused" in outcome
              ? outcome
              : { droppedKept: { task, id, label: outcome.label } };
          },
          rerun: async (task: string, id: string) => {
            const outcome = await here.rerun(task, id);
            return "refused" in outcome ? outcome : { reran: outcome };
          },
          end: async (task: string, pid: number) => {
            const outcome = await here.end(task, pid);
            return "refused" in outcome ? outcome : { ended: outcome };
          },
        }
      : {}),
    list: () => {
      const file = readStops(taskFolder);
      return { stops: file.stops, keeps: file.keeps ?? [] };
    },
    add: (input) => {
      const label = stopLabelSchema.safeParse(input.label);
      const command = stopCommandSchema.safeParse(input.command);
      if (!label.success)
        return { text: "Name what the stop stops in at most 120 characters.", refused: "invalid" };
      if (!command.success)
        return {
          text: "Give the command that stops it, in at most 4000 characters.",
          refused: "invalid",
        };
      const file = readStops(taskFolder);
      const stop: TaskStop = {
        id: `s${file.next}`,
        label: label.data,
        command: command.data,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        at: now(),
      };
      writeStops(taskFolder, { ...file, next: file.next + 1, stops: [...file.stops, stop] });
      return { added: stop, stops: [...file.stops, stop], keeps: file.keeps ?? [] };
    },
    keep: (input) => {
      if (keepsHere) return { text: keepsHere.refused, refused: "refused" };
      const label = stopLabelSchema.safeParse(input.label);
      const check = stopCommandSchema.safeParse(input.check);
      const remove = stopCommandSchema.safeParse(input.remove);
      if (!label.success)
        return { text: "Name the job in at most 120 characters.", refused: "invalid" };
      if (!check.success)
        return {
          text: "Give the command that checks the job runs, in at most 4000 characters.",
          refused: "invalid",
        };
      if (!remove.success)
        return {
          text: "Give the command that removes the job, in at most 4000 characters.",
          refused: "invalid",
        };
      const file = readStops(taskFolder);
      const id = `s${file.next}`;
      // Beside the task folders, never in them: no close removes it.
      const folder = join(keptRoot(dirname(taskFolder)), `${basename(taskFolder)}-${id}`);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const keep: TaskKeep = {
        id,
        label: label.data,
        check: check.data,
        remove: remove.data,
        folder,
        account: userInfo().username,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        at: now(),
      };
      const keeps = [...(file.keeps ?? []), keep];
      writeStops(taskFolder, { next: file.next + 1, stops: file.stops, keeps });
      return { kept: keep, stops: file.stops, keeps };
    },
    drop: (id) => {
      const file = readStops(taskFolder);
      const left = file.stops.filter((stop) => stop.id !== id);
      const keeps = (file.keeps ?? []).filter((keep) => keep.id !== id);
      if (left.length === file.stops.length && keeps.length === (file.keeps ?? []).length)
        return { text: `This task keeps no stop or job ${id}.`, refused: "refused" };
      writeStops(taskFolder, {
        next: file.next,
        stops: left,
        ...(keeps.length > 0 ? { keeps } : {}),
      });
      return { dropped: id, stops: left, keeps };
    },
  };
}
