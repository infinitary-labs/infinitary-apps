import { z } from "zod";
import type { taskLifecycleOpSchema } from "./cards";
import { modelReasonSchema } from "./modelReason";
import { slotSchema } from "./modelSlots";
import { placementSnapshotSchema } from "./placement";
import { reasoningSchema } from "./reasoning";
import { repoDeliverySchema } from "./repos";
import { captainActionSchema, requiredActionStatusSchema } from "./requiredActions";
import { reviewRiskSchema, reviewVerdictSchema, rigorSchema } from "./rigor";
import { riskAssessmentSchema } from "./risk";
import { deliverableSchema } from "./routingPolicy";
import { taskBrowserFactSchema } from "./taskBrowser";
import { taskPlanSchema } from "./taskPlan";
import { effectiveTaskPoliciesSchema, taskRunsOnSchema } from "./taskPolicies";
import { workPostureSchema } from "./workPosture";

/**
 * The task protocol's wire surface (task-system design section 9, P3).
 *
 * Everything a client learns about tasks crosses in these shapes: the
 * board (`inf:tasks` push, `inf:tasks:board` invoke) is the bounded LIVE set
 * rebuilt from SQLite after every commit and pushed whole, coalesced;
 * `inf:tasks:detail` is one record in full; `inf:projects:list` is the
 * project index with counts. Two FmEvents ride beside them
 * (`src/shared/events.ts`): `task_changed` for per-task invalidation and
 * `task_event` as the feed's source.
 *
 * The enums mirror the record's own vocabulary in
 * `src/core/storage/taskStore.ts` and `taskEventStore.ts`; the core's view
 * builder (`src/core/tasks/taskProtocol.ts`) assigns record fields into
 * these types, so a value added on one side without the other fails
 * typecheck rather than a client's parse.
 */

