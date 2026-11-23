import { z } from "zod";
import { crewSpeedSchema } from "./crewSpeed";
import { folderNoticedSchema, folderRefreshCauseSchema } from "./folderRefresh";
import {
  type IntelligenceBucket,
  intelligenceBucketSchema,
  reasoningChoiceSchema,
} from "./modelSlots";
import {
  awayCopySchema,
  computerMoveSchema,
  homeCopySchema,
  placementRequirementsSchema,
  placementWaitSchema,
} from "./placement";
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
 * What a piece of work IS. Retrieval - a fact, or a how or why, read from
 * what the app can already read - is separate from research and reproduction
 * (FI3-1238, widened by INF-1430). `review` is the host's alone (delivery rigor phase 2): an independent
 * read of another task's pull request, stamped `kind_source: host:review`
 * and never a classifier's answer.
 */
export const workKindSchema = z.enum([
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "implement",
  "fix",
  "chore",
  "review",
  "unclear",
]);
export type WorkKind = z.infer<typeof workKindSchema>;

/**
 * Whether a task is the captain's quick answer (INF-4344, from INF-4341's
 * plan): retrieval, and not an internal step whose answer goes to the next
 * step rather than to a card. Its crewmate's brief carries the quick
 * answer's words (`renderAnswerShapeSection`) and its cards wear the app's
 * Quick answer mark (`Card.quick`); both read this one fact.
 */
export function isQuickAnswer(
  shape: { kind?: WorkKind; internal_step?: boolean } | null | undefined,
): boolean {
  return shape?.kind === "retrieval" && shape.internal_step !== true;
}

/**
 * What a piece of work DELIVERS (the deliverable axis, crew-posture
 * rationalization Task B, captain F1 A of 2026-09-20). Orthogonal to the
 * kind and to the tier: an `answer` task finds something out and lands one
 * card - its worktree is a laboratory it commits nothing from, it pushes
 * nothing, it opens no pull request, and it closes when the captain
 * resolves that card. A `change` task ships something through a gate and
 * is everything the fleet did before this axis existed.
 *
 * An `operation` makes and verifies a named effect and closes finished on
 * reported evidence, without code delivery. Folder work is an operation.
 * The host derives this from the first mate's typed `read-only` or
 * `operation` constraint (`deliverableFor`), refusing contradictory declarations.
 */
export const deliverableSchema = z.enum(["answer", "change", "operation"]);
export type Deliverable = z.infer<typeof deliverableSchema>;

/** The kinds a classifier may actually assert; `unclear` is its abstention. */
export const CLASSIFIABLE_KINDS = [
  "plan",
  "research",
  "retrieval",
  "reproduce",
  "implement",
  "fix",
  "chore",
] as const satisfies ReadonlyArray<WorkKind>;

/**
 * The classifiable kinds nested under what the work delivers (INF-1430
 * piece 1). The host tells the classifier the deliverable it derived and
 * offers only that branch, so an answer is never sorted into a change kind
 * or a change into an answer kind. A crewmate's follow-up carries no
 * declaration, so its kind decides the branch the other way round
 * (`deliverableFor`).
 */
export const KINDS_BY_DELIVERABLE = {
  answer: ["retrieval", "research", "plan", "reproduce"],
  change: ["implement", "fix", "chore"],
  operation: [],
} as const satisfies Record<Deliverable, ReadonlyArray<(typeof CLASSIFIABLE_KINDS)[number]>>;

