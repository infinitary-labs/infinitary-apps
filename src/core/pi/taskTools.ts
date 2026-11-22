import { randomUUID } from "node:crypto";
import type { CostLimit } from "@shared/costLimit";
import { HOME } from "@shared/deviceNames";
import { HOLD_KINDS, isOverridable, type OverridableHold, overrideRefusal } from "@shared/holds";
import { type ReasoningChoice, reasoningChoiceSchema } from "@shared/modelSlots";
import type { PlacementRequirements } from "@shared/placement";
import type { RequiredActionRevisionInput } from "@shared/requiredActions";
import { CLASSIFIABLE_KINDS, type WorkShapeAsk } from "@shared/routingPolicy";
import type { TaskPolicyEdits } from "@shared/taskPolicies";
import { type Static, Type } from "typebox";
import { parseSpawnIntent, type SpawnIntent } from "../orchestrator/intentBrief";
import { ANSWER_WHOLE_MAX_CHARACTERS } from "../session/answerFiles";
import {
  bindTool,
  boundTool,
  type CrewmateToolDelegate,
  callWithSignal,
  crewmateTool,
  stringEnum,
} from "../session/tools";
import type { TaskLinkType } from "../storage/taskLinkStore";
import type { TaskStartPolicy, TaskStatus } from "../storage/taskRecords";
import type { TaskQueryInput, TaskQueryProject, TaskQueryRow } from "../tasks/taskQuery";
import { CONSTRAINTS_PARAM, PLACEMENT_REQUIREMENTS_PARAM, RESULT_SCHEMA_PARAM } from "./crewTools";

/**
 * The Firstmate agent's graph tools (task-system P2, design section 7):
 * create_task records work on request by default, update_task edits, moves,
 * re-parents or drops a record, link_tasks records typed edges, and
 * `tasks` is the query side of the record. Every refusal a graph rule
 * makes - a cycle, a parent with open children, a move a workspace
 * forbids - returns as result text so the agent reads it in conversation;
 * an unknown id or malformed input throws, the loud tool error.
 */

export type TaskToolsDelegate = {
  plan(input: {
    title: string;
    intent: SpawnIntent;
    repoId?: string;
    parent?: string;
    blockedBy?: string[];
    startPolicy?: TaskStartPolicy;
    priority?: number;
    /** The basis the step names; the host verifies it when the step dispatches. */
    shape?: WorkShapeAsk;
    /** The captain asked for it to wait, as when they chose to file it for later (INF-4165 finding 3). */
    captainStop?: boolean;
  }): { taskId: string; key: string; text: string };
  update(input: {
    task: string;
    correctRequiredAction?: boolean;
    policies?: TaskPolicyEdits;
    /** The standing direction's id behind the model, runs_on and policy edits. */
    direction?: string;
    title?: string;
    goal?: string;
    priority?: number;
    /** A task ref, or the empty string to clear the parent. */
    parent?: string;
    project?: string;
    /** With project: the repository it moves into, when the project holds several. */
    repository?: string;
    startPolicy?: TaskStartPolicy;
    /** Why started work goes back to the backlog (start_policy on-request, INF-2062). */
    reason?: string;
    /** The captain asked for it to wait (INF-3846 piece 2): it counts as stopped by them. */
    captainStop?: boolean;
    /** Prerequisites to add. Already-linked ones stay; none are removed. */
    declaredBlockers?: string[];
    verdict?: string | null;
    basis?: string;
    /** The result shape its report must carry (INF-799); null clears it. */
    resultSchema?: Record<string, unknown> | null;
    /** The task whose last commit it starts at (INF-799); empty clears it. */
    branchFrom?: string;
    /** The branch name the first mate wrote, before it starts; empty clears it. */
    branch?: string;
    /** The blocked_by task whose approved merge starts it, before it starts; empty clears it. */
    startAtApproval?: string;
    /** The blocked_by tasks whose merge it needs, before it starts; empty clears it. */
    needsMerge?: string[];
    /** Whether the work is the first mate's own, not the captain's ask (INF-1467). */
    internalStep?: boolean;
    /** A program's new bound on its task() calls (INF-799), on the captain's words. */
    programBound?: number;
    /** The model the user named (override_model_id); empty clears it. */
    model?: string;
    /** The answer to a task stuck at its provider: a fresh conversation, or the app's pick of another model. */
    unstick?: "restart" | "move";
    speed?: import("@shared/crewSpeed").CrewSpeed | null;
    /** The reasoning effort the user named (override_reasoning); null inherits Models. */
    reasoning?: ReasoningChoice | null;
    /** Where the captain said it runs: a device id or `this-mac`; null follows its parent's or project's again. */
    runsOn?: string | null;
    placementRequirements?: PlacementRequirements | null;
  }): { text: string; ok: boolean } | Promise<{ text: string; ok: boolean }>;
  drop(input: { task: string; reason: string; confirm?: boolean; replacedBy?: string }): string;
  /** Withdraw the captain's kept merge approval on his words; the work stays (FI3-304). */
  withdrawMerge(input: { task: string }): string;
  /** Raise the task's put-off cards now, on the captain's words (INF-3846 piece 3). */
  raisePutOff?(input: { task: string }): string;
  /**
   * Hold a started, idle task until a time, sooner on an event when one is
   * named, or lift the hold with null (INF-5145).
   */
  hold?(input: {
    task: string;
    hold: {
      until: number;
      reason: string;
      onEvent?: { integration: string; event: string; filter?: Record<string, string> };
      onUpdate?: { version?: string };
    } | null;
  }): Promise<string>;
  /** Pin a task to the top of Tasks, or unpin it, on the captain's words (INF-3127). */
  pin(input: { task: string; pinned: boolean }): string;
  /** Correct a required action's words, keeping its filing (docs/required-actions.md). */
  reviseRequiredAction?(input: RequiredActionRevisionInput): string;
  /**
   * Record the captain's override (docs/delivery-rigor.md, "The holds"):
   * his words from this turn, or from the message `from` cites - his reply
   * under a card of the task, or his line in its Crewmate tab - which the
   * host keeps; refused without them, and in a scheduled check.
   */
  override(input: {
    task: string;
    holds: OverridableHold[];
    until: "version" | "task";
    from?: string;
  }): string;
  /** He takes his override back. */
  withdrawOverride(input: { task: string }): string;
  /** The captain takes back a yes the app recorded from their click on a card (INF-3170 piece 2). */
  withdrawAllowance(input: { task: string; card: string }): string;
  /**
   * Set a task's own cost limit on the captain's words (docs/usage.md, "The
   * cost limit"): an amount in estimated dollars, none, or null to follow
   * its project's or the app's again.
   */
  costLimit?(input: { task: string; limit: CostLimit | null }): string;
  /** A queued row starts now, past any reasoning re-ask (P0, WI-3). Refusals are text. */
  startNow(input: { task: string }): Promise<string>;
  startAgain(input: { task: string }): Promise<string>;
  link(input: { from: string; to: string; type: TaskLinkType; remove?: boolean }): string;
  /** One card as it stands, before a revision or an answer on it (docs/card-threads.md). */
  readCard?(cardId: string): string;
  query(input: TaskQueryInput):
    | {
        rows: TaskQueryRow[];
        total: number;
        projects?: TaskQueryProject[];
      }
    | Promise<{ rows: TaskQueryRow[]; total: number; projects?: TaskQueryProject[] }>;
};

