import { type ReasoningChoice, reasoningChoiceSchema } from "@shared/modelSlots";
import type { PlacementRequirements } from "@shared/placement";
import type { WorkShapeAsk } from "@shared/routingPolicy";
import type { TaskPolicyEdits } from "@shared/taskPolicies";
import { Type } from "typebox";
import { parseSpawnIntent, type SpawnIntent } from "../orchestrator/intentBrief";
import { bindTool, boundTool, callWithSignal, crewmateTool, stringEnum } from "../session/tools";
import type { TaskLinkType } from "../storage/taskLinkStore";
import type { TaskStartPolicy, TaskStatus } from "../storage/taskStore";
import type { TaskQueryInput, TaskQueryRow } from "../tasks/taskQuery";
import { CONSTRAINTS_PARAM, PLACEMENT_REQUIREMENTS_PARAM } from "./crewTools";

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
    startPolicy?: TaskStartPolicy;
    /** Prerequisites to add. Already-linked ones stay; none are removed. */
    declaredBlockers?: string[];
    verdict?: string | null;
    basis?: string;
    /** The model the user named (override_model_id); empty clears it. */
    model?: string;
    speed?: import("@shared/crewSpeed").CrewSpeed | null;
    /** The reasoning effort the user named (override_reasoning); null inherits Models. */
    reasoning?: ReasoningChoice | null;
    /** Where the captain said it runs: a device id or `this-mac`; null follows its parent's or project's again. */
    runsOn?: string | null;
    placementRequirements?: PlacementRequirements | null;
  }): { text: string; ok: boolean };
  drop(input: { task: string; reason: string; confirm?: boolean; replacedBy?: string }): string;
  /** Withdraw the captain's kept merge approval on his words; the work stays (FI3-304). */
  withdrawMerge(input: { task: string }): string;
  /** A queued row starts now, past any reasoning re-ask (P0, WI-3). Refusals are text. */
  startNow(input: { task: string }): Promise<string>;
  startAgain(input: { task: string }): Promise<string>;
  link(input: { from: string; to: string; type: TaskLinkType; remove?: boolean }): string;
  query(input: TaskQueryInput): { rows: TaskQueryRow[]; total: number };
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
    "when-ready auto-starts once unblocked/unheld. on-request (the default): no crewmate starts on it until update_task start_now. Leave a parent on request: its children do its work.",
});

function undeclaredPrerequisites(verb: "filed" | "changed") {
  return {
    text: `Nothing was ${verb}. Follow HANDOFF. Queued work must declare blocked_by in this call, as create_task's blocked_by.`,
    details: { refusal: { kind: "undeclared-prerequisites" } },
  };
}

