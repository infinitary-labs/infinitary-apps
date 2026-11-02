import { type CheckDiagnosis, failingRun } from "@shared/checkRepair";
import { checksFailingOnMain } from "@shared/checkSnapshot";
import type { TaskDelivery, TaskRecord } from "../storage/taskStore";
import type { TaskService } from "./taskService";

const STANDING_DEPENDENCIES = Symbol("standing dependency waits");

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
 * Latest diagnoses and observed failures, indexed once for a bulk read.
 * A board row may carry a long append-only history; searching that history
 * afresh for every entry made the wait derivation quadratic (INF-2186).
 * These indexes live only for this read, so the next observation is visible.
 */
function standingDiagnoses(delivery: TaskDelivery) {
  const diagnoses = delivery.ciRepair?.diagnoses ?? [];
  const latest = new Map<string, (typeof diagnoses)[number]>();
  const keyOf = (head: string, check: string) => JSON.stringify([head, check]);
  for (const diagnosis of diagnoses)
    latest.set(keyOf(diagnosis.headSha, diagnosis.check), diagnosis);
  const failed = new Set<string>();
  for (const run of delivery.ciRepair?.runs ?? []) {
    if (delivery.headSha !== undefined && delivery.headSha !== run.headSha) continue;
    for (const check of run.failed) failed.add(keyOf(run.headSha, check));
  }
  return diagnoses.filter(
    (diagnosis) =>
      latest.get(keyOf(diagnosis.headSha, diagnosis.check)) === diagnosis &&
      diagnosis.classification === "baseline-blocked" &&
      ((diagnosis.headSha === delivery.headSha && delivery.ci !== "green") ||
        failed.has(keyOf(diagnosis.headSha, diagnosis.check))),
  );
}

/**
 * The checks a task's standing baseline waits name (INF-833 Fix 4): each
 * check of a baseline-blocked diagnosis that still stands, once, and, while
 * a completion offer stands at the current version, each check that reading
 * found red that the default branch's newest run failed too (INF-1915 fix
 * 1), so the merge card's "wait for main's fix" is watched from the recorded
 * fact without a diagnosis, and a crewmate still driving its checks hears no
 * wake about main. The host reads the default branch's observations for
 * these and relays changes, without judging whether they clear the wait.
 */
export function standingBaselineChecks(delivery: TaskDelivery | null | undefined): string[] {
  if (!delivery) return [];
  const offered =
    delivery.ci !== "green" &&
    (delivery.completionOffers ?? []).some((offer) => offer.headSha === delivery.headSha);
  const names = new Set<string>(offered ? checksFailingOnMain(delivery) : []);
  for (const diagnosis of standingDiagnoses(delivery)) {
    if (!diagnosis.dependencyTask) continue;
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
  tasks: Pick<TaskService, "get"> & Partial<Pick<TaskService, "projectedFact">>,
  delivery: TaskDelivery | null | undefined,
  projection?: Pick<TaskService, "projectedFact">,
): DependencyWait[] {
  if (!delivery) return [];
  const read = () => dependencyTimes(delivery);
  const owner = projection ?? tasks;
  const since = owner.projectedFact
    ? owner.projectedFact(delivery, STANDING_DEPENDENCIES, read)
    : read();
  // Share the history work, but preserve the caller's lookup/snapshot boundary.
  return [...since].flatMap(([id, at]) => {
    const task = tasks.get(id);
    return task ? [{ task, ...(at !== undefined ? { since: at } : {}) }] : [];
  });
}

function dependencyTimes(delivery: TaskDelivery): Map<string, number | undefined> {
  // A diagnosis from before the time was recorded leaves its wait's start unknown.
  const since = new Map<string, number | undefined>();
  for (const d of standingDiagnoses(delivery)) {
    const id = d.dependencyTask;
    if (!id) continue;
    const prior = since.has(id) ? since.get(id) : d.at;
    since.set(id, prior === undefined || d.at === undefined ? undefined : Math.min(prior, d.at));
  }
  return since;
}