export function isAnswerKind(kind: WorkKind | undefined): boolean {
  return (KINDS_BY_DELIVERABLE.answer as ReadonlyArray<string>).includes(kind ?? "");
}

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
  /** Work persists across turns until explicitly finished. */
  ongoing: z.boolean().optional(),
  /** The first mate's requested intelligence; premium still needs the captain's ask. */
  intelligence: intelligenceBucketSchema.optional(),
  /** The task whose report is the spec or the reproduction, when one exists. */
  basis: z.string().optional(),
  /**
   * Whether that basis resolved to a real task that is done or carries an
   * outcome. A claimed spec never buys a cheaper tier by itself, so an
   * unverified basis is treated as absent. Derived by the host at every
   * read (`TaskService.graph.basisHolds`) and handed to the table with the
   * shape; the task record never stores it.
   */
  basis_verified: z.boolean().optional(),
  /** The captain asked for premium in words. */
  premium_ask: z.boolean().optional(),
  /** The captain named a specific model (bare id or provider-qualified key). */
  override_model_id: z.string().optional(),
  /**
   * A review's model the decision model picked from the person's standing
   * directions (`provider/model`, docs/delivery-rigor.md, "Which model
   * reviews"): a preference, never a pin. Routing tries it first while it
   * passes the ladder's own checks, and otherwise chooses as usual and says
   * why; nothing ever waits for it.
   */
  review_model: z.string().optional(),
  /** Only the captain requests a faster speed; absent inherits the model default. */
  override_speed: crewSpeedSchema.optional(),
  /**
   * The captain named this task's reasoning effort. It wins over the
   * Settings → Models choice and the level's default for this task alone,
   * capped to what the serving model offers; absent inherits them.
   */
  override_reasoning: reasoningChoiceSchema.optional(),
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
   * The latest Automatic wait, written by the host onto the record so a
   * restart keeps the words and does not say the line again (INF-416 piece F).
   * Not the could-not-start notice. Absent once the task is no longer waiting.
   */
  placement_wait: placementWaitSchema.optional(),
  /** Start-wait source timestamps, never a cached readiness decision. */
  start_wait_since: z
    .object({
      policy: z.number().optional(),
      gate: z.number().optional(),
      dependencies: z.number().optional(),
    })
    .optional(),
  /** A started task's move to another computer, written only by the host (`computerMoveSchema`). */
  computer_move: computerMoveSchema.optional(),
  /** The commit this Mac last brought home of its branch on a computer that runs work, written only by the host (`homeCopySchema`). */
  home_copy: homeCopySchema.optional(),
  /** What it left on computers it moved off while they were out of reach, written only by the host (`awayCopySchema`). */
  away_copies: z.array(awayCopySchema).max(16).optional(),
  /**
   * The Firstmate's own declaration, made when it creates the task: this is
   * an internal step of a sequence it is running for an ask, whose answer is
   * handed to the next step (docs/sequences.md). Its judgment, taught by its
   * instructions - never inferred by the host, which only stores it and
   * honours it: `settle_task` done, why answered, closes an answer task only when it
   * was declared this way, and the brief tells such a step that its report
   * is the answer handed on. Absent - the default, and every row from
   * before it - is the captain's own ask, his to close.
   */
  internal_step: z.boolean().optional(),
  /**
   * The first mate's declaration that this answer task reads words from
   * outside its project's own people, such as issues and pull requests
   * strangers open (docs/agents-reach.md, "An outside reader"): its session
   * gets no shell, no web, no browser and no subagent, its file reads stay
   * in its working copy, its reads where the project lives stay in its own
   * project and arrive fenced, and every write it makes there waits for the
   * captain's click on one host card. The host refuses it on a task that is
   * not an answer, and the task runs only on the computer keeping the record.
   */
  outside_reader: z.boolean().optional(),
  /**
   * The shape this task's report must carry as its typed result (INF-799
   * piece 1): a JSON Schema object with an object at its root, declared by
   * the first mate when it plans or spawns the task. The host prints it in
   * the brief and checks each report's `result` against it, refusing a
   * mismatch by naming the first failing field (`src/core/tasks/taskResult.ts`).
   */
  result_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * The task, by key, whose last commit this task's working copy starts at
   * (INF-799 piece 1): its branch head while its working copy is present,
   * else its kept ref. Declared by the first mate; the host checks it holds
   * when it is named and again when the task starts.
   */
  branch_from: z.string().optional(),
  /**
   * The earlier part of a plan, by key, whose approved merge starts this
   * task (docs/task-graph.md, "A part that starts at approval"): one of its
   * `blocks` prerequisites, declared by the first mate to name which wait
   * the start follows. On batched pull requests a wait starts the task at
   * its approval without the mark too, unless `needs_merge` names it.
   */
  start_at_approval: z.string().optional(),
  /**
   * The `blocks` prerequisites, by key, whose merge this task needs, not
   * only their code (docs/task-graph.md, "A part that starts at approval"):
   * declared by the first mate, such as for a release. Each one waits for
   * its merge on batched pull requests too.
   */
  needs_merge: z.array(z.string()).optional(),
  /**
   * The approved version of an earlier part this task's working copy
   * started on (`start_at_approval`): that task, its pushed branch and the
   * approved commit, written by the host at the start. The brief, the
   * review, the line counts and the batch line read the task's own
   * difference against it.
   */
  built_on: z.object({ task: z.string(), branch: z.string(), head: z.string() }).optional(),
  /**
   * The name the first mate wrote for this task's branch from the naming
   * runbook's words, before its code (docs/architecture.md, "A task's
   * branch"). The host checks git would take it when it is written, and
   * appends a short code from the task's id when the working copy is
   * first made; with none, the branch is named from the title.
   */
  branch: z.string().optional(),
  /**
   * The program this task runs (INF-799 piece 2, docs/programs.md): a plain
   * JavaScript script the first mate declared, the args it reads, and the
   * upper bound it proposed on the script's task() calls. A task with a
   * program has no crewmate and no working copy: the host's runner
   * evaluates the script in its own process and files each task() call as
   * a part, a child task. The host checks that the script compiles and
   * imports nothing, and reads nothing of what it means.
   */
  program: z
    .object({
      script: z.string(),
      args: z.unknown().optional(),
      bound: z.number().int().positive(),
    })
    .optional(),
  /**
   * Which call of its parent's program filed this part (INF-799 piece 2):
   * the call's number in the order the script made them, a digest of the
   * call's prompt and options, and its label. The runner's journal: after
   * a quit it replays the script, and a call equal to a recorded one takes
   * that part's result instead of filing another. Written by the host when
   * it files the part.
   */
  program_part: z
    .object({
      call: z.number().int().nonnegative(),
      hash: z.string(),
      label: z.string(),
      /** The script's choice, not a model pin or permission to use premium. */
      intelligence: intelligenceBucketSchema.optional(),
    })
    .optional(),
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
  /**
   * The host filed this task to work in place, in its project's own folder,
   * with no working copy, branch, pull request or completion decision
   * (INF-549, docs/task-record.md "A folder a merge left behind"). Only the
   * host writes it, in one of two shapes.
   *
   * A folder a merge left behind, or one missing or behind where other work
   * found it (INF-572), carries the facts the folder was refused on: the default branch, the merged version the folder must reach
   * (`reach`), origin's default branch as last read (`remote`) and the typed
   * cause. The host closes the task once the folder is clean, on `branch`
   * and at or past `reach`.
   *
   * A pull request an abandoned task could not close carries that pull
   * request (`pull`): the host closes the task once it reads it closed.
   *
   * The host renders the brief from either at each start.
   *
   * Work the first mate declared works in the project's folder
   * (`in_folder` on its ask, INF-567) carries `folder: true`: its brief is
   * the first mate's intent, it runs on the computer keeping the folder
   * whatever the project's Runs on says, and it closes as any task does.
   */
  in_place: z
    .union([
      z.object({
        /** Absent when origin was missing or named no default branch. */
        branch: z.string().optional(),
        reach: z.string().optional(),
        remote: z.string().optional(),
        cause: folderRefreshCauseSchema,
        /** The merged task whose refresh was refused, by key, or the task that found the folder. */
        after: z.string().optional(),
        /** What found the folder so (INF-572); absent on a repair a merge filed before it. */
        noticed: folderNoticedSchema.optional(),
        /**
         * Where the repair's crewmate works when the folder was missing as it
         * started: the nearest folder above it that exists (INF-572). A resume
         * opens there again, even once the folder is back; a new start reads
         * the project's folder again and opens in it when it is there (INF-757).
         */
        started_in: z.string().optional(),
      }),
      z.object({
        pull: z.object({
          number: z.number(),
          /** The host's own label for it, such as #12 or !12. */
          label: z.string(),
          url: z.string().optional(),
          /** The branch it carries where the project lives. */
          branch: z.string().optional(),
          /** What the host answered when Infinitary tried to close it, as it said it. */
          problem: z.string().optional(),
        }),
        /** The abandoned task that opened it, by key and by id. */
        after: z.string().optional(),
        after_id: z.string(),
      }),
      z.object({ folder: z.literal(true) }),
    ])
    .optional(),
});
export type WorkShape = z.infer<typeof workShapeSchema>;
export type InPlaceWork = NonNullable<WorkShape["in_place"]>;
/** The facts of a folder a merge left behind. */
export type InPlaceFacts = Extract<InPlaceWork, { cause: unknown }>;
/** The facts of a pull request an abandoned task could not close. */
export type InPlacePull = Extract<InPlaceWork, { pull: unknown }>;

