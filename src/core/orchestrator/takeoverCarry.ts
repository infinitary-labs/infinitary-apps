import { said } from "@shared/i18n/said";
import { acceptedValidation, type LiveValidation } from "@shared/liveValidation";
import type { ReviewFrom } from "@shared/tasks";
import { carryKeptValidationEvidence } from "../pi/validationEvidence";
import { sameWorkLineage } from "../tasks/alreadyAllowed";
import type { TaskService } from "../tasks/taskService";

/**
 * A takeover carries the review an earlier task passed, and the proof
 * accepted with it, when its committed version is the very commit that
 * review read (INF-6536 finding 3). The earlier tasks are the work it was
 * handed, the same lineage the captain's yeses carry through
 * (`sameWorkLineage`). Only the identical commit carries: a head one
 * commit past the reviewed one carries nothing, and needs its own review
 * as any new commit does. The pass keeps naming the task that earned it
 * (`reviewFrom`). Returns the carry made now, or undefined when nothing
 * carried: the task has a verdict of its own, or no earlier task passed at
 * this commit.
 */
export function carryTakenOverReview(options: {
  tasks: TaskService;
  taskId: string;
  head: string | undefined;
  /** The folder a task's kept proof lives in. */
  proofDir: (taskId: string) => string;
}): ReviewFrom | undefined {
  const { tasks, taskId, head } = options;
  const record = tasks.get(taskId);
  if (!record || !head || record.delivery?.reviewVerdict || record.shape?.kind === "review")
    return undefined;
  const source = sameWorkLineage(tasks, record)
    .slice(1)
    .find((task) => task.delivery?.reviewVerdict === "pass" && task.delivery.reviewSha === head);
  const passed = source?.delivery;
  if (!source || !passed) return undefined;
  let liveValidation: LiveValidation | undefined;
  let proofLeft: string | undefined;
  const earned = passed.liveValidation;
  if (earned && acceptedValidation(earned, head).ready) {
    if (record.delivery?.liveValidation?.scenarioRevision) {
      // i18n-exempt: kept in the note's data, not shown
      proofLeft = "This task records scenarios of its own.";
    } else {
      // Proof whose kept files cannot be read or copied whole is not
      // carried: this task proves again, and the note's data says why.
      try {
        liveValidation = {
          ...structuredClone(earned),
          runs: earned.runs.map((run) => ({
            ...structuredClone(run),
            evidence: carryKeptValidationEvidence(
              run.evidence,
              { dir: options.proofDir(source.id), taskId: source.id },
              { dir: options.proofDir(record.id), taskId: record.id },
            ),
          })),
        };
      } catch (caught) {
        proofLeft = caught instanceof Error ? caught.message : String(caught);
      }
    }
  }
  const from = { taskId: source.id, key: source.key || source.id, title: source.title };
  const carried = tasks.delivery.carryReview(
    taskId,
    {
      facts: {
        reviewVerdict: "pass",
        reviewSha: head,
        ...(passed.reviewChange ? { reviewChange: passed.reviewChange } : {}),
        ...(passed.reviewRisk ? { reviewRisk: passed.reviewRisk } : {}),
        ...(passed.reviewRiskNote ? { reviewRiskNote: passed.reviewRiskNote } : {}),
        ...(passed.reviewedAt !== undefined ? { reviewedAt: passed.reviewedAt } : {}),
        reviewFrom: { ...from, proof: false },
      },
      ...(liveValidation ? { liveValidation } : {}),
    },
    (proof) =>
      said(proof ? "recordReviewCarriedProof" : "recordReviewCarried", {
        key: from.key,
        head: head.slice(0, 7),
      }),
    proofLeft ? { proofNotCarried: proofLeft } : undefined,
  );
  return carried ? tasks.get(taskId)?.delivery?.reviewFrom : undefined;
}
