import { type CheckDiagnosis, failingRun } from "@shared/checkRepair";
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
 * Whether a baseline wait declared at this version and check stands: at the
 * change's current head while its checks are not green, or while the
 * newest reading of a workflow run at the change's version (or of any run,
 * before the task has a pull request version) still lists the check failed
 * (INF-688).
 */
export function baselineStands(
  delivery: TaskDelivery | null | undefined,
  failed: CheckDiagnosis,
): boolean {
  if (!delivery) return false;
  // The declaration list is append-only; only its latest diagnosis for this pair is current.
  const latest = delivery.ciRepair?.diagnoses.findLast(
    (d) => d.headSha === failed.headSha && d.check === failed.check,
  );
  if (latest !== failed || latest.classification !== "baseline-blocked") return false;
  return (
    (failed.headSha === delivery.headSha && delivery.ci !== "green") ||
    failingRun(delivery, failed) !== undefined
  );
}

/**
 * The checks a task's standing baseline waits name (INF-833 Fix 4): each
 * check of a baseline-blocked diagnosis that still stands, once. The host
 * reads the default branch's observations for these and relays changes,
 * without judging whether they clear the wait.
 */
export function standingBaselineChecks(delivery: TaskDelivery | null | undefined): string[] {
  if (!delivery) return [];
  const names = new Set<string>();
  for (const diagnosis of delivery.ciRepair?.diagnoses ?? []) {
    if (
      diagnosis.classification !== "baseline-blocked" ||
      !diagnosis.dependencyTask ||
      !baselineStands(delivery, diagnosis)
    ) {
      continue;
    }
    names.add(diagnosis.check);
  }
  return [...names];
}

/**
 * The tasks a task's standing baseline waits name (FI3-671): the
 * dependencyTask of each baseline-blocked diagnosis that still stands
 * (`baselineStands`), with when the earliest of them was declared
 * (FI3-250). Derived and never stored, so a new head, a passing reading or
 * a newer reading of the run without the failure ends the wait by itself.
 */
export function standingDependencyWaits(
  tasks: { get(id: string): TaskRecord | undefined },
  delivery: TaskDelivery | null | undefined,
): DependencyWait[] {
  if (!delivery) return [];
  // A diagnosis from before the time was recorded leaves its wait's start unknown.
  const since = new Map<string, number | undefined>();
  for (const d of delivery.ciRepair?.diagnoses ?? []) {
    const id = d.dependencyTask;
    if (d.classification !== "baseline-blocked" || !id || !baselineStands(delivery, d)) continue;
    const prior = since.has(id) ? since.get(id) : d.at;
    since.set(id, prior === undefined || d.at === undefined ? undefined : Math.min(prior, d.at));
  }
  return [...since].flatMap(([id, at]) => {
    const task = tasks.get(id);
    return task ? [{ task, ...(at !== undefined ? { since: at } : {}) }] : [];
  });
}
