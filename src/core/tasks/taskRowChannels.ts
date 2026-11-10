import type { DropTaskReview, TaskLifecycleOp, TaskMoveFrom } from "@shared/cards";
import type { HostOps } from "../orchestrator/hostOps";
import type { TaskService } from "./taskService";

/**
 * The moves a task's row, tile or record sends on the captain's click: a
 * lifecycle move the host runs, and Pin or Unpin (INF-3127). A move a panel
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
  };
}
