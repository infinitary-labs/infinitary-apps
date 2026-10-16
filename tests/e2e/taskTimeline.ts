import type { TaskEventKind } from "../../src/shared/tasks";

/**
 * What a crewmate spawned in the scratch project leaves on its task's
 * timeline before anything its first turn does, in order: the row, the
 * dispatch, the dispatch's line about its working copy (the warm worktree
 * pool), the pinned first-turn brief (`TaskService.recordBrief`), and the
 * captain's ask that caused the spawn. The scratch project has no lockfile,
 * so no install line joins it. The journeys that read a task's timeline
 * (`task-protocol`, `task-record`, `task-followup`) append what their own
 * turn adds, so a change to how a start is recorded is one edit here.
 */
export const SPAWNED_TASK_START: readonly TaskEventKind[] = [
  "created",
  "dispatched",
  "note",
  "briefed",
  "ask",
];
