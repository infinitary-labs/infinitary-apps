import type { LiveValidation } from "@shared/liveValidation";
import type { CaptainAction } from "@shared/requiredActions";
import { foldForSearch } from "@shared/searchText";
import { taskChangeOf } from "@shared/taskFacts";
import type { EffectiveTaskPolicies } from "@shared/taskPolicies";
import type { WorkPosture } from "@shared/workPosture";
import { attachmentPath } from "../attachments";
import type { CardResolution } from "../storage/cardStore";
import type { TaskDelivery, TaskRecord, TaskStatus } from "../storage/taskStore";
import { TaskService } from "./taskService";
import type { TaskTimeline } from "./taskTimeline";

/**
 * The `tasks` query (task-system P2, design section 7): the full query
 * side of the record for the Firstmate and the supervision session - the
 * context block's index is bounded, this is not. Compact rows, keys for
 * every reference, and the derived flags (blocked, held, ready) computed
 * at read time, never stored (design principle 4).
 */

/** One status, or `live` (open, active) or `closed` (done, dropped). */
export type TaskStatusFilter = TaskStatus | "live" | "closed";

export type TaskQueryInput = {
  /** A project key or id; omit for every project. */
  project?: string;
  status?: TaskStatusFilter;
  /** One task by key or id: full reports, decisions, pinned brief and closing resolution. */
  key?: string;
  /** The explicitly requested field; only timeline reads load its retained source bodies. */
  field?: string;
  /** Case-insensitive substring over title and goal. */
  text?: string;
  /** Children of this task (key or id). */
  parent?: string;
  limit?: number;
  /** Row pagination for a crewmate collecting a complete task list. */
  skip?: number;
  /**
   * Every project instead of tasks: its key, name and folder on the
   * computer where the first mate lives (INF-1217), so a crewmate names a
   * project's folder instead of searching the disk for it.
   */
  projects?: boolean;
};

/** One project as the `projects` read names it. */
export type TaskQueryProject = { key: string; name: string; folder?: string };

/**
 * Where a task's crewmate ran, as a by-key read names it (INF-1217): the
 * computer, and its evidence folder there, so a file on another computer
 * is a gap to report rather than a search.
 */
export type TaskQueryPlace = { computer: string; evidence_folder?: string };

/** What the core's composition supplies beyond the record; each absent says nothing. */
export type TaskQueryReach = {
  timeline?: Pick<TaskTimeline, "sources">;
  /** A project's folder on the computer where the first mate lives. */
  projectFolder?: (repoId: string) => string | undefined;
  /** Where the task's crewmate ran, once one did. */
  placeOf?: (record: TaskRecord) => TaskQueryPlace | undefined;
  /** This computer's retained files, including copies from another computer. */
  sessionFolderOf?: (record: TaskRecord) => { dir: string; computer: string };
};

/** Closing metadata keeps distinct bodies; a body equal to the newest card is not repeated. */
type ClosingBody<T extends { body: string }> = Omit<T, "body"> & { body?: string };
export type TaskQueryResolution = Omit<CardResolution, "card" | "offer"> & {
  card: ClosingBody<CardResolution["card"]>;
  offer?: ClosingBody<NonNullable<CardResolution["offer"]>>;
};

/** The body of a closing card or offer, including one shown only in the newest card. */
export function taskResolutionBody(row: TaskQueryRow, part: "card" | "offer"): string | undefined {
  const closing = row.resolution?.[part];
  return closing ? (closing.body ?? row.card) : undefined;
}

function queryResolution(resolved: CardResolution, newestBody?: string): TaskQueryResolution {
  const withoutRepeatedBody = <T extends { body: string }>(value: T): ClosingBody<T> => {
    if (value.body !== newestBody) return value;
    const { body: _body, ...rest } = value;
    return rest;
  };
  return {
    ...resolved,
    card: withoutRepeatedBody(resolved.card),
    ...(resolved.offer ? { offer: withoutRepeatedBody(resolved.offer) } : {}),
  };
}

