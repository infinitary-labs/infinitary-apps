import type { CheckChangeInput, CheckRepairLedger } from "@shared/checkRepair";
import { CI_ROUND_CAP, ciCapReached } from "@shared/rigor";
import { type ForgeCheckState, isAcceptedCheckState } from "../forge";
import type { TaskDelivery, TaskRecord } from "../storage/taskStore";
import { TaskService } from "../tasks/taskService";
import { liveWaitCycle, waitCycleWords } from "../tasks/waitCycles";

export const CHECK_DIAGNOSIS_NEXT =
  "Read the failed step and logs first. Record diagnosis with check_change: own-regression with attribution evidence, baseline-blocked with untouched-main evidence and a separately owned dependencyTask, suspected-flake with comparison evidence, or unknown with the investigation gap. Fix your regression yourself; reserve one evidenced failed-job rerun, or report the separate owner and wait for its fix. Diagnosis and waiting spend no repair attempt and need no captain card.";

/**
 * What the task a baseline wait names stands at, said back to the crewmate
 * that declared it (FI3-671): the way forward differs for work nobody has
 * started, work underway and work already done.
 */
function dependencyWords(tasks: TaskService, dependency: TaskRecord): string {
  const name = `${dependency.key || dependency.id} "${dependency.title}"`;
  if (dependency.status === "done")
    return ` ${name} is already done: bring your change up to date and read the checks again.`;
  if (dependency.status === "active")
    return ` ${name} is underway: report the wait once and end your turn; you are resumed when it closes.`;
  if (!tasks.awaitsStart(dependency))
    return ` ${name} is queued and starts by itself: report the wait once and end your turn; you are resumed when it closes.`;
  return ` Nobody has started ${name}. Lead your report with its key, that it has not started and what starting it unblocks: that report wakes the first mate, which starts it or steers you.`;
}

const empty = (): CheckRepairLedger => ({ failures: [], diagnoses: [], repairs: [] });
const same = (a: { headSha: string; check: string }, b: { headSha: string; check: string }) =>
  a.headSha === b.headSha && a.check === b.check;
const text = (s: string | undefined) => Boolean(s?.trim());

