import { checkSnapshotSchema } from "@shared/checkSnapshot";
import { committedPlacementSchema } from "@shared/placement";
import { workShapeSchema } from "@shared/routingPolicy";
import { effectiveTaskPoliciesSchema } from "@shared/taskPolicies";
import {
  taskActivitySchema,
  taskClosedReasonSchema,
  taskDeliveryModeSchema,
  taskEventActorSchema,
  taskEventKindSchema,
  taskIntentViewSchema,
  taskKindSchema,
  taskLinkTypeSchema,
  taskStatusSchema,
} from "@shared/tasks";
import { z } from "zod";
import type { AskRecord } from "../storage/askStore";
import type { ProjectRecord } from "../storage/projectStore";
import {
  TASK_CONCERN_RELATIONS,
  type TaskConcern,
  type TaskEvent,
} from "../storage/taskEventStore";
import type { TaskLink } from "../storage/taskLinkStore";
import type { TaskRecord } from "../storage/taskRecords";
import { type TaskReference, taskReferenceSchema } from "../storage/taskReferenceStore";
import {
  type TaskSession,
  type TaskSessionObservation,
  taskSessionObservationRecordSchema,
  taskSessionSchema,
} from "../storage/taskSessionStore";
import type { SavedSpecification } from "../storage/taskSpecificationStore";

/**
 * The task record as JSONL (task-system P5, design section 12): one line
 * per row of the five record tables - projects, tasks, timeline events,
 * links, captain asks - behind one header line, in the stores' own field
 * vocabulary. The export is the record itself, verbatim: nothing derived
 * (flags, views, feed lines) and nothing from outside the record (session
 * JSONL stays in place under `crewmates/<id>/sessions`, durable by D2;
 * worktree and session paths are exported as the machine-local strings
 * they are). Timeline event ids are storage-local and left out; order is
 * the timeline's.
 *
 * Round trip: `TaskService.archive.importRecords(parseTaskExport(lines))` on a
 * database holding none of these rows reproduces them, and exporting that
 * database again yields the same lines (taskExport.test.ts). The importer
 * refuses to overwrite: a task id or key, or a project key, already taken
 * is a refusal before anything is written.
 */

export const TASK_EXPORT_FORMAT = "infinitary-tasks/1";
/** The same lines as Firstmate 3000 named them before the Infinitary rename: still imported. */
const OLDER_TASK_EXPORT_FORMAT = "fm3000-tasks/1";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

const projectLineSchema = z.object({
  kind: z.literal("project"),
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string(),
  projectKind: z.enum(["scratch", "repo"]),
  repoId: nullableString,
  nextSeq: z.number().int().min(1),
  createdAt: z.number(),
  archivedAt: nullableNumber,
});

const gateSchema = z.object({
  kind: z.enum(["quota-reset", "at-time", "captain"]),
  ref: z.string().optional(),
  until: z.number().optional(),
  reason: z.string().optional(),
});

const deliverySchema = z.object({
  mode: taskDeliveryModeSchema,
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  changeLabel: z.string().optional(),
  ci: z.enum(["green", "red", "pending", "no-pr", "merged"]).optional(),
  ciAt: z.number().optional(),
  checks: checkSnapshotSchema.optional(),
  landedMode: z.enum(["fast-forward", "merge", "pr"]).optional(),
  closedPolicies: effectiveTaskPoliciesSchema.optional(),
  result: z.object({ at: z.number(), value: z.record(z.string(), z.unknown()) }).optional(),
});

