import { z } from "zod";
import { checkSnapshotSchema, mainCheckEvidenceSchema } from "./checkSnapshot";
import { reviewRiskSchema, reviewVerdictSchema } from "./rigor";
import { taskClosedReasonSchema } from "./tasks";

/**
 * The host's typed record of one change (INF-1868 piece 1; `docs/task-record.md`,
 * "A task's change"): where it is, its handle where the project's host keeps
 * one, who raised it, each version pushed, and at each version the facts the
 * host holds - the checks it read, the review verdict declared, the story
 * published and the consent given - with its receipt once merged or closed.
 * Every value is a fact the host held or was told; none is a judgment.
 */

/** A pull request or merge request on the project's host; a plain Git host keeps none. */
export const changeHandleSchema = z.object({
  kind: z.enum(["pr", "mr"]),
  number: z.number().int().positive(),
  url: z.string().optional(),
  label: z.string().optional(),
});
export type ChangeHandle = z.infer<typeof changeHandleSchema>;

/** Who raised the change. A task's own change carries its task; later pieces add the first mate and a named pull request. */
export const changeRaisedBySchema = z.object({ kind: z.literal("task"), task: z.string() });
export type ChangeRaisedBy = z.infer<typeof changeRaisedBySchema>;

/** The check facts read at one version: the host's states, when, and the lines against the base. */
export const changeChecksSchema = z.object({
  state: z.enum(["green", "red", "pending", "no-pr", "merged"]).optional(),
  snapshot: checkSnapshotSchema.optional(),
  at: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  lines: z
    .object({ base: z.string(), added: z.number(), deleted: z.number(), at: z.number() })
    .optional(),
  /** The default branch's newest run of each check the reading found red (INF-1915 fix 1): evidence, never a merge input. */
  main: mainCheckEvidenceSchema.optional(),
});
export type ChangeChecks = z.infer<typeof changeChecksSchema>;

/** The review verdict declared at one version, with its risk and the reading it rests on. */
export const changeReviewSchema = z.object({
  verdict: reviewVerdictSchema,
  risk: reviewRiskSchema.optional(),
  riskNote: z.string().optional(),
  at: z.number().optional(),
  reading: z.string().optional(),
});
export type ChangeReview = z.infer<typeof changeReviewSchema>;

/** The story revisions prepared at one version, and the one published there. */
export const changeStorySchema = z.object({
  revisions: z.array(z.object({ revision: z.number().int().positive(), title: z.string() })),
  published: z
    .object({
      revision: z.number().int().positive(),
      state: z.enum(["sending", "confirmed", "uncertain"]),
      number: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ChangeStory = z.infer<typeof changeStorySchema>;

/** The captain's words that pass a hold, as the delivery facts record them. */
export const changeOverrideSchema = z.object({
  words: z.string(),
  holds: z.array(z.string()),
  until: z.enum(["version", "task"]).optional(),
  head: z.string().optional(),
  at: z.number(),
});
export type ChangeOverride = z.infer<typeof changeOverrideSchema>;

/**
 * The consent given at one version: the captain's merge click on a card, an
 * approval carried to a repaired version by a declared repair, and an
 * override given for that version alone.
 */
export const changeConsentSchema = z.object({
  click: z
    .object({
      authorization: z.string(),
      generation: z.number().int(),
      card: z.object({ id: z.string(), offerId: z.string(), actionId: z.string() }),
      status: z.enum(["standing", "consumed", "revoked", "invalidated", "superseded"]),
      at: z.number(),
    })
    .optional(),
  carried: z
    .object({
      authorization: z.string(),
      from: z.string(),
      impact: z.string(),
      generation: z.number().int(),
      at: z.number(),
    })
    .optional(),
  override: changeOverrideSchema.optional(),
});
export type ChangeConsent = z.infer<typeof changeConsentSchema>;

/** One version of the change: a head pushed, in the order the host saw them. */
export const changeVersionSchema = z.object({
  seq: z.number().int().positive(),
  head: z.string(),
  /** When the host first saw this version; null when no fact dates it. */
  at: z.number().nullable(),
  checks: changeChecksSchema.nullable(),
  review: changeReviewSchema.nullable(),
  story: changeStorySchema.nullable(),
  consent: changeConsentSchema.nullable(),
});
export type ChangeVersion = z.infer<typeof changeVersionSchema>;

/** How the change ended: merged, discarded, or closed another way with the task's reason. */
export const changeReceiptSchema = z.object({
  outcome: z.enum(["merged", "discarded", "closed"]),
  reason: taskClosedReasonSchema.optional(),
  head: z.string().optional(),
  sha: z.string().optional(),
  by: z.literal("captain").optional(),
  at: z.number().nullable(),
});
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>;

export const changeRecordSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  /** The branch it merges into; null when the record does not hold it (the project's default branch at the time). */
  base: z.string().nullable(),
  head: z.object({ branch: z.string() }),
  handle: changeHandleSchema.nullable(),
  raisedBy: changeRaisedBySchema,
  /** The task that carries this change; null once a change stands on its own. */
  taskId: z.string().nullable(),
  /** An override given for the whole task, every version included. */
  override: changeOverrideSchema.nullable(),
  receipt: changeReceiptSchema.nullable(),
  versions: z.array(changeVersionSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChangeRecord = z.infer<typeof changeRecordSchema>;
