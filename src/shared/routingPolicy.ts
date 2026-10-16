import { z } from "zod";
import { crewSpeedSchema } from "./crewSpeed";
import {
  type IntelligenceBucket,
  intelligenceBucketSchema,
  reasoningChoiceSchema,
} from "./modelSlots";
import { placementRequirementsSchema } from "./placement";
import { repoDeliverySchema } from "./repos";
import { rigorSchema } from "./rigor";
import { taskPolicyStateSchema } from "./taskPolicies";

/**
 * The work shape and the tier policy over it (captain-approved design
 * 2026-09-18, `fm3000-intelligence-bucket-routing-s1/report.md` sections
 * 3-5). The eight rules the captain locked are not eight model
 * preferences: they are ONE deterministic table over three facts about a
 * piece of work - what KIND it is, whether it is grounded in an
 * established spec or reproduction (`basis`), and whether a weaker
 * attempt already failed (`escalation`). This module is the shared home
 * of that vocabulary, the way `STARTER_SLOTS` is the shared home of the
 * slot seed: a later user-override record (deferred, S6) reads the same
 * definition.
 *
 * Nothing here reads a task's text and nothing here picks a model. The
 * kind arrives from a `KindClassifier` (`src/core/routing/kindClassifier.ts`),
 * the table lives in `src/core/routing/policy.ts`, and everything under
 * the tier - slots, the fallback ladder, the premium boundary, pins,
 * spend-priority ranking - is untouched.
 */

/**
 * What a piece of work IS. Bounded fact retrieval is separate from
 * research and reproduction (FI3-1238). `review` is the host's alone (delivery rigor phase 2): an independent
 * read of another task's pull request, stamped `kind_source: host:review`
 * and never a classifier's answer.
 */
export const workKindSchema = z.enum([
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "teach",
  "implement",
  "fix",
  "chore",
  "review",
  "unclear",
]);
export type WorkKind = z.infer<typeof workKindSchema>;

/**
 * What a piece of work DELIVERS (the deliverable axis, crew-posture
 * rationalization Task B, captain F1 A of 2026-09-20). Orthogonal to the
 * kind and to the tier: an `answer` task finds something out and lands one
 * card - its worktree is a laboratory it commits nothing from, it pushes
 * nothing, it opens no pull request, and it closes when the captain
 * resolves that card. A `change` task ships something through a gate and
 * is everything the fleet did before this axis existed.
 *
 * The HOST derives it at the mint from facts it already holds - the
 * classifier's kind and a typed `read-only` constraint - the same way it
 * derives the tier and the rigor. No agent judges it.
 */
export const deliverableSchema = z.enum(["answer", "change"]);
export type Deliverable = z.infer<typeof deliverableSchema>;

/** The kinds a classifier may actually assert; `unclear` is its abstention. */
export const CLASSIFIABLE_KINDS = [
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "teach",
  "implement",
  "fix",
  "chore",
] as const satisfies ReadonlyArray<WorkKind>;

/**
 * The escalation stamp (S4 scaffolding, no behaviour here). The host
 * computes it once at commission time from the lineage and writes it on
 * the shape; the table then reads `floor` rather than re-deriving a tier.
 */
export const escalationSchema = z.object({
  /** The task key whose result the captain rejected. */
  from: z.string(),
  /** 1-based position in the lineage; bounded by `maxEscalations`. */
  attempt: z.number().int().positive(),
  /** The tier this attempt runs at; an escalation never routes downward. */
  floor: intelligenceBucketSchema,
});
export type Escalation = z.infer<typeof escalationSchema>;

/**
 * Everything the tier decision is made from. The Firstmate supplies only
 * what it alone can see (`basis`, `premium_ask`, `override_model_id`,
 * `escalate_from`); the host supplies `kind` and `escalation`. Field
 * names are the wire names `spawn_crewmate` carries since S2, so they
 * are snake_case like the tool's other parameters.
 */