export function createTaskTools(delegate: TaskToolsDelegate) {
  const create = boundTool({
    name: "create_task",
    label: "Create task",
    description: [
      "Record project work without starting: saved plans, waits or containers.",
      "when-ready can start now; declare blocked_by.",
      "Basis checked at start.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({
        description:
          'Sentence-case title saying what it does (max 64 chars), e.g. "Ship the bridge to alpha", not its place in a plan',
      }),
      goal: Type.String({ description: "As spawn_crewmate's goal." }),
      user_words: Type.String({ description: "As spawn_crewmate's user_words." }),
      constraints: Type.Optional({
        ...CONSTRAINTS_PARAM,
        description: "As spawn_crewmate's constraints.",
      }),
      delivery_note: Type.Optional(
        Type.String({ description: "As spawn_crewmate's delivery_note." }),
      ),
      repo_id: Type.Optional(
        Type.String({
          description:
            "A registered repo id from the context block; a child inherits its parent's when omitted",
        }),
      ),
      parent: Type.Optional(
        Type.String({ description: "The task this one belongs under (task id or key)" }),
      ),
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description: "Prerequisite ids/keys. Required for when-ready; [] declares none.",
        }),
      ),
      start_policy: Type.Optional(START_POLICY),
      priority: PRIORITY,
      basis: Type.Optional(Type.String({ description: "As spawn_crewmate's shape.basis." })),
      placement_requirements: Type.Optional({
        ...PLACEMENT_REQUIREMENTS_PARAM,
        description:
          "Declared systems, chips, exact program names and admission profile; omitted platforms inherit home. Never infer portability or tools from keywords. Tasks cannot relax project requirements.",
      }),
      internal_step: Type.Optional(
        Type.Boolean({
          description:
            "As spawn_crewmate's shape.internal_step. Omit it when the captain asked for this result himself; it stays his to close.",
        }),
      ),
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
        ...(params.internal_step ? { internal_step: true } : {}),
      };
      const intent = parseSpawnIntent({
        goal: params.goal,
        user_words: params.user_words,
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
      });
      return { text: planned.text };
    },
  });

  const update = boundTool({
    name: "update_task",
    label: "Update task",
    description: [
      "Edit a task; only unstarted open work can change project.",
      "Captain-requested start_again alone replaces dropped work, preserves saved work/waits,",
      "starts with fresh routing (not escalation), and returns its new key.",
      "To drop a task pass drop true with reason; confirm true also supersedes open children.",
      "Replacement: replaced_by. Started work: settle_task.",
      "start_now: queued work on available model despite allowance waits; edits first, refusals",
      "block it.",
      "When the user names a model for a filed task, pass override_model_id - with start_now",
      "to start it now: it keeps its key and links, so never drop it and spawn a replacement.",
      "delivery/autonomy/rigor: explicit captain requests only, already consent; never re-ask.",
      "project resets overrides; omission keeps them. Policy edits never start/restart work.",
      "Local Careful = Default; keep request.",
      "No silent PR close or fallback without access. Policies refuse closed/answer/review/",
      "personal-workspace tasks. Ask only unclear task/scope/consent; refusals name blockers.",
    ].join(" "),
    parameters: Type.Object({
      task: Type.String({ description: "The task id or key" }),
      title: Type.Optional(Type.String({ description: "As create_task's title." })),
      goal: Type.Optional(Type.String({ description: "New one-sentence goal" })),
      priority: PRIORITY,
      // What each policy means is said once, on create_task's start_policy.
      start_policy: Type.Optional(
        stringEnum(START_POLICY_VALUES, { description: "As create_task's start_policy" }),
      ),
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description: "As create_task's blocked_by. Adds any not yet linked; never removes.",
        }),
      ),
      parent: Type.Optional(
        Type.String({ description: "New parent (task id or key); empty string clears it" }),
      ),
      project: Type.Optional(
        Type.String({ description: "Move to this project (key from the tasks index)" }),
      ),
      basis: Type.Optional(
        Type.String({
          description:
            "Attach the plan/spec task (key or id) to open work that has not started; empty clears it.",
        }),
      ),
      crew_speed: Type.Optional(
        Type.Union([stringEnum(["standard", "fast", "ultrafast"]), Type.Null()], {
          description:
            "Captain-only crew/summary speed, next request; null inherits Models. First mate/Decisions stay Standard. Ultrafast: 8× allowance/6× credits. Unavailable: explained Standard, same model/account.",
        }),
      ),
      override_model_id: Type.Optional(
        Type.String({
          description:
            "As spawn_crewmate.shape.override_model_id; routes when this open task starts. Empty clears it.",
        }),
      ),
      reasoning: Type.Optional(
        Type.Union([stringEnum(reasoningChoiceSchema.options), Type.Null()], {
          description: "Captain-named effort when this open task starts; null inherits Models.",
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
          description: "As create_task's placement_requirements; null restores defaults.",
        }),
      ),
      runs_on: Type.Optional(
        Type.String({
          description:
            "Captain-only, before start, for it and its parts: deviceId from device-remove, this-mac, or automatic (choose once, fresh compatibility and room); project resets it.",
        }),
      ),
      direction: Type.Optional(
        Type.String({
          description:
            "The id (d:...) of the standing direction behind this call's edit; the record names it.",
        }),
      ),
      start_again: Type.Optional(
        Type.Boolean({
          description: "Start dropped work again, as above",
        }),
      ),
      start_now: Type.Optional(
        Type.Boolean({
          description: "Start a queued task right now",
        }),
      ),
      drop: Type.Optional(Type.Boolean({ description: "Close the task as dropped" })),
      correct_required_action: Type.Optional(
        Type.Boolean({
          description:
            "On the captain's words that he confirmed a required action by mistake: reopen its durable operation and preserve the confirmation history. This does not reverse work that already continued. Cancel an unneeded action with drop and reason, never confirm it.",
        }),
      ),
      withdraw_merge: Type.Optional(
        Type.Boolean({
          description: "The captain takes back a merge he clicked; the work stays",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description:
            "Why it is dropped (required with drop); for work another task did or holds, covered by its key",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "Required to drop a parent with open children after the captain chose",
        }),
      ),
      replaced_by: Type.Optional(
        Type.String({
          description: "With drop: the task (key or id) doing its work",
        }),
      ),
      verdict: Type.Optional(
        Type.String({
          description:
            "One line when you leave a filing planned: what waiting costs and who pays it, and what would start it. The captain reads it on the record. Empty clears it.",
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
      if (params.withdraw_merge) return { text: delegate.withdrawMerge({ task: params.task }) };
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
        ...(params.crew_speed !== undefined ? { speed: params.crew_speed } : {}),
        ...(params.override_model_id !== undefined ? { model: params.override_model_id } : {}),
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
        ...(params.start_policy ? { startPolicy: params.start_policy } : {}),
        ...(params.blocked_by !== undefined ? { declaredBlockers: params.blocked_by } : {}),
        ...(params.verdict !== undefined ? { verdict: params.verdict } : {}),
      };
      const hasEdits = Object.keys(edits).some((key) => key !== "task" && key !== "direction");
      const updated = hasEdits || !params.start_now ? delegate.update(edits) : undefined;
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
      "Record a typed edge between two tasks (ids or keys). blocks: `to` cannot start until",
      "`from` closes, and a cycle is refused as text. related: work neither task is waiting on.",
      "discovered-from: `from` was found while doing `to`. replaced-by: `from` was",
      "dropped for `to`, which does its work. Pass remove true to unlink.",
    ].join(" "),
    parameters: Type.Object({
      from: Type.String({ description: "The task the edge starts at (id or key)" }),
      to: Type.String({ description: "The task the edge points at (id or key)" }),
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

  return [create, update, link, createTasksQueryTool((input) => delegate.query(input))];
}

export const TASKS_QUERY_TOOL_NAME = "tasks";

/**
 * The `tasks` query's contract, shared by the Firstmate, the supervision
 * session, and every crewmate (cards/tasks/agents P0, WI-4: the backlog is
 * readable by every agent, the way every engineer can read the tracker),
 * over Pi and over Claude's tool server alike.
 */
export const TASKS_QUERY_TOOL_DESCRIPTION = [
  "Query the task record: compact rows with key, task_id, kind, status, title, project,",
  "parent, blockers, what it blocks, children, and whether it is ready or what it waits on.",
  "Filter by project (key), status (open, active, done, dropped, live, closed),",
  "key (one task), text (title or goal), or parent (its children). Fetch one task by key",
  "to read its latest report, full chronological reports, last card, saved closing decisions,",
  "persisted closing resolution (offer, action, submitted answers), and pinned dispatch brief.",
  "Resolution carries facts; HANDOFF governs authorization. History is evidence,",
  "not inferred approval; later reports do not erase earlier specifications. Lists carry no bodies.",
  "The context block's tasks index is a bounded view of the same record; this is the full one.",
].join(" ");

/** Keep task reads in the client's unconditional text band when formatting alone can do so. */
const TASK_QUERY_TEXT_BAND = 50_000;

function pointerChild(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** The query result as tool text; identical content is served once, never removed from records. */
export function renderTasksQueryResult(result: { rows: TaskQueryRow[]; total: number }): string {
  if (result.rows.length === 0) return "No tasks match.";
  const heading = `${result.rows.length} of ${result.total} matching task${result.total === 1 ? "" : "s"}:\n`;
  const original = heading + JSON.stringify(result.rows, null, 2);
  // INF-133 F2: fitting reads retain their exact format on every provider.
  if (original.length <= TASK_QUERY_TEXT_BAND) return original;
  let references = false;
  const rows = result.rows.map((row, index) => {
    const seen = new Map<string, string>();
    // Keep the familiar latest report and newest card as the canonical text.
    for (const key of ["outcome", "card"] as const) {
      const value = row[key];
      if (value !== undefined && !seen.has(JSON.stringify(value))) {
        seen.set(JSON.stringify(value), `#/${index}/${key}`);
      }
    }
    const share = (value: unknown, path: string): unknown => {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) return value;
      const ref = seen.get(encoded);
      if (
        ref !== undefined &&
        ref !== path &&
        JSON.stringify({ $ref: ref }).length < encoded.length
      ) {
        references = true;
        return { $ref: ref };
      }
      if (ref === undefined) seen.set(encoded, path);
      if (Array.isArray(value)) return value.map((item, at) => share(item, pointerChild(path, at)));
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, share(item, pointerChild(path, key))]),
        );
      }
      return value;
    };
    return share(row, `#/${index}`);
  });
  const note = references
    ? "Repeated values use $ref JSON Pointers inside this result, not another tool call.\n"
    : "";
  const pretty = heading + note + JSON.stringify(rows, null, 2);
  if (pretty.length <= TASK_QUERY_TEXT_BAND) return pretty;
  const compact = heading + note + JSON.stringify(rows);
  if (compact.length <= TASK_QUERY_TEXT_BAND) return compact;
  // Large markup pays for every escaped quote and newline inside JSON. Serve
  // only profitable strings as verbatim, length-framed blocks in this SAME read.
  // Never summarize the accepted offer or silently cut any unique content.
  const blocks: string[] = [];
  const frameText = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const marker = { $text: value.length };
      const block = `\n\nText ${path} (${value.length} UTF-16 units):\n${value}`;
      if (JSON.stringify(marker).length + block.length < JSON.stringify(value).length) {
        blocks.push(block);
        return marker;
      }
    }
    if (Array.isArray(value))
      return value.map((item, at) => frameText(item, pointerChild(path, at)));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, frameText(item, pointerChild(path, key))]),
      );
    }
    return value;
  };
  const metadata = rows.map((row, index) => frameText(row, `#/${index}`));
  const blockNote = "$text names the length of its verbatim Text block below.\n";
  const framed = heading + note + blockNote + JSON.stringify(metadata) + blocks.join("");
  return framed.length < compact.length ? framed : compact;
}

