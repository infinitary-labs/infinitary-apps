import { z } from "zod";
import { stopCommandSchema, stopLabelSchema } from "./leftoverPrograms";
import type { PanelKeptJobs } from "./personal/contracts";

/**
 * The jobs the captain asked to keep running past their task's close, as
 * Settings → Automation and the Automation panel list them under Kept
 * running (docs/leftover-programs.md, "Kept running"; INF-4381's approved
 * plan, piece 2). Each names the computer it runs on, the account it runs
 * as, the task that set it up, and how its last check and its last remove
 * that did not finish went. The commands themselves stay at the home.
 */

/** How a kept job's check went: its command exited 0, exited otherwise, ran too long, or never reached the computer. */
export const keptCheckOutcomeSchema = z.enum([
  "running",
  "not-running",
  "timed-out",
  "unreachable",
]);
export type KeptCheckOutcome = z.infer<typeof keptCheckOutcomeSchema>;

/** How a remove that left the job listed went. */
export const keptRemoveFailureSchema = z.enum(["failed", "timed-out", "unreachable"]);
export type KeptRemoveFailure = z.infer<typeof keptRemoveFailureSchema>;

export const keptCheckSchema = z.object({
  at: z.number().int().nonnegative(),
  outcome: keptCheckOutcomeSchema,
});
export const keptRemoveFailedSchema = z.object({
  at: z.number().int().nonnegative(),
  outcome: keptRemoveFailureSchema,
  exitCode: z.number().int().optional(),
});

/**
 * A Settings item that opens a kept job's row in Automation, as a panel's
 * `point.openSettings` and a host card's button name it: this, then its id.
 */
export const KEPT_ITEM_PREFIX = "kept:";

export const keptJobViewSchema = z.object({
  /** Its kept folder's own name (`<task>-<keep id>`), with `@` and the computer's id for a job on a computer that runs work. */
  id: z.string().min(1).max(256),
  label: stopLabelSchema,
  /** The computer that runs work it runs on, by device id; null for the home itself. */
  computer: z.string().min(1).max(128).nullable(),
  /** That computer's name, as Settings → Computers names it. */
  computerName: z.string().max(256),
  account: z.string().max(256),
  task: z.string().min(1).max(64),
  key: z.string().max(64),
  /** When its task's close kept it, in ms since the epoch. */
  at: z.number().int().nonnegative(),
  checked: keptCheckSchema.optional(),
  removeFailed: keptRemoveFailedSchema.optional(),
});
export type KeptJobView = z.infer<typeof keptJobViewSchema>;

export const keptJobsViewSchema = z.object({
  jobs: z.array(keptJobViewSchema),
}) satisfies z.ZodType<PanelKeptJobs>;
export type KeptJobsView = z.infer<typeof keptJobsViewSchema>;

/** What Remove answers: the job left the list, or it stays with how the remove went. */
export const keptRemoveResultSchema = z.object({
  id: z.string(),
  removed: z.boolean(),
  job: keptJobViewSchema.optional(),
});
export type KeptRemoveResult = z.infer<typeof keptRemoveResultSchema>;

/**
 * The order the home sends a computer that runs work to run one kept job's
 * check or remove there (`kept-job-orders.md`): the command the home keeps,
 * in the job's kept folder. A remove that ran cleanly takes the folder with
 * it. The computer refuses a folder outside its own kept folder.
 */
export const KEPT_JOB_ORDER = "inf:computer:kept-job";
export const keptJobOrders = {
  [KEPT_JOB_ORDER]: {
    effect: "change",
    request: z.tuple([
      z.object({
        action: z.enum(["check", "remove"]),
        label: stopLabelSchema,
        command: stopCommandSchema,
        folder: z.string().min(1).max(4096),
      }),
    ]),
    response: z.object({
      outcome: z.enum(["ran", "failed", "timed-out"]),
      exitCode: z.number().int().optional(),
    }),
  },
} as const;
