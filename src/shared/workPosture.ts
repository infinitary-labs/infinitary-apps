import { z } from "zod";
import { CUT_OFF_CLASSES } from "./authFailure";

/**
 * The typed cut-off behind a paused-for-access posture, when one stands on
 * the task's account (the cut-off contract, docs/quota.md "Typed
 * cut-offs"): its class, the provider as the captain names it, and the
 * reset a spent allowance carries. A card thread's waiting line names the
 * way back from it (docs/card-threads.md, "The waiting line").
 */
export const accountHoldSchema = z.object({
  class: z.enum(CUT_OFF_CLASSES),
  provider: z.string(),
  resetsAt: z.number().optional(),
  /**
   * Where the account is, for a task on a computer that runs work, which
   * runs on that computer's own sign-in ("on Mac mini", "as Builder");
   * absent for this Mac's own.
   */
  where: z.string().optional(),
});
export type AccountHold = z.infer<typeof accountHoldSchema>;

/** Presentation only: never a session state or a recovery witness. */
export const workPostureSchema = z.object({
  state: z.enum(["active", "idle", "paused", "unknown"]),
  reason: z.enum([
    "turn",
    "job",
    "checks",
    "guidance",
    "settlement",
    "timed-wait",
    "captain",
    "inactive",
    "access",
    "dependency",
    "unobserved",
  ]),
  /** Present on `access` while a typed cut-off stands on the task's account. */
  hold: accountHoldSchema.optional(),
  /** Pending batch status on the offered version; older views keep their checks look. */
  batch: z.enum(["waiting", "in-batch", "paused"]).optional(),
  /** The watched contribution is open with its upstream maintainers. */
  maintainers: z.boolean().optional(),
});
export type WorkPosture = z.infer<typeof workPostureSchema>;

export function workPostureLabel(posture: WorkPosture): string {
  if (posture.maintainers) return "Waiting for the maintainers";
  if (posture.reason === "checks" && posture.batch) return "Waiting for the batch check";
  const reasons: Record<WorkPosture["reason"], string> = {
    turn: "Working",
    job: "Background work continues",
    checks: "Waiting for checks",
    guidance: "A reply is queued",
    settlement: "Finishing the task",
    "timed-wait": "Waiting to continue automatically",
    // A supervision hold need not have a ready card; taskStatusOf owns that choice.
    captain: "Work is paused",
    inactive: "No continuing work",
    access: "Paused for access",
    dependency: "Blocked by another task",
    unobserved: "Background work is unknown",
  };
  return reasons[posture.reason];
}
