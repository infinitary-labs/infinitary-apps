import { type ReasoningChoice, reasoningChoiceSchema } from "@shared/modelSlots";
import type { PlacementRequirements } from "@shared/placement";
import type { RepoDelivery } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import type { WorkShapeAsk } from "@shared/routingPolicy";
import { Type } from "typebox";
import type { CiReadingFact } from "../orchestrator/ciFact";
import type { SteerDelivery } from "../orchestrator/crewSupervisor";
import { crewHoldWays, type HoldRefusal, renderHold } from "../orchestrator/holds";
import { parseSpawnIntent, type SpawnIntent } from "../orchestrator/intentBrief";
import { type NamedModel, namedModelWords } from "../orchestrator/namedModel";
import { boundTool, stringEnum } from "../session/tools";
import type { CardRefusalReason } from "../storage/taskStore";
import type { SettleRefusal } from "../tasks/taskService";

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
 * small handle (task id + crewmate name) as soon as the session starts;
 * results arrive later as [fm-op] inbox messages, never as the tool result.
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
  lastReport?: string;
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
   * Where the independent review stands, on a reviewed task or a review
   * task: `awaiting review`, `review open (<key>)`, `review: findings`,
   * `review passed`, or `reviews <key>` on the reviewer's own row.
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
   * The host's refusal of this task's completion card, standing until one
   * goes up (FI3-401): the card's title, when (ISO 8601), the typed reason
   * and the host's words for it. A report saying the card went up is wrong
   * while this is here.
   */
  cardRefused?: { title: string; at: string; reason: CardRefusalReason; why: string };
};

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
    crewmate: string;
    /** The model the user named beside the one that took the task (FI3-444). */
    model?: NamedModel;
  }>;
  steerCrewmate(taskId: string, message: string): Promise<SteerDelivery>;
  interruptCrewmate(taskId: string, mode: "interrupt" | "cancel"): Promise<void>;
  crewStatus(taskId?: string): CrewStatusEntry[];
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
    mode: "merge-pr" | "land" | "discard" | "answered" | "released",
    confirm?: boolean,
    proceedWithOpen?: boolean,
    releaseEvidence?: string,
  ): Promise<{ text: string; refusal?: SettleRefusal }>;
};

/** What `internal_step` means, shared by spawn_crewmate and create_task. */
export const INTERNAL_STEP_DESCRIPTION =
  'True when you add this task yourself as an internal step of a sequence you run: its answer goes to the next step, and once that step has started you close it with settle_task answered. Omit it when the captain asked for this result himself ("show me the repro first"): that stays his to close.';

/**
 * What `basis` means, shared by spawn_crewmate and create_task: a planned
 * step names its basis the same way a spawn does, and the host verifies it
 * when the step dispatches.
 */
export const BASIS_DESCRIPTION =
  "The task (id or key) whose report is this work's spec, or whose reproduction it fixes. Name it only when that task really carries it - the host checks, and ignores an unverified basis.";

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
export const CONSTRAINTS_DESCRIPTION = groupDescription(
  "Typed constraint flags plus free strings.",
  {
    kind: "read-only: the task answers a question and ships nothing - no commit, push or pull request; free: anything else, relayed verbatim",
    text: "Required when kind is free; optional qualifier otherwise",
  },
);

export const CONSTRAINTS_PARAM = Type.Optional(
  Type.Array(
    Type.Object({
      kind: stringEnum(["read-only", "tests-required", "no-new-deps", "minimal-diff", "free"]),
      text: Type.Optional(Type.String()),
    }),
    { description: CONSTRAINTS_DESCRIPTION },
  ),
);

export const DELIVERY_NOTE_PARAM = Type.Optional(
  Type.String({
    description:
      'A delivery expectation refining the repository posture, e.g. "stack on top of PR 41". A posture override is delivery_ask, not this.',
  }),
);

/**
 * What each work-shape fact in spawn_crewmate's `shape` group means. The
 * rules ride the group's own description, never the fields' (contract
 * v4.13): a Claude seat's client drops every description below a top-level
 * parameter, and a Pi seat reads the same words in the same place.
 */
const SHAPE_FIELD_RULES = {
  delivery_ask:
    "Only when the user asked in words for this task to ship as a pull request or to stay local. The repository's default is unchanged.",
  basis: BASIS_DESCRIPTION,
  premium_ask:
    'True only when the user asked for premium or the best model in words, or clicked your "Try a premium model" action. Never your own judgment.',
  override_speed: "As update_task.crew_speed.",
  override_reasoning: "As update_task.reasoning.",
  override_model_id:
    "The model the user named: an exact model id (e.g. gpt-6-astra), or a provider-qualified key (e.g. anthropic-claude/claude-fable-5-1) when the provider matters. Only when the user named one; it wins when available, else normal routing.",
  escalate_from:
    "The task (id or key) whose result the user rejected: only under the escalation rule. The host stops that attempt, keeps its branch and report, and runs this one a tier up. Pass the user's words verbatim as user_words and the original goal.",
  rigor_ask: "Only when the user said in words how careful to be.",
  autonomy_ask:
    "Only when the user said in words whether this task merges its green work itself (true) or asks first (false). The repository's default is unchanged.",
  runs_on_ask: "As update_task's runs_on.",
  internal_step: INTERNAL_STEP_DESCRIPTION,
  skipped_plan_because:
    "On a direct build with no chosen basis, which parts of the sequences test passed: one nameable place, no changed rule, state or meaning, and a result checkable by looking. The host records and shows it, and does not judge it.",
  review_of:
    "The task whose committed work an independent reviewer checks, read-only; pass the user's original words as user_words and the same repo_id.",
} as const satisfies Record<keyof typeof SHAPE_FIELDS, string>;

