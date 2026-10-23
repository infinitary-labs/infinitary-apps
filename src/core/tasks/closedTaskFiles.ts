import { join } from "node:path";
import { APP_KEPT_PARTS, removedWords, removeTaskLeftovers } from "./taskLeftovers";

export { APP_KEPT_PARTS } from "./taskLeftovers";

import type { AppPaths } from "../paths";
import type { TaskRecord } from "../storage/taskStore";
import { TaskService } from "./taskService";

/**
 * A closed task's leftover files (docs/task-retention.md, "A closed task's
 * leftover files"; the captain's FI3-1199 answer): a week after a task
 * closes, its evidence folder and everything else its crewmate left in
 * `crewmates/<taskId>/` go, unless a live task still builds on it, was
 * filed from it or waits on it, directly or through earlier tasks. The
 * parts the app keeps for itself stay.
 */

/** How long a closed task's leftover files stay after its close. */
export const CLOSED_TASK_FILES_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

type TasksReader = Pick<
  TaskService,
  "get" | "list" | "listLive" | "allLinks" | "resolve" | "note" | "onChange" | "timeline"
>;

export type ClosedTaskFilesOptions = {
  paths: Pick<AppPaths, "crewmatesDir" | "worktreeTrashDir">;
  tasks: TasksReader;
  /** Deletes a folder already moved into the trash, below the UI (`WorkspaceService`). */
  deleteInBackground: (dir: string) => void;
  now: () => number;
  /** Only acknowledged cleanup clears a placed task; out-of-reach computers retry. */
  removePlaced?: (record: TaskRecord) => Promise<{ removedFiles: string[]; bytes: number }>;
};

/** Every upstream task live work builds on, including through closed intermediates. */
function heldByLiveWork(tasks: Pick<TasksReader, "listLive" | "allLinks" | "resolve">) {
  const upstream = new Map<string, string[]>();
  for (const link of tasks.allLinks()) {
    const [from, to] =
      link.type === "discovered-from"
        ? [link.fromId, link.toId]
        : link.type === "blocks"
          ? [link.toId, link.fromId]
          : [];
    if (!from || !to) continue;
    const refs = upstream.get(from) ?? [];
    refs.push(to);
    upstream.set(from, refs);
  }
  const pending = tasks.listLive();
  const held = new Set<string>();
  for (const record of pending) {
    if (held.has(record.id)) continue;
    held.add(record.id);
    const refs = [...(upstream.get(record.id) ?? [])];
    if (record.shape?.basis) refs.push(record.shape.basis);
    for (const ref of refs) {
      const ancestor = tasks.resolve(ref);
      if (ancestor && !held.has(ancestor.id)) pending.push(ancestor);
    }
  }
  return held;
}

/** Whether a closed task's leftover files are due to go now. */
function closedTaskFilesDue(record: TaskRecord, held: Set<string>, now: number): boolean {
  return (
    TaskService.isClosed(record) &&
    record.closedAt !== null &&
    now - record.closedAt >= CLOSED_TASK_FILES_KEPT_MS &&
    !held.has(record.id)
  );
}

export class ClosedTaskFiles {
  /** Tasks whose folder holds nothing more to remove, by id and close. */
  private readonly cleared = new Set<string>();
  private running: Promise<void> | undefined;
  private again = false;
  private lastPassAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: ClosedTaskFilesOptions) {}

  /**
   * Each close starts a pass: a task closing may free others it held, and
   * a long-running app passes the week of earlier closes. The app's own
   * writes on older closed rows (this class's notes among them) start none.
   */
  watch(): () => void {
    return this.options.tasks.onChange(({ taskIds }) => {
      const closedSince = taskIds.some((id) => {
        const record = this.options.tasks.get(id);
        return (
          record !== undefined &&
          TaskService.isClosed(record) &&
          (record.closedAt ?? 0) >= this.lastPassAt
        );
      });
      if (closedSince) void this.sweep();
    });
  }

  /**
   * One pass over every closed task, or one more after the pass already
   * running. Never throws; what cannot be removed now is tried again.
   */
  sweep(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          // Out of the writer's change listener before reading the record.
          await Promise.resolve();
          this.again = false;
          await this.pass().catch((caught) => {
            console.warn("[tasks] the pass over closed tasks' leftover files failed:", caught);
          });
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Resolves once the pass running now, and any queued after it, has finished (tests). */
  async settled(): Promise<void> {
    await this.running;
  }

  private async pass(): Promise<void> {
    const now = this.options.now();
    this.lastPassAt = now;
    const held = heldByLiveWork(this.options.tasks);
    for (const record of this.options.tasks.list()) {
      if (!closedTaskFilesDue(record, held, now)) continue;
      const key = `${record.id}@${record.closedAt}`;
      if (this.cleared.has(key)) continue;
      try {
        if (record.deviceId) {
          if (!this.options.removePlaced) continue;
          const result = await this.options.removePlaced(record);
          this.noteRemoved(record.id, result.removedFiles, result.bytes, {
            deviceId: record.deviceId,
            closedAt: record.closedAt,
          });
        }
        await this.remove(record.id);
        this.cleared.add(key);
      } catch (caught) {
        console.warn(`[tasks] could not remove the leftover files of task ${record.id}:`, caught);
      }
    }
  }

  /**
   * Moves every part the app does not keep out of the task's folder, one
   * rename apiece into one folder in the trash, notes what went, and
   * deletes it in the background; the next boot's trash sweep finishes a
   * delete a quit cut short. A link is moved or removed as a link, never
   * followed, and a task folder that is itself a link is left alone.
   */
  private async remove(taskId: string): Promise<void> {
    const { removedFiles, bytes } = await removeTaskLeftovers(
      join(this.options.paths.crewmatesDir, taskId),
      this.options.paths.worktreeTrashDir,
      taskId,
      APP_KEPT_PARTS,
      this.options.deleteInBackground,
    );
    this.noteRemoved(taskId, removedFiles, bytes);
  }

  private noteRemoved(
    taskId: string,
    names: string[],
    bytes: number,
    placed?: { deviceId: string; closedAt: number | null },
  ): void {
    if (names.length === 0) return;
    // The computer replays its acknowledged answer after a home restart.
    if (
      placed &&
      this.options.tasks
        .timeline(taskId)
        .some(
          (event) =>
            event.data?.removedFiles !== undefined &&
            event.data.deviceId === placed.deviceId &&
            event.data.closedAt === placed.closedAt,
        )
    )
      return;
    this.options.tasks.note(taskId, removedWords(names, bytes), {
      news: false,
      data: { removedFiles: names, bytes, ...placed },
    });
  }
}