const PRIORITY = Type.Optional(
  Type.Integer({
    minimum: 0,
    maximum: 3,
    description: "0 urgent, 1 high, 2 normal (default), 3 low",
  }),
);

const START_POLICY_VALUES = ["when-ready", "on-request"] as const;

const START_POLICY = stringEnum(START_POLICY_VALUES, {
  description:
    "when-ready starts when blocks/holds clear. on-request (the default): no crewmate starts on it until update_task start_now. Leave a parent on request: its children do its work. For captain-requested waits (e.g. file for later), captain_stop true silences alarms until start.",
});

function undeclaredPrerequisites(verb: "filed" | "changed") {
  return {
    text: `Nothing was ${verb}. Follow HANDOFF. Queued work must declare blocked_by in this call, as create_task's blocked_by says.`,
    details: { refusal: { kind: "undeclared-prerequisites" } },
  };
}

export function createTaskTools(delegate: TaskToolsDelegate) {
  const create = boundTool({
    name: "create_task",
    label: "Create task",
    description: [
      "File, add, note or backlog without starting, including saved plans, waits and containers.",
      "when-ready can start now; declare blocked_by. Basis checked at start.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({
        description:
          'Sentence-case title saying what it does (max 64 chars), e.g. "Ship the bridge to alpha", not its place in a plan',
      }),
      goal: Type.String({ description: "As spawn_crewmate's goal." }),
      user_words: Type.Optional(Type.String({ description: "As spawn_crewmate's user_words." })),
      constraints: Type.Optional({
        ...CONSTRAINTS_PARAM,
        description: "As spawn_crewmate's constraints.",
      }),
      delivery_note: Type.Optional(
        Type.String({ description: "As spawn_crewmate's delivery_note." }),
      ),
      repo_id: Type.Optional(
        Type.String({
          description: "Registered repo id from context; omitted child inherits parent's",
        }),
      ),
      parent: Type.Optional(Type.String({ description: "Parent task (id or key)" })),
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description: "Prerequisite ids/keys. Required for when-ready; [] declares none.",
        }),
      ),
      start_policy: Type.Optional(START_POLICY),
      // What it records is said on start_policy, so it is served bare.
      captain_stop: Type.Optional(Type.Boolean()),
      priority: PRIORITY,
      ongoing: Type.Optional(Type.Boolean({ description: "As spawn_crewmate shape.ongoing." })),
      intelligence: Type.Optional(stringEnum(["low", "medium", "high", "premium"])),
      kind: Type.Optional(stringEnum([...CLASSIFIABLE_KINDS, "unclear"])),
      basis: Type.Optional(Type.String({ description: "As spawn_crewmate's shape.basis." })),
      placement_requirements: Type.Optional({
        ...PLACEMENT_REQUIREMENTS_PARAM,
        description:
          "Declare systems, chips, exact programs and admission profile. Omitted platforms inherit home. Never infer portability or tools from keywords or relax project requirements.",
      }),
      internal_step: Type.Optional(
        Type.Boolean({
          description: "As spawn_crewmate's shape.internal_step.",
        }),
      ),
      // Their rule is said once, in the served sequences guide (INF-799).
      result_schema: Type.Optional(RESULT_SCHEMA_PARAM),
      branch_from: Type.Optional(Type.String()),
      start_at_approval: Type.Optional(
        Type.String({
          description:
            "The blocked_by task whose approved merge version starts this task, when several could.",
        }),
      ),
      needs_merge: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "On batched pull requests each blocked_by starts this task at its approval. List those it needs merged, not only their code, such as for a release.",
        }),
      ),
      branch: Type.Optional(Type.String({ description: "As spawn_crewmate's branch." })),
    }),
    run: async (params) => {
      // Automatic creation must not turn an undeclared graph into independent work (INF-143).
      if (params.start_policy === "when-ready" && params.blocked_by === undefined)
        return undeclaredPrerequisites("filed");
      const basis = params.basis?.trim();
      const shape = {
        ...(params.placement_requirements
          ? { placement_requirements: params.placement_requirements }
          : {}),
        ...(basis ? { basis } : {}),
        ...(params.ongoing !== undefined ? { ongoing: params.ongoing } : {}),
        ...(params.intelligence ? { intelligence: params.intelligence } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.internal_step ? { internal_step: true } : {}),
        ...(params.result_schema
          ? { result_schema: params.result_schema as Record<string, unknown> }
          : {}),
        ...(params.branch_from?.trim() ? { branch_from: params.branch_from.trim() } : {}),
        ...(params.start_at_approval?.trim()
          ? { start_at_approval: params.start_at_approval.trim() }
          : {}),
        ...(params.needs_merge?.length ? { needs_merge: params.needs_merge } : {}),
        ...(params.branch?.trim() ? { branch: params.branch.trim() } : {}),
      };
      const intent = parseSpawnIntent({
        goal: params.goal,
        ...(params.user_words !== undefined ? { user_words: params.user_words } : {}),
        ...(params.constraints ? { constraints: params.constraints } : {}),
        ...(params.delivery_note !== undefined ? { delivery_note: params.delivery_note } : {}),
      });
      const planned = delegate.plan({
        title: params.title,
        intent,
        ...(params.repo_id ? { repoId: params.repo_id } : {}),
        ...(params.parent ? { parent: params.parent } : {}),
        ...(params.blocked_by ? { blockedBy: params.blocked_by } : {}),
        ...(params.start_policy ? { startPolicy: params.start_policy } : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
        ...(Object.keys(shape).length > 0 ? { shape } : {}),
        ...(params.captain_stop ? { captainStop: true } : {}),
      });
      return { text: planned.text };
    },
  });

  const update = boundTool({
    name: "update_task",
    label: "Update task",
    description: [
      "Edit tasks; only unstarted open work can change project.",
      "Only captain-requested start_again replaces dropped work, keeping saved work/waits and returning a new key. Routes afresh, not escalation.",
      "Drop with drop true and reason; confirm true also supersedes open children. Use replaced_by for replacement, settle_task for started work.",
      "start_now applies edits first, stops on refusals, and starts queued work on an available model despite allowance waits.",
      "When the user names a model, pass override_model_id (start_now starts it): it keeps its key and links; never drop it to spawn a replacement.",
      "Explicit captain requests alone authorize delivery/autonomy/rigor edits; don't re-ask. Project resets overrides, omission keeps them. Policy edits never start/restart work.",
      "Local Careful = Default; keep request. No silent PR close or fallback without access. Ask only unclear task/scope/consent; refusals name blockers.",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ description: "The task id or key" }),
      title: Type.Optional(Type.String({ description: "As create_task's title." })),
      goal: Type.Optional(Type.String({ description: "New goal, one sentence" })),
      priority: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 3, description: "As create_task's priority." }),
      ),
      // What each policy means is said once, on create_task's start_policy.
      start_policy: Type.Optional(
        stringEnum(START_POLICY_VALUES, {
          description:
            "As create_task's start_policy. on-request parks started work: stops the turn, keeps work; only start_now wakes it. News notifies you once. Give a reason for a captain-requested pause or a stall wake’s blocker no steer can change.",
        }),
      ),
      // What it records is said on start_policy, so it is served bare.
      captain_stop: Type.Optional(Type.Boolean()),
      // What [] declares is said once, on create_task's blocked_by.
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "As create_task's blocked_by, required for when-ready. Adds any not yet linked; never removes.",
        }),
      ),
      parent: Type.Optional(Type.String({ description: "Parent id/key; empty clears" })),
      project: Type.Optional(
        Type.String({
          description: "Destination project key: backlog, or tasks with projects",
        }),
      ),
      repository: Type.Optional(
        Type.String({
          description: "With project: repository name if several",
        }),
      ),
      basis: Type.Optional(
        Type.String({
          description: "Set plan/spec task (key or id) on unstarted open work; empty clears it.",
        }),
      ),
      internal_step: Type.Optional(
        Type.Boolean({
          description:
            "As spawn_crewmate's shape.internal_step, on open work before start (e.g. unasked filing).",
        }),
      ),
      result_schema: Type.Optional(RESULT_SCHEMA_PARAM),
      branch_from: Type.Optional(Type.String()),
      branch: Type.Optional(
        Type.String({
          description: "As spawn_crewmate's branch, pre-start; empty clears.",
        }),
      ),
      start_at_approval: Type.Optional(
        Type.String({
          description: "As create_task's start_at_approval, before start; empty clears it.",
        }),
      ),
      needs_merge: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "As create_task's needs_merge, before start; replaces the list, empty clears.",
        }),
      ),
      program_bound: Type.Optional(Type.Integer()),
      crew_speed: Type.Optional(
        Type.Union([stringEnum(["standard", "fast", "ultrafast"]), Type.Null()], {
          description:
            "Captain-only crew/summary speed next request; null inherits Models. First mate/Decisions stay Standard. Ultrafast: 8× allowance/6× credits.",
        }),
      ),
      override_model_id: Type.Optional(
        Type.String({
          description:
            "As spawn_crewmate.shape.override_model_id. Routes at start, moves started work between turns; empty clears.",
        }),
      ),
      unstick: Type.Optional(
        stringEnum(["restart", "move"], {
          description:
            "Provider-stuck tasks only: restart continues in a fresh conversation; move takes the app's pick on another provider.",
        }),
      ),
      reasoning: Type.Optional(
        Type.Union([stringEnum(reasoningChoiceSchema.options), Type.Null()], {
          description: "Captain-named starting effort for open work; null inherits Models.",
        }),
      ),
      delivery: Type.Optional(
        stringEnum(["direct-pr", "local-only", "project"], {
          description: "The captain's requested delivery",
        }),
      ),
      autonomy: Type.Optional(
        stringEnum(["on", "off", "project"], {
          description: "on: the captain permits self-merging; off: asks first",
        }),
      ),
      rigor: Type.Optional(
        stringEnum(["quick", "standard", "reviewed", "project"], {
          description: "The captain's requested care",
        }),
      ),
      placement_requirements: Type.Optional(
        Type.Union([PLACEMENT_REQUIREMENTS_PARAM, Type.Null()], {
          description: "As create_task's placement_requirements; null resets.",
        }),
      ),
      runs_on: Type.Optional(
        Type.String({
          description:
            "Before start, for task and parts: computer name/id, this-mac, automatic (model preference, then eligible answered basis’s current work computer, then room), or project to reset. Name a computer only on captain’s words or reported crew need.",
        }),
      ),
      direction: Type.Optional(
        Type.String({
          description: "Record the standing direction id (d:...) behind this edit.",
        }),
      ),
      // What start_again and start_now do is said once, in the description above.
      start_again: Type.Optional(Type.Boolean()),
      start_now: Type.Optional(Type.Boolean()),
      // The description says how to drop a task (drop true with reason), and the
      // refusal says a drop needs its reason, so drop is served bare.
      drop: Type.Optional(Type.Boolean()),
      correct_required_action: Type.Optional(
        Type.Boolean({
          description:
            "Captain reports a mistaken confirmation: reopen the required action's durable operation; keep history. Cancel unneeded actions with drop and reason; never confirm them.",
        }),
      ),
      revise_required_action: Type.Optional(
        Type.Object(
          {
            source: Type.String(),
            action_id: Type.String(),
            expected_generation: Type.Integer({ minimum: 0 }),
            patch: Type.Object({
              title: Type.Optional(Type.String()),
              consequence: Type.Optional(Type.String()),
              instructions: Type.Optional(Type.Array(Type.String())),
              criterion: Type.Optional(Type.String()),
            }),
            reason: Type.String(),
            operation_id: Type.String(),
            same_action: Type.Boolean(),
          },
          {
            description: "Correct a required action's verified-wrong words; it reopens nothing.",
          },
        ),
      ),
      cost_limit: Type.Optional(
        Type.String({
          description:
            "Captain's words only. Number in estimated dollars for task and descendants; none means unlimited; follow inherits nearest answer above, then project, then app.",
        }),
      ),
      // The captain's pin (INF-3127), served bare: the name says it, and the
      // refusal says it goes alone.
      pinned: Type.Optional(Type.Boolean()),
      withdraw_merge: Type.Optional(
        Type.Boolean({
          description: "Only on the captain's words: withdraw their merge click; keep work.",
        }),
      ),
      raise_put_off: Type.Optional(
        Type.Boolean({
          description: "Captain's words: raise the put-off card now.",
        }),
      ),
      hold: Type.Optional(
        Type.Union(
          [
            Type.Object({
              until: Type.String(),
              reason: Type.String(),
              on_event: Type.Optional(
                Type.Object({
                  integration: Type.String(),
                  event: Type.String(),
                  filter: Type.Optional(Type.Unsafe<Record<string, string>>({ type: "object" })),
                }),
              ),
              on_update: Type.Optional(Type.Object({ version: Type.Optional(Type.String()) })),
            }),
            Type.Null(),
          ],
          {
            description:
              "Hold started idle work for time or an outside event no message can speed. until: ISO deadline; reason: one-line wait; on_event?: {integration, event, filter?} as in Automation; on_update?: {version?} when it waits for an Infinitary update on its computer, ending once that version, or any newer one, is installed. No reminders except unanswered captain replies; notify once at deadline if held. Any turn ends it sooner; on_event and on_update do too, telling the task what arrived. null lifts it. Hold keeps work started; park for backlog.",
          },
        ),
      ),
      take_back_yes: Type.Optional(
        Type.String({
          description: "Captain's words: card id of an allowed yes",
        }),
      ),
      override: Type.Optional(
        Type.Object(
          {
            // Every kind, so one the override cannot pass is refused in its
            // own words below rather than by the schema (INF-762).
            holds: Type.Array(stringEnum(HOLD_KINDS)),
            until: stringEnum(["version", "task"]),
            from: Type.Optional(Type.String()),
          },
          {
            description:
              "Captain's words (this turn's; or from: a card id, their reply or click there; crewmate-tab; or standing, the recorded words, to add holds) pass soft holds you judge, until as they mean, even unrefused; empty holds takes it back.",
          },
        ),
      ),
      reason: Type.Optional(
        Type.String({
          description:
            "Why it drops (if another task did or holds the work, covered by its key) or why on-request parks started work.",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "After the captain chooses, required to drop a parent with open children",
        }),
      ),
      replaced_by: Type.Optional(
        Type.String({
          description: "With drop: task (key or id) doing its work",
        }),
      ),
      verdict: Type.Optional(
        Type.String({
          description:
            "One line for a filing left planned: what waiting costs, who pays it and what would start it. The captain reads it on the record. Empty clears.",
        }),
      ),
    }),
    run: async (params) => {
      // INF-188: an update must not bypass automatic creation's declaration gate.
      if (params.start_policy === "when-ready" && params.blocked_by === undefined)
        return undeclaredPrerequisites("changed");
      if (params.start_again) {
        if (
          Object.keys(params).some(
            (key) =>
              key !== "task" &&
              key !== "start_again" &&
              params[key as keyof typeof params] !== undefined,
          )
        )
          return {
            text: "Pass only task and start_again. Edit the replacement separately after it exists.",
          };
        return { text: await delegate.startAgain({ task: params.task }) };
      }
      if (params.pinned !== undefined) {
        if (
          Object.keys(params).some(
            (key) =>
              key !== "task" &&
              key !== "pinned" &&
              params[key as keyof typeof params] !== undefined,
          )
        )
          return { text: "Pass only task and pinned. Make other edits in a separate call." };
        return { text: delegate.pin({ task: params.task, pinned: params.pinned }) };
      }
      if (params.hold !== undefined) {
        if (
          Object.keys(params).some(
            (key) =>
              key !== "task" && key !== "hold" && params[key as keyof typeof params] !== undefined,
          )
        )
          return { text: "Pass only task and hold. Make other edits in a separate call." };
        if (!delegate.hold) return { text: "Holds are not available here." };
        if (params.hold === null)
          return { text: await delegate.hold({ task: params.task, hold: null }) };
        const until = Date.parse(params.hold.until);
        if (!Number.isFinite(until))
          return { text: "hold.until takes an ISO time, such as 2026-11-20T09:00:00-08:00." };
        const onEvent = params.hold.on_event;
        const onUpdate = params.hold.on_update;
        return {
          text: await delegate.hold({
            task: params.task,
            hold: {
              until,
              reason: params.hold.reason,
              ...(onEvent
                ? {
                    onEvent: {
                      integration: onEvent.integration,
                      event: onEvent.event,
                      ...(onEvent.filter ? { filter: onEvent.filter } : {}),
                    },
                  }
                : {}),
              ...(onUpdate
                ? { onUpdate: onUpdate.version ? { version: onUpdate.version } : {} }
                : {}),
            },
          }),
        };
      }
      if (params.withdraw_merge) return { text: delegate.withdrawMerge({ task: params.task }) };
      if (params.raise_put_off)
        return {
          text: delegate.raisePutOff
            ? delegate.raisePutOff({ task: params.task })
            : "Put-off cards are not available here.",
        };
      if (params.take_back_yes?.trim())
        return {
          text: delegate.withdrawAllowance({
            task: params.task,
            card: params.take_back_yes.trim(),
          }),
        };
      if (params.cost_limit !== undefined) {
        if (!delegate.costLimit) return { text: "Cost limits are not available here." };
        const value = params.cost_limit.trim();
        const usd = Number(value.replace(/^\$/, ""));
        if (value !== "none" && value !== "follow" && !(usd > 0 && Number.isFinite(usd)))
          return { text: "cost_limit takes an amount in dollars above $0, none or follow." };
        return {
          text: delegate.costLimit({
            task: params.task,
            limit: value === "follow" ? null : value === "none" ? { none: true } : { usd },
          }),
        };
      }
      if (params.revise_required_action) {
        const revision = params.revise_required_action;
        if (!delegate.reviseRequiredAction)
          return { text: "Required-action corrections are not available here." };
        return {
          text: delegate.reviseRequiredAction({
            action: params.task,
            source: revision.source,
            actionId: revision.action_id,
            expectedGeneration: revision.expected_generation,
            patch: revision.patch,
            reason: revision.reason,
            operationId: revision.operation_id,
            sameAction: revision.same_action,
          }),
        };
      }
      if (params.override) {
        const { holds, until } = params.override;
        const refusal = overrideRefusal(holds);
        if (refusal) return { text: refusal };
        const from = params.override.from?.trim();
        return {
          text: holds.length
            ? delegate.override({
                task: params.task,
                holds: holds.filter(isOverridable),
                until,
                ...(from ? { from } : {}),
              })
            : delegate.withdrawOverride({ task: params.task }),
        };
      }
      if (params.drop) {
        const reason = params.reason?.trim();
        if (!reason) throw new Error("reason is required when dropping a task.");
        const replacedBy = params.replaced_by?.trim();
        const text = delegate.drop({
          task: params.task,
          reason,
          ...(params.confirm ? { confirm: true } : {}),
          ...(replacedBy ? { replacedBy } : {}),
        });
        return { text };
      }
      if (params.start_now && params.basis !== undefined)
        throw new Error("Set the basis before a separate start_now call.");
      const policies: TaskPolicyEdits = {
        ...(params.delivery !== undefined
          ? { delivery: params.delivery === "project" ? null : params.delivery }
          : {}),
        ...(params.autonomy !== undefined
          ? { autonomy: params.autonomy === "project" ? null : params.autonomy === "on" }
          : {}),
        ...(params.rigor !== undefined
          ? { rigor: params.rigor === "project" ? null : params.rigor }
          : {}),
      };
      const edits = {
        task: params.task,
        ...(params.correct_required_action ? { correctRequiredAction: true } : {}),
        ...(Object.keys(policies).length ? { policies } : {}),
        ...(params.direction?.trim() ? { direction: params.direction.trim() } : {}),
        ...(params.basis !== undefined ? { basis: params.basis } : {}),
        // An empty object clears the shape, as an empty branch_from clears it.
        ...(params.result_schema !== undefined
          ? {
              resultSchema: Object.keys(params.result_schema).length
                ? (params.result_schema as Record<string, unknown>)
                : null,
            }
          : {}),
        ...(params.branch_from !== undefined ? { branchFrom: params.branch_from } : {}),
        ...(params.branch !== undefined ? { branch: params.branch } : {}),
        ...(params.start_at_approval !== undefined
          ? { startAtApproval: params.start_at_approval }
          : {}),
        ...(params.needs_merge !== undefined ? { needsMerge: params.needs_merge } : {}),
        ...(params.internal_step !== undefined ? { internalStep: params.internal_step } : {}),
        ...(params.program_bound !== undefined ? { programBound: params.program_bound } : {}),
        ...(params.crew_speed !== undefined ? { speed: params.crew_speed } : {}),
        ...(params.override_model_id !== undefined ? { model: params.override_model_id } : {}),
        ...(params.unstick !== undefined ? { unstick: params.unstick } : {}),
        ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
        ...(params.placement_requirements !== undefined
          ? { placementRequirements: params.placement_requirements }
          : {}),
        ...(params.runs_on?.trim()
          ? { runsOn: params.runs_on.trim() === "project" ? null : params.runs_on.trim() }
          : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.goal !== undefined ? { goal: params.goal } : {}),
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
        ...(params.parent !== undefined ? { parent: params.parent } : {}),
        ...(params.project !== undefined ? { project: params.project } : {}),
        ...(params.repository !== undefined ? { repository: params.repository } : {}),
        ...(params.start_policy ? { startPolicy: params.start_policy } : {}),
        ...(params.start_policy && params.reason?.trim() ? { reason: params.reason.trim() } : {}),
        ...(params.captain_stop ? { captainStop: true } : {}),
        ...(params.blocked_by !== undefined ? { declaredBlockers: params.blocked_by } : {}),
        ...(params.verdict !== undefined ? { verdict: params.verdict } : {}),
      };
      const hasEdits = Object.keys(edits).some((key) => key !== "task" && key !== "direction");
      const updated = hasEdits || !params.start_now ? await delegate.update(edits) : undefined;
      if (updated && !updated.ok) return { text: updated.text };
      if (params.start_now) {
        const started = await delegate.startNow({ task: params.task });
        return { text: [updated?.text, started].filter(Boolean).join("\n") };
      }
      return { text: updated?.text ?? "" };
    },
  });

  const link = boundTool({
    name: "link_tasks",
    label: "Link tasks",
    description: [
      "Record a typed edge between tasks (ids or keys). blocks: `to` neither starts nor merges",
      "until `from` closes; on batched pull requests `to` starts at `from`'s merge approval unless",
      "its needs_merge names `from` (add such a wait with update_task blocked_by and needs_merge together), and a cycle is refused as text. related: work neither task is waiting on.",
      "discovered-from: `from` was found while doing `to`. replaced-by: `to` does `from`'s work now;",
      "link every move of work to another task (drop, takeover, fresh task): `from`'s waits",
      "and those on it move to `to`. remove true unlinks.",
    ].join(" "),
    parameters: Type.Object({
      from: Type.String({ description: "Edge's starting task (id or key)" }),
      to: Type.String({ description: "Edge's target task (id or key)" }),
      type: stringEnum(["blocks", "related", "discovered-from", "replaced-by"]),
      remove: Type.Optional(Type.Boolean()),
    }),
    run: async (params) => {
      const text = delegate.link({
        from: params.from,
        to: params.to,
        type: params.type,
        ...(params.remove ? { remove: true } : {}),
      });
      return { text };
    },
  });

  return [
    create,
    update,
    link,
    createTasksQueryTool(
      (input) => delegate.query(input),
      delegate.readCard ? (cardId) => delegate.readCard?.(cardId) ?? "" : undefined,
    ),
  ];
}