export const workShapeSchema = z.object({
  /** Current edits; original asks and dispatch stamps remain provenance. */
  policies: taskPolicyStateSchema.optional(),
  kind: workKindSchema,
  /** The task whose report is the spec or the reproduction, when one exists. */
  basis: z.string().optional(),
  /**
   * Whether that basis resolved to a real task that is done or carries an
   * outcome. A claimed spec never buys a cheaper tier by itself, so an
   * unverified basis is treated as absent. Derived by the host at every
   * read (`TaskService.basisHolds`) and handed to the table with the
   * shape; the task record never stores it.
   */
  basis_verified: z.boolean().optional(),
  /** The captain asked for premium in words. */
  premium_ask: z.boolean().optional(),
  /** The captain named a specific model (bare id or provider-qualified key). */
  override_model_id: z.string().optional(),
  /** Only the captain requests a faster speed; absent inherits the model default. */
  override_speed: crewSpeedSchema.optional(),
  /** The task the captain rejected; the Firstmate's escalation ask (S4). */
  escalate_from: z.string().optional(),
  /** The host's stamp for that ask (S4). */
  escalation: escalationSchema.optional(),
  /** How the kind was established, for the audit row (e.g. `classifier:xai/grok-4.6`). */
  kind_source: z.string().optional(),
  /**
   * The captain said in words how carefully this work should ship
   * (delivery rigor phase 2). The Firstmate passes it only then, the way it
   * passes `premium_ask`; the host derives the rigor from it and the other
   * facts (`src/shared/rigor.ts`).
   */
  rigor_ask: rigorSchema.optional(),
  /**
   * The captain asked in words for this task to ship at a different
   * posture than the repository's default. The Firstmate passes it only
   * then, the way it passes `rigor_ask`; the host uses it for this task
   * alone (`deliveryFor` in `./repos.ts`) and the repo is unchanged.
   */
  delivery_ask: repoDeliverySchema.optional(),
  /**
   * The captain said in words whether this task's green work may be merged
   * by the fleet itself or should be brought to him first. The Firstmate
   * passes it only then, the way it passes `rigor_ask`; the host uses it
   * for this task alone (`autonomyFor` in `./repos.ts`) and the
   * repository's default is unchanged. `false` is an ask too - "ask me
   * before merging this one" on an autonomous repository - so this field
   * is read by presence, never by truthiness.
   */
  autonomy_ask: z.boolean().optional(),
  /**
   * The captain said in words where this task runs (docs/helper.md, "A
   * task's own Runs on"): a computer that runs work by its device id, or
   * `this-mac` (`RUNS_ON_THIS_MAC`). The Firstmate passes it only then, at
   * spawn or with update_task before the task starts; it wins over the
   * project's Runs on for this task and for each part of it with none of
   * its own. Absent follows the parent's, else the project's.
   */
  runs_on_ask: z.string().optional(),
  placement_requirements: placementRequirementsSchema.optional(),
  /** Host-owned acceptance of the existing fallback while an Automatic start waits. */
  placement_fallback_accepted: z.boolean().optional(),
  /**
   * The Firstmate's own declaration, made when it creates the task: this is
   * an internal step of a sequence it is running for an ask, whose answer is
   * handed to the next step (docs/sequences.md). Its judgment, taught by its
   * instructions - never inferred by the host, which only stores it and
   * honours it: `settle_task answered` closes an answer task only when it
   * was declared this way, and the brief tells such a step that its report
   * is the answer handed on. Absent - the default, and every row from
   * before it - is the captain's own ask, his to close.
   */
  internal_step: z.boolean().optional(),
  /** Legacy metadata kept readable for saved tasks; grants no different access. */
  knowledge_access: z.literal("references").optional(),
  /** Firstmate's stated reason for skipping a plan; the host does not judge it. */
  skipped_plan_because: z.string().optional(),
  /**
   * The rigor the host derived at dispatch and stamped here, so a queued
   * row and the record both carry what the crewmate was told. Absent on a
   * row dispatched before phase 2, and on a `review` task, which ships
   * nothing.
   */
  rigor: rigorSchema.optional(),
  /**
   * What this task DELIVERS, derived by the host at the mint (Task B).
   * Optional on the schema so a row shaped before the axis existed parses;
   * every mint since stamps it, and a row that carries none is read as a
   * `change`, which is what it shipped at.
   */
  deliverable: deliverableSchema.optional(),
  /**
   * The autonomy the host derived at dispatch and stamped here, beside the
   * rigor, so the record carries what the task was commissioned under.
   * Provenance only: every reader - the settle refusal, `crew_status`, the
   * fact strip - derives the EFFECTIVE value live from the ask and the
   * repository, so flipping a repository's default reaches the work
   * already in flight.
   */
  autonomy: z.boolean().optional(),
  /**
   * Free prose about HOW the kind was established, when there is any: a
   * native decision model's own certainty, or the note that one failed and
   * the adapter answered in its place (S7b). One reason line on the routing
   * decision; absent on an ordinary answer. It replaced `kind_confidence`,
   * which nothing ever filled - the decision interface carries no
   * confidence, on the captain's call.
   */
  kind_detail: z.string().optional(),
});
export type WorkShape = z.infer<typeof workShapeSchema>;

/** The feed's note for a declared plan skip (`skipped_plan_because`): the Firstmate's reason, as given. */
export function planSkippedText(reason: string): string {
  return `Plan skipped for this work: ${reason.trim()}`;
}

/**
 * The half of the shape the Firstmate supplies on `spawn_crewmate`
 * (contract v2.8): the facts only it can see. The host adds `kind`,
 * `basis_verified` and `escalation` before the table runs, so those are
 * deliberately absent here - a model can neither classify its own work
 * nor certify its own basis.
 */