const taskLineSchema = z.object({
  kind: z.literal("task"),
  id: z.string().min(1),
  key: z.string().min(1),
  seq: z.number().int(),
  projectId: z.string().min(1),
  parentId: nullableString,
  taskKind: taskKindSchema,
  title: z.string(),
  goal: nullableString,
  intent: taskIntentViewSchema.nullable(),
  prompt: z.string(),
  repoId: nullableString,
  repoDir: z.string(),
  worktreeDir: z.string(),
  branch: z.string(),
  sessionFile: nullableString,
  sessions: z.array(taskSessionSchema).optional(),
  sessionObservations: z
    .array(taskSessionObservationRecordSchema.omit({ taskId: true, seq: true }))
    .optional(),
  specifications: z
    .array(z.object({ goal: nullableString, prompt: z.string(), intentJson: nullableString }))
    .optional(),
  /**
   * Its basis, branch source and earlier attempt as recorded (INF-1296 piece
   * 2): who named each and when. The shape still carries each name under its
   * older field, so an export reads the same to a build before them.
   */
  references: z.array(taskReferenceSchema).optional(),
  /**
   * The recorded conversation its resume binding names (INF-1296 piece 3),
   * null when its token names none. An older export has none, and its
   * import names the conversation the token belongs to, as the upgrade does.
   */
  conversation: nullableString.optional(),
  accountId: nullableString,
  difficulty: z.enum(["low", "medium", "high", "premium"]).nullable(),
  shape: workShapeSchema.nullable(),
  placement: committedPlacementSchema.nullable().optional(),
  gate: gateSchema.nullable(),
  status: taskStatusSchema,
  activity: taskActivitySchema.nullable(),
  closedReason: taskClosedReasonSchema.nullable(),
  priority: z.number().int(),
  startPolicy: z.enum(["when-ready", "on-request"]),
  workspaceState: z.enum(["none", "present", "removed"]),
  outcome: nullableString,
  outcomeSummary: nullableString,
  delivery: deliverySchema.nullable(),
  assignee: nullableString,
  model: nullableString,
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: nullableNumber,
  closedAt: nullableNumber,
  testPath: z.string().nullable().optional(),
  captainOpenedAt: z.number().nullable().optional(),
  verdict: z.string().nullable().optional(),
});

const eventLineSchema = z.object({
  kind: z.literal("event"),
  taskId: z.string().min(1),
  identity: z
    .string()
    .regex(/^task-event:.+:-?\d+$/)
    .optional(),
  at: z.number(),
  actor: taskEventActorSchema,
  eventKind: taskEventKindSchema,
  text: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  ref: nullableString,
  feed: z.boolean(),
  /** The other tasks the event concerns (docs/task-record.md, "Whom an event concerns"). */
  concerns: z
    .array(
      z.object({
        taskId: z.string().min(1),
        relation: z.enum(TASK_CONCERN_RELATIONS),
        via: nullableString,
      }),
    )
    .optional(),
});

const linkLineSchema = z.object({
  kind: z.literal("link"),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  type: taskLinkTypeSchema,
  actor: taskEventActorSchema,
  createdAt: z.number(),
  /** Absent on an export from before the mark: a blocks edge was holding. */
  holdsMerge: z.boolean().optional(),
});

const askLineSchema = z.object({
  kind: z.literal("ask"),
  id: z.string().min(1),
  at: z.number(),
  text: z.string(),
  images: z.array(z.object({ mimeType: z.string() })),
  hintTaskId: nullableString,
  taskId: nullableString,
  attachedVia: nullableString,
  attachedAt: nullableNumber,
  turnState: z.enum(["open", "closed", "failed"]),
});

const headerLineSchema = z.object({
  kind: z.literal("header"),
  format: z.enum([TASK_EXPORT_FORMAT, OLDER_TASK_EXPORT_FORMAT]),
  exportedAt: z.number(),
  counts: z.object({
    projects: z.number().int(),
    tasks: z.number().int(),
    events: z.number().int(),
    links: z.number().int(),
    asks: z.number().int(),
  }),
});

const lineSchema = z.discriminatedUnion("kind", [
  headerLineSchema,
  projectLineSchema,
  taskLineSchema,
  eventLineSchema,
  linkLineSchema,
  askLineSchema,
]);

export type TaskExportLine = z.infer<typeof lineSchema>;

/** The parsed export: the record's rows, in the stores' own shapes. */
export type TaskExportBundle = {
  header: z.infer<typeof headerLineSchema>;
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  sessions?: { taskId: string; session: TaskSession }[];
  sessionObservations?: { taskId: string; observation: TaskSessionObservation & { id: string } }[];
  specifications?: { taskId: string; specifications: SavedSpecification[] }[];
  /** Recorded references; an older export has none, and its shapes name them. */
  references?: { taskId: string; reference: TaskReference }[];
  /** Each resume binding's recorded conversation; an older export has none. */
  conversations?: { taskId: string; conversation: string | null }[];
  /**
   * Timeline events, in export order (the timeline's), without storage ids,
   * each with the other tasks it concerns when it concerns any.
   */
  events: (Omit<TaskEvent, "id"> & { concerns?: TaskConcern[] })[];
  links: TaskLink[];
  asks: AskRecord[];
};