export const TASKS_QUERY_TOOL_NAME = "tasks";

/**
 * The `tasks` query's contract, shared by the Firstmate, the supervision
 * session, and every crewmate (cards/tasks/agents P0, WI-4: the backlog is
 * readable by every agent, the way every engineer can read the tracker),
 * over Pi and over Claude's tool server alike.
 */
export const TASKS_QUERY_TOOL_DESCRIPTION = [
  "Beyond context: key/task_id, kind/status/title/project, parent/blockers/blocked tasks/children, ready/wait; no bodies.",
  "Filters: project/status/key/id/title/goal/parent.",
  "Key reads: reports, cards, choices, brief, checks, sessions, earlier attempt. Timeline and exact sources only with field: timeline.",
  "Resolution is facts; HANDOFF governs authorization. History grants none.",
  "Paging names remaining fields/lengths; identical card bodies appear once.",
  "card alone reads one card.",
].join(" ");

/**
 * A page fits the client's unconditional text band (docs/claude-client.md),
 * in characters and in UTF-8 bytes. INF-416 piece K: a longer by-key read
 * pages by field and offset instead of compressing. INF-133's 100,000-token
 * cap stays the outer limit and is not this band. It is the longest answer
 * a crewmate's tool hands its model whole, so a full page reaches the model
 * itself and never goes to a file (`serveAnswerFiles`).
 */
