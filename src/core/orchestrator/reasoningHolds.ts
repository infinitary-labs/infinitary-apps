import { tierFor } from "../routing/policy";
import type { RouteResult } from "../routing/router";
import type { TaskGate, TaskRecord } from "../storage/taskRecords";
import type { CrewCore } from "./crewCore";
import { reasoningWaitGate } from "./intake";

/**
 * The waits a start holds on its reasoning level (docs/routing.md): the
 * gate a queued ask sets when no model can serve it, the wake that says so
 * and the read of a task held on its own level.
 */
export class ReasoningHolds {
  constructor(private readonly core: CrewCore) {}

  /**
   * A queued premium ask or escalation rung that nothing can serve waits on
   * its level's quota reset (P7 + R1), with one wake the first time that gate
   * is set (`gate` is the row's gate before this dispatch). When no model is
   * placed at the level (`RouteResult.emptyBucket`), or every model placed
   * there reads text only and the task carries pictures
   * (`RouteResult.picturesUnread`), the gate carries that cause, which the
   * record's words read, and the hold and the wake say it instead; a changed
   * cause sets the gate again.
   */
  holdForReasoning(
    taskId: string,
    title: string,
    gate: TaskGate | null,
    routed: RouteResult,
  ): void {
    const cause = routed.emptyBucket ? "empty" : routed.picturesUnread ? "pictures" : undefined;
    const waitGate: TaskGate = { ...reasoningWaitGate(routed.bucket), ...(cause ? { cause } : {}) };
    if (gate?.kind === waitGate.kind && gate.ref === waitGate.ref && gate.cause === cause) return;
    this.core.options.tasks.placement.setGate(
      taskId,
      waitGate,
      cause === "empty"
        ? `held: no model is placed at ${routed.bucket}`
        : cause === "pictures"
          ? `held: no ${routed.bucket} model reads pictures`
          : `held: no ${routed.bucket} model has allowance`,
    );
    this.wakeReasoningWait(taskId, title, routed);
  }

  /**
   * An Automatic task held on its own level's reset (`holdForReasoning`).
   * Another computer's headroom at that level can end the hold, and only its
   * choice reads that, so the gate sweep asks it again each pass.
   */
  heldOnItsLevel(record: TaskRecord): boolean {
    const shape = record.shape;
    const bucket =
      shape && (shape.premium_ask || shape.escalation) ? tierFor(shape).bucket : undefined;
    return (
      bucket !== undefined &&
      record.gate?.kind === "quota-reset" &&
      record.gate.ref === reasoningWaitGate(bucket).ref &&
      this.core.placement.automaticFor(record)
    );
  }

  /**
   * The ask-first wake (P7 + R1; cards/tasks/agents P0, WI-3): the user
   * explicitly asked for a reasoning class no model can serve right now.
   * The row already waits on that class's quota reset - the safe default -
   * and the Firstmate may start it lower with update_task start_now, or
   * drop it. With no model in that class at all there is no reset to wait
   * for, and the wake says the wait ends when one is placed there.
   * Deduped by content on the task's ref.
   */
  wakeReasoningWait(taskId: string, title: string, routed: RouteResult): void {
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "reasoning-wait",
          task: { id: taskId, title },
          requested: routed.bucket,
          ...(routed.servedBucket ? { served: routed.servedBucket } : {}),
          ...(routed.emptyBucket ? { empty: true as const } : {}),
          ...(!routed.emptyBucket && routed.picturesUnread ? { pictures: true as const } : {}),
        },
      },
      "agent",
      taskId,
    );
  }
}
