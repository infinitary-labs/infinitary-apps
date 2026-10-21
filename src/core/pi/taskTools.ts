import { OVERRIDABLE_HOLDS, type OverridableHold } from "@shared/holds";
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
  /**
   * Record the captain's override (docs/delivery-rigor.md, "The holds"):
   * refused outside a turn that carries his words, which the host keeps.
   */
  override(input: { task: string; holds: OverridableHold[]; until: "version" | "task" }): string;
  /** He takes his override back. */
  withdrawOverride(input: { task: string }): string;
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
    text: `Nothing was ${verb}. Follow HANDOFF. Queued work must declare blocked_by in this call, as create_task's blocked_by says.`,
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
      "No silent PR close or fallback without access.",
      "Ask only unclear task/scope/consent; refusals name blockers.",
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
      // What [] declares is said once, on create_task's blocked_by.
      blocked_by: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "As create_task's blocked_by; required for when-ready. Adds any not yet linked; never removes.",
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
      override: Type.Optional(
        Type.Object(
          {
            holds: Type.Array(stringEnum(OVERRIDABLE_HOLDS)),
            until: stringEnum(["version", "task"]),
          },
          {
            description:
              "Captain's words this turn pass soft holds refusals named, until as he means; empty holds takes it back.",
          },
        ),
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
      if (params.override)
        return {
          text: params.override.holds.length
            ? delegate.override({ task: params.task, ...params.override })
            : delegate.withdrawOverride({ task: params.task }),
        };
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
  "Lists beyond the context index: key/task_id, kind/status/title/project, parent/blockers/blocked tasks/children, ready/wait; no bodies.",
  "Filters: project/status/key/id/title/goal/parent.",
  "Key reads: ordered reports, last card, decisions, resolution offer/action/answers, brief, validation/review.",
  "Resolution is facts; HANDOFF governs authorization. History grants none; later reports preserve prior specs.",
  "Paging names remaining fields/lengths; identical card bodies appear once.",
].join(" ");

/**
 * A page fits the client's unconditional text band (docs/claude-client.md),
 * in characters and in UTF-8 bytes. INF-416 piece K: a longer by-key read
 * pages by field and offset instead of compressing. INF-133's 100,000-token
 * cap stays the outer limit and is not this band.
 */
export const TASK_QUERY_PAGE_CHARACTERS = 50_000;

const PAGE_NOTE =
  "This record does not fit one read. Read remaining fields before acting; nextOffset continues.";
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
  return { rows: JSON.parse(text.slice(jsonAt + 1)) as TaskQueryRow[], omitted };
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
    field: Type.Optional(
      Type.String({
        description:
          "On a by-key read, one field to page. A string is its text; any other field is JSON. Applies only with key.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "1-based character offset into that field. Applies only with field. nextOffset continues.",
      }),
    ),
    text: Type.Optional(Type.String({ description: "Substring over title and goal" })),
    parent: Type.Optional(Type.String({ description: "List the children of this task" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  bind: ({ onQueryTasks }) =>
    onQueryTasks &&
    (async (params, signal) => {
      if ((params.field !== undefined || params.offset !== undefined) && !params.key) {
        return { text: "field and offset apply only with a key." };
      }
      if (params.offset !== undefined && !params.field) {
        return { text: "offset applies only with a field." };
      }
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
      if (params.field) {
        const row = result.rows[0];
        if (!row) return { text: "No tasks match." };
        return { text: renderTasksFieldPage(row, params.field, params.offset ?? 1) };
      }
      return { text: renderTasksQueryResult(result) };
    }),
});

/** The `tasks` query tool as the Firstmate's Pi session holds it. */
export function createTasksQueryTool(
  query: (input: TaskQueryInput) => { rows: TaskQueryRow[]; total: number },
) {
  return bindTool(TASKS_QUERY_TOOL, { onQueryTasks: query });
}