export const taskStatusSchema = z.enum(["open", "active", "done", "dropped"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskActivitySchema = z.enum(["starting", "running", "idle", "interrupted"]);
export type TaskActivity = z.infer<typeof taskActivitySchema>;

export const taskKindSchema = z.enum(["work", "question", "decision", "operation"]);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskClosedReasonSchema = z.enum([
  "landed",
  "merged",
  "released",
  "answered",
  "settled",
  "finished",
  "cancelled",
  "discarded",
  "failed",
  "superseded",
]);
export type TaskClosedReason = z.infer<typeof taskClosedReasonSchema>;

export const taskLinkTypeSchema = z.enum(["blocks", "related", "discovered-from", "replaced-by"]);
export type TaskLinkType = z.infer<typeof taskLinkTypeSchema>;

export const taskEventActorSchema = z.enum([
  "captain",
  "firstmate",
  "crewmate",
  "supervisor",
  "host",
]);
export type TaskEventActor = z.infer<typeof taskEventActorSchema>;

export const taskEventKindSchema = z.enum([
  "created",
  "ask",
  "answered",
  "briefed",
  "dispatched",
  "steered",
  "progress",
  "report",
  "failed",
  "card_raised",
  "card_resolved",
  "status",
  "linked",
  "unlinked",
  "moved",
  "pr_opened",
  "ci",
  "landed",
  "merged",
  "triaged",
  "note",
  "compacted",
  "interrupted",
  "decided",
  "escalated",
  "review",
  "cap_reset",
  "replied",
]);
export type TaskEventKind = z.infer<typeof taskEventKindSchema>;

/**
 * How a task's work reached its destination: one of the repository's
 * delivery postures, or `in-place` - the personal workspace's commit at the
 * end of each turn, which is its KIND's business rather than a posture
 * (Task A of the posture rationalization; it read `live` before).
 */
export const taskDeliveryModeSchema = z.enum([...repoDeliverySchema.options, "in-place"]);
export type TaskDeliveryMode = z.infer<typeof taskDeliveryModeSchema>;

/** Delivery facts as they become known (check_pr_ci, land, merge-pr, review). */
export const taskDeliveryViewSchema = z.object({
  captainAction: captainActionSchema.optional(),
  mode: taskDeliveryModeSchema,
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  /** The change's name where the project lives: `#N`, or the sent-up branch. */
  changeLabel: z.string().optional(),
  /** The PR head the last CI read saw. */
  headSha: z.string().optional(),
  ci: z.enum(["green", "red", "pending", "no-pr", "merged"]).optional(),
  ciAt: z.number().optional(),
  landedMode: z.enum(["fast-forward", "merge", "pr"]).optional(),
  landedAt: z.number().optional(),
  /** The independent review's latest verdict on a reviewed task (delivery rigor phase 2). */
  reviewVerdict: reviewVerdictSchema.optional(),
  /** The head the reviewer read. */
  reviewSha: z.string().optional(),
  reviewRisk: reviewRiskSchema.optional(),
  reviewRiskNote: z.string().optional(),
  reviewedAt: z.number().optional(),
  /**
   * The round counters and caps the host enforces (delivery rigor phase
   * 3): unsuccessful declared own repairs (legacy records counted red heads), findings verdicts the review
   * returned, and when each cap was reached - present while the cap holds
   * and cleared by the steer that reopens the rounds (`cap_reset`).
   */
  ciRounds: z.number().optional(),
  ciRedHead: z.string().optional(),
  ciCapAt: z.number().optional(),
  reviewRounds: z.number().optional(),
  /** The head the last COUNTED findings round read: a round is one per head. */
  reviewRoundSha: z.string().optional(),
  reviewCapAt: z.number().optional(),
  /** The captain answered a Firstmate decision card on the task since the cap. */
  capAnsweredAt: z.number().optional(),
  /**
   * The risk assessment on the task's newest completion card: the levels and
   * lines its crewmate declared
   * (docs/card-authoring.md "The risk chart"). No overall level exists.
   */
  risk: riskAssessmentSchema.optional(),
});
export type TaskDeliveryView = z.infer<typeof taskDeliveryViewSchema>;

/** Derived on read, never stored (design principle 4). */
export const taskFlagsSchema = z.object({
  /** An uncleared `blocks` edge points at it. */
  blocked: z.boolean(),
  /** A gate (quota-reset, at-time, captain) holds it. */
  held: z.boolean(),
  /** An open decision card on it, a captain hold, or a dead blocker. */
  needsYou: z.boolean(),
  /** Open, unblocked, unheld work: dispatches when its start policy is when-ready. */
  ready: z.boolean(),
});
export type TaskFlags = z.infer<typeof taskFlagsSchema>;

/**
 * A start the captain asked for, before the crewmate begins. Published on
 * the board so both task surfaces leave Backlog at once. Absent once the
 * attempt is claimed, refused, or known to have failed.
 */
export const startAttemptSchema = z.object({
  phase: z.enum(["preparing", "checking"]),
  /** When the attempt was accepted, for the record's slow-start line. */
  since: z.number(),
});
export type StartAttempt = z.infer<typeof startAttemptSchema>;

/**
 * A confirmed manual start that did not begin. The task is back where its
 * start policy puts it; the reason stays until retry or another resolution.
 */
export const startNoticeSchema = z.object({
  reason: z.string(),
});
export type StartNotice = z.infer<typeof startNoticeSchema>;

/** Whether a move is open to a task now, or why not (src/shared/taskMoves.ts). */
const taskMoveAllowanceSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), text: z.string() }),
]);

/**
 * Where a task runs when that is a computer other than this Mac
 * (docs/helper.md, "Runs on"): where it started, or where it would start
 * now. `name` is that computer as the feed names it ("Mac mini", "Running
 * as Builder"), `where` as the Tasks row reads it after the project ("on
 * Mac mini", "as Builder"). `outOfReach` is present while open or underway
 * work's computer is out of reach, or back and not yet caught up.
 */