/**
 * The `tasks` query, one entry of the crewmate tool spec: every crewmate
 * gets it on either runtime, and the Firstmate's tool set carries the same
 * entry (`createTasksQueryTool`).
 */
export const TASKS_QUERY_TOOL = crewmateTool({
  name: TASKS_QUERY_TOOL_NAME,
  label: "Tasks",
  description: TASKS_QUERY_TOOL_DESCRIPTION,
  parameters: Type.Object({
    project: Type.Optional(Type.String({ description: "A project key from the tasks index" })),
    status: Type.Optional(
      stringEnum(["open", "active", "done", "dropped", "live", "closed"], {
        description: "live = open, active; closed = done, dropped",
      }),
    ),
    key: Type.Optional(Type.String({ description: "One task by key or id" })),
    text: Type.Optional(Type.String({ description: "Substring over title and goal" })),
    parent: Type.Optional(Type.String({ description: "List the children of this task" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  bind: ({ onQueryTasks }) =>
    onQueryTasks &&
    (async (params, signal) => {
      const result = await callWithSignal(
        onQueryTasks,
        [
          {
            ...(params.project ? { project: params.project } : {}),
            ...(params.status ? { status: params.status as TaskStatus | "live" | "closed" } : {}),
            ...(params.key ? { key: params.key } : {}),
            ...(params.text ? { text: params.text } : {}),
            ...(params.parent ? { parent: params.parent } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          },
        ],
        signal,
      );
      return { text: renderTasksQueryResult(result) };
    }),
});

/** The `tasks` query tool as the Firstmate's Pi session holds it. */
export function createTasksQueryTool(
  query: (input: TaskQueryInput) => { rows: TaskQueryRow[]; total: number },
) {
  return bindTool(TASKS_QUERY_TOOL, { onQueryTasks: query });
}
