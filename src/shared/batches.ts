import { z } from "zod";
import * as m from "./i18n/messages.generated.ts";

/**
 * Batches of your own (docs/forge.md, "Batches of your own"): one person's
 * approved changes of one project, combined at home into one pull request.
 * These are the shapes of the local record `Batches` keeps on the project's
 * row; nothing here is written where the project lives.
 */

/** Every batch branch the app pushes starts with this, so a person and a rule can name them. */
export const BATCH_BRANCH_PREFIX = "infinitary-batch/";

/** An approved change, as the line holds it: a pushed branch at the approved version. */
export const batchChangeSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  /** The approved version of the branch. */
  head: z.string(),
  /** The change's checked title: its commit's subject in a batch. */
  title: z.string(),
  /** The commit's body: the story's What changed and any breaking footer. */
  body: z.string(),
  /** When it was approved (epoch ms): the line's order. */
  at: z.number(),
  /** Its own pull request, where it has one; closed with a link once the batch merges. */
  number: z.number().int().positive().optional(),
  /**
   * The branch its own pull request targets, when that is not the default
   * branch: a change stacked on another. It joins a batch only once that
   * branch's work is already in, so a batch never carries unapproved work.
   */
  base: z.string().optional(),
  /**
   * The task whose approved version this change was built on, while that
   * task had not merged (docs/task-graph.md, "A part that starts at
   * approval"); `base` names its pushed branch. The change waits in line,
   * never left out, until that task's work is merged or ahead of it.
   */
  after: z.string().optional(),
  /** Declared the held batch's fix: it joins that batch and ends the hold. */
  fix: z.literal(true).optional(),
  /**
   * The held batch version a fix was built on, once a combine verified it:
   * the fix is carried as its own difference from it from then on, and is
   * left out, never carried whole, when its branch no longer builds on it.
   */
  heldBase: z.string().optional(),
});
export type BatchChange = z.infer<typeof batchChangeSchema>;

/** A change in the open batch: its own commit on the batch branch. */
export const batchMemberSchema = batchChangeSchema.extend({ commit: z.string() });
export type BatchMember = z.infer<typeof batchMemberSchema>;

/**
 * Why a batch holds: its checks failed, the project allows no merge that
 * keeps its commits or refused the merge, or the host reads its pull request
 * as blocked by a rule of the default branch, such as a required review or
 * signed commits (`rules`), which ends by itself once the host lets it through.
 */
export const batchHoldSchema = z.object({
  at: z.number(),
  /** The batch's version the hold is about. */
  head: z.string(),
  reason: z.enum(["checks", "merge-way", "rules"]),
  /** The failed checks' names, as the host reads them. */
  checks: z.array(z.string()),
  /** The host's own words for a merge it refused. */
  detail: z.string().optional(),
  /**
   * The checks of the held version that were cancelled, skipped or still
   * unfinished when last read: none of them ran to an end on its changes.
   * Absent where it is not known: the reading was incomplete, the batch is
   * held for something other than its checks, or the hold was kept before
   * it was recorded.
   */
  notRun: z.array(z.string()).optional(),
});
export type BatchHold = z.infer<typeof batchHoldSchema>;