export type TaskQueryRow = {
  /** Retained entries and exact sources, shared with Activity. Explicit timeline field reads only. */
  timeline?: ReturnType<TaskTimeline["sources"]>;
  /** Every conversation on this task; earlier attempts keep their own lists. By-key only. */
  sessions?: ReturnType<TaskService["sessions"]>;
  earlier_attempt?: string;
  policies?: EffectiveTaskPolicies;
  required_action?: CaptainAction;
  key: string;
  task_id: string;
  first_release?: TaskDelivery["firstRelease"] | null;
  merge_commit?: string;
  kind: string;
  status: string;
  title: string;
  project: string;
  priority: number;
  start_policy?: string;
  parent?: string;
  blocked_by?: string[];
  blocks?: string[];
  children?: string;
  /** The task(s) this one was discovered while working on. */
  discovered_from?: string[];
  /** Follow-ups discovered from this task: "1 open of 3". */
  follow_ups?: string;
  assignee?: string;
  repo?: string;
  /**
   * The task's change where the project lives (FI3-1307): its label (`#N`,
   * or a pushed branch) and its page where the host has one, so an author
   * that names the pull request on a card links the page it was given.
   */
  change?: { label?: string; url?: string };
  ready?: true;
  waiting?: string;
  closed_reason?: string;
  goal?: string;
  /** Explicit task override; absent inherits the selected model’s default. */
  crew_speed?: import("@shared/crewSpeed").CrewSpeed;
  /** The captain's named effort for this task; absent inherits Settings → Models. */
  reasoning?: import("@shared/modelSlots").ReasoningChoice;
  /**
   * The row's latest report. Only a fetch BY KEY carries it (Task B): a
   * builder that names an investigation as its basis reads the answer back
   * here, while a list stays the compact index it has always been.
   */
  outcome?: string;
  /** Its short form, when the record has one. */
  outcome_summary?: string;
  /** Complete report history, chronological, never treated as inferred approval. By-key only. */
  reports?: { event_id: number; text: string }[];
  /** The exact pinned dispatch content, independent of later reports. By-key only. */
  brief?: string;
  /** Saved closing choices/answers from the timeline, not inferred from prose. */
  decisions?: { event_id: number; text: string; data: Record<string, unknown> | null }[];
  /** Explicitly named source, never guessed from the prose. */
  basis?: string;
  /**
   * Every task that names this one as its basis, open or closed, with its
   * status, closing reason, short outcome and change (INF-976): the work
   * already built on an answer, read before filing or starting more on it.
   * By-key only.
   */
  built_on_by?: TaskQueryBuiltOn[];
  /** The task whose last commit its working copy starts at (INF-799). */
  branch_from?: string;
  /** The JSON Schema its report's result must fit (INF-799). By-key only. */
  result_schema?: Record<string, unknown>;
  /** Its latest typed result, as the host checked it (INF-799). By-key only. */
  result?: Record<string, unknown>;
  /**
   * The body of the task's newest card, open or resolved - an answer task's
   * card IS its deliverable. By-key only, for the same reason.
   */
  card?: string;
  /** Persisted closing offer/action/answers, not the proposal defaults. By-key only. */
  resolution?: TaskQueryResolution;
  /**
   * The captain's pictures that came with the task's messages, by name and
   * the app's own copy (`TaskService.pictures`). By-key only.
   */
  pictures?: { name: string; path: string }[];
  live_validation?: LiveValidation;
  validation_assignment?: TaskDelivery["validationAssignment"];
  /** The computer the task's crewmate ran on (INF-1217). By-key only. */
  computer?: string;
  /** Its evidence folder on that computer (INF-1217). By-key only. */
  evidence_folder?: string;
  updated_at: string;
};

/** One task built on the read task, as a by-key read names it (INF-976). */
export type TaskQueryBuiltOn = {
  key: string;
  task_id: string;
  title: string;
  status: string;
  closed_reason?: string;
  outcome_summary?: string;
  change?: { label?: string; url?: string };
};

