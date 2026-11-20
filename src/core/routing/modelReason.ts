import { type ModelReason, modelReasonSchema } from "@shared/modelReason";
import { type ModelPin, servedModelKey } from "@shared/quota";
import type { DecisionStore, RoutingDecision } from "../storage/decisionStore";
import type { TaskRecord } from "../storage/taskRecords";

/** The newest decision of a task that chose a model, at or before `at`. */
export function chosen(
  decisions: Pick<DecisionStore, "routing">,
  taskId: string,
  at = Number.POSITIVE_INFINITY,
): RoutingDecision | undefined {
  return decisions
    .routing({ taskIds: [taskId], chosen: true })
    .filter((decision) => decision.at <= at)
    .at(-1);
}

/**
 * Why a task's crewmate runs on its model (`TaskDetail.modelReason`,
 * FI3-427): the typed columns of its newest routing decision that chose
 * something - the same row `servedSlots` reads - beside the shape that
 * decision was made from. The reasons prose is never read. Absent when the
 * task never routed, when the row predates the rule column, or when the
 * session runs on another model than the decision chose (the record's
 * dispatched model is the one the captain sees named).
 */
export function modelReasonOf(
  task: Pick<TaskRecord, "id" | "model" | "shape" | "parentId">,
  sources: {
    decisions: Pick<DecisionStore, "routing">;
    /** The models pinned in Settings now. */
    pins: () => readonly ModelPin[];
    /** A task's key by key or id; undefined when the record does not hold it. */
    keyOf: (ref: string) => string | undefined;
  },
): ModelReason | undefined {
  const decision = chosen(sources.decisions, task.id);
  if (!decision?.rule || !decision.provider || !decision.model) return undefined;
  const served = `${decision.provider}/${decision.model}`;
  if (task.model !== served) return undefined;
  const { shape } = task;
  const override = shape?.override_model_id;
  const basis = shape?.basis ? sources.keyOf(shape.basis) : undefined;
  const builder = shape?.kind === "review" && task.parentId ? task.parentId : undefined;
  const reviewOf = builder ? sources.keyOf(builder) : undefined;
  const builderProvider =
    decision.rule === "R9" && builder
      ? chosen(sources.decisions, builder, decision.at)?.provider
      : undefined;
  const reason = modelReasonSchema.safeParse({
    rule: decision.rule,
    asked: decision.bucket,
    served: decision.served ?? decision.bucket,
    ...(decision.rule === "R2" && shape && shape.kind !== "unclear" ? { kind: shape.kind } : {}),
    ...((decision.rule === "R4" || decision.rule === "R6") && basis ? { basis } : {}),
    ...(decision.rule === "R1b" && shape?.escalation
      ? { escalatedFrom: sources.keyOf(shape.escalation.from) ?? shape.escalation.from }
      : {}),
    ...(reviewOf ? { reviewOf } : {}),
    ...(builderProvider && builderProvider !== decision.provider ? { elsewhere: true } : {}),
    ...(decision.rule === "R0" &&
    override &&
    (override.includes("/") ? override === served : override === decision.model)
      ? { named: true }
      : {}),
    ...(sources.pins().some((pin) => servedModelKey(pin) === served) ? { pinned: true } : {}),
  });
  return reason.success ? reason.data : undefined;
}
