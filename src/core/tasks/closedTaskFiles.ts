import { join } from "node:path";
import { APP_KEPT_PARTS, removedWords, removeTaskLeftovers } from "./taskLeftovers";

export { APP_KEPT_PARTS } from "./taskLeftovers";

import type { AppPaths } from "../paths";
import type { TaskRetentionFields } from "../storage/taskRecords";
import { TaskService } from "./taskService";

/**
 * A closed task's leftover files (docs/task-retention.md, "A closed task's
 * leftover files"; the captain's FI3-1199 answer): a week after a task
 * closes, its evidence folder and everything else its crewmate left in
 * `crewmates/<taskId>/` go, unless a live task still builds on it, was
 * filed from it, waits on it, carries its work on or retries it on a
 * stronger model, directly or through earlier tasks. The parts the app
 * keeps for itself stay.
 */

/** How long a closed task's leftover files stay after its close. */
export const CLOSED_TASK_FILES_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

type TasksReader = Pick<
  TaskService,
  | "get"
  | "heldByLiveWork"
  | "listClosedRetentionFields"
  | "retentionFields"
  | "note"
  | "onChange"
  | "timeline"
>;

export type ClosedTaskFilesOptions = {
  paths: Pick<AppPaths, "crewmatesDir" | "worktreeTrashDir">;
  tasks: TasksReader;
  /** Deletes a folder already moved into the trash, below the UI (`WorkspaceService`). */
  deleteInBackground: (dir: string) => void;
  now: () => number;
  /**
   * A task on another computer: whether that computer is in reach now, and
   * the removal there. Only an acknowledged removal clears the task; one
   * whose computer is out of reach waits, unasked, for that computer.
   */
  placed?: {
    inReach: (deviceId: string) => boolean;
    remove: (record: TaskRetentionFields) => Promise<{ removedFiles: string[]; bytes: number }>;
  };
};

/** Whether a closed task's leftover files are due to go now. */
function closedTaskFilesDue(record: TaskRetentionFields, held: Set<string>, now: number): boolean {
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
  /** What the last pass found held by live work: due now if that work let go. */
  private held = new Set<string>();
  /** Tasks a pass found due but could not clear yet, tried again at the next. */
  private retry = new Set<string>();
  /**
   * Due tasks whose computer was out of reach, by computer: neither asked
   * nor read again until a pass finds that computer in reach, such as the
   * pass its contact starts (INF-4685).
   */
  private readonly waiting = new Map<string, Set<string>>();

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

  /**
   * The first pass reads every close a week old. A later one reads only
   * the closes that turned a week old since the last pass, and the tasks
   * that pass left: held by live work then, not cleared yet, or waiting for
   * a computer in reach now. A task comes due only by its close aging or
   * its holder letting go, so that is every task that can have come due,
   * read without the whole record.
   */
  private async pass(): Promise<void> {
    const now = this.options.now();
    const since = this.lastPassAt;
    const tasks = this.options.tasks;
    // Every task live work builds on, including through closed
    // intermediates: what it was filed from, what waits on it, its basis,
    // and what carries its work on (a `replaced-by` link) or retries it on a
    // stronger model (its `retry-of` reference, or the older `escalated`
    // row), since the carrier reads its evidence in place (INF-3169). Read
    // as ids in one statement, composing no record (INF-3032, INF-3641).
    const held = tasks.heldByLiveWork();
    const aged = tasks.listClosedRetentionFields(
      since === Number.NEGATIVE_INFINITY ? null : since - CLOSED_TASK_FILES_KEPT_MS,
      now - CLOSED_TASK_FILES_KEPT_MS,
    );
    const back = [...this.waiting].filter(([deviceId]) => this.options.placed?.inReach(deviceId));
    const left = tasks.retentionFields([
      ...new Set([...this.held, ...this.retry, ...back.flatMap(([, ids]) => [...ids])]),
    ]);
    // Only once read: a pass that failed before reads its window again.
    this.lastPassAt = now;
    this.held = held;
    this.retry = new Set();
    for (const [deviceId] of back) this.waiting.delete(deviceId);
    const read = new Set<string>();
    for (const record of [...aged, ...left]) {
      if (read.has(record.id)) continue;
      read.add(record.id);
      if (!closedTaskFilesDue(record, held, now)) continue;
      const key = `${record.id}@${record.closedAt}`;
      if (this.cleared.has(key)) continue;
      const placed = this.options.placed;
      if (record.deviceId && placed && !placed.inReach(record.deviceId)) {
        this.wait(record.deviceId, record.id);
        continue;
      }
      this.retry.add(record.id);
      try {
        if (record.deviceId) {
          if (!placed) continue;
          const result = await placed.remove(record);
          this.noteRemoved(record.id, result.removedFiles, result.bytes, {
            deviceId: record.deviceId,
            closedAt: record.closedAt,
          });
        }
        await this.remove(record.id);
        this.cleared.add(key);
        this.retry.delete(record.id);
      } catch (caught) {
        console.warn(`[tasks] could not remove the leftover files of task ${record.id}:`, caught);
      }
    }
  }

  private wait(deviceId: string, taskId: string): void {
    const tasks = this.waiting.get(deviceId) ?? new Set<string>();
    tasks.add(taskId);
    this.waiting.set(deviceId, tasks);
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