/** The one open batch of a project at this home. */
export const openBatchSchema = z.object({
  /** Approved repository address when this batch branch was first pushed. */
  origin: z.string().nullable().optional(),
  /** The batch branch the app owns. */
  branch: z.string(),
  /** Its version: the last member's commit. */
  head: z.string(),
  /** The default branch's commit it was combined onto. */
  base: z.string(),
  /** Absent until the host confirmed the pull request. */
  number: z.number().int().positive().optional(),
  url: z.string().nullable().optional(),
  /** Empty once every member was withdrawn: the pull request is then closed. */
  members: z.array(batchMemberSchema),
  since: z.number(),
  hold: batchHoldSchema.optional(),
  /**
   * The version the host's own merge queue took (docs/forge.md, "The host's
   * merge queue"): its place there is read, and nothing is sent again.
   */
  queued: z.string().optional(),
  /**
   * The version a merge was sent at whose outcome the host did not confirm,
   * on a host whose merge names no version (docs/forge.md, "Batches of your
   * own"): later passes read how it ended and never send it again.
   * `mergeTask` is the host's own reference to that merge, when it gave one.
   * `pending` is when a pass first read the host's merge as still running:
   * from then Settings → Projects shows the wait with Try again, and the
   * Activity feed said so once. No time decides that the merge ended.
   */
  unconfirmed: z
    .object({ head: z.string(), mergeTask: z.string().optional(), pending: z.number().optional() })
    .optional(),
  /** Its members, or the words of one, changed since it was pushed: the next pass combines it again. */
  stale: z.literal(true).optional(),
  /**
   * The repair whose declaration sent changes back beside its own fix: the
   * batch stays held at its version until that task's change is approved,
   * even once every member has left. Empty once that task closed first: the
   * batch stays held until another declared fix is approved or Try again.
   */
  awaits: z.string().optional(),
  /**
   * Its repair's judgment that the held version passed on a rerun of its
   * failed checks, such as the project's own rerun of the failed tests: at
   * `head`, the failed checks named in `checks` are answered, and the batch
   * merges once every other check passed. A fix declared meanwhile goes to
   * the next batch. A combine at a new version drops it.
   */
  passed: z.object({ head: z.string(), checks: z.array(z.string()) }).optional(),
});
export type OpenBatch = z.infer<typeof openBatchSchema>;

/**
 * The merge an open batch waits on while its host still reads it as running
 * (`unconfirmed.pending`), at the version the batch holds now: Settings →
 * Projects shows it with Try again. A held batch shows its hold instead.
 */
export function mergeWait(
  open: OpenBatch | undefined,
): { head: string; pending: number } | undefined {
  const sent = open?.unconfirmed;
  if (!open || open.hold || sent?.pending === undefined || sent.head !== open.head)
    return undefined;
  return { head: sent.head, pending: sent.pending };
}

/** A member of a merged batch: its own commit on the default branch, where it could be read. */
export const batchReceiptSchema = z.object({
  taskId: z.string(),
  head: z.string(),
  sha: z.string().optional(),
  /** The batch's pull request. */
  number: z.number().int().positive(),
  url: z.string().nullable().optional(),
  at: z.number(),
});
export type BatchReceipt = z.infer<typeof batchReceiptSchema>;

/**
 * One send-back of a change from its batch (INF-5097 piece 1): the version
 * sent back, the reason its crewmate read, the batch's pull request, and
 * the batch's checks that failed and that never ran to an end there. The
 * app keeps every one while the change's task is open, so the change's
 * repair, its crewmate and its merge card read how often it went back and
 * why; it judges nothing from them.
 */
export const batchSendBackSchema = z.object({
  taskId: z.string(),
  /** The version sent back. */
  head: z.string(),
  reason: z.string(),
  at: z.number(),
  /** The batch's pull request, where it was opened. */
  number: z.number().int().positive().optional(),
  url: z.string().nullable().optional(),
  /** The batch's checks that failed at the held version. */
  failed: z.array(z.string()),
  /**
   * The batch's checks that were cancelled, skipped or unfinished there;
   * absent where its hold kept no such list, so they are not known.
   */
  notRun: z.array(z.string()).optional(),
});
export type BatchSendBack = z.infer<typeof batchSendBackSchema>;

/** A change the last combine left out, until its branch moves: it no longer combines. */
export const batchLeftOutSchema = z.object({
  taskId: z.string(),
  head: z.string(),
  reason: z.string(),
  at: z.number(),
  /**
   * The task of the approved change ahead of it in the batch that it clashes
   * with, where it still combines with the default branch alone: nothing can
   * be done until that change merges or leaves the batch. Absent when it
   * clashes with the default branch itself.
   */
  ahead: z.string().optional(),
});
export type BatchLeftOut = z.infer<typeof batchLeftOutSchema>;

