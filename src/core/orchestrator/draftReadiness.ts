import { acceptedValidation } from "@shared/liveValidation";
import { type Forge, type ForgeChange, ForgeError } from "../forge";
import type { ChangeContext, ChangeDeliveryOptions } from "./changeContext";
import { reviewCoversHead } from "./reviewCarry";

/**
 * A prerequisite draft's readiness: the draft pull request a task opened for
 * an approved prerequisite publication is marked ready once its final proof
 * and review cover the version, and stays held otherwise.
 */
export class DraftReadiness {
  private readonly options: ChangeDeliveryOptions;
  private readonly readinessInFlight = new Set<string>();

  constructor(context: ChangeContext) {
    this.options = context.options;
  }

  /** Only a task-owned prerequisite draft graduates automatically after final proof and review. */
  async readyPrerequisite(taskId: string, forge: Forge, change: ForgeChange): Promise<ForgeChange> {
    if (change.number === undefined || this.readinessInFlight.has(taskId)) return change;
    this.readinessInFlight.add(taskId);
    const allowed = () => {
      const task = this.options.tasks.get(taskId);
      return (
        task?.branch === change.branch &&
        reviewCoversHead(task.delivery, change.headSha) &&
        acceptedValidation(task.delivery?.liveValidation, change.headSha).ready &&
        task.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.state === "succeeded" &&
            item.request.kind === "effect" &&
            item.request.prerequisitePublication &&
            item.request.publication?.repoId === task.repoId &&
            item.request.publication.branch === change.branch,
        )
      );
    };
    try {
      const readiness = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
      // A person may restore draft after readiness applied. That holds this version;
      // only a newer version may graduate again with its own current proof and review.
      if (
        readiness?.state === "ready" &&
        readiness.number === change.number &&
        readiness.head === change.headSha
      )
        return change;
      if (readiness?.state === "unknown" && readiness.number === change.number && change.draft) {
        // Read after the earlier attempt settled locally, not an overlapping caller's old snapshot.
        const current = await forge.changeFor(change.branch);
        if (!current || current.number !== change.number || current.branch !== change.branch)
          throw new ForgeError(
            "refused",
            "The earlier draft-readiness request cannot be reconciled with this change.",
          );
        change = current;
        if (change.draft)
          this.options.tasks.recordChangeEvidence(
            taskId,
            {
              validationReadiness: {
                head: change.headSha,
                number: readiness.number,
                state: "not-applied",
              },
            },
            {
              kind: "note",
              text: "The host still reports a draft; the earlier readiness request did not apply.",
            },
          );
      }
      if (!change.draft) {
        if (readiness && readiness.number === change.number)
          this.options.tasks.recordChangeEvidence(taskId, {
            validationReadiness: { head: change.headSha, number: readiness.number, state: "ready" },
          });
        return change;
      }
      if (!allowed()) return change;
      if (!forge.markReady)
        throw new ForgeError("unsupported", "This host cannot mark the prerequisite draft ready.");
      if (
        !this.options.verifyValidationEvidence &&
        this.options.tasks.get(taskId)?.delivery?.liveValidation?.runs.at(-1)?.evidence.length
      )
        throw new ForgeError("refused", "Kept proof cannot be verified here.");
      const ready = await forge.markReady(change, () => {
        if (!allowed())
          throw new ForgeError(
            "refused",
            "Validation changed; the prerequisite draft stays held until review.",
          );
        this.options.verifyValidationEvidence?.(taskId);
        this.options.tasks.recordChangeEvidence(taskId, {
          validationReadiness: { head: change.headSha, number: change.number!, state: "unknown" },
        });
      });
      this.options.tasks.recordChangeEvidence(taskId, {
        validationReadiness: { head: ready.headSha, number: ready.number!, state: "ready" },
      });
      return ready;
    } catch (caught) {
      const previous = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
      const problem = caught instanceof Error ? caught.message : String(caught);
      // Readiness is delivery bookkeeping, never a replacement for the host's check reading.
      this.options.tasks.recordChangeEvidence(
        taskId,
        {
          validationReadiness: {
            ...(previous && previous.number === change.number
              ? previous
              : {
                  head: change.headSha,
                  number: change.number!,
                  state: "not-applied" as const,
                }),
            problem,
          },
        },
        previous?.problem === problem
          ? undefined
          : {
              kind: "note",
              text: `Draft readiness is held: ${problem}`,
            },
      );
      return change;
    } finally {
      this.readinessInFlight.delete(taskId);
    }
  }

  readinessProblem(taskId: string, change: ForgeChange): string {
    const readiness = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
    return readiness && readiness.number === change.number && readiness.problem
      ? `Draft readiness is held: ${readiness.problem}`
      : "";
  }
}