export const taskPlaceSchema = z.object({
  name: z.string(),
  where: z.string(),
  outOfReach: z.literal(true).optional(),
  /**
   * With `outOfReach`: the computer is connected on an older Firstmate and
   * takes no new work until it is updated, which is not being out of reach.
   */
  noNewWork: z.literal(true).optional(),
  /**
   * With `outOfReach`: the computer is out of reach only because its
   * connection is being made (`deviceConnecting`), so the task says
   * connecting, with no warn mark. `outOfReach` stays so a paired view on
   * protocol 8.5, which knows only that marker, still draws it.
   */
  connecting: z.literal(true).optional(),
});
export type TaskPlace = z.infer<typeof taskPlaceSchema>;

export const taskViewSchema = z.object({
  id: z.string(),
  /** `<PROJECT_KEY>-<seq>`, the conversational handle (D6). */
  key: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  /** Builder whose change this active host-commissioned review reads; absent for other work. */
  reviewOf: z.string().nullable().optional(),
  /** Actual execution device; null is the home Mac, absent on an older home. */
  executionDeviceId: z.string().nullable().optional(),
  /** Where it runs, in words, when another computer runs it; absent on this Mac. */
  place: taskPlaceSchema.optional(),
  kind: taskKindSchema,
  title: z.string(),
  goal: z.string().nullable(),
  /** 0 urgent .. 3 low. */
  priority: z.number(),
  status: taskStatusSchema,
  activity: taskActivitySchema.nullable(),
  workPosture: workPostureSchema.optional(),
  closedReason: taskClosedReasonSchema.nullable(),
  startPolicy: z.enum(["when-ready", "on-request"]),
  flags: taskFlagsSchema,
  /** Keys of live (open/active) blockers; closed edges remain graph history. */
  blockedBy: z.array(z.string()),
  /** Keys of the tasks waiting on this one. */
  blocks: z.array(z.string()),
  children: z.object({ total: z.number(), closed: z.number() }),
  assignee: z.string().nullable(),
  model: z.string().nullable(),
  /**
   * The intelligence slot the task's crewmate is served on: its newest
   * routing decision's served slot - the weaker one when the ladder fell
   * back - or, on a row routed before `served` was recorded, the slot it
   * asked for. Null when the task never routed. The crew orbit paints it
   * as the crewmate's solid.
   */
  tier: slotSchema.nullable(),
  repo: z.object({ name: z.string(), branch: z.string() }).nullable(),
  delivery: taskDeliveryViewSchema.nullable(),
  /**
   * The latest report's one-line headline: the summary its crewmate gave,
   * else its first sentence past any Intent section.
   */
  outcomeSummary: z.string().nullable(),
  /** Reachable shown ready decision on a live task; not durable attention/holds. */
  waitingCardId: z.string().nullable(),
  /** Its waiting card settles with a merge: only that card's own button merges. Absent otherwise. */
  waitingCardMerges: z.literal(true).optional(),
  /**
   * Open, underway or dropped work: which lifecycle moves (`TASK_LIFECYCLE_OPS`)
   * it allows now, and why not, by the task record's own rule
   * (`taskMovesOf`, src/shared/taskMoves.ts). `inf:task:run` checks again.
   */
  moves: z
    .object({
      "start-task": taskMoveAllowanceSchema,
      "start-again": taskMoveAllowanceSchema.optional(),
      "stop-task": taskMoveAllowanceSchema,
      "continue-task": taskMoveAllowanceSchema,
      "drop-task": taskMoveAllowanceSchema,
      "queue-task": taskMoveAllowanceSchema,
      "unqueue-task": taskMoveAllowanceSchema,
      "show-card": taskMoveAllowanceSchema.optional(),
    } satisfies Record<z.infer<typeof taskLifecycleOpSchema>, z.ZodType>)
    .optional(),
  /**
   * Its crewmate's last report declared that it waits on the captain
   * (FI3-435), with or without a card up. Present only while that stands.
   */
  captainWait: z.boolean().optional(),
  requiredAction: requiredActionStatusSchema.optional(),
  /** Replacement key, including a stronger-model retry; absent when none replaced it. */
  replacedBy: z.string().optional(),
  /** Origin key when a crewmate filed this row. Absent otherwise. */
  foundOn: z.string().optional(),
  /** Crew-filed, and the captain has not opened the record yet. */
  filingNew: z.boolean().optional(),
  /** Accepted start, not yet a running crewmate. Absent otherwise. */
  startAttempt: startAttemptSchema.optional(),
  /** Confirmed manual start failure. Absent once cleared. */
  startNotice: startNoticeSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;

/**
 * Open work that has never started. The record's Drop task is offered only
 * here, and the host refuses a drop that no longer matches.
 */
export function isUnstartedWork(
  task: Pick<TaskView, "kind" | "status" | "startedAt" | "activity">,
): boolean {
  return (
    task.kind === "work" &&
    task.status === "open" &&
    task.startedAt == null &&
    task.activity == null
  );
}

/** One task a drop would name: a part, or a task waiting on this one. */
export const dropEffectTaskSchema = z.object({
  key: z.string(),
  title: z.string(),
});

/**
 * What Drop task would affect, computed with the record. Absent once the
 * row is no longer unstarted work. Open parts are refused, not dropped.
 */
export const dropEffectsSchema = z.object({
  parts: z.array(dropEffectTaskSchema.extend({ started: z.boolean() })),
  waiting: z.array(dropEffectTaskSchema),
  underway: z.array(dropEffectTaskSchema),
});
export type DropEffects = z.infer<typeof dropEffectsSchema>;

export const taskLinkViewSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  type: taskLinkTypeSchema,
});
export type TaskLinkView = z.infer<typeof taskLinkViewSchema>;