export const TASK_QUERY_PAGE_CHARACTERS = ANSWER_WHOLE_MAX_CHARACTERS;

const PAGE_NOTE =
  "This record does not fit one read. Read remaining fields before acting; nextOffset continues.";
/** A list that stops short ends by saying where its next page starts. */
/** A list that stops short ends by naming the read that continues its one cut. */
const morePagesLine = (next: string) => `More: read with next "${next}" for the next page.`;
const MORE_PAGES = /\nMore: read with next "[^"]*" for the next page\.$/;
const LIST_NOTE =
  "This list does not fit one read. Narrow it with status, text, parent or a smaller limit.";

type FieldAs = "text" | "json";

type OmittedField = { field: string; as: FieldAs; length: number };

function resultHeading(count: number, total: number): string {
  return `${count} of ${total} matching task${total === 1 ? "" : "s"}:\n`;
}

function fitsPage(text: string): boolean {
  return (
    text.length <= TASK_QUERY_PAGE_CHARACTERS &&
    Buffer.byteLength(text) <= TASK_QUERY_PAGE_CHARACTERS
  );
}

/** A string field is its own text. Any other field is JSON, so an offset is stable. */
export function taskFieldBody(value: unknown): { as: FieldAs; text: string } {
  if (typeof value === "string") return { as: "text", text: value };
  return { as: "json", text: JSON.stringify(value) };
}

