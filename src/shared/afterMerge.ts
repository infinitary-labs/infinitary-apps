import { z } from "zod";

/** How a filed after-merge step's title opens, the same word a crewmate's Continue filing uses. */
export const AFTER_MERGE_TITLE_PREFIX = "Continue: ";

/** A task title's room (`file_followup`'s 64), less the prefix the host adds. */
const AFTER_MERGE_TITLE_ROOM = 64 - AFTER_MERGE_TITLE_PREFIX.length;

/**
 * One step the crew does once a merge goes through (INF-2796, the captain's
 * Approve and build: "we should not mandate these follow up tasks though"):
 * listed on the change's saved story, drawn on its merge card, and filed by
 * the host as a Continue task that starts on its own only when the merge
 * went through. A story may list none, and that is the same as not listing.
 */
const taskRef = z.string().trim().min(1).max(64);
export const afterMergeStepSchema = z.object({
  /** An existing open task the merge starts, in place of a new one (title, goal, why). */
  task: taskRef.optional(),
  title: z.string().min(1).max(AFTER_MERGE_TITLE_ROOM).optional(),
  goal: z.string().min(1).max(1000).optional(),
  why: z.string().min(1).max(4000).optional(),
  /** The project a new step is filed in, by key; the origin's when absent. */
  project: taskRef.optional(),
  /** Tasks whose merge the step waits for, by key: each a `blocks` link into it. */
  blockedBy: z.array(taskRef).max(10).optional(),
});
export const afterMergeStepsSchema = z.array(afterMergeStepSchema).max(10);
export type AfterMergeStep = z.infer<typeof afterMergeStepSchema>;

/**
 * What a step must hold besides its schema: an existing task alone, or a
 * new one's title, goal and why. The host refuses the rest when the story is
 * prepared (`TaskDeliveries.afterMergeRefusal`), where it also reads the
 * tasks and projects the step names.
 */
export function afterMergeShapeRefusal(step: AfterMergeStep, index: number): string | undefined {
  const at = `afterMerge step ${index + 1}`;
  if (step.task)
    return step.title || step.goal || step.project
      ? `${at} names an existing task, which keeps its own title, goal and project.`
      : undefined;
  return step.title?.trim() && step.goal?.trim() && step.why?.trim()
    ? undefined
    : `${at} needs a title, a goal and why, or an existing task's key.`;
}

/**
 * A step as its merge card draws it: a new step's title and goal, or an
 * existing task's key with its own title and goal, read when the card is shown.
 */
export type AfterMergeShown = { title: string; goal?: string; key?: string; waitsFor?: string[] };
export const afterMergeShownSchema = z.object({
  title: z.string().min(1).max(500),
  goal: z.string().max(4000).optional(),
  key: z.string().max(64).optional(),
  waitsFor: z.array(z.string().max(64)).max(10).optional(),
});
export const afterMergeShownListSchema = z.array(afterMergeShownSchema).max(10);

/**
 * One step the host filed or started at a merge, as the settled wake names
 * it; `skipped` says why an existing task named on the card was not started.
 */
export type FiledAfterMergeStep = { key: string; title: string; skipped?: string };

/** The line under a step that waits for other work to merge first. */
export function afterMergeWaitWords(keys: readonly string[]): string {
  return `Starts once ${keys.join(" and ")} ${keys.length > 1 ? "merge" : "merges"} too`;
}

/** What leads a merge card's after-merge steps (`AfterMergeSteps.tsx`). */
export const AFTER_MERGE_LEAD = "After merging, the crew starts";
