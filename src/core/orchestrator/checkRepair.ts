import { type CheckChangeInput, type CheckRepairLedger, failingRun } from "@shared/checkRepair";
import { overridePasses, softHoldWords } from "@shared/holds";
import { CI_ROUND_CAP, ciCapReached } from "@shared/rigor";
import { type ForgeCheck, isAcceptedCheckState } from "../forge";
import type { TaskDelivery, TaskRecord } from "../storage/taskStore";
import { baselineStands } from "../tasks/dependencyWaits";
import { TaskService } from "../tasks/taskService";
import { liveWaitCycle, waitCycleWords } from "../tasks/waitCycles";

export const CHECK_DIAGNOSIS_NEXT =
  "Read the failed step and logs first. Record diagnosis with check_change: own-regression with attribution evidence, baseline-blocked with untouched-main evidence and a separately owned dependencyTask, suspected-flake with comparison evidence and changedTest false, never for a test your change adds or edits, or unknown with the investigation gap. Fix your regression yourself; reserve one evidenced failed-job rerun, or report the separate owner and wait for its fix. Diagnosis and waiting spend no repair attempt and need no captain card.";

/**
 * What the task a baseline wait names stands at, said back to the crewmate
 * that declared it (FI3-671): the way forward differs for work nobody has
 * started, work underway and work already done.
 */
function dependencyWords(tasks: TaskService, dependency: TaskRecord): string {
  const name = `${dependency.key || dependency.id} "${dependency.title}"`;
  const resumed =
    "you are resumed when the default branch's own run of that check passes, and when it closes.";
  if (dependency.status === "done")
    return ` ${name} is already done: bring your change up to date and read the checks again.`;
  if (dependency.status === "active")
    return ` ${name} is underway: report the wait once and end your turn; ${resumed}`;
  if (!tasks.awaitsStart(dependency))
    return ` ${name} is queued and starts by itself: report the wait once and end your turn; ${resumed}`;
  return ` Nobody has started ${name}. Lead your report with its key, that it has not started and what starting it unblocks: that report wakes the first mate, which starts it or steers you.`;
}

const empty = (): CheckRepairLedger => ({ failures: [], diagnoses: [], repairs: [] });

/** The declared own repair whose result no reading has settled yet: at most one is open. */
export function outstandingRepair(
  ledger: CheckRepairLedger | null | undefined,
): CheckRepairLedger["repairs"][number] | undefined {
  return ledger?.repairs.find((r) => r.outcome === undefined);
}
const same = (a: { headSha: string; check: string }, b: { headSha: string; check: string }) =>
  a.headSha === b.headSha && a.check === b.check;
const text = (s: string | undefined) => Boolean(s?.trim());

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

/**
 * A declaration is validated as a closed typed fact, never parsed out of prose.
 * `target` is what the project's host answered about a repair's version
 * (INF-1184): `held` false when it holds no commit there, absent when it could
 * not say; `where` names the host in the refusal.
 */