function renderOversizedRow(head: string, row: TaskQueryRow): string {
  const omitted: OmittedField[] = [];
  const kept: Record<string, unknown> = { ...row };
  const render = (): string => {
    const lines = omitted.map((item) => `${item.field} as ${item.as}, ${item.length} characters`);
    return `${head}${PAGE_NOTE}\n${lines.join("\n")}${lines.length ? "\n" : ""}${JSON.stringify([kept], null, 2)}`;
  };
  const sizes = Object.keys(row)
    .map((field) => ({
      field,
      length: taskFieldBody(row[field as keyof TaskQueryRow]).text.length,
    }))
    .sort((a, b) => b.length - a.length || a.field.localeCompare(b.field));
  for (const { field } of sizes) {
    if (fitsPage(render())) break;
    const body = taskFieldBody(kept[field]);
    omitted.push({ field, as: body.as, length: body.text.length });
    delete kept[field];
  }
  omitted.sort((a, b) => a.field.localeCompare(b.field));
  return render();
}

/** The projects read as tool text: each project's key, name and folder. */
export function renderProjectsResult(projects: readonly TaskQueryProject[]): string {
  if (projects.length === 0) return "No projects.";
  return `Each project's folder is on ${HOME.the}:\n${JSON.stringify(projects, null, 2)}`;
}

