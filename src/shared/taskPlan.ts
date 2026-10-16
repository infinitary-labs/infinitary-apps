import { z } from "zod";

/**
 * The plan a crewmate reports with a progress note (FI3-734, the captain's
 * Build it on the steps-view preview): a short, high-level list of what the
 * task takes, each item declared done, current, next or skipped. The host
 * stores the list exactly as declared and reads nothing into the words;
 * every note that carries one replaces the whole list. The crewmate is asked
 * to keep it under eight items and may fold finished items into one to make
 * room; the hard cap below only refuses what no surface could show.
 */
export const PLAN_ITEM_LABEL_MAX = 60;
export const PLAN_ITEM_SHORT_MAX = 12;
export const PLAN_ITEMS_MAX = 12;
/** Past this many items, the finished ones fold away on both surfaces. */
export const PLAN_FOLD_PAST = 8;

export const planItemStateSchema = z.enum(["done", "current", "next", "skipped"]);
export type PlanItemState = z.infer<typeof planItemStateSchema>;

export const planItemSchema = z.strictObject({
  /** What the item is, in a few words. */
  label: z.string().min(1).max(PLAN_ITEM_LABEL_MAX),
  /** The word or two under its dot on the summary. */
  short: z.string().min(1).max(PLAN_ITEM_SHORT_MAX),
  state: planItemStateSchema,
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const planItemsSchema = z.array(planItemSchema).min(1).max(PLAN_ITEMS_MAX);

/**
 * One item as the record reads it: as declared, plus `since`, when it first
 * read this state in an unbroken run of notes (by its label), so a finished
 * item shows when it finished.
 */
export const taskPlanItemSchema = planItemSchema.extend({ since: z.number() });
export type TaskPlanItem = z.infer<typeof taskPlanItemSchema>;

/** The latest list a task's crewmate reported, and when. */
export const taskPlanSchema = z.object({
  items: z.array(taskPlanItemSchema),
  at: z.number(),
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;

/** The whole list as a crewmate's note carries it; refused in words when it does not fit. */
export function readPlanItems(raw: unknown): { items: PlanItem[] } | { refusal: string } {
  const parsed = planItemsSchema.safeParse(raw);
  if (parsed.success) {
    return {
      items: parsed.data.map((item) => ({
        ...item,
        label: tidy(item.label),
        short: tidy(item.short),
      })),
    };
  }
  const issue = parsed.error.issues[0];
  const where = issue?.path.length
    ? ` at plan${issue.path.map((p) => `[${String(p)}]`).join("")}`
    : "";
  return {
    refusal: `plan was refused${where}: ${issue?.message ?? "it does not fit"}. Give at most ${PLAN_ITEMS_MAX} items, each a label of at most ${PLAN_ITEM_LABEL_MAX} characters, a short label of at most ${PLAN_ITEM_SHORT_MAX}, and a state of done, current, next or skipped; fold finished items into one to make room.`,
  };
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** How far the plan stands: done against the items that count (skipped ones do not). */
export function planCounts<T extends PlanItem>(
  items: readonly T[],
): { done: number; total: number; skipped: number; current: T | null } {
  let done = 0;
  let skipped = 0;
  let current: T | null = null;
  for (const item of items) {
    if (item.state === "done") done++;
    else if (item.state === "skipped") skipped++;
    else if (item.state === "current" && !current) current = item;
  }
  return { done, total: items.length - skipped, skipped, current };
}

/**
 * Past `PLAN_FOLD_PAST` items, the finished ones before the newest finished
 * one fold away: the summary counts them in one dot, the record puts them
 * behind Show earlier. Folding one item would gain nothing, so it takes two;
 * null means nothing folds and the list shows whole.
 */
export function foldPlan<T extends PlanItem>(
  items: readonly T[],
): { folded: T[]; rest: T[] } | null {
  if (items.length <= PLAN_FOLD_PAST) return null;
  let lastDone = -1;
  items.forEach((item, i) => {
    if (item.state === "done") lastDone = i;
  });
  const hides = (item: T, i: number) => item.state === "done" && i < lastDone;
  const folded = items.filter(hides);
  if (folded.length < 2) return null;
  return { folded, rest: items.filter((item, i) => !hides(item, i)) };
}
