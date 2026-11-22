import { formatUsd } from "@shared/costLimit";
import { DONE_WHYS, type DoneWhy } from "@shared/deliveryFacts";
import { softHoldWords } from "@shared/holds";
import { type ReasoningChoice, reasoningChoiceSchema } from "@shared/modelSlots";
import type { PlacementRequirements } from "@shared/placement";
import type { RepoDelivery } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import { CLASSIFIABLE_KINDS, type WorkKind, type WorkShapeAsk } from "@shared/routingPolicy";
import { Type } from "typebox";
import type { CiReadingFact } from "../orchestrator/ciFact";
import type { LaneHold, SteerDelivery } from "../orchestrator/crewRuntime";
import { crewHoldWays, type HoldRefusal, renderHold } from "../orchestrator/holds";
import { parseSpawnIntent, type SpawnIntent } from "../orchestrator/intentBrief";
import { boundTool, stringEnum } from "../session/tools";
import type { CardRefusalReason } from "../storage/taskRecords";
import type { SettleRefusal } from "../tasks/taskGraph";

export const PLACEMENT_REQUIREMENTS_PARAM = Type.Object(
  {
    systems: Type.Optional(
      Type.Array(stringEnum(["macos", "linux"]), { minItems: 1, maxItems: 2 }),
    ),
    chips: Type.Optional(Type.Array(stringEnum(["arm64", "x64"]), { minItems: 1, maxItems: 2 })),
    tools: Type.Optional(
      Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$" }), { maxItems: 32 }),
    ),
    profile: Type.Optional(stringEnum(["conversation", "standard", "heavy"])),
  },
  { additionalProperties: false },
);

/**
 * The Firstmate agent's crew control plane: typed in-process tools
 * (report section 5). Every failure returns as a thrown error so the agent
 * reacts in conversation instead of failing silently, and every failure is
 * loud - an unknown repo_id rejects the spawn rather than silently landing
 * in the default workspace.
 *
 * spawn_crewmate follows the admission-handle discipline: it returns a
 * small handle (the task id) as soon as the task is recorded, before its
 * crewmate starts (INF-3060); results arrive later as [fm-op] inbox
 * messages, never as the tool result.
 */

export type CrewStatusEntry = {
  taskId: string;
  /** The record's conversational handle (`FM3K-12`), when it has one. */
  key?: string;
  title: string;
  status: string;
  crewmate?: string;
  repoName?: string;
  branch: string;
  /** A queued row's wait, in plain words (R1). */
  gate?: string;
  /**
   * The computer this task runs on, by name, or "this computer" (INF-992);
   * absent while no computer that runs work is listed, or before an
   * unstarted task's computer is known.
   */
  computer?: string;
  /**
   * The computer it runs on is out of reach: what this computer holds of
   * it and how a move on the captain's yes continues it elsewhere
   * (docs/helper.md, "Moving a task off a computer that is out of reach").
   */
  away?: string;
  lastReport?: string;
  /** Observed recovery after reopening; reading this never wakes the crewmate. */
  restart?: { at: string; text: string };
  /** Whether this task has a higher escalation rung left (separate from model/quota availability). */
  premiumRetryEligible?: boolean;
  /** The rigor the host derived at dispatch (delivery rigor phase 2). */
  rigor?: Rigor;
  /** The posture this task ships at (its ask, else the repository's). */
  delivery?: RepoDelivery;
  /**
   * Where this task's proposed change goes, in the person's word for the
   * host (`GitHub`, `git.example.com`; git integration PR 1.3). Absent
   * where the work merges locally or the project lives only on this Mac.
   */
  goesIn?: string;
  /**
   * Whether this task's green work may be merged without the captain (its
   * `autonomy_ask`, else the repository's flag) - the fact the Firstmate
   * needs before it reaches for settle_task. Absent only where there is no
   * merge to be autonomous about: a task on the personal workspace, which
   * carries no delivery either.
   */
  autonomy?: boolean;
  /**
   * The CI reading the app last recorded on this task's change (the
   * crewmate's check, the host's watch or the completion card's gate took
   * it): green, red, pending, no-pr or merged, with when and at which head.
   * Absent until one is recorded. A merge rechecks the checks fresh, so an
   * old reading is a guide, never the merge's evidence.
   */
  ci?: CiReadingFact;
  /**
   * Where the independent review stands, on a task with a review or a
   * review task: `review open (<key>)`, `review: findings`, `review passed`,
   * or `reviews <key>` on the reviewer's own row. Absent with no review.
   */
  review?: string;
  /**
   * The card threads on this task's open cards (cards-as-threads phase 1):
   * `2 messages, last from captain`. The Firstmate is never woken for a
   * thread message, so this - and the context block's own bounded section -
   * is how it learns a conversation happened.
   */
  thread?: string;
  /**
   * An open idle episode the ladder has acted on (docs/report-sort.md):
   * `stalled 1h 20m · 2 wakes` - how long the crewmate has been idle with
   * nobody's turn, and how many wakes about it went out.
   */
  stalled?: string;
  /**
   * The task's oldest background job still running (INF-1244): how long it
   * has run and its command, `running 1h 26m: pnpm test`, so a duration is
   * read, never guessed.
   */
  job?: string;
  /**
   * What a quiet turn waits on, once the twenty-minute check named it and
   * until the turn moves (INF-2603): its open calls and unread steers,
   * `inside github_read 13h 46m; 1 steer unread 12h`.
   */
  waiting?: string;
  /** How long ago its crewmate last reported (INF-1244): `1h 26m ago`. */
  reported?: string;
  /**
   * The check-back its crewmate's last report named (INF-1244): when it is
   * due and what it waits for, `in 20m: the unit tests`.
   */
  checkBack?: string;
  /**
   * The captain's override standing on this task (INF-1216): what his
   * words pass and for how long, `the rerun limit for this version`, and
   * his words. Absent when none stands at the task's version.
   */
  override?: { passes: string; words: string };
  /**
   * Each yes the captain gave that this task's turns are served as already
   * allowed (INF-3170 piece 2): the card it was given on, which
   * update_task take_back_yes names, and what it covers.
   */
  allowed?: { card: string; covers: string }[];
  /**
   * The host's refusal of this task's completion card, standing until one
   * goes up (FI3-401): the card's title, when (ISO 8601), the typed reason
   * and the host's words for it. A report saying the card went up is wrong
   * while this is here.
   */
  cardRefused?: { title: string; at: string; reason: CardRefusalReason; why: string };
  /**
   * The same durations as the times they run from (INF-1712): the first
   * mate's context serves these, so a row changes when its facts do, never
   * because the clock moved. crew_status keeps the words above.
   */
  times?: {
    jobSince?: number;
    job?: string;
    reportedAt?: number;
    checkBackUntil?: number;
    checkBackFor?: string;
    stalledSince?: number;
    stalledWakes?: number;
    /** The named wait's open calls and its oldest unread steer (INF-2603). */
    calls?: { tool: string; since: number }[];
    steersUnread?: number;
    steersSince?: number;
  };
};