/** The query result as tool text. A read that fits is unchanged. A longer one pages. */
export function renderTasksQueryResult(result: { rows: TaskQueryRow[]; total: number }): string {
  if (result.rows.length === 0) return "No tasks match.";
  const head = resultHeading(result.rows.length, result.total);
  const original = head + JSON.stringify(result.rows, null, 2);
  // INF-133 F2: fitting reads retain their exact format on every provider.
  if (fitsPage(original)) return original;
  if (result.rows.length !== 1) return head + LIST_NOTE;
  return renderOversizedRow(head, result.rows[0]!);
}

/** One field of a by-key row, from a 1-based character offset. nextOffset continues. */
export function renderTasksFieldPage(row: TaskQueryRow, field: string, offset: number): string {
  if (!Object.hasOwn(row, field)) {
    return `No field "${field}". Fields: ${Object.keys(row).join(", ")}.`;
  }
  const body = taskFieldBody(row[field as keyof TaskQueryRow]);
  const past = body.text.length === 0 ? offset > 1 : offset > body.text.length;
  if (past) return `offset ${offset} is past field ${field} (length ${body.text.length}).`;
  let low = offset - 1;
  let high = body.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const next = mid < body.text.length ? offset + (mid - (offset - 1)) : null;
    const text =
      fieldPageHeader(field, body.as, offset, next, body.text.length) +
      body.text.slice(offset - 1, mid);
    if (fitsPage(text)) low = mid;
    else high = mid - 1;
  }
  if (low < offset && body.text.length >= offset) {
    throw new Error("A task field page header does not fit");
  }
  const next = low < body.text.length ? offset + (low - (offset - 1)) : null;
  return (
    fieldPageHeader(field, body.as, offset, next, body.text.length) +
    body.text.slice(offset - 1, low)
  );
}

function fieldPageHeader(
  field: string,
  as: FieldAs,
  offset: number,
  nextOffset: number | null,
  length: number,
): string {
  return `field ${field} as ${as}, offset ${offset}, nextOffset ${nextOffset ?? "none"}, length ${length}\n`;
}

const FIELD_PAGE =
  /^field ([A-Za-z0-9_]+) as (text|json), offset (\d+), nextOffset (\d+|none), length (\d+)\n/;
const OMITTED_FIELD = /^([A-Za-z0-9_]+) as (text|json), (\d+) characters$/;

export type TasksFieldPage = {
  field: string;
  as: FieldAs;
  offset: number;
  nextOffset: number | null;
  length: number;
  text: string;
};

