import type { IntelligenceBucket } from "@shared/quota";
import {
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type TierDecision,
  type WorkShape,
} from "@shared/routingPolicy";

/**
 * The tier table (captain-approved design 2026-09-18, report section 3.2).
 * Pure: it reads a shape and a policy, never a task's text, never the
 * catalog, never the slot record. `route()` under it is unchanged - this
 * only decides WHICH slot the ladder is asked for.
 *
 * Precedence, top to bottom, is the captain's own ordering:
 *   R0  an available model override wins outright
 *   R1a a premium ask
 *   R1b an escalation floor (the only automatic path into premium)
 *   R2-R7 the kind rules, two of them turning on a verified basis
 *   R8  unclear -> high
 */
export function tierFor(
  shape: WorkShape,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): TierDecision {
  if (shape.override_model_id) {
    return {
      rule: "R0",
      pin: shape.override_model_id,
      reason: `rule R0: the captain named ${shape.override_model_id}`,
    };
  }
  if (shape.premium_ask) {
    return { rule: "R1a", bucket: "premium", reason: "rule R1a: the captain asked for premium" };
  }
  if (shape.escalation) {
    const { from, attempt, floor } = shape.escalation;
    return {
      rule: "R1b",
      bucket: floor,
      reason: `rule R1b: escalation attempt ${attempt} from ${from} runs at ${floor}`,
    };
  }
  switch (shape.kind) {
    case "retrieval": {
      const bucket = policy.kindTier.retrieval;
      return { rule: "R10", bucket, reason: `rule R10: retrieval -> ${bucket}` };
    }
    case "plan":
    case "research":
    case "reproduce":
    case "teach":
    case "review": {
      const bucket = policy.kindTier[shape.kind];
      return { rule: "R2", bucket, reason: `rule R2: ${shape.kind} -> ${bucket}` };
    }
    case "implement":
    case "fix": {
      const grounded = isGrounded(shape);
      const tiers = policy.groundedTier[shape.kind];
      const bucket = grounded ? tiers.grounded : tiers.ungrounded;
      const rule = shape.kind === "implement" ? (grounded ? "R4" : "R3") : grounded ? "R6" : "R5";
      const because = grounded ? `on the verified basis ${shape.basis}` : "with no verified basis";
      return { rule, bucket, reason: `rule ${rule}: ${shape.kind} ${because} -> ${bucket}` };
    }
    case "chore": {
      const bucket = policy.kindTier.chore;
      return { rule: "R7", bucket, reason: `rule R7: chore -> ${bucket}` };
    }
    default: {
      const bucket = policy.unclearTier;
      return { rule: "R8", bucket, reason: `rule R8: kind unclear -> ${bucket}` };
    }
  }
}

/**
 * A basis only counts when it resolved to a real task that is done or
 * carries an outcome. A claimed spec never buys a cheaper tier by itself
 * (report section 3.1), so an unverified basis is treated as absent.
 */
function isGrounded(shape: WorkShape): boolean {
  return Boolean(shape.basis) && shape.basis_verified === true;
}

/** The outcome of asking for one rung up (S4 scaffolding; nothing calls it yet). */
export type EscalationFloor = { floor: IntelligenceBucket; attempt: number } | { refused: string };

/**
 * One rung up the ladder, bounded. Two refusals, both the captain's:
 * a lineage may spend `maxEscalations` (2), and nothing sits above
 * premium. The host stamps the answer onto the shape as `escalation`,
 * which is what `tierFor` then reads for R1b.
 */
export function escalationFloor(
  previous: IntelligenceBucket,
  attempt: number,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): EscalationFloor {
  if (attempt > policy.maxEscalations) {
    return {
      refused: `this lineage already used its ${policy.maxEscalations} escalations`,
    };
  }
  const ladder = policy.escalationLadder;
  const at = ladder.indexOf(previous);
  const next = at >= 0 ? ladder[at + 1] : undefined;
  if (!next) return { refused: `nothing routes above ${previous}` };
  return { floor: next, attempt };
}

/**
 * What a pre-S2 judgment means as a shape. The old contract asked the
 * Firstmate for a reasoning class and an exact model; of those two only
 * the facts survive the redesign - a `premium` class was only ever set
 * because the captain asked in words (the v2.7 routing rule), and a named
 * model is the same override under a new name. The judged low/medium/high
 * carries nothing the table reads, so it drops: the kind is `unclear` and
 * R8 routes it high.
 *
 * Two readers: a commissioned queued row written before `tasks.shape_json`
 * existed, and the replay engine translating a recorded
 * `difficulty`/`model_id` spawn (`docs/replay-harness.md`). A crewmate's
 * follow-up is neither - it is filed with no intent and never carried a
 * judgment - so the dispatch builds it a fresh shape and `rigorFor`
 * derives its rigor.
 *
 * The rigor is `quick` (delivery rigor phase 2): nothing derived one before
 * the tier existed and the crewmate was told no procedure, so a recorded
 * session replays - and a pre-phase-2 queued row dispatches - as the quick
 * work it was, never as a reviewed task the recording has no reviewer for.
 */
export function legacyShapeFromDifficulty(
  bucket: IntelligenceBucket | null | undefined,
  modelId?: string | null,
): WorkShape {
  return {
    kind: "unclear",
    kind_source: "legacy-judgment",
    rigor: "quick",
    ...(modelId ? { override_model_id: modelId } : {}),
    ...(bucket === "premium" ? { premium_ask: true } : {}),
  };
}