/**
 * The version a review ask assigned, and whether its builder held edits
 * not yet committed then: true, false, or null when that could not be read.
 */
export type ReviewAssigned = { head: string; uncommitted: boolean | null };

/** What a review ask's answer says about the version it assigned (INF-3141). */
export function reviewAssignedWords(review: ReviewAssigned): string {
  const head = review.head.slice(0, 7);
  return ` The review is assigned the builder's committed version ${head}.${
    review.uncommitted === true
      ? " The builder also has edits not yet committed; the review does not see them, and once they are committed a later review turn takes the newer version."
      : review.uncommitted === null
        ? " Whether the builder has edits not yet committed could not be read."
        : ""
  }`;
}

export type CrewDelegate = {
  commission(input: {
    title: string;
    /** The structured intent (spawn v2); the host renders the brief. */
    intent: SpawnIntent;
    repoId?: string;
    /**
     * The facts the Firstmate alone can see (contract v3.3): the task whose
     * report is the spec, the captain's premium ask, the model he named,
     * the task the captain just rejected, the captain's words on care, and
     * the task whose PR an independent reviewer should read. The host
     * classifies the kind and computes the tier and the rigor from them.
     */
    shape?: WorkShapeAsk;
    startAfter?: { afterTask?: string; whenQuotaResets?: string; at?: number };
    /** The graph (task-system P2): a parent, blockers (queues it), a priority. */
    parent?: string;
    blockedBy?: string[];
    priority?: number;
  }): Promise<{
    taskId: string;
    /** `queued` for work that waits, otherwise starting behind the answer (INF-3060). */
    crewmate: string;
    /** A review ask's assigned version (INF-3141). */
    review?: ReviewAssigned;
  }>;
  /**
   * The work started from the captain's reply under a card (`from_card`):
   * the app's line in that card's thread naming the task, answered in words.
   */
  startedFrom?(cardId: string, taskId: string, queued: boolean): string;
  steerCrewmate(
    taskId: string,
    message: string,
    response?: import("@shared/crewResponses").AskedResponsePolicy,
  ): Promise<SteerDelivery>;
  /** What holds a task's lane now (`CrewFacts.laneHold`), for a kept message's answer. */
  laneHold?(taskId: string): LaneHold | undefined;
  /**
   * Delivers the files `fromTask`'s reports handed on into `toTask`'s
   * hand-over folder (INF-992); answers the words its steer carries.
   */
  handFiles?(fromTask: string, toTask: string): Promise<string>;
  /**
   * The same hand-over with the steer after it, answered once its checks
   * pass and before the files cross (INF-3060); a failure after that wakes
   * the first mate.
   */
  steerAfterFiles?(
    fromTask: string,
    taskId: string,
    message: string,
    response?: import("@shared/crewResponses").AskedResponsePolicy,
  ): Promise<void>;
  interruptCrewmate(
    taskId: string,
    mode: "interrupt" | "cancel",
    closingSentence?: string,
  ): Promise<void>;
  crewStatus(taskId?: string): CrewStatusEntry[];
  /**
   * Moves a started task to another computer at a safe pause, or cancels
   * a move that has not started crossing (`computer` null); answers what
   * happened in words (docs/helper.md, "Moving a started task").
   */
  moveTask?(
    taskId: string,
    computer: string | null,
    keep?: string[],
    leaveBehind?: boolean,
  ): Promise<{ ok: boolean; text: string }>;
  /**
   * Records a task started with `repairs_batch` as the repair of its
   * project's held batch; answers why not in words, or nothing.
   */
  markBatchRepair?(taskId: string): Promise<string | undefined>;
  /** Whether the named lineage has a higher rung left; unknown tasks defer to the card rule. */
  escalationEligible?(taskId: string): boolean;
  /** Whether a premium-slot model is available and has not exhausted measured quota. */
  premiumCanServe?(): boolean;
  /**
   * True only on a wake that carries the captain's own words (the same
   * stamp `remember` and `flag_missed_escalation` read). Escalation is the
   * captain's move, so the model cannot forge the turn it needs (Q2).
   */
  isCaptainTurn(): boolean;
  /**
   * Merge a PR, land locally, or discard a task; the prose leads the tool
   * result and a structured refusal (WI-12), when there is one, rides its
   * `details` so the Firstmate can carry the ways out as effect buttons.
   */
  settleTask(
    taskId: string,
    mode: "merge-pr" | "land" | "discard",
    confirm?: boolean,
    proceedWithOpen?: boolean,
    closingSentence?: string,
  ): Promise<{ text: string; refusal?: SettleRefusal }>;
  /**
   * settle_task done (INF-3169's plan, piece 2): the one close as done,
   * naming why, with the captain's words, when they ask it, passing every
   * soft hold (`captainWordsFrom`: `turn`, or where his words came in).
   */
  closeDone(
    taskId: string,
    input: {
      why?: DoneWhy;
      carriedBy?: string;
      deliveredIn?: string;
      evidence?: string;
      captainWordsFrom?: string;
      closingSentence?: string;
      dropWaiting?: number[];
    },
  ): Promise<{ text: string; refusal?: SettleRefusal }>;
};

