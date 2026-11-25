import { z } from "zod";

/**
 * Check existing tasks (docs/task-tags.md, "Checking existing tasks"): the
 * decision model judges a project's tags on tasks filed before automatic
 * tagging saw them, over one of three reaches, one request per task. One
 * check runs at a time across every project, behind new tasks.
 */

/**
 * Which tasks a check reads: the open ones; the open ones and those done in
 * the 7 days before it started; or every task of the project.
 */
export const tagCheckReachSchema = z.enum(["open", "week", "all"]);
export type TagCheckReach = z.infer<typeof tagCheckReachSchema>;

/** The days a `week` reach looks back for done tasks. */
export const TAG_CHECK_WEEK_DAYS = 7;

/** A check under way, as its project's view shows it. */
export const tagCheckRunningSchema = z.object({
  reach: tagCheckReachSchema,
  /** The tags it checks; absent, every tag of the project. */
  tagIds: z.array(z.string()).optional(),
  /** Tasks it set out to ask. */
  total: z.number().int(),
  /** Tasks it has asked, or found nothing left to ask, so far. */
  done: z.number().int(),
});
export type TagCheckRunning = z.infer<typeof tagCheckRunningSchema>;

/**
 * One project's check, as its Tags group draws it: whether automatic tagging
 * asks now, who answers, how many requests each reach would make for the
 * tags asked about, and the check under way, if any.
 */
export const tagCheckViewSchema = z.object({
  projectId: z.string(),
  /** Whether Tag tasks automatically asks now: its switch and the answering model's approval. */
  auto: z.boolean(),
  /** The Jev or OpenRouter model answering, by name; null while the person's own models answer. */
  answerer: z.string().nullable(),
  /** Requests each reach would make: its tasks with a tag the decision model has not judged at its description. */
  reaches: z.object({ open: z.number().int(), week: z.number().int(), all: z.number().int() }),
  running: tagCheckRunningSchema.optional(),
  /** Another project's check holds the one slot, by that project's name. */
  elsewhere: z.string().optional(),
});
export type TagCheckView = z.infer<typeof tagCheckViewSchema>;

/** Which project's check to read, and the tags to count for; absent, every project with tags. */
export const tagCheckReadSchema = z.strictObject({
  projectId: z.string().min(1),
  tagIds: z.array(z.string().min(1)).min(1).optional(),
});
export type TagCheckRead = z.infer<typeof tagCheckReadSchema>;

/** Start or stop a project's check (`inf:projects:tag-check`), Settings' and the first mate's alike. */
export const tagCheckChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("start"),
    projectId: z.string().min(1),
    reach: tagCheckReachSchema,
    /** Only these tags, as a tag added later or newly described offers; absent, every tag. */
    tagIds: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.strictObject({ op: z.literal("stop"), projectId: z.string().min(1) }),
]);
export type TagCheckChange = z.infer<typeof tagCheckChangeSchema>;