/**
 * The merges a project allows, as its host answers: `rebase` and `merge`
 * keep one commit per change, `squash` does not.
 */
export const mergeWaysSchema = z.object({
  squash: z.boolean(),
  rebase: z.boolean(),
  merge: z.boolean(),
});
export type MergeWays = z.infer<typeof mergeWaysSchema>;
export type MergeWay = keyof MergeWays;

export const batchRecordSchema = z.object({
  line: z.array(batchChangeSchema),
  open: openBatchSchema.optional(),
  receipts: z.array(batchReceiptSchema),
  leftOut: z.array(batchLeftOutSchema),
  /** The merges the project allows, as last read where it lives. */
  ways: mergeWaysSchema.optional(),
  /** Tasks whose change a repair declared the held batch's fix. */
  fixes: z.array(z.string()).optional(),
  /** Every send-back of an open task's change, oldest first (`BatchSendBack`). */
  sentBack: z.array(batchSendBackSchema).optional(),
  /**
   * Every version of the project's batch that held, newest first, kept
   * while a declared fix is outstanding and otherwise until a batch merges
   * or ends, through each combine and a batch closed and put back in line:
   * a declared fix built on one of them
   * combines as its own difference from that version, so it can change what
   * members wrote, and never carries a change sent back.
   */
  held: z.array(z.string()).optional(),
  /**
   * The held version each declared fix was verified to build on, by task,
   * kept with its repair, not with the change in line or in the batch, until
   * a batch merges with the fix or its task closes: every later version of
   * the fix is carried from it, or left out when it no longer builds on it.
   */
  fixBases: z.record(z.string(), z.string()).optional(),
  /**
   * When the project's last batch formed from the line (epoch ms): a
   * project's batch gap counts from it (`batchGap` on the project). A held
   * batch combined again by its repair forms no new batch, so it moves nothing.
   */
  formed: z.number().optional(),
});
export type BatchRecord = z.infer<typeof batchRecordSchema>;

export const EMPTY_BATCH_RECORD: BatchRecord = { line: [], receipts: [], leftOut: [] };

/**
 * A by-hand answer to a held batch, from Settings or a repair: try the
 * batch again, or send changes back, each with its reason. `head` names
 * the held version it answers, so an answer to a hold that ended is refused.
 */
export const batchAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("try-again"), head: z.string().min(1) }),
  z.object({
    action: z.literal("send-back"),
    head: z.string().min(1),
    changes: z
      .array(
        z.object({
          taskId: z.string().min(1),
          reason: z.string().trim().min(1),
        }),
      )
      .min(1),
  }),
]);
export type BatchAnswer = z.infer<typeof batchAnswerSchema>;

/**
 * A repair's answer to a held batch (`check_change` `batch`): its own change
 * declared the batch's fix, the changes at fault sent back, each by its
 * task key with the reason its crewmate reads, or both in one declaration. `evidence` says how every
 * failed test was accounted for against every change in the batch.
 */
export const batchDeclarationSchema = z.object({
  fix: z.boolean().optional(),
  sendBack: z.array(z.object({ task: z.string(), reason: z.string() })).optional(),
  /**
   * The held version, a full commit id, when a rerun passed its failed
   * checks: it merges at that version once its other checks pass, and a
   * fix declared beside it or meanwhile goes to the next batch.
   */
  passed: z.string().optional(),
  evidence: z.string(),
});
export type BatchDeclaration = z.infer<typeof batchDeclarationSchema>;

/**
 * A change's place in this person's batch, as its check reading and its
 * merge card's Batch check cell say it. The app keeps it on the task and
 * writes no status where the project lives.
 */
export type BatchStatus = {
  kind: "waiting" | "in-batch" | "paused" | "passed" | "failed";
  words: string;
  /** The batch's pull request. */
  link?: string;
};

/**
 * The name a change's place in its batch takes among its checks: the app
 * adds one check of this name to the change's reading, and the merge card's
 * Batch check cell reads it. It is written nowhere the project lives. The
 * value is the name saved readings and paired views already know it by.
 */