export const projectViewSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  repo: z
    .object({ name: z.string(), delivery: repoDeliverySchema, autonomy: z.boolean() })
    .nullable(),
  archived: z.boolean(),
  counts: z.object({
    /** Broader durable attention, including holds and dead dependencies. */
    needsYou: z.number(),
    /** Live tasks with a reachable shown ready decision, each counted once. */
    waitingOnYou: z.number(),
    open: z.number(),
    active: z.number(),
    /** Done within the board's recent window. */
    doneRecent: z.number(),
  }),
});
export type ProjectView = z.infer<typeof projectViewSchema>;

/**
 * The live board: open and active rows, rows closed within
 * `BOARD_RECENT_MS`, and the parents of every row shown. History never
 * rides the push (design section 9.1); it is read one task at a time.
 */
export const taskBoardSchema = z.object({
  /** Monotonic per mutation; a later push with a lower seq is stale. */
  seq: z.number(),
  /** When this snapshot was built. */
  at: z.number(),
  projects: z.array(projectViewSchema),
  tasks: z.array(taskViewSchema),
  /** Edges whose both ends are on the board. */
  links: z.array(taskLinkViewSchema),
});
export type TaskBoard = z.infer<typeof taskBoardSchema>;

/** Closed rows stay on the board this long after closing. */
export const BOARD_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export const taskEventViewSchema = z.object({
  id: z.number(),
  at: z.number(),
  actor: taskEventActorSchema,
  kind: taskEventKindSchema,
  /** The timeline line, as recorded. */
  text: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  ref: z.string().nullable(),
  feed: z.boolean(),
});
export type TaskEventView = z.infer<typeof taskEventViewSchema>;

