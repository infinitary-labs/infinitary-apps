import { z } from "zod";
import { formatList } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";

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

/**
 * Who does a step (finding 4 of INF-3060, the captain's "an after-merge step
 * names its doer, and app changes go to the first mate"): a crewmate in a
 * project's working copy, the default, or the first mate, for a change in
 * the app itself - an Automation rule, a setting, a direction - which no
 * crewmate can reach. A first-mate step files no task: the merge hands it to
 * the first mate in its settled wake.
 */
export const AFTER_MERGE_DOERS = ["crewmate", "firstmate"] as const;
export type AfterMergeDoer = (typeof AFTER_MERGE_DOERS)[number];

export const afterMergeStepSchema = z.object({
  /** Who does it: a crewmate (the default) or the first mate, for a change in the app itself. */
  doer: z.enum(AFTER_MERGE_DOERS).optional(),
  /** An existing open task the merge starts, in place of a new one (title, goal, why). */
  task: taskRef.optional(),
  title: z.string().min(1).max(AFTER_MERGE_TITLE_ROOM).optional(),
  goal: z.string().min(1).max(1000).optional(),
  why: z.string().min(1).max(4000).optional(),
  /** The project a new step is filed in, by key; the origin's when absent. */
  project: taskRef.optional(),
  /**
   * The repository a new step works in, by name (INF-4220): needed when the
   * step's project is not the origin's and holds several; in the origin's
   * project, the origin's repository when absent.
   */
  repository: taskRef.optional(),
  /** Tasks whose merge the step waits for, by key: each a `blocks` link into it. */
  blockedBy: z.array(taskRef).optional(),
  /**
   * Tasks waiting on this change that still need the step's work, by key
   * (INF-3846 piece 4): the merge moves each one's wait onto the step, so it
   * keeps waiting for the rest instead of being told to carry on.
   */
  holds: z.array(taskRef).optional(),
  /**
   * What the step will use that needs the captain's yes - the resource, the
   * check and its possible cost or change (INF-4574, the captain's yes to
   * merge_click_allows_listed_step): drawn under the step on its merge card,
   * and the captain's own merge click records it as already allowed on the
   * task the step starts. A merge the app makes on its own records nothing.
   */
  uses: z.string().trim().min(1).max(1000).optional(),
});
export const afterMergeStepsSchema = z.array(afterMergeStepSchema);
export type AfterMergeStep = z.infer<typeof afterMergeStepSchema>;

/**
 * What a step must hold besides its schema: an existing task alone, or a
 * new one's title, goal and why. The host refuses the rest when the story is
 * prepared (`TaskDeliveries.afterMergeRefusal`), where it also reads the
 * tasks and projects the step names.
 */
export function afterMergeShapeRefusal(step: AfterMergeStep, index: number): string | undefined {
  const at = `afterMerge step ${index + 1}`;
  if (
    step.doer === "firstmate" &&
    (step.task ||
      step.project ||
      step.repository ||
      step.blockedBy?.length ||
      step.holds?.length ||
      step.uses)
  )
    return `${at} is the first mate's change in the app, which files no task: give it a title, a goal and why, with no task, project, repository, blockedBy, holds or uses.`;
  if (step.task)
    return step.title || step.goal || step.project || step.repository
      ? `${at} names an existing task, which keeps its own title, goal, project and repository.`
      : undefined;
  return step.title?.trim() && step.goal?.trim() && step.why?.trim()
    ? undefined
    : `${at} needs a title, a goal and why, or an existing task's key.`;
}

/**
 * A step as its merge card draws it: a new step's title and goal, or an
 * existing task's key with its own title and goal, read when the card is shown.
 */
export type AfterMergeShown = {
  title: string;
  goal?: string;
  key?: string;
  waitsFor?: string[];
  /** Who does it; a crewmate when absent. */
  doer?: AfterMergeDoer;
  /** What it will use that the captain's merge click allows (`AfterMergeStep.uses`). */
  uses?: string;
};
export const afterMergeShownSchema = z.object({
  doer: z.enum(AFTER_MERGE_DOERS).optional(),
  title: z.string().min(1).max(500),
  goal: z.string().max(4000).optional(),
  key: z.string().max(64).optional(),
  waitsFor: z.array(z.string().max(64)).optional(),
  uses: z.string().max(1000).optional(),
});
export const afterMergeShownListSchema = z.array(afterMergeShownSchema);

/**
 * One step the host filed or started at a merge, as the settled wake names
 * it; `skipped` says why an existing task named on the card was not started.
 */
export type FiledAfterMergeStep = {
  key: string;
  title: string;
  skipped?: string;
  /** The tasks whose wait the merge moved onto this step (`AfterMergeStep.holds`). */
  holds?: string[];
};

/** A first-mate step a merge hands over, as its settled wake names it: no task holds it. */
export type FirstmateAfterMergeStep = { title: string; goal: string; why?: string };

/** The line under a step that waits for other work to merge first. */
export function afterMergeWaitWords(keys: readonly string[]): string {
  return m.cardAfterMergeWait({ count: keys.length, keys: formatList(keys) });
}

/** The line under each step on its merge card, naming who does it. */
export const AFTER_MERGE_DOER_WORDS: Record<AfterMergeDoer, string> = {
  get crewmate() {
    return m.cardAfterMergeDoerCrewmate();
  },
  get firstmate() {
    return m.cardAfterMergeDoerFirstmate();
  },
};

/** What leads a merge card's after-merge steps (`AfterMergeSteps.tsx`). */
export const AFTER_MERGE_LEAD = m.cardAfterMergeLead();