export function isFolderRepair(facts: InPlaceWork | undefined): facts is InPlaceFacts {
  return facts !== undefined && "cause" in facts;
}

/** Work the first mate declared works in the project's folder (`WorkShape.in_place`). */
export function isFolderWork(
  facts: InPlaceWork | undefined,
): facts is Extract<InPlaceWork, { folder: true }> {
  return facts !== undefined && "folder" in facts;
}

export function isPullRepair(facts: InPlaceWork | undefined): facts is InPlacePull {
  return facts !== undefined && "pull" in facts;
}

/**
 * Fields on a work shape a person owns. A host stamp never writes these.
 * Named once so a start-time write (INF-409) reuses this list instead of
 * copying fields back by name.
 */
export const CAPTAIN_OWNED_SHAPE_FIELDS = [
  "policies",
  "ongoing",
  "intelligence",
  "basis",
  "premium_ask",
  "override_model_id",
  "override_speed",
  "override_reasoning",
  "escalate_from",
  "rigor_ask",
  "delivery_ask",
  "autonomy_ask",
  "runs_on_ask",
  "placement_requirements",
  "internal_step",
  "outside_reader",
  "skipped_plan_because",
  "result_schema",
  "branch_from",
  "start_at_approval",
  "needs_merge",
  "branch",
  "program",
] as const satisfies readonly (keyof WorkShape)[];