/** One event of a record's Activity (`condenseActivity`), in plain words. */
export const taskActivityLineSchema = z.object({
  /** The event it reads, so a client can key it. */
  id: z.number(),
  at: z.number(),
  kind: taskEventKindSchema,
  text: z.string(),
  /**
   * The other task that wrote it, when the event is a linked task's that
   * concerns this one (docs/task-record.md, "Whom an event concerns"), so
   * a client can name it and open its record. Absent on the task's own.
   */
  from: z.object({ id: z.string(), key: z.string() }).optional(),
  /**
   * The words of `text` that name a pull request with a page - `[from, to)`,
   * such as "pull request #612" - and that page, so a client links them
   * (the design skill's TaskRecord, "Pull request links"). Absent when the
   * line names none, or the host has no page for it.
   */
  change: z.object({ url: z.string(), from: z.number(), to: z.number() }).optional(),
});
export type TaskActivityLine = z.infer<typeof taskActivityLineSchema>;

/**
 * One thing a crewmate did, read from the session the app keeps for its
 * task, never from the task table (docs/task-record.md, "A crewmate's
 * actions"): the line the crewmate wrote to say what a call does, or a
 * plain reading of the call when it wrote none.
 */
export const taskActionLineSchema = z.object({
  at: z.number(),
  text: z.string(),
});
export type TaskActionLine = z.infer<typeof taskActionLineSchema>;

/**
 * One row of a record's Activity, with the minor events folded under it
 * (docs/task-record.md, "What Activity holds"): the ones that led to it,
 * oldest first, and for the newest row the ones since. Absent when none.
 * `actions` folds what the crewmate did the same way.
 */
export const taskActivityRowSchema = taskActivityLineSchema.extend({
  folded: z.array(taskActivityLineSchema).optional(),
  actions: z.array(taskActionLineSchema).optional(),
});
export type TaskActivityRow = z.infer<typeof taskActivityRowSchema>;

export const taskAskViewSchema = z.object({
  id: z.string(),
  at: z.number(),
  text: z.string(),
  /** How many images rode the ask; never the bytes. */
  images: z.number(),
  attachedVia: z.string().nullable(),
  turnState: z.enum(["open", "closed", "failed"]),
});
export type TaskAskView = z.infer<typeof taskAskViewSchema>;

/** The structured spawn intent (src/core/orchestrator/intentBrief.ts). */
export const taskIntentViewSchema = z.object({
  goal: z.string(),
  userWords: z.string(),
  constraints: z
    .array(
      z.object({
        kind: z.enum([
          // Retired at contract 4.6 (a plan is its own step now); a stored
          // intent may still name it.
          "plan-first",
          "read-only",
          "tests-required",
          "no-new-deps",
          "minimal-diff",
          "free",
        ]),
        text: z.string().optional(),
      }),
    )
    .optional(),
  deliveryNote: z.string().optional(),
});

/**
 * One card a task showed, for the record's Cards row (FI3-579 piece 1): the
 * kind the captain knows it by, its title (the version last seen once it has
 * closed), and how it ended in the captain's words. An `open` card is still on
 * the stage (a folded seen note included), so the row points at the live card;
 * a `closed` one opens as the read-only past card.
 */
export const taskCardRowSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["decision", "note"]),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  /** How a closed card ended (`pastEndingWords`); absent while it is open. */
  ending: z.string().optional(),
  /** When it ended, or when an open card was raised. */
  at: z.number(),
});
export type TaskCardRow = z.infer<typeof taskCardRowSchema>;

