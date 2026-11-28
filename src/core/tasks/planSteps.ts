import type { RequiredAction } from "@shared/requiredActions";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "./taskService";

/**
 * A plan's steps for the captain (docs/required-actions.md, "A plan's
 * steps"): the steps a plan card declared only the captain can do, kept on
 * the plan as a change's required actions are kept on the change. A change's
 * wait for its merge; a plan's start only on the first mate's call, since
 * whether the captain's choice approved the plan is the first mate's reading.
 */
export function keepPlanSteps(
  tasks: Pick<TaskService, "delivery">,
  planId: string,
  shown: { id: string; offerId?: string } | undefined,
  actions: RequiredAction[],
): void {
  if (!shown?.offerId) return;
  tasks.delivery.declareRequiredActions(planId, {
    cardId: shown.id,
    offerId: shown.offerId,
    actions,
  });
}

/**
 * Makes each kept step its own task with its own card. Declaring the kept
 * offer again with `immediate` activates it in the declaration's own write,
 * and the activation's receipts make a second call answer the same tasks
 * and file nothing new.
 */
export function startPlanSteps(
  tasks: Pick<TaskService, "get" | "delivery" | "listWithRequirementFrom">,
  planId: string,
): { steps: TaskRecord[] } | { refused: "no-steps" } {
  const plan = tasks.get(planId);
  const offer = plan?.delivery?.requiredActionOffer;
  if (plan?.shape?.deliverable !== "answer" || !offer?.actions.length)
    return { refused: "no-steps" };
  tasks.delivery.declareRequiredActions(planId, offer, true);
  const steps = tasks
    .listWithRequirementFrom(
      planId,
      offer.actions.flatMap((action) => (action.sharedId ? [action.sharedId] : [])),
    )
    .filter((row) =>
      row.delivery?.captainAction?.requirements.some(
        (requirement) => requirement.source === planId && requirement.offer === offer.offerId,
      ),
    );
  return { steps };
}