/**
 * The first mate's closing sentence (INF-547): a top-level parameter on
 * both of its close tools, so its rule reaches a Claude first mate whole.
 * settle_task's says it once; interrupt_crewmate's points there.
 */
export const CLOSING_SENTENCE_DESCRIPTION =
  "Required except done answered or carried_on: one plain sentence for the captain on what became of the work and why.";

/** A close of started work refused for want of its sentence: what is missing and how to answer. */
export function closingSentenceMissing(mode: string): string {
  return `Not closed: ${mode} needs closing_sentence, one plain sentence for the captain on what became of this task's work and why. Call it again with one.`;
}

/** What `internal_step` means, shared by spawn_crewmate and create_task. */
export const INTERNAL_STEP_DESCRIPTION =
  "True when the captain did not ask for this work: a sequence step, a helper another task needs, a crewmate's request, or work you start unasked. Its drop or finish puts no note up; a merge or release still does. A step's answer goes to the next step, and once that step has started you close it with settle_task done, why answered. Omit it when the captain asked for this result - by message, card choice or schedule: that stays theirs to close.";

/**
 * What `basis` means, shared by spawn_crewmate and create_task: a planned
 * step names its basis the same way a spawn does, and the host verifies it
 * when the step dispatches.
 */
export const BASIS_DESCRIPTION =
  "The task (id or key) whose report specifies this work, or whose reproduction it fixes. Name it only when that task carries it; the host ignores an unverified basis.";

/** A group's description: what it holds, then each field's rule on its own line under the field's name. */
function groupDescription(lead: string, rules: Record<string, string>): string {
  return [lead, ...Object.entries(rules).map(([name, rule]) => `${name}: ${rule}`)].join("\n");
}

/**
 * The intent's typed constraints and delivery note, shared by spawn_crewmate
 * and create_task: a planned step carries the same intent a spawn does, and
 * its brief prints a free constraint verbatim under the user's words. What
 * each field means rides the array's own description (contract v4.13): a
 * Claude seat's client drops every description below a top-level parameter.
 */
export const CONSTRAINTS_DESCRIPTION = groupDescription("Constraints.", {
  kind: "read-only: answer; operation: named effect; never code, merge or prepare a merge card. Steer the pull request's owning crewmate to its merge card (past branch rules, check_change skipRules), or start one without this kind; otherwise change; free: relayed verbatim",
  text: "Required when kind is free; optional qualifier otherwise",
});

export const CONSTRAINTS_PARAM = Type.Optional(
  Type.Array(
    Type.Object({
      kind: stringEnum([
        "read-only",
        "operation",
        "tests-required",
        "no-new-deps",
        "minimal-diff",
        "free",
      ]),
      text: Type.Optional(Type.String()),
    }),
    { description: CONSTRAINTS_DESCRIPTION },
  ),
);

export const DELIVERY_NOTE_PARAM = Type.Optional(
  Type.String({
    description:
      'Delivery expectation refining the repository posture, e.g. "stack on top of PR 41". A posture override is delivery_ask, not this.',
  }),
);

/**
 * What each work-shape fact in spawn_crewmate's `shape` group means. The
 * rules ride the group's own description, never the fields' (contract
 * v4.13): a Claude seat's client drops every description below a top-level
 * parameter, and a Pi seat reads the same words in the same place.
 */
const SHAPE_FIELD_RULES = {
  ongoing:
    "True for work continuing across turns until explicitly finished; routine personal-workspace turns commit without waking the first mate.",
  intelligence:
    "Intelligence: low, medium or high; premium needs the captain's premium ask. Tell the captain difficulty: high Hard, medium Normal, low Simple, premium Premium.",
  kind: "Declare kind: read-only answers use plan/retrieval/research/reproduce; changes use implement/fix/chore. The classifier sorts what you omit; review is host-owned.",
  delivery_ask:
    "Only when the user asked in words for this task to ship as a pull request or stay local. The repository default is unchanged.",
  basis: BASIS_DESCRIPTION,
  premium_ask:
    'True only when the user asked for premium or the best model in words, or clicked your "Try a premium model" action. Never your own judgment.',
  override_speed: "As update_task.crew_speed.",
  override_reasoning: "As update_task.reasoning.",
  override_model_id:
    "The user-named model: exact id or provider-qualified key if the provider matters. Only when named by the user; it wins when available; otherwise the task waits for a computer serving it. Omit for normal routing.",
  escalate_from:
    "Task (id or key) whose result the user rejected, only under the escalation rule. The host stops that attempt, keeps its branch and report, and runs this one a tier up.",
  rigor_ask: "Only when the user said in words how careful to be.",
  autonomy_ask:
    "Only when the user said in words whether this task merges its green work itself (true) or asks first (false). The repository default is unchanged.",
  runs_on_ask: "As update_task's runs_on.",
  internal_step: INTERNAL_STEP_DESCRIPTION,
  in_folder: "Operate in the project's folder; ships nothing.",
  skipped_plan_because:
    "For a direct build without a chosen basis, which sequences test parts passed: one nameable place, no changed rule, state or meaning, and a result checkable by looking. The host shows it unjudged.",
  review_of:
    "Task whose committed work an independent reviewer checks read-only; pass the user's original words and same repo_id. It runs on its builder's computer: omit runs_on_ask.",
  repairs_batch:
    "True only on the one task you start to repair a project's held batch: the host records it as that batch's repair, which the captain sees.",
} as const satisfies Record<keyof typeof SHAPE_FIELDS, string>;

/** What each wait in spawn_crewmate's `start_after` group means, on the group (v4.13). */
const START_AFTER_FIELD_RULES = {
  after_task: "the named task finishes; the same as one blocked_by entry",
  when_quota_resets:
    "quota returns for a scope: a provider name from the quota line, or bucket:premium / bucket:high / bucket:medium / bucket:low",
  at_time: "an ISO 8601 date-time",
} as const satisfies Record<keyof typeof START_AFTER_FIELDS, string>;