/** What each wait in spawn_crewmate's `start_after` group means, on the group (v4.13). */
const START_AFTER_FIELD_RULES = {
  after_task:
    "the named task (a task id from crew_status) finishes; the same as one blocked_by entry",
  when_quota_resets:
    "quota returns for a scope: a provider name from the quota line, or bucket:premium / bucket:high / bucket:medium / bucket:low",
  at_time: "an ISO 8601 date-time",
} as const satisfies Record<keyof typeof START_AFTER_FIELDS, string>;

/** What spawn_crewmate's `shape` group holds (contract v4.12, primitives P7; its fields' rules since v4.13). */
export const SHAPE_GROUP_DESCRIPTION = groupDescription(
  "The facts the host routes and ships this work by. Set each only as its rule says and omit the rest.",
  SHAPE_FIELD_RULES,
);

/** What spawn_crewmate's `start_after` group holds (contract v4.12, primitives P7; its fields' rules since v4.13). */
export const START_AFTER_GROUP_DESCRIPTION = groupDescription(
  "Queue this work instead of starting it now, until one of these; omit the group to start now.",
  START_AFTER_FIELD_RULES,
);

/** The work-shape facts spawn_crewmate carries in `shape`, with the type each holds. */
const SHAPE_FIELDS = {
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
  skipped_plan_because: "string",
  review_of: "string",
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
export const NOTHING_SPAWNED = "Nothing was spawned.";

/** What steer_crewmate answers for guidance a held lane keeps until its account answers. */
export function heldSteerText(taskId: string): string {
  return `Task ${taskId}'s account is not answering right now, so your message is kept and goes out when it answers again; you will hear when it does. Do not resend.`;
}

export function createCrewTools(delegate: CrewDelegate) {
  const spawn = boundTool({
    name: "spawn_crewmate",
    label: "Spawn crewmate",
    description: [
      "Commission a crewmate for project work or an evidence-gathering investigation.",
      "Pass a structured intent - a one-sentence goal, the user's words verbatim, typed",
      "constraints, and an optional delivery note - and the crewmate briefs itself from it",
      "on its first turn. Do not author a brief.",
      "Pass repo_id to bind a managed repository; omit it for repo-less work (the default",
      "workspace). Lessons and the user's own panels on the rails use personal_ui true: the",
      "host binds the personal workspace itself (no repo_id) and the crewmate builds in place,",
      "so name an existing surface's id in the goal for a change.",
      "Never ask a crewmate to run security, codesign or any Keychain command against the real",
      "keychains, ~/.infinitary/local-codesign or ~/.firstmate-3000/local-codesign, or to put a secret in a command line;",
      "keychain or signing behavior is reproduced only under a scratch HOME with",
      "INFINITARY_LOCAL_CODESIGN_DIR. Returns the task id immediately;",
      "the crewmate's results arrive later as [fm-op] messages, so end your turn.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({ description: "As create_task's title." }),
      goal: Type.String({
        description: "One sentence: what done looks like, in plain language",
      }),
      user_words: Type.String({
        description: "The user's request verbatim; outranks every elaboration downstream",
      }),
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
          description:
            "The task this work belongs under (a task id or key); it inherits that task's project",
        }),
      ),
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Tasks (ids or keys) that must close before this work starts; queues it instead of starting now",
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 3,
          description: "0 urgent, 1 high, 2 normal (default), 3 low",
        }),
      ),
      shape: Type.Optional(
        Type.Object(
          {
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
            skipped_plan_because: Type.Optional(Type.String()),
            review_of: Type.Optional(Type.String()),
          },
          { description: SHAPE_GROUP_DESCRIPTION },
        ),
      ),
      placement_requirements: Type.Optional({
        ...PLACEMENT_REQUIREMENTS_PARAM,
        description: "As create_task's placement_requirements.",
      }),
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
      const shape = shapeAskFrom({
        ...shapeParams,
        ...(params.placement_requirements
          ? { placement_requirements: params.placement_requirements }
          : {}),
      });
      const intent = parseSpawnIntent({
        goal: params.goal,
        user_words: params.user_words,
        ...(params.constraints ? { constraints: params.constraints } : {}),
        ...(params.delivery_note !== undefined ? { delivery_note: params.delivery_note } : {}),
        ...(params.personal_ui ? { kind: "personal-ui" } : {}),
      });
      const { taskId, crewmate, model } = await delegate.commission({
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
      // A named model routes only when it can serve, so the answer says
      // which model took the task, never the named one on its own (FI3-444).
      if (crewmate === "queued") {
        return {
          text: `Queued task ${taskId}; it starts when its wait ends and you will hear about it as [fm-op] messages.${shape?.override_model_id ? " Which model takes it is known only once it starts." : ""}`,
        };
      }
      return {
        text: `Commissioned ${crewmate} on task ${taskId}${model ? `; it runs ${namedModelWords(model)}` : ""}.`,
      };
    },
  });

  const steer = boundTool({
    name: "steer_crewmate",
    label: "Steer crewmate",
    description:
      "Send guidance, feedback, or a follow-up to a crewmate's running or idle task. " +
      "The data plane only - use interrupt_crewmate for lifecycle control. Some " +
      "crewmates cannot take guidance mid-turn; the result says so when the message " +
      "was queued for their next turn instead.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task id from the context block or spawn" }),
      message: Type.String({ description: "What the crewmate should know or do next" }),
    }),
    run: async (params) => {
      const delivery = await delegate.steerCrewmate(params.task_id, params.message);
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
                ? heldSteerText(params.task_id)
                : delivery === "recorded-queued"
                  ? `Task ${params.task_id}'s latest update is being handled right now, so your message is durably queued and will be delivered right after, in order. Do not resend.`
                  : `Steered task ${params.task_id}.`,
      };
    },
  });

  const interrupt = boundTool({
    name: "interrupt_crewmate",
    label: "Interrupt crewmate",
    description:
      "Lifecycle control for a task. mode 'interrupt' stops the current turn but keeps " +
      "the crewmate steerable; mode 'cancel' ends the task. Never send lifecycle " +
      "instructions as steer text.",
    parameters: Type.Object({
      task_id: Type.String(),
      mode: stringEnum(["interrupt", "cancel"]),
    }),
    run: async (params) => {
      await delegate.interruptCrewmate(params.task_id, params.mode);
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
      "Merge a pull request, merge a local branch, or discard a task. merge-pr rechecks the checks and merges the " +
      "pull request where the project lives (on GitHub; a fast-forward of the default branch " +
      "on a plain Git host), then closes the task and removes its worktree. land merges the " +
      "local branch into the local checkout, then closes the task and removes its worktree; " +
      "never use land for direct-PR delivery. discard removes the worktree without merging and " +
      "closes the task as discarded; unmerged or uncommitted work refuses until you pass " +
      "confirm true after the captain chooses. answered closes an idle answer task you opened " +
      "as an internal_step once a planned or started task names it as its basis or waits on it " +
      "through a blocks link (the close clears that wait), or an answer task whose crewmate " +
      "reported it finished; it is refused on anything else, while the crewmate works, while " +
      "its answer card waits on the captain, and when nothing builds on or waits on a step. " +
      "released closes a reported, idle work task only after you independently verify its " +
      "delivery through an external release process; pass release_evidence naming the " +
      "release and what proves delivery. It refuses a task-owned pull request and any unmerged " +
      "commits or edits; a missing change or dismissed note alone is never proof. Closing the " +
      "captain's settle card keeps an idle task resumable. A close refused for open children " +
      "returns its ways out in the tool result; pass proceed_with_open true to settle and keep " +
      "them planned. The task record and its session stay on file in every case. Use " +
      "crew_status to pick the task id; never guess among several matches.",
    parameters: Type.Object({
      task_id: Type.String({ description: "The task id from crew_status or spawn" }),
      mode: stringEnum(["merge-pr", "land", "discard", "answered", "released"]),
      release_evidence: Type.Optional(
        Type.String({ description: "For released: the release and what proves delivery" }),
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
    }),
    run: async (params) => {
      const { text, refusal } = await delegate.settleTask(
        params.task_id,
        params.mode,
        params.confirm,
        params.proceed_with_open,
        params.release_evidence,
      );
      return { text, ...(refusal ? { details: { refusal } } : {}) };
    },
  });

  const status = createCrewStatusTool((taskId) => delegate.crewStatus(taskId));

  return [spawn, steer, interrupt, settle, status];
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
      return { text: entries.length > 0 ? JSON.stringify(entries, null, 2) : "No crew right now." };
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
  review_of?: string;
  skipped_plan_because?: string;
}): WorkShapeAsk | undefined {
  const basis = params.basis?.trim();
  const override = params.override_model_id?.trim();
  const escalateFrom = params.escalate_from?.trim();
  const reviewOf = params.review_of?.trim();
  // At the start, following the project is the same as saying nothing.
  const runsOn = params.runs_on_ask?.trim().replace(/^project$/, "");
  const ask: WorkShapeAsk = {
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
    ...(reviewOf ? { review_of: reviewOf } : {}),
    ...(params.skipped_plan_because?.trim()
      ? { skipped_plan_because: params.skipped_plan_because.trim() }
      : {}),
  };
  return Object.keys(ask).length > 0 ? ask : undefined;
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