/** Fields a host stamp may write onto the shape as it stands. */
export const HOST_STAMP_FIELDS = [
  "kind",
  "kind_source",
  "kind_detail",
  "deliverable",
  "escalation",
  "rigor",
  "autonomy",
  "in_place",
] as const satisfies readonly (keyof WorkShape)[];

/**
 * Host runtime on the shape that a stamp leaves as it stands: not a person's
 * edit, and not part of the verdict a stamp writes.
 */
export const HOST_KEPT_SHAPE_FIELDS = [
  "placement_fallback_accepted",
  "placement_wait",
  "start_wait_since",
  "computer_move",
  "home_copy",
  "away_copies",
  "program_part",
  "built_on",
  "review_model",
] as const satisfies readonly (keyof WorkShape)[];

/** Derived at every read and never stored. */
export const DERIVED_SHAPE_FIELDS = [
  "basis_verified",
] as const satisfies readonly (keyof WorkShape)[];

/** The host's stamp: only the fields a stamp owns, each optional so a quiet tier write can pass none. */
export type HostStamp = Partial<Pick<WorkShape, (typeof HOST_STAMP_FIELDS)[number]>>;

/** Writes a host stamp onto the shape as it stands. A field the stamp omits stays, including one a person cleared. */
export function stampOnto(current: WorkShape, stamp: HostStamp): WorkShape {
  const next: WorkShape = { ...current };
  for (const field of HOST_STAMP_FIELDS) {
    if (!Object.hasOwn(stamp, field)) continue;
    const value = stamp[field];
    if (value === undefined) continue;
    (next as Record<string, unknown>)[field] = value;
  }
  return next;
}

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
    ongoing: true,
    intelligence: true,
    basis: true,
    premium_ask: true,
    override_model_id: true,
    override_speed: true,
    override_reasoning: true,
    escalate_from: true,
    rigor_ask: true,
    delivery_ask: true,
    autonomy_ask: true,
    runs_on_ask: true,
    placement_requirements: true,
    internal_step: true,
    outside_reader: true,
    skipped_plan_because: true,
    result_schema: true,
    branch_from: true,
    start_at_approval: true,
    needs_merge: true,
    branch: true,
    program: true,
  })
  .extend({
    kind: workKindSchema.exclude(["review"]).optional(),
    /**
     * The task an independent reviewer should read (delivery rigor phase 2).
     * An ask only: the host commissions the review as a CHILD of that
     * builder, so the parent edge is the one stored join - the shape never
     * carries a builder pointer beyond `basis`.
     */
    review_of: z.string().optional(),
    /**
     * The first mate's declaration that this task works in its project's
     * own folder, not a working copy (INF-567): the host stamps
     * `in_place: { folder: true }` from it.
     */
    in_folder: z.boolean().optional(),
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
  "R12",
]);
/** R11 is ledger-only; older views do not have a program-choice reason line. */
export type RuleId = z.infer<typeof ruleIdSchema> | "R11";

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
 * R10 adds retrieval -> low (FI3-1238; a how or why read from what is here since INF-1430), without changing R2/R7.
 */
const DEFAULT_ROUTING_POLICY_VALUE: RoutingPolicy = {
  version: 1,
  kindTier: {
    plan: "high",
    research: "high",
    retrieval: "low",
    reproduce: "high",
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
