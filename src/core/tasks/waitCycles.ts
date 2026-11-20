import { isHostRaisedShape } from "../storage/changeProjection";
import type { TaskRecord } from "../storage/taskRecords";
import { standingDependencyWaits } from "./dependencyWaits";

export type WaitGraph = {
  get(id: string): TaskRecord | undefined;
  graph: { blockers(id: string): TaskRecord[]; children(id: string): TaskRecord[] };
};

/**
 * Before accepting waiter → prerequisite, follow only current, live waits
 * back to waiter: the `blocks` edges into each task, its standing baseline
 * waits, and its own live parts, since a parent closes only once its parts
 * have (INF-3167, the loop INF-3140 found: a parent waiting on its own
 * part). The host's delivery children (a review, a repair assessment) hold
 * no parent's close and so count for nothing here.
 */
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
      ...tasks.graph.blockers(id),
      ...standingDependencyWaits(tasks, task.delivery).map((wait) => wait.task),
      ...tasks.graph.children(id).filter((child) => !isHostRaisedShape(child.shape)),
    ];
    for (const next of prerequisites) {
      if (live(next) && !seen.has(next.id)) stack.push([...path, next.id]);
    }
  }
}

/**
 * The refusal's words, served to the first mate and the crew alike
 * (INF-3167, the captain's choice A): every wait holds the waiter's start
 * and merge until the other task closes, and a task waits on its own
 * parts, so the loop is repaired by reshaping the work, never by a wait
 * that holds nothing. Two repairs of failing checks keep the one-owner way.
 */
export function waitCycleWords(tasks: Pick<WaitGraph, "get">, path: string[]): string {
  return `Circular wait: ${path.map((id) => tasks.get(id)?.key || id).join(" → ")}. A task waits on its own open parts until they close, and every wait holds the waiter until the other task closes. Report this loop to the first mate: when only part of a task gives what the waiter needs, split that part into its own task, or fold the waiter into the task it waits on; remove a wait only when it names the wrong task. Two repairs of failing checks keep one existing owner, who combines attributed patches, verifies the combined version and reconciles after merge. No wait recorded or repair attempt spent; failing checks still prevent merging.`;
}