/** A declaration is validated as a closed typed fact, never parsed out of prose. */
export function declareCheckAction(
  tasks: TaskService,
  taskId: string,
  input: CheckChangeInput,
  at: number,
): { text: string; read: boolean } {
  const task = tasks.get(taskId);
  if (!task) return { read: false, text: "Check declaration refused: task not found." };
  const ledger = structuredClone(task.delivery?.ciRepair ?? empty());
  if ([input.diagnosis, input.repair, input.rerun].filter(Boolean).length !== 1) {
    return {
      read: false,
      text: "Check declaration refused: send exactly one diagnosis, repair or rerun.",
    };
  }
  if (task.delivery?.ciCapAt !== undefined)
    return {
      read: false,
      text: "Check declaration refused: the repair allowance is exhausted; report the three attempts and wait for the captain's answer.",
    };
  const diagnosis = input.diagnosis;
  let waitsOn: TaskRecord | undefined;
  if (diagnosis) {
    const failed = ledger.failures.some(
      (f) => f.headSha === diagnosis.headSha && f.checks.includes(diagnosis.check),
    );
    if (!failed || !text(diagnosis.evidence))
      return {
        read: false,
        text: "Diagnosis refused: name an observed failing head/check and supporting log evidence first.",
      };
    if (diagnosis.classification === "baseline-blocked") {
      const dependency = diagnosis.dependencyTask ? tasks.get(diagnosis.dependencyTask) : undefined;
      if (
        !dependency ||
        dependency.id === taskId ||
        dependency.parentId === taskId ||
        dependency.projectId !== task.projectId ||
        dependency.status === "dropped"
      ) {
        return {
          read: false,
          text: "Diagnosis refused: baseline-blocked needs untouched-main evidence and an existing separately owned task in this project (use its task id).",
        };
      }
      diagnosis.dependencyTask = dependency.id;
      waitsOn = dependency;
    }
    if (
      diagnosis.classification === "unknown" &&
      ledger.diagnoses.some((d) => d.classification === "unknown" && !same(d, diagnosis))
    )
      return {
        read: false,
        text: "Diagnosis refused: resolve the outstanding unknown diagnosis through one bounded investigation before declaring another.",
      };
    const previous = ledger.diagnoses.find((d) => same(d, diagnosis));
    if (
      previous &&
      previous.classification !== "unknown" &&
      !(
        previous.classification === "suspected-flake" &&
        ledger.rerun &&
        same(ledger.rerun, diagnosis) &&
        ["own-regression", "baseline-blocked"].includes(diagnosis.classification)
      )
    )
      return {
        read: false,
        text: "Diagnosis already recorded; no attempt spent. Follow the recorded diagnosis, not a new exemption.",
      };
    if (previous && diagnosis.classification === "unknown")
      return {
        read: false,
        text: "Unknown diagnosis already recorded. Stop rereading; report the evidence gap to the first mate for a bounded investigation, not a captain card or another rerun.",
      };
    // Historical and duplicate diagnoses create no new standing wait. No
    // await separates this check from TaskService's delivery write below.
    if (waitsOn && diagnosis.headSha === task.delivery?.headSha && task.delivery.ci !== "green") {
      const cycle = liveWaitCycle(tasks, taskId, waitsOn.id, TaskService.blockerHoldsClose);
      if (cycle) return { read: false, text: `Diagnosis refused: ${waitCycleWords(tasks, cycle)}` };
    }
    ledger.diagnoses = ledger.diagnoses.filter((d) => !same(d, diagnosis));
    // When the wait began: the sweep resumes a crewmate only for work that
    // closed after it (FI3-250), never for work already done when declared.
    ledger.diagnoses.push({ ...diagnosis, at });
  }
  const repair = input.repair;
  if (repair) {
    if (
      !text(repair.id) ||
      !text(repair.evidence) ||
      !text(repair.headSha) ||
      repair.headSha === repair.sourceHead
    )
      return {
        read: false,
        text: "Repair refused: provide a stable id, evidence of your fix and a new target head.",
      };
    const previous = ledger.repairs.find((r) => r.id === repair.id || r.headSha === repair.headSha);
    if (previous) {
      const read =
        same(previous, repair) &&
        previous.id === repair.id &&
        previous.sourceHead === repair.sourceHead;
      return {
        read,
        text: read
          ? "Repair already recorded; repeated observations spend nothing."
          : "Repair refused: that id or target head already names a different attempt.",
      };
    }
    const source = ledger.diagnoses.find(
      (d) => d.headSha === repair.sourceHead && d.check === repair.check,
    );
    if (source?.classification !== "own-regression")
      return {
        read: false,
        text: "Repair refused: first diagnose the source head/check as your own regression with evidence.",
      };
    if (ledger.repairs.some((r) => r.outcome === undefined))
      return {
        read: false,
        text: "Repair refused: read the outstanding attempt before starting another.",
      };
    ledger.repairs.push(repair);
  }
  const rerun = input.rerun;
  if (rerun) {
    if (ledger.rerun)
      return {
        read: false,
        text: "Rerun refused: this task already reserved its one failed-job rerun; do not rerun again. Report unresolved evidence to the first mate for diagnosis.",
      };
    const source = ledger.diagnoses.find((d) => same(d, rerun));
    if (source?.classification !== "suspected-flake" || !text(rerun.evidence))
      return {
        read: false,
        text: "Rerun refused: first record an evidenced suspected-flake diagnosis for this head/check.",
      };
    if (task.delivery?.headSha !== rerun.headSha || task.delivery.ci === "green")
      return { read: false, text: "Rerun refused: the failed head is no longer current." };
    ledger.rerun = rerun;
  }
  tasks.recordDelivery(
    taskId,
    { ciRepair: ledger },
    {
      kind: "ci",
      text: `Check ${diagnosis ? "diagnosis" : repair ? "repair" : "rerun reservation"} recorded`,
      actor: "crewmate",
    },
  );
  return {
    read: Boolean(repair),
    text: rerun
      ? "Rerun authorized once: rerun only this failed job without changing code, using github_write on its rerun-failed-jobs route: that call also reads the checks and starts the watch. This reservation survives restarts; another call will not authorize it again."
      : diagnosis
        ? `Diagnosis recorded: ${diagnosis.classification}; no repair attempt spent.${diagnosis.classification === "unknown" ? " Investigate once, then report the gap to the first mate if unresolved; do not loop readings or reruns." : ""}${waitsOn ? dependencyWords(tasks, waitsOn) : ""}`
        : "Own repair recorded; only its unsuccessful result spends an attempt.",
  };
}

