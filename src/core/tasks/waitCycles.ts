import type { TaskRecord } from "../storage/taskStore";
import { standingDependencyWaits } from "./dependencyWaits";

export type WaitGraph = {
  get(id: string): TaskRecord | undefined;
  blockers(id: string): TaskRecord[];
};

/** Before accepting waiter → prerequisite, follow only current, live waits back to waiter. */
export function liveWaitCycle(
  tasks: WaitGraph,
  waiter: string,
  prerequisite: string,
  isLive: (task: TaskRecord) => boolean,
): string[] | undefined {
  const live = (task: TaskRecord | undefined): task is TaskRecord => !!task && isLive(task);
  if (!live(tasks.get(waiter)) || !live(tasks.get(prerequisite))) return;
  const seen = new Set<string>();
  const stack = [[prerequisite]];
  while (stack.length) {
    const path = stack.pop() as string[];
    const id = path[path.length - 1] as string;
    if (id === waiter) return [waiter, ...path];
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasks.get(id);
    if (!live(task)) continue;
    const prerequisites = [
      ...tasks.blockers(id),
      ...standingDependencyWaits(tasks, task.delivery).map((wait) => wait.task),
    ];
    for (const next of prerequisites) {
      if (live(next) && !seen.has(next.id)) stack.push([...path, next.id]);
    }
  }
}

export function waitCycleWords(tasks: Pick<WaitGraph, "get">, path: string[]): string {
  return `Circular wait: ${path.map((id) => tasks.get(id)?.key || id).join(" → ")}. Report this loop to the first mate to choose one existing repair owner, combine attributed patches, remove only obsolete waits, verify the combined version, and reconcile after merge. No wait recorded or repair attempt spent; failing checks still prevent merging.`;
}
