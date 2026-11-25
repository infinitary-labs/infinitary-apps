import type { DropTaskReview, TaskLifecycleOp, TaskMoveFrom } from "@shared/cards";
import type { HostOps } from "../orchestrator/hostOps";
import type { TaskService } from "./taskService";
import { TaskTagRefusal } from "./taskTags";

/**
 * The moves a task's row, tile or record sends on the captain's click: a
 * lifecycle move the host runs, Pin or Unpin (INF-3127), and Edit tags. A move a panel
 * made names that panel, so the task's record says where it came from.
 */
export function taskRowChannels(hostOps: () => HostOps, tasks: TaskService) {
  return {
    "inf:task:run": (
      taskId: string,
      op: TaskLifecycleOp,
      review?: DropTaskReview | null,
      from?: TaskMoveFrom,
    ) => {
      const refusal = hostOps().runTaskOp(taskId, op, review ?? undefined, from);
      return refusal ? { ok: false as const, text: refusal } : { ok: true as const };
    },
    "inf:task:pin": (taskId: string, pinned: boolean, from?: TaskMoveFrom) =>
      tasks.setPinned(taskId, pinned, { actor: "captain", panel: from?.panel }),
    // Edit tags on the record (docs/task-tags.md): the captain's own tags.
    "inf:task:tags": (taskId: string, tagIds: string[]) => {
      try {
        tasks.replaceTags(taskId, { ids: tagIds }, "captain");
        return { ok: true as const };
      } catch (caught) {
        if (caught instanceof TaskTagRefusal) return { ok: false as const, text: caught.message };
        throw caught;
      }
    },
  };
}
