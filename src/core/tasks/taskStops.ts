import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LeftBehind,
  type ProgramOutcome,
  type StopOutcome,
  stopCommandSchema,
  stopLabelSchema,
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

/** The answer the task command gets: the stops now, or why one was refused. */
export type TaskStopsAnswer = {
  stops?: TaskStop[];
  added?: TaskStop;
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
  if (file.stops.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

/**
 * Takes every stop, newest first, and empties the file: each runs once,
 * and a close asked again finds none left to run.
 */
export function takeStops(taskFolder: string): TaskStop[] {
  const { stops } = readStops(taskFolder);
  if (stops.length > 0) rmSync(stopsFile(taskFolder), { force: true });
  return [...stops].reverse();
}

/**
 * Moves every stop to the task that carries the work on, after its own,
 * and answers how many moved. The successor's close runs them.
 */
export function handOverStops(fromFolder: string, toFolder: string): number {
  const { stops } = readStops(fromFolder);
  if (stops.length === 0) return 0;
  const target = readStops(toFolder);
  let next = target.next;
  const moved = stops.map((stop) => ({ ...stop, id: `s${next++}` }));
  writeStops(toFolder, {
    next,
    stops: [...target.stops, ...moved],
  });
  rmSync(stopsFile(fromFolder), { force: true });
  return moved.length;
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
    list: () => ({ stops: readStops(taskFolder).stops }),
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
      writeStops(taskFolder, { next: file.next + 1, stops: [...file.stops, stop] });
      return { added: stop, stops: [...file.stops, stop] };
    },
    drop: (id) => {
      const file = readStops(taskFolder);
      const left = file.stops.filter((stop) => stop.id !== id);
      if (left.length === file.stops.length)
        return { text: `This task keeps no stop ${id}.`, refused: "refused" };
      writeStops(taskFolder, { next: file.next, stops: left });
      return { dropped: id, stops: left };
    },
  };
}
