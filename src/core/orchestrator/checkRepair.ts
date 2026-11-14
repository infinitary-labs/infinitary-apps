import { type CheckChangeInput, type CheckRepairLedger, failingRun } from "@shared/checkRepair";
import { QUEUE_STATUS } from "@shared/repos";
import { type ForgeCheck, isRedCheckState } from "../forge";
import type { TaskDelivery, TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { liveWaitCycle, waitCycleWords } from "../tasks/waitCycles";

export const BASELINE_OBSERVATIONS_NEXT =
  "changed default-branch check observations and the named task closing wake you to judge whether the wait is cleared.";

function dependencyWords(tasks: TaskService, dependency: TaskRecord): string {
  const name = `${dependency.key || dependency.id} "${dependency.title}"`;
  const resumed = BASELINE_OBSERVATIONS_NEXT;
  if (dependency.status === "done")
    return ` ${name} is already done: bring your change up to date and read the checks again.`;
  if (dependency.status === "dropped")
    return ` ${name} was dropped: inspect its outcome and name the current owner if a fix is still needed.`;
  if (dependency.status === "active")
    return ` ${name} is underway: report the wait once and end your turn; ${resumed}`;
  if (!tasks.graph.awaitsStart(dependency))
    return ` ${name} is queued and starts by itself: report the wait once and end your turn; ${resumed}`;
  return ` Nobody has started ${name}. Lead your report with its key, that it has not started and what starting it unblocks: that report wakes the first mate, which starts it or steers you.`;
}

const empty = (): CheckRepairLedger => ({ failures: [], diagnoses: [], repairs: [] });

/**
 * Whether the host's own merge queue removed `headSha` under the captain's
 * kept approval, as the approval recorded it: the closed fact an answer to
 * that removal is checked against (docs/forge.md, "The host's merge queue").
 */
function hostRemoved(task: TaskRecord, headSha: string): boolean {
  const kept = task.delivery?.mergeAuthorization;
  return (
    kept?.status === "standing" &&
    kept.handed?.head === headSha &&
    kept.handed.removed !== undefined
  );
}

/**
 * A workflow run's reading on the repair ledger (INF-688), from the
 * crewmate's short read or the run watch: its failed jobs join the raw
 * failure history at the run's version, so a run with no pull request
 * names an observed failing head/check, and the run's own entry keeps the
 * newest attempt's failed jobs. An incomplete job list never drops a job
 * the same attempt already showed failed. Answers the ledger to record, or
 * nothing when the reading adds nothing.
 */
export function observeRunFailures(
  delivery: TaskDelivery | null | undefined,
  run: { id: number; headSha: string; attempt: number },
  read: { failed: string[]; complete: boolean },
): CheckRepairLedger | undefined {
  const ledger = structuredClone(delivery?.ciRepair ?? empty());
  const runs = ledger.runs ?? [];
  const seen = runs.find((r) => r.runId === run.id);
  if (!seen && read.failed.length === 0) return undefined;
  const kept =
    seen && !read.complete && seen.attempt === run.attempt && seen.headSha === run.headSha
      ? seen.failed
      : [];
  const failed = [...new Set([...kept, ...read.failed])];
  const unchanged =
    seen?.attempt === run.attempt &&
    seen.headSha === run.headSha &&
    seen.failed.length === failed.length &&
    failed.every((name) => seen.failed.includes(name));
  if (unchanged) return undefined;
  ledger.runs = [
    ...runs.filter((r) => r.runId !== run.id),
    { runId: run.id, headSha: run.headSha, attempt: run.attempt, failed },
  ];
  if (failed.length) {
    const history = ledger.failures.find((f) => f.headSha === run.headSha);
    if (history) history.checks = [...new Set([...history.checks, ...failed])];
    else ledger.failures.push({ headSha: run.headSha, checks: failed });
  }
  return ledger;
}

/** Record the crew's evidence and judgments, without interpreting their meaning. */
export function declareCheckAction(
  tasks: TaskService,
  taskId: string,
  input: CheckChangeInput,
  at: number,
  _target?: { held?: boolean; where: string },
): { text: string; read: boolean } {
  const task = tasks.get(taskId);
  if (!task) return { read: false, text: "Check declaration refused: task not found." };
  const ledger = structuredClone(task.delivery?.ciRepair ?? empty());
  const entries = [input.declaration, input.diagnosis, input.repair, input.rerun].filter(Boolean);
  if (entries.length !== 1 || !entries[0]?.evidence.trim())
    return {
      read: false,
      text: "Check declaration refused: provide one declaration with evidence.",
    };
  const declaration = input.declaration;
  if (declaration) {
    if (
      declaration.verdict !== "flake" &&
      declaration.verdict !== "settled" &&
      declaration.verdict !== "answered"
    )
      return {
        read: false,
        text: "Check declaration refused: readiness is expressed by the merge offer, not a separate ready or red verdict. Use declaration only for a flake, a repair settlement or an answer to the queue.",
      };
    if (!declaration.headSha.trim())
      return { read: false, text: "Check declaration refused: name the version." };
    if (declaration.verdict === "answered") {
      // An answer is to the queue's own failed status at that version, as
      // the newest reading holds it: a closed fact, never the crew's words.
      const snapshot = task.delivery?.checks;
      const queue =
        snapshot?.headSha === declaration.headSha
          ? snapshot.items.find((item) => item.name === QUEUE_STATUS)
          : undefined;
      if ((!queue || !isRedCheckState(queue.state)) && !hostRemoved(task, declaration.headSha))
        return {
          read: false,
          text: `Answer refused: the newest reading shows no failed ${QUEUE_STATUS} at ${declaration.headSha}, and the host's own merge queue has not removed that version. Read the checks with check_change first; answer only the queue's failure or send-back of the version it is on.`,
        };
    }
    if (declaration.verdict === "settled" && (!declaration.repairId || !declaration.outcome))
      return { read: false, text: "Settlement refused: name the repair and its declared outcome." };
    if (declaration.verdict === "settled") {
      const repair = ledger.repairs.find(
        (row) => row.id === declaration.repairId && row.headSha === declaration.headSha,
      );
      if (!repair)
        return {
          read: false,
          text: "Settlement refused: that repair is not on this version's record.",
        };
      repair.outcome = declaration.outcome;
    }
    ledger.declarations = [...(ledger.declarations ?? []), { ...declaration, at }];
  }
  if (input.diagnosis) {
    const diagnosis = { ...input.diagnosis };
    if (diagnosis.dependencyTask) {
      const dependency = tasks.resolve(diagnosis.dependencyTask);
      if (!dependency || dependency.projectId !== task.projectId)
        return {
          read: false,
          text: "Diagnosis refused: the named dependency is not in this project.",
        };
      const cycle = liveWaitCycle(tasks, taskId, dependency.id, TaskService.blockerHoldsClose);
      if (cycle) return { read: false, text: `Diagnosis refused: ${waitCycleWords(tasks, cycle)}` };
      diagnosis.dependencyTask = dependency.id;
    }
    ledger.diagnoses.push({ ...diagnosis, at });
    ledger.declarations = [...(ledger.declarations ?? []), { ...diagnosis, kind: "diagnosis", at }];
  }
  if (input.repair) {
    ledger.repairs.push({ ...input.repair });
    ledger.declarations = [...(ledger.declarations ?? []), { ...input.repair, kind: "repair", at }];
  }
  if (input.rerun) {
    const run = failingRun(task.delivery, input.rerun);
    ledger.rerun = { ...input.rerun, ...(run ? { runId: run.runId } : {}) };
    ledger.declarations = [...(ledger.declarations ?? []), { ...ledger.rerun, kind: "rerun", at }];
  }
  tasks.delivery.recordChangeEvidence(
    taskId,
    { ciRepair: ledger },
    {
      kind: "ci",
      text: "Crew check declaration recorded",
      actor: "crewmate",
    },
  );
  return {
    read: true,
    text: input.diagnosis
      ? `Diagnosis recorded with evidence.${input.diagnosis.dependencyTask && tasks.resolve(input.diagnosis.dependencyTask) ? dependencyWords(tasks, tasks.resolve(input.diagnosis.dependencyTask)!) : ""}`
      : input.declaration?.verdict === "answered"
        ? hostRemoved(task, input.declaration.headSha)
          ? `Answer to the merge queue's removal recorded with evidence. The captain's kept merge approval sends ${input.declaration.headSha} to that queue once more, when your turn ends. Put up no card for it.`
          : `Answer to the queue recorded with evidence. The captain's kept merge approval, where one covers ${input.declaration.headSha}, marks it waiting for the queue again once, when your turn ends; without one, nothing is marked until the captain's merge click. Put up no card for it.`
        : "Crew check declaration recorded with evidence. No merge was authorized.",
  };
}

/**
 * check_change on a task that makes an effect and ships no change (an
 * operation): it has no pull request to read or merge, so it records only
 * a diagnosis of a workflow run it read, a reserved failed-job rerun, or
 * a flake declaration, on the same repair ledger a change's are
 * (docs/delivery-rigor.md, "A run with no pull request").
 */
export function declareRunCheck(
  tasks: TaskService,
  taskId: string,
  input: CheckChangeInput,
  at: number,
): string {
  const other = (
    [
      "change",
      "pull",
      "skipRules",
      "absentChecks",
      "repair",
      "conflictRepair",
      "captainGuidance",
    ] as const
  ).filter((field) => input[field] !== undefined);
  if (other.length)
    return `check_change refused: this task makes an effect and ships no change, so it records only a diagnosis, a rerun or a flake declaration of a run you read, not ${other.join(", ")}.`;
  if (!input.diagnosis && !input.rerun && !input.declaration)
    return "check_change here reads nothing: this task has no pull request. Read a run with read_workflow, then record its diagnosis, reserve its rerun with rerun, or declare a flake.";
  if (input.declaration && input.declaration.verdict !== "flake")
    return "check_change refused: this task has no repair to settle; declare only a flake.";
  return declareCheckAction(tasks, taskId, input, at).text;
}

/** Retain raw failure observations without settling repairs or spending an allowance. */
export function observeCheckRepair(
  delivery: TaskDelivery | null | undefined,
  headSha: string,
  checks: ForgeCheck[],
  _at: number,
): Partial<TaskDelivery> {
  const ledger = structuredClone(delivery?.ciRepair ?? empty());
  const failed = checks.filter((c) => isRedCheckState(c.state)).map((c) => c.name);
  if (failed.length) {
    const history = ledger.failures.find((f) => f.headSha === headSha);
    if (history) history.checks = [...new Set([...history.checks, ...failed])];
    else ledger.failures.push({ headSha, checks: failed });
  }
  return { ciRepair: ledger };
}