/** What spawn_crewmate's `shape` group holds (contract v4.12, primitives P7; its fields' rules since v4.13). */
export const SHAPE_GROUP_DESCRIPTION = groupDescription(
  "Facts the host routes and ships work by. Set each only as its rule says and omit the rest.",
  SHAPE_FIELD_RULES,
);

/** What spawn_crewmate's `start_after` group holds (contract v4.12, primitives P7; its fields' rules since v4.13). */
export const START_AFTER_GROUP_DESCRIPTION = groupDescription(
  "Queue this work instead of starting it now, until one of these; omit the group to start now.",
  START_AFTER_FIELD_RULES,
);

/** The work-shape facts spawn_crewmate carries in `shape`, with the type each holds. */
const SHAPE_FIELDS = {
  ongoing: "boolean",
  intelligence: "string",
  kind: "string",
  delivery_ask: "string",
  basis: "string",
  premium_ask: "boolean",
  override_model_id: "string",
  override_speed: "string",
  override_reasoning: "string",
  escalate_from: "string",
  rigor_ask: "string",
  autonomy_ask: "boolean",
  runs_on_ask: "string",
  internal_step: "boolean",
  in_folder: "boolean",
  skipped_plan_because: "string",
  review_of: "string",
  repairs_batch: "boolean",
} as const;

/** The waits spawn_crewmate carries in `start_after`, with the type each holds. */
const START_AFTER_FIELDS = {
  after_task: "string",
  when_quota_resets: "string",
  at_time: "string",
} as const;

/**
 * A spawn's args in the grouped shape (contract v4.12): the work-shape facts
 * under `shape`, the waits under `start_after`. Before v4.12 the same fields
 * sat at the top level, and a Firstmate session - which is durable - or a
 * recorded one still passes them there; they move into their group, where
 * a value the group already carries wins. A field of the wrong type is not
 * carried, the way a schema would refuse it. The one reader of both
 * shapes: the tool and the replay engine both go through it.
 */
export function groupSpawnArgs(args: Record<string, unknown>): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};
  const groups = {
    shape: { fields: SHAPE_FIELDS, values: {} as Record<string, unknown> },
    start_after: { fields: START_AFTER_FIELDS, values: {} as Record<string, unknown> },
  };
  for (const [key, value] of Object.entries(args)) {
    if (key === "shape" || key === "start_after") continue;
    const group = Object.values(groups).find((candidate) => key in candidate.fields);
    if (!group) {
      grouped[key] = value;
      continue;
    }
    if (typeof value === group.fields[key as keyof typeof group.fields]) group.values[key] = value;
  }
  for (const [name, group] of Object.entries(groups)) {
    const nested = args[name];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(group.values, nested);
    }
    if (Object.keys(group.values).length > 0) grouped[name] = group.values;
  }
  return grouped;
}

/** How the refusal of an escalation the captain did not ask for opens. */
/**
 * A task's result shape (INF-799): any JSON object, checked by the host when
 * it is named, written as the bare keyword so every seat reads a few
 * characters of it on every request (the fixed-context budget).
 */
export const RESULT_SCHEMA_PARAM = Type.Unsafe<Record<string, unknown>>({ type: "object" });

/**
 * The task's branch name the first mate writes from the naming runbook's
 * words (docs/architecture.md, "A task's branch"); the app adds the code.
 */
export const BRANCH_PARAM = Type.String({
  description:
    "The task's branch, as the naming runbook says; the app adds a short code. Omit to name it from the title.",
});

export const NOTHING_SPAWNED = "Nothing was spawned.";

/**
 * spawn_crewmate's `from_card` (INF-3071's plan, its second change): the
 * card whose thread holds the captain's reply this work answers, so the app
 * writes a line there naming the task, ended cards included.
 */
export const FROM_CARD_DESCRIPTION =
  "Card id whose captain reply this work answers, yours or one a crewmate's report names; the app writes a line there naming the task.";

/** A first mate with no way to hand files on refuses files_from in words. */
function missingHandFiles(): Promise<string> {
  return Promise.reject(new Error("Handing files between tasks is not available here."));
}

/**
 * What steer_crewmate answers for guidance a held lane keeps: the hold that
 * keeps it (`LaneHold`), and for a cost limit the card whose answer releases
 * it, so the first mate never reports one hold as another.
 */
export function heldSteerText(taskId: string, hold?: LaneHold): string {
  const kept = "so your message is kept and goes out on its own";
  const tail = "Do not resend.";
  switch (hold?.kind) {
    case "cost-limit": {
      const where =
        hold.holder === taskId || hold.holderKey === taskId
          ? `Task ${taskId} passed its ${formatUsd(hold.limitUsd)} cost limit`
          : `Task ${taskId} is under ${hold.holderKey}, which passed its ${formatUsd(hold.limitUsd)} cost limit`;
      return `${where}, ${kept} once the captain allows more spending on its cost limit card ${hold.cardId}. ${tail}`;
    }
    case "move":
      return `Task ${taskId} is moving to another computer, ${kept} once it has moved and its conversation is open there. ${tail}`;
    case "hand-over":
      return `Task ${taskId} is still receiving files handed over to it, ${kept} right after them. ${tail}`;
    case "model":
      switch (hold.cause) {
        case "update":
          return `Task ${taskId}'s model is on no level in Settings any more, and the computer it runs on must be updated before its conversation can leave that model, ${kept} once it is. ${softHoldWords("model-levels", "firstmate")} ${tail}`;
        case "unread":
          return `Task ${taskId}'s subscriptions have not said yet which models they serve, ${kept} once they have. ${tail}`;
        default:
          return `Task ${taskId}'s model is on no level in Settings any more and no other model there can take it, ${kept} once one can. ${softHoldWords("model-levels", "firstmate")} ${tail}`;
      }
    case "account":
      return `Task ${taskId}'s account is not answering right now, ${kept} when it answers again; you will hear when it does. ${tail}`;
    case "update":
      return `The computer task ${taskId} runs on is being updated, ${kept} once the update is over and it is back. ${tail}`;
    case "out-of-reach":
      return `The computer task ${taskId} runs on is out of reach or still catching up, ${kept} once it is back and caught up. ${tail}`;
    default:
      return `Task ${taskId} cannot take messages right now, ${kept} when it can. ${tail}`;
  }
}