/** One field page, or undefined when the text is a row read or a refusal. */
export function parseTasksFieldPage(text: string): TasksFieldPage | undefined {
  const match = FIELD_PAGE.exec(text);
  if (!match) return undefined;
  const offset = Number(match[3]);
  const nextOffset = match[4] === "none" ? null : Number(match[4]);
  const length = Number(match[5]);
  const body = text.slice(match[0].length);
  const expected = nextOffset === null ? length - offset + 1 : nextOffset - offset;
  if (body.length !== expected) throw new Error("A task field page must stay complete");
  return {
    field: match[1]!,
    as: match[2] as FieldAs,
    offset,
    nextOffset,
    length,
    text: body,
  };
}

export type ParsedTasksQuery = {
  rows: TaskQueryRow[];
  omitted: OmittedField[];
};

/** The row read: fitting JSON, or an index that names the fields still to page. */
export function parseTasksQueryText(text: string): ParsedTasksQuery {
  if (text === "No tasks match." || text.endsWith(LIST_NOTE)) return { rows: [], omitted: [] };
  const jsonAt = text.indexOf("\n[");
  if (jsonAt < 0) throw new Error("A task read must include its rows");
  const notes = text.slice(0, jsonAt).split("\n").slice(1);
  const omitted: OmittedField[] = [];
  for (const line of notes) {
    if (!line || line === PAGE_NOTE) continue;
    const match = OMITTED_FIELD.exec(line);
    if (!match) throw new Error("A task read note must name a field");
    omitted.push({ field: match[1]!, as: match[2] as FieldAs, length: Number(match[3]) });
  }
  return {
    rows: JSON.parse(text.slice(jsonAt + 1).replace(MORE_PAGES, "")) as TaskQueryRow[],
    omitted,
  };
}

/** The index read plus every field page, in any order, as the complete rows. */
export function assembleTasksReads(reads: string[]): TaskQueryRow[] {
  const index = reads.find((read) => parseTasksFieldPage(read) === undefined);
  if (!index) throw new Error("A paged task read needs its row");
  const parsed = parseTasksQueryText(index);
  const pages = new Map<string, TasksFieldPage[]>();
  for (const read of reads) {
    const page = parseTasksFieldPage(read);
    if (!page) continue;
    pages.set(page.field, [...(pages.get(page.field) ?? []), page]);
  }
  return parsed.rows.map((row) => {
    const filled: Record<string, unknown> = { ...row };
    for (const omitted of parsed.omitted) {
      const parts = (pages.get(omitted.field) ?? []).sort((a, b) => a.offset - b.offset);
      if (omitted.length === 0) {
        filled[omitted.field] = omitted.as === "text" ? "" : JSON.parse("null");
        continue;
      }
      let at = 1;
      let text = "";
      for (const part of parts) {
        if (part.offset !== at || part.as !== omitted.as || part.length !== omitted.length) {
          throw new Error(`field ${omitted.field} page does not continue the index`);
        }
        text += part.text;
        at = part.nextOffset ?? part.offset + part.text.length;
      }
      if (at !== omitted.length + 1) throw new Error(`field ${omitted.field} is incomplete`);
      filled[omitted.field] = omitted.as === "json" ? JSON.parse(text) : text;
    }
    return filled as TaskQueryRow;
  });
}