export const workShapeAskSchema = workShapeSchema
  .pick({
    basis: true,
    premium_ask: true,
    override_model_id: true,
    override_speed: true,
    escalate_from: true,
    rigor_ask: true,
    delivery_ask: true,
    autonomy_ask: true,
    runs_on_ask: true,
    placement_requirements: true,
    internal_step: true,
    knowledge_access: true,
    skipped_plan_because: true,
  })
  .extend({
    /**
     * The task an independent reviewer should read (delivery rigor phase 2).
     * An ask only: the host commissions the review as a CHILD of that
     * builder, so the parent edge is the one stored join - the shape never
     * carries a builder pointer beyond `basis`.
     */
    review_of: z.string().optional(),
  });
export type WorkShapeAsk = z.infer<typeof workShapeAskSchema>;

/**
 * The rule ids of the captain's table; they are the audit vocabulary. R9 is
 * the one row outside the tier table: reviewer placement (delivery rigor
 * phase 3, Q5) - a review task keeps the tier its kind routes to (R2) and
 * the ladder prefers a provider other than the builder's, recorded as R9.
 */
export const ruleIdSchema = z.enum([
  "R0",
  "R1a",
  "R1b",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
]);
export type RuleId = z.infer<typeof ruleIdSchema>;

/**
 * The policy is DATA: a tier per kind rule, the unclear default, the
 * escalation ladder and its bound. A later
 * settings record overrides rows of this the way `model-slots` overrides
 * `STARTER_SLOTS` (S6, deferred by the captain's Q6 C).
 */
export const routingPolicySchema = z.object({
  version: z.literal(1),
  /** kind -> tier when no basis is required to tell them apart. */
  kindTier: z.object({
    plan: intelligenceBucketSchema,
    research: intelligenceBucketSchema,
    retrieval: intelligenceBucketSchema,
    reproduce: intelligenceBucketSchema,
    /** Tutoring a learner: a lesson loop is never a change nor an answer. */
    teach: intelligenceBucketSchema,
    chore: intelligenceBucketSchema,
    /** An independent review reads like research (delivery rigor phase 2, Q5). */
    review: intelligenceBucketSchema,
  }),
  /** The two kinds whose tier turns on a verified basis. */
  groundedTier: z.object({
    implement: z.object({
      grounded: intelligenceBucketSchema,
      ungrounded: intelligenceBucketSchema,
    }),
    fix: z.object({
      grounded: intelligenceBucketSchema,
      ungrounded: intelligenceBucketSchema,
    }),
  }),
  /** R8: what an abstained, failed or skipped classification routes to. */
  unclearTier: intelligenceBucketSchema,
  /** R1b's ladder, weakest first. The only automatic path into premium. */
  escalationLadder: z.array(intelligenceBucketSchema),
  /** How many escalations one lineage may spend. */
  maxEscalations: z.number().int().nonnegative(),
  /**
   * The live thinking level requested for each served tier. Backends clamp
   * it to the chosen model; a Quick change steps down one offered rung.
   */
  effort: z
    .object({
      premium: z.string(),
      high: z.string(),
      medium: z.string(),
      low: z.string(),
    })
    .optional(),
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

/**
 * v1 = the captain's eight locked defaults, verbatim:
 * 1 premium = a user ask, or a lower tier failed/escalated;
 * 2 high = a complex plan, bug reproduction, or complex research;
 * 3 high = implementing unplanned/unspecced features;
 * 4 medium = implementing from a verified plan/spec (FI3-1389);
 * 5 high = fixing bugs not yet reproduced/understood;
 * 6 medium = fixing bugs reproduced, understood, with a clear solution;
 * 7 low = simple config/docs/cosmetic work;
 * 8 unclear -> high.
 * R10 adds bounded fact retrieval -> low (FI3-1238), without changing R2/R7.
 * `teach` (tutoring a learner through lessons) -> high, through R2.
 */
const DEFAULT_ROUTING_POLICY_VALUE: RoutingPolicy = {
  version: 1,
  kindTier: {
    plan: "high",
    research: "high",
    retrieval: "low",
    reproduce: "high",
    teach: "high",
    chore: "low",
    review: "high",
  },
  groundedTier: {
    implement: { grounded: "medium", ungrounded: "high" },
    fix: { grounded: "medium", ungrounded: "high" },
  },
  unclearTier: "high",
  escalationLadder: ["low", "medium", "high", "premium"],
  maxEscalations: 2,
  effort: { premium: "xhigh", high: "xhigh", medium: "medium", low: "medium" },
};

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = Object.freeze(DEFAULT_ROUTING_POLICY_VALUE);

/** The tier a shape routes to, and the rule that said so. */
export type TierDecision = {
  rule: RuleId;
  /**
   * Absent ONLY for R0, where the captain named a model and the tier is
   * whichever slot that model sits in - which the caller resolves, since
   * this module knows no slot record.
   */
  bucket?: IntelligenceBucket;
  /** R0 only: the model the captain named, for the caller to resolve. */
  pin?: string;
  /** One line for `routing_decisions.reasons`. */
  reason: string;
};

/** The existing level default, shared by settings and crew opening. */
export function levelDefaultReasoning(slot: IntelligenceBucket) {
  return reasoningChoiceSchema.parse(DEFAULT_ROUTING_POLICY.effort?.[slot] ?? "medium");
}
