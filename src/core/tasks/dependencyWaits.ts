import type { TaskDelivery, TaskRecord } from "../storage/taskStore";

/**
 * The waits a task declared on other work that live on its delivery record
 * rather than on the graph (FI3-671, FI3-250): read by the idle ladder's
 * witnesses and the ready sweep (`IdleLadder`), and by the task views that
 * name what an active task waits on (`TaskProtocol`). A `blocks` edge is the
 * graph's own wait and is read there.
 */

/** A typed wait on another task, and when it was declared (absent when the record does not say). */
export type DependencyWait = { task: TaskRecord; since?: number };

/**
 * The tasks a task's standing baseline waits name (FI3-671): the
 * dependencyTask of each baseline-blocked diagnosis at its change's current
 * head, while its checks are not green, with when the earliest of them was
 * declared (FI3-250). Derived and never stored, so a new head or a passing
 * reading ends the wait by itself.
 */
export function standingDependencyWaits(
  tasks: { get(id: string): TaskRecord | undefined },
  delivery: TaskDelivery | null | undefined,
): DependencyWait[] {
  if (!delivery || delivery.ci === "green") return [];
  // A diagnosis from before the time was recorded leaves its wait's start unknown.
  const since = new Map<string, number | undefined>();
  for (const d of delivery.ciRepair?.diagnoses ?? []) {
    const id = d.dependencyTask;
    if (d.classification !== "baseline-blocked" || d.headSha !== delivery.headSha || !id) continue;
    const prior = since.has(id) ? since.get(id) : d.at;
    since.set(id, prior === undefined || d.at === undefined ? undefined : Math.min(prior, d.at));
  }
  return [...since].flatMap(([id, at]) => {
    const task = tasks.get(id);
    return task ? [{ task, ...(at !== undefined ? { since: at } : {}) }] : [];
  });
}