export function createCrewTools(delegate: CrewDelegate) {
  const spawn = boundTool({
    name: "spawn_crewmate",
    label: "Spawn crewmate",
    description: [
      "Commission a crewmate for project work or evidence-gathering investigation.",
      "Pass a goal, the user's verbatim words, typed constraints and an optional delivery note;",
      "the crewmate briefs itself from these on its first turn; do not author a brief.",
      "Pass repo_id to bind a project, or omit it for the default workspace.",
      "Lessons and the user's own panels on the rails use personal_ui true: the",
      "host binds the personal workspace itself (no repo_id) and the crewmate builds in place,",
      "so name an existing surface's id in the goal for a change.",
      "Before security, codesign or any Keychain command against real keychains or a project's own signing material, ask for consent on a card; never put a secret in a command line; prefer stand-ins under a scratch HOME.",
      "Returns the task id immediately;",
      "the crewmate's results arrive later as [fm-op] messages, so end your turn.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({ description: "As create_task's title." }),
      goal: Type.String({
        description:
          "One plain sentence: only the asked-for change. Preserve via constraints: “leave ... as it is”, not how it works now.",
      }),
      user_words: Type.Optional(
        Type.String({
          description:
            "The captain's verbatim words for this task or the ask it is a step of; outrank every elaboration downstream; else omit",
        }),
      ),
      repo_id: Type.Optional(
        Type.String({ description: "A registered repo id from the context block" }),
      ),
      personal_ui: Type.Optional(
        Type.Boolean({ description: "As above; never for a new game or app" }),
      ),
      constraints: CONSTRAINTS_PARAM,
      delivery_note: DELIVERY_NOTE_PARAM,
      parent: Type.Optional(
        Type.String({
          description: "Parent task id or key; this work inherits its project",
        }),
      ),
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Task ids or keys that must close before this work starts; queues it instead of starting now",
        }),
      ),
      priority: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 3, description: "As create_task's priority." }),
      ),
      shape: Type.Optional(
        Type.Object(
          {
            ongoing: Type.Optional(Type.Boolean()),
            intelligence: Type.Optional(stringEnum(["low", "medium", "high", "premium"])),
            kind: Type.Optional(stringEnum([...CLASSIFIABLE_KINDS, "unclear"])),
            delivery_ask: Type.Optional(stringEnum(["direct-pr", "local-only"])),
            basis: Type.Optional(Type.String()),
            premium_ask: Type.Optional(Type.Boolean()),
            override_model_id: Type.Optional(Type.String()),
            override_speed: Type.Optional(stringEnum(["standard", "fast", "ultrafast"])),
            override_reasoning: Type.Optional(stringEnum(reasoningChoiceSchema.options)),
            escalate_from: Type.Optional(Type.String()),
            rigor_ask: Type.Optional(stringEnum(["quick", "standard", "reviewed"])),
            autonomy_ask: Type.Optional(Type.Boolean()),
            runs_on_ask: Type.Optional(Type.String()),
            internal_step: Type.Optional(Type.Boolean()),
            in_folder: Type.Optional(Type.Boolean()),
            skipped_plan_because: Type.Optional(Type.String()),
            review_of: Type.Optional(Type.String()),
            repairs_batch: Type.Optional(Type.Boolean()),
          },
          { description: SHAPE_GROUP_DESCRIPTION },
        ),
      ),
      placement_requirements: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: "As create_task's placement_requirements.",
        }),
      ),
      result_schema: Type.Optional(RESULT_SCHEMA_PARAM),
      branch_from: Type.Optional(
        Type.String({
          description:
            "Start from this task’s last commit, held here; for work on another computer, name its pushed version in the brief.",
        }),
      ),
      branch: Type.Optional(BRANCH_PARAM),
      start_after: Type.Optional(
        Type.Object(
          {
            after_task: Type.Optional(Type.String()),
            when_quota_resets: Type.Optional(Type.String()),
            at_time: Type.Optional(Type.String()),
          },
          { description: START_AFTER_GROUP_DESCRIPTION },
        ),
      ),
      from_card: Type.Optional(Type.String({ description: FROM_CARD_DESCRIPTION })),
    }),
    run: async (raw) => {
      // Grouped since v4.12; a flat call from before it reads the same.
      const params = groupSpawnArgs(raw as Record<string, unknown>) as typeof raw;
      const shapeParams = params.shape ?? {};
      // The escalation gate is the captain's turn itself (Q2, report
      // section 4 step 2): nothing climbs a tier without a human saying so,
      // and a refusal here stops the whole spawn rather than quietly
      // starting a duplicate at the tier that already failed.
      const escalateFrom = shapeParams.escalate_from?.trim();
      if (escalateFrom && !delegate.isCaptainTurn()) {
        // The ways out are the HOST's to name (contract v3.6, captain lock 3;
        // audit 4.4b row 7): this refusal used to spell out the card to
        // write, which is the same prose the two cap wakes carried and the
        // persona repeated a third time. It carries the facts and the
        // structured options instead, the way a close refusal has since
        // WI-12, and the card rule in the prompt does the rest.
        const hold: HoldRefusal = {
          held: "escalation-needs-captain",
          task: { id: escalateFrom },
          ways: crewHoldWays(
            escalateFrom,
            undefined,
            delegate.escalationEligible?.(escalateFrom),
            delegate.premiumCanServe?.(),
          ),
          text: `${NOTHING_SPAWNED} escalate_from needs the captain's own words rejecting ${escalateFrom}, and this turn is not a captain turn: a crewmate's own account of itself never climbs a tier. These are the ways out of the hold on that task, and the captain's answer is what takes one.`,
        };
        return { text: renderHold(hold) };
      }
      const startAfter = startAfterFrom(params.start_after ?? {});
      const { repairs_batch: repairsBatch, ...shapeRest } = shapeParams;
      const shape = shapeAskFrom({
        ...shapeRest,
        ...(params.placement_requirements
          ? { placement_requirements: params.placement_requirements }
          : {}),
        ...(params.result_schema
          ? { result_schema: params.result_schema as Record<string, unknown> }
          : {}),
        ...(params.branch_from ? { branch_from: params.branch_from } : {}),
        ...(params.branch ? { branch: params.branch } : {}),
      });
      const intent = parseSpawnIntent({
        goal: params.goal,
        ...(params.user_words !== undefined ? { user_words: params.user_words } : {}),
        ...(params.constraints ? { constraints: params.constraints } : {}),
        ...(params.delivery_note !== undefined ? { delivery_note: params.delivery_note } : {}),
        ...(params.personal_ui ? { kind: "personal-ui" } : {}),
      });
      const { taskId, crewmate, review } = await delegate.commission({
        title: params.title,
        intent,
        ...(params.repo_id ? { repoId: params.repo_id } : {}),
        ...(shape ? { shape } : {}),
        ...(startAfter ? { startAfter } : {}),
        ...(params.parent ? { parent: params.parent } : {}),
        ...(params.blocked_by && params.blocked_by.length > 0
          ? { blockedBy: params.blocked_by }
          : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
      });
      const queued = crewmate === "queued";
      const fromCard = params.from_card?.trim();
      const started = fromCard ? (delegate.startedFrom?.(fromCard, taskId, queued) ?? "") : "";
      const line = `${started}${repairsBatch ? await batchRepairLine(delegate, taskId) : ""}`;
      // A named model routes only when it can serve, so which model took
      // the task is told once it runs, never the named one on its own
      // (FI3-444).
      if (queued) {
        return {
          text: `Queued task ${taskId}; it starts when its wait ends and you will hear about it as [fm-op] messages.${shape?.override_model_id ? " Which model takes it is known only once it starts." : ""}${line}`,
        };
      }
      // Recorded, and starting behind this answer (INF-3060).
      return {
        text: `Recorded task ${taskId}; it is starting now, and its tile shows any wait, such as for room on its computer. You hear an [fm-op] if it cannot start or waits for something its tile does not name${shape?.override_model_id ? ", and which model took it once it runs" : ""}.${review ? reviewAssignedWords(review) : ""}${line}`,
      };
    },
  });

  const steer = boundTool({
    name: "steer_crewmate",
    label: "Steer crewmate",
    description:
      "Send guidance, feedback or a follow-up to a crewmate's running or idle task. " +
      "The result says when it queued for the next turn. " +
      "Messages expect a correlated response by default; guidance-only response_mode needs none. Responses wake you at once when submitted.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task id from context or spawn" }),
      message: Type.String({ description: "What the crewmate should know or do next" }),
      // Its default and guidance-only behavior are in the tool description.
      response_mode: Type.Optional(stringEnum(["expected", "guidance-only"])),
      response_context: Type.Optional(
        Type.Object(
          {
            card_id: Type.String(),
            captain_message_id: Type.Integer(),
          },
          {
            description:
              "Card and captain message this request concerns; omit otherwise. Routing context, never edit permission.",
          },
        ),
      ),
      cancel_response_requests: Type.Optional(
        Type.Array(Type.String(), {
          description: "Cancel these pending response requests; closing work does not cancel them.",
        }),
      ),
      // Its meaning rides the context block's computers rule (INF-992).
      files_from: Type.Optional(Type.String()),
    }),
    run: async (params) => {
      const response: import("@shared/crewResponses").AskedResponsePolicy = {
        mode: params.response_mode ?? "expected",
        ...(params.response_context
          ? {
              card: {
                id: params.response_context.card_id,
                messageId: params.response_context.captain_message_id,
              },
            }
          : {}),
        ...(params.cancel_response_requests ? { cancel: params.cancel_response_requests } : {}),
      };
      const from = params.files_from?.trim();
      if (from && delegate.steerAfterFiles) {
        await delegate.steerAfterFiles(from, params.task_id, params.message, response);
        return {
          text: `Task ${params.task_id} has your message, recorded; its crewmate reads it as soon as the files from ${from} are handed over, verified, once the task has started if it has not yet. You hear an [fm-op] only if the files do not arrive. Do not resend.`,
        };
      }
      const handed = from
        ? await (delegate.handFiles ?? missingHandFiles)(from, params.task_id)
        : undefined;
      const delivery = await delegate.steerCrewmate(
        params.task_id,
        handed ? `${params.message}\n\n${handed}` : params.message,
        response,
      );
      // A queued steer is reported as queued. The crewmate this task runs on
      // cannot take guidance mid-turn, so saying "steered" would tell the
      // user their correction had landed on work that never heard it.
      return {
        text:
          delivery === "queued-next-turn"
            ? `Task ${params.task_id} cannot take guidance mid-turn, so your message is queued and will be delivered as its next turn. It is not affecting the turn now running.`
            : delivery === "recorded-retrying"
              ? `Task ${params.task_id} did not accept the message just now, but it is durably recorded: delivery is retried automatically, and you will hear an [fm-op] if it keeps failing. Do not resend.`
              : delivery === "recorded-held"
                ? heldSteerText(params.task_id, delegate.laneHold?.(params.task_id))
                : delivery === "recorded-queued"
                  ? `Task ${params.task_id} has not started yet; your message is recorded and its crewmate reads it right after its brief once it starts. Do not resend.`
                  : delivery === "recorded-sending"
                    ? `Task ${params.task_id} has your message, recorded; it is being delivered now and is retried automatically if delivery fails. Do not resend.`
                    : delivery === "after-files"
                      ? `Task ${params.task_id} has your message, recorded; its crewmate reads it right after your earlier message with files, once those are handed over, in the order you sent them. Do not resend.`
                      : `Steered task ${params.task_id}.`,
      };
    },
  });

  const interrupt = boundTool({
    name: "interrupt_crewmate",
    label: "Interrupt crewmate",
    description:
      "Task lifecycle: 'interrupt' stops the current turn and ends kept merge approval; " +
      "the crewmate waits until steered. 'cancel' ends the task. " +
      "Never send lifecycle instructions as steer text.",
    parameters: Type.Object({
      task_id: Type.String(),
      mode: stringEnum(["interrupt", "cancel"]),
      closing_sentence: Type.Optional(
        Type.String({ description: "Required with cancel, as settle_task's." }),
      ),
    }),
    run: async (params) => {
      const sentence = params.closing_sentence?.trim();
      if (params.mode === "cancel" && !sentence) return { text: closingSentenceMissing("cancel") };
      await delegate.interruptCrewmate(
        params.task_id,
        params.mode,
        ...(params.mode === "cancel" && sentence ? [sentence] : []),
      );
      return {
        text:
          params.mode === "cancel"
            ? `Cancelled task ${params.task_id}.`
            : `Interrupted task ${params.task_id}; it remains steerable.`,
      };
    },
  });

  const settle = boundTool({
    name: "settle_task",
    label: "Settle task",
    description:
      "merge-pr rechecks and merges the task's current pull request, or closes it as merged " +
      "if already merged and no question or other pull request is open; on Bitbucket it only closes an already-merged one, and a new merge needs the merge card's approval, even with autonomy on. land merges locally, never for direct-PR. " +
      "discard removes unwanted work unmerged; never discard results. done closes it and names why: answered " +
      "(an answer reported or handed on), finished (verified work with nothing to merge), released (you independently " +
      "verified its delivery through an external release; evidence names it), carried_on (carried_by) or merged (delivered_in: any pull request in its project, or a commit on main). " +
      "Every close stops its crewmate and keeps its work. done leaves its pull request open and records it; " +
      "carried_on closes it. Closing on your own, done holds for open decisions, parts, waits and delivery proof: " +
      "a report, its pull request closed or merged, and its work merged or named elsewhere. " +
      "captain_words passes them all. Use crew_status to pick the task id; never guess among several matches.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task id from crew_status or spawn" }),
      mode: stringEnum(["merge-pr", "land", "discard", "done"]),
      why: Type.Optional(stringEnum([...DONE_WHYS])),
      carried_by: Type.Optional(
        Type.String({ description: "For carried_on: task (key or id) carrying its work" }),
      ),
      delivered_in: Type.Optional(
        Type.String({ description: "For merged: pull request number or commit id" }),
      ),
      evidence: Type.Optional(
        Type.String({ description: "For done: release or result; required for released" }),
      ),
      captain_words: Type.Optional(
        Type.String({
          description:
            "For done on the captain's own words asking it: turn, or the card id or crewmate-tab they came in",
        }),
      ),
      drop_waiting: Type.Optional(
        Type.Array(Type.Integer(), {
          description:
            "For done: refusal-named ids of messages the idle crewmate no longer needs; dropped once the close goes through",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "Discard unmerged or uncommitted work, after the captain chose",
        }),
      ),
      proceed_with_open: Type.Optional(
        Type.Boolean({
          description: "Settle and keep open children planned, after the captain chose",
        }),
      ),
      closing_sentence: Type.Optional(Type.String({ description: CLOSING_SENTENCE_DESCRIPTION })),
    }),
    run: async (params) => {
      const sentence = params.closing_sentence?.trim();
      if (params.mode === "done") {
        if (params.why !== "answered" && params.why !== "carried_on" && !sentence)
          return { text: closingSentenceMissing("done") };
        const { text, refusal } = await delegate.closeDone(params.task_id, {
          ...(params.why ? { why: params.why } : {}),
          ...(params.carried_by?.trim() ? { carriedBy: params.carried_by.trim() } : {}),
          ...(params.delivered_in?.trim() ? { deliveredIn: params.delivered_in.trim() } : {}),
          ...(params.evidence ? { evidence: params.evidence } : {}),
          ...(params.captain_words ? { captainWordsFrom: params.captain_words } : {}),
          ...(sentence ? { closingSentence: sentence } : {}),
          ...(params.drop_waiting?.length ? { dropWaiting: params.drop_waiting } : {}),
        });
        return { text, ...(refusal ? { details: { refusal } } : {}) };
      }
      if (!sentence) return { text: closingSentenceMissing(params.mode) };
      const { text, refusal } = await delegate.settleTask(
        params.task_id,
        params.mode,
        params.confirm,
        params.proceed_with_open,
        sentence,
      );
      return { text, ...(refusal ? { details: { refusal } } : {}) };
    },
  });

  const move = boundTool({
    name: "move_task",
    label: "Move task",
    description:
      "Moves started work to another work computer or this Mac at a safe pause: " +
      "its crewmate's turn and commands finish first. It keeps " +
      "its key, branch, uncommitted work, files and record, and continues in a new conversation " +
      "there on the same model. Only on the captain's ask, never to balance load. cancel stops a " +
      "move before crossing starts. Git-ignored files stay with the old copy unless keep names them. " +
      "Off a computer out of reach it refuses, saying what stays behind; leave_behind, only once " +
      "the captain heard that and said yes, continues from the commit the first mate's computer holds.",
    parameters: Type.Object({
      task_id: Type.String(),
      computer: Type.Optional(
        Type.String({ description: "The computer's name or deviceId from app_state, or this-mac" }),
      ),
      cancel: Type.Optional(Type.Boolean()),
      keep: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Ignored files or folders to move too, by working-copy path, as the captain or its crewmate named them",
        }),
      ),
      // The description above is the one home of its rule.
      leave_behind: Type.Optional(Type.Boolean()),
    }),
    run: async (params) => {
      if (!delegate.moveTask)
        return { text: "Moving a task to another computer is not available." };
      if (!params.cancel && !params.computer?.trim())
        return { text: "Name the computer to move it to, or pass cancel." };
      const done = await delegate.moveTask(
        params.task_id,
        params.cancel ? null : (params.computer ?? "").trim(),
        params.keep,
        // Only the captain's yes to what stays behind moves off a computer out of reach.
        ...(params.leave_behind === true ? [true] : []),
      );
      return { text: done.text };
    },
  });

  const status = createCrewStatusTool((taskId) => delegate.crewStatus(taskId));

  return [spawn, steer, interrupt, settle, move, status];
}

