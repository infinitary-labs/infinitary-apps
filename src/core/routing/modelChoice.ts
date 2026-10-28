import { crewBandSchema, type ModelChoice, type ModelChoiceCandidate } from "@shared/modelChoice";
import { compareBandRank } from "@shared/quotaSignals";
import type { DecisionStore } from "../storage/decisionStore";
import type { TaskRecord } from "../storage/taskStore";
import { chosen } from "./modelReason";

/**
 * How a task's crewmate got its model (`TaskDetail.modelChoice`, INF-1714):
 * the comparison its newest routing decision that chose something saved when
 * it was made - the same row `modelReasonOf` reads - so a later reading or a
 * restart never rewrites it. Absent when that row saved no selection (made
 * before INF-1714) or the crewmate runs on another model than it chose.
 */
export function modelChoiceOf(
  task: Pick<TaskRecord, "id" | "model">,
  decisions: Pick<DecisionStore, "routing" | "routingFacts">,
): ModelChoice | undefined {
  const decision = chosen(decisions, task.id);
  if (!decision?.provider || !decision.model) return undefined;
  const served = `${decision.provider}/${decision.model}`;
  if (task.model !== served) return undefined;
  const facts = decisions.routingFacts(decision.id);
  if (facts?.kind !== "routing-candidates" || !facts.selection) return undefined;
  const candidates: ModelChoiceCandidate[] = facts.candidates
    .filter((fact) => fact.status.startsWith("picked") || fact.status.startsWith("eligible"))
    .sort(compareBandRank)
    .map((fact) => {
      const band = crewBandSchema.safeParse(fact.band);
      const points = fact.charge?.windows.reduce(
        (most, window) => Math.max(most, window.points),
        0,
      );
      const measuredAt = fact.measuredAt ?? fact.charge?.measuredAt;
      return {
        model: `${fact.provider}/${fact.model}`,
        picked: `${fact.provider}/${fact.model}` === served,
        ...(band.success ? { band: band.data } : {}),
        ...(fact.percentRemaining !== undefined ? { percentRemaining: fact.percentRemaining } : {}),
        ...(fact.spendPriority !== undefined ? { spendPriority: fact.spendPriority } : {}),
        ...(fact.rawSpendPriority !== undefined && fact.rawSpendPriority !== fact.spendPriority
          ? { rawSpendPriority: fact.rawSpendPriority }
          : {}),
        ...(points ? { placedWorkPoints: points } : {}),
        ...(measuredAt !== undefined ? { measuredAt } : {}),
        ...(fact.resetsAtMs !== undefined ? { resetsAtMs: fact.resetsAtMs } : {}),
      };
    });
  return {
    decidedBy: facts.selection.decidedBy,
    floorPercent: facts.selection.floorPercent,
    candidates,
  };
}