export const BATCH_CHECK = "infinitary/queue";

/** What an approved change's batch check says while it waits in line. */
export const BATCH_WAITING_WORDS = "Waiting for the batch check";

/**
 * A change's batch check on a version, as its task's last reading kept it
 * (`BatchStatus` at `head`). A fact an earlier version kept may carry no
 * `kind`; the next reading replaces it.
 */
export type BatchCheckFact = {
  head: string;
  kind?: BatchStatus["kind"];
  words?: string;
  link?: string;
  /**
   * Every time the task's change was sent back from its batch, at any
   * version, oldest first: a version not in line yet carries them too.
   */
  sentBack?: BatchSendBackFact[];
};

/** A send-back as the merge card names it: the batch's pull request as its host labels it. */
export type BatchSendBackFact = Pick<BatchSendBack, "head" | "reason" | "at" | "notRun"> & {
  change?: string;
  link?: string;
};

/** The kind a batch check's state alone says, where its kept fact carries none. */
export function batchKindOf(state: string): BatchStatus["kind"] {
  return state === "pending" ? "waiting" : state === "success" ? "passed" : "failed";
}

export const BATCH_STATUS_WORDS = {
  /** A change in line while the project's batch gap runs: the time its next batch starts. */
  waitingUntil: (time: string) => `${BATCH_WAITING_WORDS}; the next batch starts at ${time}`,
  batch: "In a batch; its checks are running",
  held: (reason: BatchHold["reason"]) =>
    reason === "rules"
      ? "Its batch is held by a rule where the project lives, such as a required review"
      : reason === "merge-way"
        ? "Its batch is held because it could not be merged where the project lives"
        : "Its batch is held because the batch's checks failed",
  failed: (checks: readonly string[]) =>
    checks.length ? `Its batch's checks failed: ${checks.join(", ")}` : "Its batch's checks failed",
  leftOut: (reason: string) => `Left out of its batch: ${reason}`,
  sentBack: (reason: string) => `Sent back from its batch: ${reason}`,
  merged: "Merged with its batch",
} as const;

/**
 * Whether a project's allowed merges can keep one commit per change. A
 * project that allows only squash merges is not offered batched pull
 * requests (the captain's answer, `squash_only`).
 */
export function keepsCommits(ways: MergeWays): boolean {
  return ways.rebase || ways.merge;
}

/** Settings' reason under "Where changes go" for a project that allows only squash merges. */
export const SQUASH_ONLY_WORDS =
  "Batched pull requests are not offered for this project: it allows only squash merges, and a batch keeps one commit for each change.";

/**
 * The merge a batch takes, from what the host allows. A batch of one merges
 * as that change's pull request does, by squash, where the project allows
 * it. A batch of several keeps one commit per change: a rebase merge where
 * allowed, a merge commit otherwise. Undefined when no allowed merge fits.
 */
export function mergeWayFor(ways: MergeWays, members: number): MergeWay | undefined {
  if (members === 1 && ways.squash) return "squash";
  if (ways.rebase) return "rebase";
  if (ways.merge) return "merge";
  return undefined;
}

/**
 * The gaps Settings → Projects offers under When a batch starts (docs/forge.md,
 * "The batch gap"), in minutes, after As soon as a change is approved. The
 * first mate may set any whole number of minutes; Settings then offers it too.
 */
export const BATCH_GAP_CHOICES: readonly number[] = [60, 120, 180, 240, 360];

/** The words of a project's batch gap, from one owner. */
export const BATCH_GAP_WORDS = {
  get title() {
    return m.settingsProjectsBatchGap();
  },
  get description() {
    return m.settingsProjectsBatchGapDescription();
  },
  /** A gap in minutes as its choice reads, or As soon as a change is approved with none. */
  label: (gap: number | null | undefined): string =>
    !gap
      ? m.settingsProjectsBatchGapNow()
      : gap % 60 === 0
        ? m.settingsProjectsBatchGapHours({ count: gap / 60 })
        : m.settingsProjectsBatchGapMinutes({ count: gap }),
} as const;