/** The work built on a task, open or closed, as the by-key read and the wakes name it. */
export function builtOnRows(tasks: TaskService, id: string): TaskQueryBuiltOn[] {
  return tasks.builtOn(id).map((record) => {
    const change = record.delivery ? taskChangeOf(record.delivery) : null;
    return {
      key: record.key || record.id,
      task_id: record.id,
      title: record.title,
      status: statusText(record),
      ...(record.closedReason ? { closed_reason: record.closedReason } : {}),
      ...(record.outcomeSummary ? { outcome_summary: record.outcomeSummary } : {}),
      ...(change && (change.label || change.url)
        ? {
            change: {
              ...(change.label ? { label: change.label } : {}),
              ...(change.url ? { url: change.url } : {}),
            },
          }
        : {}),
    };
  });
}

export const TASK_QUERY_DEFAULT_LIMIT = 30;
export const TASK_QUERY_MAX_LIMIT = 100;

const STATUS_ORDER: Record<TaskStatus, number> = {
  active: 0,
  open: 1,
  done: 2,
  dropped: 3,
};

function statusText(record: TaskRecord): string {
  if (record.status === "active") return record.activity ?? "active";
  return record.status;
}

function matchesStatus(record: TaskRecord, status: TaskQueryInput["status"]): boolean {
  if (!status) return true;
  if (status === "live") return !TaskService.isClosed(record);
  if (status === "closed") return record.status === "done" || record.status === "dropped";
  return record.status === status;
}

export function queryTasks(
  tasks: TaskService,
  input: TaskQueryInput,
  repoName: (repoId: string) => string | undefined = () => undefined,
  /**
   * The body of a task's newest card, when the caller can read one (Task
   * B). Supplied by the core's composition; a caller with no card store
   * simply returns no body and the row carries none.
   */
  cardBody: (taskId: string) => string | undefined = () => undefined,
  resolution: (taskId: string) => CardResolution | undefined = () => undefined,
  /** Each live task's work posture, read as the board reads it; absent says nothing is known. */
  posture: (record: TaskRecord) => WorkPosture | undefined = () => undefined,
  reach: TaskQueryReach = {},
): { rows: TaskQueryRow[]; total: number; projects?: TaskQueryProject[] } {
  if (input.projects) return { rows: [], total: 0, projects: projectRows(tasks, reach) };
  const limit = Math.max(
    1,
    Math.min(input.limit ?? TASK_QUERY_DEFAULT_LIMIT, TASK_QUERY_MAX_LIMIT),
  );
  const project = input.project?.trim()
    ? (tasks.projects.byKey(input.project) ?? tasks.projects.get(input.project))
    : undefined;
  if (input.project?.trim() && !project) return { rows: [], total: 0 };
  const parent = input.parent?.trim() ? tasks.resolve(input.parent) : undefined;
  if (input.parent?.trim() && !parent) return { rows: [], total: 0 };
  const one = input.key?.trim() ? tasks.resolve(input.key) : undefined;
  if (input.key?.trim() && !one) return { rows: [], total: 0 };
  const typed = input.text?.trim();
  const needle = typed ? foldForSearch(typed) : undefined;
  const pool = one ? [one] : parent ? tasks.children(parent.id) : tasks.list();
  const matched = pool
    .filter((record) => !project || record.projectId === project.id)
    .filter((record) => matchesStatus(record, input.status))
    .filter(
      (record) =>
        !needle ||
        foldForSearch(record.title).includes(needle) ||
        foldForSearch(record.goal ?? "").includes(needle),
    )
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.priority - b.priority ||
        b.updatedAt - a.updatedAt,
    );
  const projectKeys = new Map(tasks.projects.list().map((entry) => [entry.id, entry.key]));
  const skip = one ? 0 : Math.max(0, Math.floor(input.skip ?? 0));
  const rows = matched
    .slice(skip, skip + limit)
    // A by-key fetch is one row and reads the whole answer; a list is the
    // compact index and never carries bodies in bulk.
    .map((record) => {
      const resolved = one ? resolution(record.id) : undefined;
      const row = toRow(tasks, record, projectKeys, repoName, one ? cardBody : undefined, posture);
      return {
        ...row,
        ...(one
          ? {
              ...(input.field === "timeline" && reach.timeline
                ? { timeline: reach.timeline.sources(record.id) }
                : {}),
              sessions: tasks.sessions(record.id, reach.sessionFolderOf?.(record)),
              ...(record.shape?.escalate_from
                ? {
                    earlier_attempt:
                      tasks.resolve(record.shape.escalate_from)?.key ?? record.shape.escalate_from,
                  }
                : {}),
            }
          : {}),
        ...(resolved ? { resolution: queryResolution(resolved, row.card) } : {}),
        ...(one && record.delivery?.liveValidation
          ? {
              live_validation: {
                ...record.delivery.liveValidation,
                runs: record.delivery.liveValidation.runs.map((run) => ({
                  ...run,
                  evidence: run.evidence.map(({ text: _text, ...item }) => item),
                })),
              },
            }
          : {}),
        ...(one && record.delivery?.validationAssignment
          ? { validation_assignment: record.delivery.validationAssignment }
          : {}),
        ...(one ? (reach.placeOf?.(record) ?? {}) : {}),
      };
    });
  return { rows, total: matched.length };
}