/** What every `tasks` query takes, the Firstmate's and a crewmate's alike. */
const TASKS_QUERY_PARAMETERS = {
  project: Type.Optional(Type.String({ description: "A project key" })),
  status: Type.Optional(
    stringEnum(["open", "active", "done", "dropped", "live", "closed"], {
      description: "live = open, active; closed = done, dropped",
    }),
  ),
  key: Type.Optional(Type.String({ description: "One task by key or id" })),
  field: Type.Optional(
    Type.String({
      description:
        "By-key read: one field to page. A string is its text; other fields are JSON. Requires key.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based character offset in that field; requires field. nextOffset continues.",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Substring over title and goal" })),
  parent: Type.Optional(Type.String({ description: "List the children of this task" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  card: Type.Optional(Type.String()),
};

const TASKS_QUERY_OBJECT = Type.Object(TASKS_QUERY_PARAMETERS);

/** The `tasks` query also lists projects and their folders (INF-1217). */
const PROJECTS_PARAMETER = Type.Optional(Type.Boolean({ description: "List project folders" }));

export const TIMELINE_PAGING_RESTART =
  "This timeline read is no longer retained. Read field timeline from offset 1.";
export const LIST_PAGING_RESTART =
  "This list's earlier read is no longer retained. Read it again from its first page, without next.";

/**
 * A list's `next`: which kept cut it continues and where. A cut's id is
 * random, so a `next` kept in a resumed conversation never matches a cut a
 * rebuilt tool took later.
 */
function listNext(cut: string, skip: number): string {
  return Buffer.from(JSON.stringify({ cut, skip })).toString("base64url");
}

function listCursor(next: string): { cut: string; skip: number } | undefined {
  try {
    const at = JSON.parse(Buffer.from(next, "base64url").toString()) as unknown;
    if (
      typeof at === "object" &&
      at !== null &&
      typeof (at as { cut?: unknown }).cut === "string" &&
      Number.isInteger((at as { skip?: unknown }).skip) &&
      (at as { skip: number }).skip >= 0
    )
      return at as { cut: string; skip: number };
  } catch {}
  return undefined;
}

function tasksQueryRun(
  onQueryTasks: NonNullable<CrewmateToolDelegate["onQueryTasks"]>,
  onReadCard?: CrewmateToolDelegate["onReadCard"],
) {
  // Retain only this tool's most recent incomplete field read, by canonical id.
  // A new read supersedes the previous one; never combine pages from different cuts.
  const timelines = new Map<string, TaskQueryRow>();
  // A list that stops short keeps the one cut its owner took in the same
  // read as the first page - every matching id, in order - and its More line
  // names a `next` that reads those ids: a task started or updated between
  // pages moves in the live order, and must neither skip another row nor
  // show one twice. A `next` whose cut is no longer kept is refused, never
  // read from the live order. One cut is kept per query, with the filters
  // it was taken under, so `next` alone continues it.
  const cuts = new Map<
    string,
    { id: string; filters: Omit<TaskQueryInput, "ids">; order: string[]; size: number }
  >();
  return async (
    params: Static<typeof TASKS_QUERY_OBJECT> & {
      projects?: boolean;
      skip?: number;
      next?: string;
    },
    signal?: AbortSignal,
  ) => {
    if (params.card !== undefined) {
      // One card as it stands (docs/card-threads.md, "Shared cards").
      const { card, ...rest } = params;
      if (Object.values(rest).some((value) => value !== undefined))
        return { text: "card reads one card alone; give it without other filters." };
      if (!onReadCard) return { text: "Card reads are not available here." };
      return { text: await callWithSignal(onReadCard, [card], signal) };
    }
    if ((params.field !== undefined || params.offset !== undefined) && !params.key) {
      return { text: "field and offset apply only with a key." };
    }
    if (params.offset !== undefined && !params.field) {
      return { text: "offset applies only with a field." };
    }
    if ((params.skip !== undefined || params.next !== undefined) && (params.key || params.field))
      return { text: "skip and next apply only to task lists." };
    if (params.next !== undefined && params.skip !== undefined)
      return { text: "next continues a list; give it without skip." };
    const listing = !params.key && !params.field && !params.projects;
    if (listing) {
      const { skip: _skip, limit: _limit, next: _next, ...rest } = params;
      const query = JSON.stringify(rest, Object.keys(rest).sort());
      const filters = {
        ...(params.project ? { project: params.project } : {}),
        ...(params.status ? { status: params.status as TaskStatus | "live" | "closed" } : {}),
        ...(params.text ? { text: params.text } : {}),
        ...(params.parent ? { parent: params.parent } : {}),
      };
      if (params.next !== undefined) {
        // Capture the cut before any await: a concurrent read may replace
        // the query's kept cut, and this page reads only the one it names.
        const at = listCursor(params.next);
        const cut = at && [...cuts.values()].find((kept) => kept.id === at.cut);
        if (!at || !cut) return { text: LIST_PAGING_RESTART };
        const ids = cut.order.slice(at.skip, at.skip + (params.limit ?? cut.size));
        const page =
          ids.length > 0
            ? await callWithSignal(onQueryTasks, [{ ...cut.filters, ids }], signal)
            : { rows: [], total: 0 };
        const text = renderTasksQueryResult({ rows: page.rows, total: cut.order.length });
        const after = at.skip + ids.length;
        return {
          text:
            ids.length > 0 && cut.order.length > after
              ? `${text}\n${morePagesLine(listNext(cut.id, after))}`
              : text,
        };
      }
      // The owner takes the whole cut in the same read as the first page;
      // a skip reads the live list from that offset, as it stands.
      const skip = params.skip ?? 0;
      const first = await callWithSignal(
        onQueryTasks,
        [
          {
            ...filters,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(skip > 0 ? { skip } : {}),
            snapshot: true,
          },
        ],
        signal,
      );
      const text = renderTasksQueryResult(first);
      const after = skip + first.rows.length;
      if (!first.order || first.order.length <= after) {
        cuts.delete(query);
        return { text };
      }
      const cut = {
        id: randomUUID(),
        filters,
        order: first.order,
        size: Math.max(1, first.rows.length),
      };
      cuts.set(query, cut);
      return { text: `${text}\n${morePagesLine(listNext(cut.id, after))}` };
    }
    const continuing = params.field === "timeline" && (params.offset ?? 1) > 1;
    const retained = timelines.values().next().value;
    const snapshot =
      continuing &&
      retained &&
      params.key &&
      (retained.task_id === params.key || retained.key === params.key.toUpperCase())
        ? timelines.get(retained.task_id)
        : undefined;
    if (continuing && !snapshot) return { text: TIMELINE_PAGING_RESTART };
    const result = snapshot
      ? { rows: [snapshot], total: 1 }
      : await callWithSignal(
          onQueryTasks,
          [
            {
              ...(params.project ? { project: params.project } : {}),
              ...(params.status ? { status: params.status as TaskStatus | "live" | "closed" } : {}),
              ...(params.key ? { key: params.key } : {}),
              ...(params.field ? { field: params.field } : {}),
              ...(params.text ? { text: params.text } : {}),
              ...(params.parent ? { parent: params.parent } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
              ...(params.skip !== undefined ? { skip: params.skip } : {}),
              ...(params.projects ? { projects: true } : {}),
            },
          ],
          signal,
        );
    if (params.projects) return { text: renderProjectsResult(result.projects ?? []) };
    if (params.field) {
      const row = result.rows[0];
      if (!row) return { text: "No tasks match." };
      const text = renderTasksFieldPage(row, params.field, params.offset ?? 1);
      if (params.field === "timeline" && params.key) {
        const page = parseTasksFieldPage(text);
        timelines.clear();
        if (page?.nextOffset) timelines.set(row.task_id, row);
      }
      return { text };
    }
    return { text: renderTasksQueryResult(result) };
  };
}

/**
 * The `tasks` query, one entry of the crewmate tool spec: every crewmate
 * gets it on either runtime, and the Firstmate's tool set carries the same
 * entry without the projects parameter (`createTasksQueryTool`).
 */
export const TASKS_QUERY_TOOL = crewmateTool({
  name: TASKS_QUERY_TOOL_NAME,
  label: "Tasks",
  description: TASKS_QUERY_TOOL_DESCRIPTION,
  parameters: Type.Object({
    ...TASKS_QUERY_PARAMETERS,
    projects: PROJECTS_PARAMETER,
    skip: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Skip this many task-list rows; collect all keys before recording releases.",
      }),
    ),
    // A list's More line names `next` with its value, so it needs no description.
    next: Type.Optional(Type.String()),
  }),
  bind: ({ onQueryTasks, onReadCard }) => onQueryTasks && tasksQueryRun(onQueryTasks, onReadCard),
});

/**
 * The `tasks` query tool as the Firstmate's Pi session holds it: the
 * crewmate's entry, paging and projects included, since the context lists
 * only started work and the backlog is read here (INF-1712).
 */
export function createTasksQueryTool(
  query: NonNullable<CrewmateToolDelegate["onQueryTasks"]>,
  readCard?: (cardId: string) => string,
) {
  return bindTool(TASKS_QUERY_TOOL, {
    onQueryTasks: query,
    ...(readCard ? { onReadCard: readCard } : {}),
  });
}