/** Raw history and budget-qualified results stay separate, on the durable delivery record. */
export function observeCheckRepair(
  delivery: TaskDelivery | null | undefined,
  headSha: string,
  checks: { name: string; state: ForgeCheckState }[],
  at: number,
): Partial<TaskDelivery> {
  const ledger = structuredClone(delivery?.ciRepair ?? empty());
  // A legacy uncapped count has no ownership/attempt evidence. Archive it,
  // not charge it to the new allowance. Existing captain holds remain intact.
  const legacy = !delivery?.ciRepair && delivery?.ciRounds !== undefined;
  if (legacy) ledger.legacyFailedVersions = delivery.ciRounds;
  const migrated: Partial<TaskDelivery> =
    legacy && delivery.ciCapAt === undefined ? { ciRounds: undefined, ciRedHead: undefined } : {};
  const failed = checks
    .filter((c) => !isAcceptedCheckState(c.state) && c.state !== "pending")
    .map((c) => c.name);
  if (failed.length) {
    const history = ledger.failures.find((f) => f.headSha === headSha);
    if (history) history.checks = [...new Set([...history.checks, ...failed])];
    else ledger.failures.push({ headSha, checks: failed });
  }
  const attempt = ledger.repairs.find((r) => r.headSha === headSha && r.outcome === undefined);
  const target = attempt ? checks.find((c) => c.name === attempt.check) : undefined;
  // Do not decide from an incomplete suite; neutral remains unsuccessful; skipped is accepted.
  if (!attempt || !target || checks.some((c) => c.state === "pending"))
    return { ...migrated, ciRepair: ledger };
  attempt.outcome = isAcceptedCheckState(target.state) ? "passed" : "failed";
  if (attempt.outcome === "passed") return { ...migrated, ciRepair: ledger };
  const ciRounds = (legacy && delivery?.ciCapAt === undefined ? 0 : (delivery?.ciRounds ?? 0)) + 1;
  return {
    ciRepair: ledger,
    ciRounds,
    ciRedHead: headSha,
    ...(ciCapReached(ciRounds) && delivery?.ciCapAt === undefined ? { ciCapAt: at } : {}),
  };
}

export function checkRepairWords(delivery: TaskDelivery | null | undefined): string[] {
  if (delivery?.ciCapAt !== undefined)
    return [
      `Three unsuccessful own repairs exhausted the allowance (${delivery.ciRounds ?? CI_ROUND_CAP}/${CI_ROUND_CAP}): stop and report the failing check and attempts. Completion stays held until the captain answers and the first mate relays it.`,
    ];
  if (delivery?.ci === "green") return [];
  const ledger = delivery?.ciRepair;
  const current = ledger?.diagnoses.filter((d) => d.headSha === delivery?.headSha) ?? [];
  return [
    CHECK_DIAGNOSIS_NEXT,
    ...(current.length
      ? [
          `Recorded diagnoses: ${JSON.stringify(current.map(({ at: _at, ...declared }) => declared))}`,
        ]
      : []),
    ...(ledger?.rerun
      ? [`Failed-job rerun already reserved: ${JSON.stringify(ledger.rerun)}. Do not rerun again.`]
      : []),
    `Unsuccessful own repairs: ${delivery?.ciRounds ?? 0}/${CI_ROUND_CAP}. Raw failed versions, diagnosis, flake reservation and dependency waits do not spend attempts.`,
  ];
}