/** One record in full: the view plus what the board leaves out. */
export const taskDetailSchema = taskViewSchema.extend({
  /** Current policies, separate from dispatch and published delivery history. */
  policies: effectiveTaskPoliciesSchema.nullable().optional(),
  /**
   * Where the task runs, once a computer that runs work is on the list:
   * where it started, or where it would start now. Absent otherwise, and
   * for a task that only ever runs on this Mac.
   */
  runsOn: taskRunsOnSchema.optional(),
  placement: placementSnapshotSchema.optional(),
  intent: taskIntentViewSchema.nullable(),
  /** Dispatch-time care; current care lives in policies. */
  rigor: rigorSchema.nullable(),
  /**
   * What the host derived this task DELIVERS (Task B of the crew-posture
   * rationalization); null on a row shaped before the axis existed, which
   * shipped as a change.
   */
  deliverable: deliverableSchema.nullable(),
  /**
   * The task this work builds on, as the record names it (a key or an id),
   * and whether it holds - done or reported - derived at read, never
   * stored. Null when no basis was named.
   */
  basis: z.object({ ref: z.string(), verified: z.boolean() }).nullable(),
  /** Firstmate's declared reason for building without a plan, if any. */
  skippedPlanBecause: z.string().nullable(),
  /** The rendered brief the crewmate ran from. */
  brief: z.string(),
  /** The latest complete report; an answer given on a card reads as the card's words. */
  outcome: z.string().nullable(),
  /** The assigned model as the captain knows it ("GPT-6 Sol"); null when none. */
  modelLabel: z.string().nullable(),
  /**
   * Why the crewmate runs on that model, off its routing decision's typed
   * columns; absent when the task never routed or the record cannot say.
   */
  modelReason: modelReasonSchema.optional(),
  /**
   * The reasoning the crewmate's session opened at on that model, as its
   * newest dispatch recorded it (FI3-439); absent when the record cannot say
   * or the crewmate has since moved to another model.
   */
  reasoning: reasoningSchema.optional(),
  /** Every card the task showed, open and past, newest first. */
  cards: z.array(taskCardRowSchema),
  /** The whole timeline, as recorded. */
  events: z.array(taskEventViewSchema),
  /** The timeline condensed for reading (the record's Activity; the popup audit, A8). */
  activityLog: z.array(taskActivityRowSchema),
  /**
   * The latest plan the crewmate reported with a progress note (FI3-734):
   * the whole list as declared, with its time; null when it never sent one.
   */
  plan: taskPlanSchema.nullable(),
  /**
   * How a closed row closed: when, and the words recorded with the close
   * (a drop's reason) when there were any beyond the reason's own word.
   */
  closing: z.object({ at: z.number(), note: z.string().nullable() }).nullable(),
  /**
   * The newest failure or interruption in plain words (`plainProblem`, whose
   * sign-in reading is the one classifier's); null when there was none. The
   * raw error stays on the timeline.
   */
  problem: z.string().nullable(),
  /**
   * Why a gate holds open work and what ends the wait, in the captain's
   * words (`taskHoldWords`, src/shared/taskHold.ts), read from its gate and
   * its own ask; absent when no gate holds it, or the captain's own does.
   */
  hold: z.object({ title: z.string(), text: z.string() }).optional(),
  asks: z.array(taskAskViewSchema),
  /** The filing, in the open on the record. Absent when this row was not crew-filed. */
  filing: z
    .object({
      why: z.string(),
      originKey: z.string(),
      verdict: z.string().nullable(),
    })
    .optional(),
  /** Present only while Drop task applies. The footer confirms these lists. */
  dropEffects: dropEffectsSchema.optional(),
  /**
   * The task's own browser on this Mac, as the captain reads it
   * (docs/task-browser.md, "The view"); absent while it never had one, and
   * on another computer.
   */
  browser: taskBrowserFactSchema.optional(),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

// ---- the delta (task-system P5, design section 9.1) ------------------------

/**
 * The live set above which the core pushes deltas instead of snapshots
 * (design section 9.1: "a snapshot over 256 KB or a live set over 500").
 * Below the trigger the snapshot stays: it is simplest and provably
 * consistent. Above it, one `inf:tasks:delta` per coalescing window carries
 * only what changed since the last push, on the same `seq`.
 */
export const BOARD_DELTA_TRIGGER = Object.freeze({
  /** Rows on the board. */
  rows: 500,
  /** Serialized snapshot size, in bytes of JSON. */
  bytes: 256 * 1024,
});

/**
 * What changed between two boards. `baseSeq` is the seq of the board the
 * delta applies to; a client whose board carries any other seq has missed
 * a push and resyncs from `inf:tasks:board`. `projects` ride whole: the
 * index is one row per managed repo, and its counts move on most writes.
 */
export const taskBoardDeltaSchema = z.object({
  /** The seq the client's board must carry for this delta to apply. */
  baseSeq: z.number(),
  /** The seq the board carries after applying it. */
  seq: z.number(),
  at: z.number(),
  /** Rows new or changed since the base, whole. */
  upserts: z.array(taskViewSchema),
  /** Ids of rows that left the board. */
  removed: z.array(z.string()),
  projects: z.array(projectViewSchema),
  links: z.object({
    added: z.array(taskLinkViewSchema),
    removed: z.array(taskLinkViewSchema),
  }),
});
export type TaskBoardDelta = z.infer<typeof taskBoardDeltaSchema>;

/**
 * The board's canonical row order (creation, then id), which the core's
 * snapshot and a client's applied delta share so that the two are equal as
 * arrays, not only as sets.
 */
export function sortBoardTasks(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function linkKey(link: TaskLinkView): string {
  return `${link.fromId} ${link.toId} ${link.type}`;
}

/** The board's canonical edge order (from, to, type). */
export function sortBoardLinks(links: readonly TaskLinkView[]): TaskLinkView[] {
  return [...links].sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
}

/**
 * The delta from `prev` to `next`: by construction
 * `applyTaskBoardDelta(prev, diffTaskBoards(prev, next))` deep-equals
 * `next` (pinned in tasks.test.ts). A row is upserted when its serialized
 * view differs, so a derived-flag change with no write of its own (a
 * blocker closing, a card leaving the stack) travels like any other.
 */
export function diffTaskBoards(prev: TaskBoard, next: TaskBoard): TaskBoardDelta {
  const before = new Map(prev.tasks.map((task) => [task.id, JSON.stringify(task)]));
  const upserts: TaskView[] = [];
  const seen = new Set<string>();
  for (const task of next.tasks) {
    seen.add(task.id);
    if (before.get(task.id) !== JSON.stringify(task)) upserts.push(task);
  }
  const removed = prev.tasks.filter((task) => !seen.has(task.id)).map((task) => task.id);
  const prevLinks = new Map(prev.links.map((link) => [linkKey(link), link]));
  const nextLinks = new Map(next.links.map((link) => [linkKey(link), link]));
  return {
    baseSeq: prev.seq,
    seq: next.seq,
    at: next.at,
    upserts,
    removed,
    projects: next.projects,
    links: {
      added: [...nextLinks.values()].filter((link) => !prevLinks.has(linkKey(link))),
      removed: [...prevLinks.values()].filter((link) => !nextLinks.has(linkKey(link))),
    },
  };
}

/**
 * Applies a delta to the board a client holds. Returns the board unchanged
 * when the delta is older than it (a stale push), the next board when the
 * delta's base is the board's seq, and null on a gap - the one signal to
 * resync from a fresh snapshot rather than guess.
 */
export function applyTaskBoardDelta(board: TaskBoard, delta: TaskBoardDelta): TaskBoard | null {
  if (delta.seq <= board.seq) return board;
  if (delta.baseSeq !== board.seq) return null;
  const rows = new Map(board.tasks.map((task) => [task.id, task]));
  for (const id of delta.removed) rows.delete(id);
  for (const task of delta.upserts) rows.set(task.id, task);
  const links = new Map(board.links.map((link) => [linkKey(link), link]));
  for (const link of delta.links.removed) links.delete(linkKey(link));
  for (const link of delta.links.added) links.set(linkKey(link), link);
  return {
    seq: delta.seq,
    at: delta.at,
    projects: delta.projects,
    tasks: sortBoardTasks([...rows.values()]),
    links: sortBoardLinks([...links.values()]),
  };
}