function toRow(
  tasks: TaskService,
  record: TaskRecord,
  projectKeys: Map<string, string>,
  repoName: (repoId: string) => string | undefined,
  cardBody?: (taskId: string) => string | undefined,
  posture: (record: TaskRecord) => WorkPosture | undefined = () => undefined,
): TaskQueryRow {
  const history = cardBody ? tasks.timeline(record.id) : [];
  const reports = cardBody
    ? tasks.reportEntries(record.id).map((entry) => ({ event_id: entry.eventId, text: entry.text }))
    : [];
  const result = cardBody ? tasks.latestResult(record.id) : undefined;
  const briefed = history.filter((event) => event.kind === "briefed").at(-1);
  const brief = briefed ? tasks.servedBrief(briefed) : undefined;
  const decisions = history
    .filter((event) => event.kind === "card_resolved")
    .map((event) => ({ event_id: event.id, text: event.text, data: decisionData(event.data) }));
  const flags = tasks.flagsOf(record);
  const parent = record.parentId ? tasks.get(record.parentId) : undefined;
  // An active row names what holds it now, by the board's own rule
  // (./holdingWaits.ts); an open row also names a dropped blocker, which
  // can never clear, so the reader can act on it.
  const now = record.status === "active" ? posture(record) : undefined;
  const blockedBy = (
    record.status === "active"
      ? tasks.waitsHolding(record.id, now?.state === "idle" && now.reason === "dependency")
      : tasks.waitingOn(record.id)
  ).map((blocker) => blocker.key || blocker.id);
  const blocks = tasks.blocking(record.id).map((blocked) => blocked.key || blocked.id);
  const children = tasks.children(record.id);
  const openChildren = children.filter((child) => !TaskService.isClosed(child));
  const origins = tasks.discoveredOrigins(record.id);
  const followUps = tasks.discoveredFrom(record.id);
  const openFollowUps = followUps.filter((followUp) => !TaskService.isClosed(followUp));
  const repo = record.repoId ? repoName(record.repoId) : undefined;
  const change = record.delivery ? taskChangeOf(record.delivery) : null;
  const waiting = record.gate
    ? record.gate.kind === "captain"
      ? (record.gate.reason ?? "waiting on you")
      : record.gate.kind === "quota-reset"
        ? `quota (${record.gate.ref ?? "unknown scope"})`
        : "a set time"
    : flags.blocked && blockedBy.length > 0
      ? `blocked by ${blockedBy.join(", ")}${flags.deadBlocker ? " (dropped - cannot clear)" : ""}`
      : undefined;
  const policies = tasks.policiesOf(record);
  const pictures = cardBody ? picturesOf(tasks, record.id) : [];
  const builtOnBy = cardBody ? builtOnRows(tasks, record.id) : [];
  return {
    key: record.key || record.id,
    task_id: record.id,
    ...(record.closedReason === "merged" || record.closedReason === "landed"
      ? {
          first_release: record.delivery?.firstRelease ?? null,
          ...(record.delivery?.mergedSha ? { merge_commit: record.delivery.mergedSha } : {}),
        }
      : {}),
    ...(record.delivery?.captainAction ? { required_action: record.delivery.captainAction } : {}),
    ...(policies ? { policies } : {}),
    kind: record.kind,
    status: statusText(record),
    title: record.title,
    project: projectKeys.get(record.projectId) ?? record.projectId,
    priority: record.priority,
    ...(record.status === "open" && record.kind === "work"
      ? { start_policy: record.startPolicy }
      : {}),
    ...(parent ? { parent: parent.key || parent.id } : {}),
    ...(blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(children.length > 0
      ? { children: `${openChildren.length} open of ${children.length}` }
      : {}),
    ...(origins.length > 0
      ? { discovered_from: origins.map((origin) => origin.key || origin.id) }
      : {}),
    ...(followUps.length > 0
      ? { follow_ups: `${openFollowUps.length} open of ${followUps.length}` }
      : {}),
    ...(record.assignee ? { assignee: record.assignee } : {}),
    ...(repo ? { repo } : {}),
    ...(change
      ? {
          change: {
            ...(change.label ? { label: change.label } : {}),
            ...(change.url ? { url: change.url } : {}),
          },
        }
      : {}),
    ...(flags.ready && record.kind === "work" ? { ready: true as const } : {}),
    ...(waiting ? { waiting } : {}),
    ...(record.closedReason ? { closed_reason: record.closedReason } : {}),
    ...(record.goal ? { goal: record.goal } : {}),
    ...(record.shape?.override_speed ? { crew_speed: record.shape.override_speed } : {}),
    ...(record.shape?.override_reasoning ? { reasoning: record.shape.override_reasoning } : {}),
    ...(record.shape?.basis ? { basis: record.shape.basis } : {}),
    ...(builtOnBy.length > 0 ? { built_on_by: builtOnBy } : {}),
    ...(record.shape?.branch_from ? { branch_from: record.shape.branch_from } : {}),
    ...(cardBody && record.shape?.result_schema
      ? { result_schema: record.shape.result_schema }
      : {}),
    ...(result ? { result: result.value } : {}),
    ...(cardBody ? { reports, decisions, ...(brief ? { brief } : {}) } : {}),
    ...(cardBody && record.outcome ? { outcome: record.outcome } : {}),
    ...(cardBody && record.outcomeSummary ? { outcome_summary: record.outcomeSummary } : {}),
    ...(cardBody ? (body(cardBody, record.id) ?? {}) : {}),
    ...(pictures.length > 0 ? { pictures } : {}),
    updated_at: new Date(record.updatedAt).toISOString(),
  };
}

/** Every project the record keeps, by key, with its folder where it has one. */
function projectRows(tasks: TaskService, reach: TaskQueryReach): TaskQueryProject[] {
  return tasks.projects
    .list()
    .filter((project) => project.archivedAt === null)
    .map((project) => {
      const folder = project.repoId ? reach.projectFolder?.(project.repoId) : undefined;
      return { key: project.key, name: project.name, ...(folder ? { folder } : {}) };
    });
}

/** The task's pictures by name and copy; a saved reference that points nowhere is left out. */
function picturesOf(tasks: TaskService, taskId: string): { name: string; path: string }[] {
  return tasks.pictures(taskId).flatMap((ref) => {
    try {
      return [{ name: ref.name, path: attachmentPath(ref) }];
    } catch {
      return [];
    }
  });
}

/** The newest card's body as a row field, or nothing when there is none. */
function body(
  cardBody: (taskId: string) => string | undefined,
  taskId: string,
): { card: string } | undefined {
  const card = cardBody(taskId);
  return card ? { card } : undefined;
}

/**
 * A decision's data as the by-key read has always shown it: the card
 * evidence alias a newer event carries (`observation`) is the unified
 * timeline's, not the reader's.
 */
function decisionData(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data || !("observation" in data)) return data;
  const { observation: _alias, ...rest } = data;
  return rest;
}
