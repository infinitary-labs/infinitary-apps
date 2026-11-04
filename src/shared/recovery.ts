import { z } from "zod";
import { HOLD_KINDS, HOLDS, type HoldKind } from "./holds";

/** INF-1550: declarations are facts, never a host reading of report prose. */
export const workWaitSchema = z.object({
  owner: z.string().trim().min(1).optional(),
  end: z.string().trim().min(1).optional(),
  observation: z.string().trim().min(1),
  cheapestWay: z.string().trim().min(1),
});
export type WorkWait = z.infer<typeof workWaitSchema>;

export const RECOVERY_APPROACHES = ["workaround", "pass-hold", "stronger-model"] as const;
export type RecoveryApproach = (typeof RECOVERY_APPROACHES)[number];

export const recoveryWaySchema = z.object({
  action: z.string().trim().min(1),
  approach: z.enum(RECOVERY_APPROACHES).optional(),
  hold: z.enum(HOLD_KINDS as [HoldKind, ...HoldKind[]]),
  evidence: z.string().trim().min(1),
  nextFact: z.string().trim().min(1),
});
export type RecoveryWay = z.infer<typeof recoveryWaySchema>;

/**
 * A way as a home reads it from another build or a saved report (R6 of INF-1644): a hold or
 * approach this build does not know stays as words and needs the captain, so a registry change
 * never refuses a report. The crewmate's own tool keeps the closed sets.
 */
export const keptRecoveryWaySchema = recoveryWaySchema.extend({
  approach: z.string().trim().min(1).optional(),
  hold: z.string().trim().min(1),
});
export type KeptRecoveryWay = z.infer<typeof keptRecoveryWaySchema>;

/** This labels a proposed move, never permission to execute or bypass a hold. */
export function recoveryWay(way: KeptRecoveryWay) {
  return { ...way, ...recoveryConsent(way.hold, way.approach) };
}

export function recoveryConsent<Hold extends string, Approach extends string>(
  hold: Hold,
  approach?: Approach,
) {
  const basis = Object.hasOwn(HOLDS, hold) ? HOLDS[hold as string as HoldKind].restsOn : undefined;
  const way: Approach | "pass-hold" = approach ?? "pass-hold";
  // A sign-in is an outside fact, but only the captain can supply it.
  return {
    hold,
    basis,
    approach: way,
    needsConsent:
      way !== "workaround" || basis === undefined || basis === "consent" || hold === "sign-in",
  };
}

/** A recovery string past its band ends in its whole text's digest (the task service's report bound); a person reads an ellipsis. */
export function withoutDigest(text: string): string {
  return text.replace(/ \[sha256:[0-9a-f]{64}\]$/, "…");
}

export type StallFact = {
  kind: "wait-without-owner" | "wait-without-end" | "repeated-wait";
  observation: string;
  cheapestWay?: string;
};

export function waitStall(wait: WorkWait, previous?: WorkWait): StallFact | undefined {
  const kind = !wait.owner
    ? "wait-without-owner"
    : !wait.end
      ? "wait-without-end"
      : previous?.owner === wait.owner &&
          previous.end === wait.end &&
          previous.observation === wait.observation
        ? "repeated-wait"
        : undefined;
  return kind ? { kind, observation: wait.observation, cheapestWay: wait.cheapestWay } : undefined;
}