/** The crew_status query tool, shared with the supervision session. */
export function createCrewStatusTool(crewStatus: (taskId?: string) => CrewStatusEntry[]) {
  return boundTool({
    name: "crew_status",
    label: "Crew status",
    description:
      "Fresh structured state of the crew - one task or all. Check here before steering " +
      "or re-escalating.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "One task id; omit for the whole crew" })),
    }),
    run: async (params) => {
      const entries = crewStatus(params.task_id);
      const shown = entries.map(({ times: _times, ...entry }) => entry);
      return { text: shown.length > 0 ? JSON.stringify(shown, null, 2) : "No crew right now." };
    },
  });
}

/**
 * The work-shape facts off the spawn's shape group (contract v2.8). Absent
 * fields are absent, not defaults: the host reads "no basis" and "no
 * premium ask" as exactly that, and undefined shape means the Firstmate
 * supplied nothing at all.
 */
function shapeAskFrom(params: {
  ongoing?: boolean;
  intelligence?: WorkShapeAsk["intelligence"];
  kind?: Exclude<WorkKind, "review">;
  basis?: string;
  premium_ask?: boolean;
  override_model_id?: string;
  override_speed?: import("@shared/crewSpeed").CrewSpeed;
  override_reasoning?: ReasoningChoice;
  escalate_from?: string;
  rigor_ask?: Rigor;
  delivery_ask?: RepoDelivery;
  autonomy_ask?: boolean;
  runs_on_ask?: string;
  placement_requirements?: PlacementRequirements;
  internal_step?: boolean;
  in_folder?: boolean;
  review_of?: string;
  skipped_plan_because?: string;
  result_schema?: Record<string, unknown>;
  branch_from?: string;
  branch?: string;
}): WorkShapeAsk | undefined {
  const basis = params.basis?.trim();
  const override = params.override_model_id?.trim();
  const escalateFrom = params.escalate_from?.trim();
  const reviewOf = params.review_of?.trim();
  // At the start, following the project is the same as saying nothing.
  const runsOn = params.runs_on_ask?.trim().replace(/^project$/, "");
  const ask: WorkShapeAsk = {
    ...(params.ongoing !== undefined ? { ongoing: params.ongoing } : {}),
    ...(params.intelligence ? { intelligence: params.intelligence } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
    ...(basis ? { basis } : {}),
    ...(params.premium_ask ? { premium_ask: true as const } : {}),
    ...(override ? { override_model_id: override } : {}),
    ...(params.override_speed ? { override_speed: params.override_speed } : {}),
    ...(params.override_reasoning ? { override_reasoning: params.override_reasoning } : {}),
    ...(escalateFrom ? { escalate_from: escalateFrom } : {}),
    ...(params.rigor_ask ? { rigor_ask: params.rigor_ask } : {}),
    ...(params.delivery_ask ? { delivery_ask: params.delivery_ask } : {}),
    // Read by presence, never truthiness: `false` is the captain asking to
    // be asked, which is the whole point of the field on an autonomous repo.
    ...(params.autonomy_ask !== undefined ? { autonomy_ask: params.autonomy_ask } : {}),
    ...(runsOn ? { runs_on_ask: runsOn } : {}),
    ...(params.placement_requirements
      ? { placement_requirements: params.placement_requirements }
      : {}),
    ...(params.internal_step ? { internal_step: true } : {}),
    ...(params.in_folder ? { in_folder: true } : {}),
    ...(reviewOf ? { review_of: reviewOf } : {}),
    ...(params.skipped_plan_because?.trim()
      ? { skipped_plan_because: params.skipped_plan_because.trim() }
      : {}),
    ...(params.result_schema ? { result_schema: params.result_schema } : {}),
    ...(params.branch_from?.trim() ? { branch_from: params.branch_from.trim() } : {}),
    ...(params.branch?.trim() ? { branch: params.branch.trim() } : {}),
  };
  return Object.keys(ask).length > 0 ? ask : undefined;
}

/** What a spawn marked `repairs_batch` answers of its mark: recorded, or why not. */
async function batchRepairLine(delegate: CrewDelegate, taskId: string): Promise<string> {
  const refused = delegate.markBatchRepair
    ? await delegate.markBatchRepair(taskId)
    : "this app records no batch repair here.";
  return refused
    ? ` Not recorded as a batch repair: ${refused}`
    : " It is recorded as the repair of its project's held batch.";
}

/** Translate the spawn's start_after group into one gate; at most one may be set. */
function startAfterFrom(params: {
  after_task?: string;
  when_quota_resets?: string;
  at_time?: string;
}): { afterTask?: string; whenQuotaResets?: string; at?: number } | undefined {
  const set = [params.after_task, params.when_quota_resets, params.at_time].filter(
    (value) => value !== undefined,
  );
  if (set.length === 0) return undefined;
  if (set.length > 1) {
    throw new Error("Pass at most one of after_task, when_quota_resets, at_time.");
  }
  if (params.after_task) return { afterTask: params.after_task };
  if (params.when_quota_resets) return { whenQuotaResets: params.when_quota_resets };
  const at = Date.parse(params.at_time ?? "");
  if (Number.isNaN(at)) {
    throw new Error(`at_time "${params.at_time}" is not a valid ISO 8601 date-time.`);
  }
  return { at };
}
