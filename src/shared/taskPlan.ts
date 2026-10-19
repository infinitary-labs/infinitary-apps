import { z } from "zod";

/**
 * The plan a crewmate reports with a progress note (FI3-734, the captain's
 * Build it on the steps-view preview): a short, high-level list of what the
 * task takes, each item declared done, current, next or skipped. The host
 * stores the list exactly as declared and reads nothing into the words;
 * every note that carries one replaces the whole list. The crewmate is asked
 * to keep it under eight items and may fold finished items into one to make
 * room. How long and how many is the crewmate's call: the host keeps every
 * word and every item, the record lists them whole, and the summary's line
 * cuts what it cannot hold (INF-484 move 5: clip and show, never refuse a
 * shape). Only what cannot be drawn at all - an item with no words, a state
 * outside the four - is refused.
 */
/** Past this many items, the finished ones fold away on both surfaces. */
export const PLAN_FOLD_PAST = 8;
/** A physical limit: the most dots the summary's line holds; past it the line folds its tail (`clipPlanLine`). */
export const PLAN_LINE_MAX = 12;

export const planItemStateSchema = z.enum(["done", "current", "next", "skipped"]);
export type PlanItemState = z.infer<typeof planItemStateSchema>;

export const planItemSchema = z.strictObject({
  /** What the item is, in a few words. */
  label: z.string().min(1),
  /** The word or two under its dot on the summary, cut there when it does not fit. */
  short: z.string().min(1),
  state: planItemStateSchema,
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const planItemsSchema = z.array(planItemSchema).min(1);

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

/** The whole list as a crewmate's note carries it; refused in words only when it cannot be drawn. */
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
    refusal: `plan was refused${where}: ${issue?.message ?? "it cannot be drawn"}. Give a list of items, each with a label, a short label and a state of done, current, next or skipped.`,
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

/**
 * The summary's line, cut to the dots it holds (INF-484 move 5): past
 * `PLAN_LINE_MAX` dots - counted after `foldPlan` - the items after the
 * current one fold into one last dot, their names on hover, while the record
 * still lists every item. The current item always keeps its dot. Folding one
 * item would gain nothing, so it takes two; null means the line holds them all.
 */
export function clipPlanLine<T extends Pick<PlanItem, "state">>(
  nodes: readonly T[],
): { shown: T[]; later: T[] } | null {
  if (nodes.length <= PLAN_LINE_MAX) return null;
  const current = nodes.findIndex((node) => node.state === "current");
  const keep = Math.max(PLAN_LINE_MAX - 1, current + 1);
  if (nodes.length - keep < 2) return null;
  return { shown: nodes.slice(0, keep), later: nodes.slice(keep) };
}