/** What the export reads; `TaskService` satisfies it. */
export type TaskExportSource = {
  projects: { list(): ProjectRecord[] };
  list(): TaskRecord[];
  archive?: {
    recordedSessions?(id: string): TaskSession[];
    sessionObservations?(
      id: string,
    ): (TaskSessionObservation & { id: string; taskId: string; seq: number })[];
    recordedSpecifications?(id: string): SavedSpecification[];
    recordedReferences?(id: string): TaskReference[];
    recordedConversation?(id: string): string | null;
  };
  timeline(id: string): TaskEvent[];
  /** Whom each event concerns, by event id. */
  eventConcerns(): Map<number, TaskConcern[]>;
  graph: { allLinks(): TaskLink[] };
  capture: { listAsks(): AskRecord[] };
};

/** The record as JSONL lines: a header, then every row, oldest first. */
export function exportTaskRecords(source: TaskExportSource, now = Date.now()): string[] {
  const projects = source.projects.list();
  const tasks = source.list();
  const events = tasks.flatMap((task) => source.timeline(task.id));
  const concerns = source.eventConcerns();
  const links = source.graph.allLinks();
  const asks = source.capture.listAsks();
  const lines: TaskExportLine[] = [
    {
      kind: "header",
      format: TASK_EXPORT_FORMAT,
      exportedAt: now,
      counts: {
        projects: projects.length,
        tasks: tasks.length,
        events: events.length,
        links: links.length,
        asks: asks.length,
      },
    },
    ...projects.map(
      (project): TaskExportLine => ({
        kind: "project",
        id: project.id,
        key: project.key,
        name: project.name,
        projectKind: project.kind,
        repoId: project.repoId,
        nextSeq: project.nextSeq,
        createdAt: project.createdAt,
        archivedAt: project.archivedAt,
      }),
    ),
    ...tasks.map((task): TaskExportLine => {
      const { kind, ...rest } = task;
      const specifications = source.archive?.recordedSpecifications?.(task.id) ?? [];
      const first = specifications[0];
      // A single canonical revision is already carried by the compatible
      // task line. Keep its raw payload too when that line cannot reproduce
      // it exactly (including older unknown intent fields or formatting).
      const keepSpecifications =
        specifications.length > 1 ||
        (first &&
          (first.goal !== task.goal ||
            first.prompt !== task.prompt ||
            first.intentJson !==
              (task.intent ? JSON.stringify(taskIntentViewSchema.parse(task.intent)) : null)));
      const sessions = source.archive?.recordedSessions?.(task.id) ?? [];
      const sessionObservations =
        source.archive
          ?.sessionObservations?.(task.id)
          .map(({ taskId: _taskId, seq: _seq, ...observed }) => observed) ?? [];
      const references = source.archive?.recordedReferences?.(task.id) ?? [];
      const conversation = task.sessionFile
        ? source.archive?.recordedConversation?.(task.id)
        : undefined;
      return {
        kind: "task",
        ...rest,
        taskKind: kind,
        ...(sessions.length ? { sessions } : {}),
        ...(sessionObservations.length ? { sessionObservations } : {}),
        ...(keepSpecifications ? { specifications } : {}),
        ...(references.length ? { references } : {}),
        ...(conversation !== undefined ? { conversation } : {}),
      };
    }),
    ...events.map((event): TaskExportLine => {
      const { id, kind, ...rest } = event;
      const about = concerns.get(id);
      return { kind: "event", ...rest, eventKind: kind, ...(about ? { concerns: about } : {}) };
    }),
    ...links.map((link): TaskExportLine => ({ kind: "link", ...link })),
    // The answer-delivery state and how the message ended are operational,
    // not part of the exported record.
    ...asks.map(
      ({
        delivery: _delivery,
        deliveryFacts: _facts,
        noticeCardId: _notice,
        followed: _followed,
        continues: _continues,
        answerCardId: _answerCard,
        acceptedAt: _accepted,
        answeredAt: _answered,
        crewmateAskedAt: _crewmateAsked,
        ...ask
      }): TaskExportLine => ({
        kind: "ask",
        ...ask,
      }),
    ),
  ];
  // Through the schema, so keys land in one canonical order on every
  // machine and the export is checked against its own contract as written.
  return lines.map((line) => JSON.stringify(lineSchema.parse(line)));
}