export function declareCheckAction(
  tasks: TaskService,
  taskId: string,
  input: CheckChangeInput,
  at: number,
  target?: { held?: boolean; where: string },
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
  if (
    task.delivery?.ciCapAt !== undefined &&
    !overridePasses(task.delivery, "repairs", task.delivery.headSha)
  )
    return {
      read: false,
      text: `Check declaration refused: the repair allowance is exhausted; report the three attempts and wait for the captain's answer. ${softHoldWords("repairs", "crewmate")}`,
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
    // INF-840: a test the change adds or edits is never a suspected flake,
    // and the crewmate declares which it is as a typed fact.
    if (diagnosis.classification === "suspected-flake" && diagnosis.changedTest !== false)
      return {
        read: false,
        text: "Diagnosis refused: a test whose own code your change adds or edits is never a suspected flake. Diagnose its failure as your own regression, or baseline-blocked with untouched-main evidence; pass changedTest false only when your change does not touch the failed test's own code.",
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
    if (waitsOn && baselineStands(task.delivery, diagnosis)) {
      const cycle = liveWaitCycle(tasks, taskId, waitsOn.id, TaskService.blockerHoldsClose);
      if (cycle) return { read: false, text: `Diagnosis refused: ${waitCycleWords(tasks, cycle)}` };
    }
    ledger.diagnoses = ledger.diagnoses.filter((d) => !same(d, diagnosis));
    // When the wait began: the sweep resumes a crewmate only for work that
    // closed after it (FI3-250), never for work already done when declared.
    // A passing run on the default branch resumes it sooner (mainCheckWake).
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
    if (target?.held === false)
      return {
        read: false,
        text: `Repair refused: no commit ${repair.headSha} exists ${target.where}, so no check can run there. Push the repaired version and declare its full commit id; nothing was recorded and no attempt was spent.`,
      };
    // A void attempt named a version no check can run at, so its id and
    // version stay free for the declaration that corrects it (INF-1184).
    const previous = ledger.repairs.find(
      (r) => r.outcome !== "void" && (r.id === repair.id || r.headSha === repair.headSha),
    );
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
    const outstanding = outstandingRepair(ledger);
    if (outstanding)
      return {
        read: false,
        text: `Repair refused: attempt ${outstanding.id} at ${outstanding.headSha} has no result yet; read its checks with check_change once they finish, before starting another.`,
      };
    ledger.repairs = [...ledger.repairs.filter((r) => r.id !== repair.id), repair];
  }
  const asked = input.rerun;
  let rerun: CheckRepairLedger["rerun"];
  if (asked) {
    if (ledger.rerun && !overridePasses(task.delivery, "rerun", task.delivery?.headSha))
      return {
        read: false,
        text: `Rerun refused: this task already reserved its one failed-job rerun; do not rerun again. Report unresolved evidence to the first mate for diagnosis. ${softHoldWords("rerun", "crewmate")}`,
      };
    const source = ledger.diagnoses.find((d) => same(d, asked));
    if (source?.classification !== "suspected-flake" || !text(asked.evidence))
      return {
        read: false,
        text: "Rerun refused: first record an evidenced suspected-flake diagnosis for this head/check.",
      };
    // The change's current failed version, or else a workflow run whose
    // newest reading still lists the job failed (INF-688).
    const onChange = task.delivery?.headSha === asked.headSha && task.delivery.ci !== "green";
    const run = onChange ? undefined : failingRun(task.delivery, asked);
    if (!onChange && !run)
      return {
        read: false,
        text: "Rerun refused: the failed head is no longer current, and no workflow run you read still shows that job failed there.",
      };
    rerun = {
      headSha: asked.headSha,
      check: asked.check,
      evidence: asked.evidence,
      ...(run ? { runId: run.runId } : {}),
    };
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
      ? rerun.runId !== undefined
        ? `Rerun authorized once: rerun only this failed job of run ${rerun.runId} without changing code, using github_write to rerun that run's failed jobs or this job alone (a job retry on GitLab): the accepted call starts the run watch. This reservation survives restarts; another call will not authorize it again.`
        : "Rerun authorized once: rerun only this failed job without changing code, using github_write on its rerun-failed-jobs route: that call also reads the checks and starts the watch. This reservation survives restarts; another call will not authorize it again."
      : diagnosis
        ? `Diagnosis recorded: ${diagnosis.classification}; no repair attempt spent.${diagnosis.classification === "unknown" ? " Investigate once, then report the gap to the first mate if unresolved; do not loop readings or reruns." : ""}${waitsOn ? dependencyWords(tasks, waitsOn) : ""}`
        : "Own repair recorded; only its unsuccessful result spends an attempt.",
  };
}

/**
 * The check that decides a repair at its version, how many checks there share
 * its name and how many of those did not pass (INF-991). GitHub lists a name
 * once per workflow run, so a version can hold the pull request's own run of a
 * check beside runs of it requested by hand. The first of them that did not
 * pass decides, whatever order the host listed them in; only when every one
 * passed does the first decide, as passed. Nothing when no check there has
 * that name.
 */
export function repairCheck(
  checks: readonly ForgeCheck[],
  name: string,
): { check: ForgeCheck; named: number; unpassed: number } | undefined {
  const named = checks.filter((check) => check.name === name);
  const unpassed = named.filter((check) => !isAcceptedCheckState(check.state));
  const check = unpassed[0] ?? named[0];
  return check ? { check, named: named.length, unpassed: unpassed.length } : undefined;
}

/**
 * Raw history and budget-qualified results stay separate, on the durable delivery record.
 * `headSha` is the version `checks` were read at: the change's current head, or an
 * earlier repair's own version the change has moved past (INF-685). Either way only
 * an attempt declared at that exact version settles, and only from these checks.
 */
export function observeCheckRepair(
  delivery: TaskDelivery | null | undefined,
  headSha: string,
  checks: ForgeCheck[],
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
  const target = attempt ? repairCheck(checks, attempt.check) : undefined;
  // Do not decide from an incomplete suite; neutral remains unsuccessful; skipped is accepted.
  if (!attempt || !target || checks.some((c) => c.state === "pending"))
    return { ...migrated, ciRepair: ledger };
  attempt.outcome = isAcceptedCheckState(target.check.state) ? "passed" : "failed";
  if (attempt.outcome === "passed") return { ...migrated, ciRepair: ledger };
  const ciRounds = (legacy && delivery?.ciCapAt === undefined ? 0 : (delivery?.ciRounds ?? 0)) + 1;
  return {
    ciRepair: ledger,
    ciRounds,
    ciRedHead: headSha,
    // A standing override on the repair limit keeps the cap from placing again.
    ...(ciCapReached(ciRounds) &&
    delivery?.ciCapAt === undefined &&
    !overridePasses(delivery, "repairs", headSha)
      ? { ciCapAt: at }
      : {}),
  };
}

/**
 * Closes the open attempt at `headSha`, which no reading can ever settle:
 * `superseded` when the change has moved past a version where the host holds
 * no check at all and no branch is at it (INF-988, INF-1185), `void` when the
 * host holds no commit there
 * (INF-1184). Either spends nothing - no result was seen - and the next
 * repair may be declared.
 */
export function closeCheckRepair(
  delivery: TaskDelivery | null | undefined,
  headSha: string,
  outcome: "superseded" | "void",
): Partial<TaskDelivery> {
  const ledger = structuredClone(delivery?.ciRepair ?? empty());
  const attempt = ledger.repairs.find((r) => r.headSha === headSha && r.outcome === undefined);
  if (attempt) attempt.outcome = outcome;
  return { ciRepair: ledger };
}

export function checkRepairWords(delivery: TaskDelivery | null | undefined): string[] {
  if (delivery?.ciCapAt !== undefined && !overridePasses(delivery, "repairs", delivery.headSha))
    return [
      `Three unsuccessful own repairs exhausted the allowance (${delivery.ciRounds ?? CI_ROUND_CAP}/${CI_ROUND_CAP}): stop and report the failing check and attempts. Completion stays held until the captain answers and the first mate relays it. ${softHoldWords("repairs", "crewmate")}`,
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