/**
 * Parses export lines back into records. Every line is validated against
 * its shape; a malformed or unknown line, a missing or wrong header, or a
 * count that does not match what follows is an Error naming the line.
 */
export function parseTaskExport(input: string | Iterable<string>): TaskExportBundle {
  const lines = typeof input === "string" ? input.split("\n") : [...input];
  let header: TaskExportBundle["header"] | undefined;
  const bundle: Omit<TaskExportBundle, "header"> = {
    projects: [],
    tasks: [],
    events: [],
    links: [],
    asks: [],
    sessions: [],
    sessionObservations: [],
    specifications: [],
    references: [],
    conversations: [],
  };
  let number = 0;
  for (const raw of lines) {
    number += 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Error(`Line ${number}: not JSON.`);
    }
    const kind = json && typeof json === "object" ? (json as { kind?: unknown }).kind : undefined;
    if (!header && kind !== "header") throw new Error(`Line ${number}: a row before the header.`);
    const parsed = lineSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Line ${number}: ${parsed.error.issues[0]?.message ?? "malformed"}.`);
    }
    const line = parsed.data;
    if (line.kind === "header") {
      if (header) throw new Error(`Line ${number}: a second header.`);
      header = line;
      continue;
    }
    switch (line.kind) {
      case "project": {
        const { kind: _kind, projectKind, ...rest } = line;
        bundle.projects.push({ ...rest, kind: projectKind });
        break;
      }
      case "task": {
        const {
          kind: _kind,
          taskKind,
          sessions,
          sessionObservations,
          specifications,
          references,
          conversation,
          ...rest
        } = line;
        if (specifications) bundle.specifications?.push({ taskId: rest.id, specifications });
        if (conversation !== undefined)
          bundle.conversations?.push({ taskId: rest.id, conversation });
        for (const observation of sessionObservations ?? [])
          bundle.sessionObservations?.push({ taskId: rest.id, observation });
        for (const session of sessions ?? []) bundle.sessions?.push({ taskId: rest.id, session });
        for (const reference of references ?? [])
          bundle.references?.push({ taskId: rest.id, reference });
        bundle.tasks.push({ ...rest, kind: taskKind });
        break;
      }
      case "event": {
        const { kind: _kind, eventKind, ...rest } = line;
        bundle.events.push({ ...rest, kind: eventKind });
        break;
      }
      case "link": {
        const { kind: _kind, holdsMerge, ...rest } = line;
        bundle.links.push({
          ...rest,
          holdsMerge: holdsMerge ?? rest.type === "blocks",
        });
        break;
      }
      case "ask": {
        const { kind: _kind, ...rest } = line;
        bundle.asks.push({
          ...rest,
          attachedVia: rest.attachedVia as AskRecord["attachedVia"],
          // The pictures' copies stay on the computer that exported the record.
          attachments: [],
          delivery: "legacy",
          deliveryFacts: { entries: [] },
          noticeCardId: null,
          followed: false,
          continues: null,
          answerCardId: null,
          acceptedAt: null,
          answeredAt: null,
          crewmateAskedAt: null,
        });
        break;
      }
    }
  }
  if (!header) throw new Error("No header line: not a task export.");
  const counts = {
    projects: bundle.projects.length,
    tasks: bundle.tasks.length,
    events: bundle.events.length,
    links: bundle.links.length,
    asks: bundle.asks.length,
  };
  for (const [table, count] of Object.entries(counts)) {
    const declared = header.counts[table as keyof typeof counts];
    if (declared !== count) {
      throw new Error(`The header declares ${declared} ${table}, the file holds ${count}.`);
    }
  }
  return { header, ...bundle };
}
