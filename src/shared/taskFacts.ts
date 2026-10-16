import type { FactDotState } from "./factDot";
import { type ModelReason, modelFootnote } from "./modelReason";
import type { Slot } from "./modelSlots";
import type { Reasoning } from "./reasoning";
import {
  browserDriverOf,
  DRIVER_WORDS,
  STOP_LINE_WORDS,
  type TaskBrowserDriver,
  type TaskBrowserFact,
} from "./taskBrowser";
import type { TaskPlan } from "./taskPlan";
import { type TaskStatusInput, type TaskStatusReading, taskStatusOf } from "./taskPresentation";
import type { TaskActivityLine, TaskActivityRow, TaskDeliveryView, TaskView } from "./tasks";
import { CHECK_WORDS, CHECKS_NOT_READ_WORDS, REVIEW_WORDS } from "./vocabulary";

/**
 * The facts every view of a task reads, in the order the crew summary
 * draws them (FI3-565, direction A, piece 2; the design skill's NowPanel
 * "Shared task facts"). A surface may show fewer of them, never different
 * ones. The model, its intelligence and reasoning, the change, its checks
 * and a review are one fact strip, the merge card's own shape and its fact
 * names (FI3-1159), with the footnote saying why that model under it; the
 * task record draws that strip just above its action bar, after its rows.
 * The identities are what a reader selects (`data-task-fact`), never a
 * label's words.
 */
export const TASK_FACTS = [
  "status",
  "task",
  "now",
  "plan",
  "model",
  "intelligence",
  "reasoning",
  "change",
  "checks",
  "review",
  "reason",
  "browser",
] as const;
export type TaskFactId = (typeof TASK_FACTS)[number];

/** The live change: a pull request, or a branch sent to a plain Git host. */
export type TaskChange = {
  noun: "Pull request" | "Branch";
  /** The forge's own label (`#612`, or the branch's name); null when it gave none. */
  label: string | null;
  /** Its page where the host has one. */
  url: string | null;
};

/**
 * The task's own browser on this Mac (docs/task-browser.md, "The view"): the
 * site, then who is driving it or what stopped it. The record's line ends
 * in Open; the crew summary, a smaller surface, has none.
 */
export type TaskBrowserLine = {
  site: string;
  /** `the crewmate is driving`, `nobody is driving`, or what stopped it. */
  words: string;
  /** Who drives an open one; absent once it stopped. */
  driver?: TaskBrowserDriver;
};

/** The checks' newest reading: its dot, its word (`failed`) and when it was read. */
export type TaskChecks = { dot: FactDotState; words: string; at: number | null };

/** An independent review's verdict, with its risk (`findings · risk high`). */
export type TaskReview = { dot: FactDotState; words: string };

/** The delivery cells of the fact strip: the live change, its checks, a review's verdict. */
export type TaskDelivery = {
  change: TaskChange | null;
  checks: TaskChecks | null;
  review: TaskReview | null;
};

export type TaskFacts = {
  key: string;
  status: TaskStatusReading;
  title: string;
  /**
   * The newest row of the record's Activity, of any kind (the captain's
   * now_source), with the words that name its pull request where it has a
   * page: undefined until the record is read, null when it has none.
   */
  now: { text: string; at: number; change?: TaskActivityLine["change"] } | null | undefined;
  /**
   * The plan the crewmate reported last (FI3-734): undefined until the
   * record is read, null when it never reported one.
   */
  plan: TaskPlan | null | undefined;
  /** The model's name through the one lookup; null before assignment. */
  model: string | null;
  /** Its intelligence level, the slot its crewmate is served on. */
  tier: Slot | null;
  /** The reasoning its session opened at. */
  reasoning: Reasoning | null;
  /** Why that model, and why the reasoning sits lower, in one footnote. */
  reason: string | null;
  delivery: TaskDelivery | null;
  /** Only the record's read carries it: null while the task has no browser here. */
  browser: TaskBrowserLine | null;
};

/** The board row, plus what only the record read carries (absent until it answers). */
export type TaskFactsInput = TaskStatusInput &
  Pick<TaskView, "key" | "title" | "model" | "tier" | "delivery"> & {
    activityLog?: readonly TaskActivityRow[];
    plan?: TaskPlan | null;
    reasoning?: Reasoning;
    modelReason?: ModelReason;
    browser?: TaskBrowserFact;
  };

/** One projection for the crew summary and the task record, so one task reads the same on both. */
export function taskFactsOf(task: TaskFactsInput, modelName: (model: string) => string): TaskFacts {
  const model = task.model ? modelName(task.model) : null;
  // Now is the task's own: a line another task wrote is Activity's alone.
  const newest = task.activityLog?.findLast((row) => !row.from);
  return {
    key: task.key,
    status: taskStatusOf(task),
    title: task.title,
    now:
      task.activityLog === undefined
        ? undefined
        : newest
          ? {
              text: newest.text,
              at: newest.at,
              ...(newest.change ? { change: newest.change } : {}),
            }
          : null,
    plan: task.activityLog === undefined ? undefined : (task.plan ?? null),
    model,
    // The readout belongs to a model: none of it stands without one.
    tier: model ? task.tier : null,
    reasoning: model ? (task.reasoning ?? null) : null,
    reason: model ? modelFootnote(task.modelReason, task.reasoning) : null,
    delivery: deliveryOf(task),
    browser: task.browser ? browserLineOf(task.browser, task) : null,
  };
}

/** The record's Browser line: the site, then who drives an open browser or what stopped it. */
export function browserLineOf(
  fact: TaskBrowserFact,
  task: Parameters<typeof browserDriverOf>[0],
): TaskBrowserLine {
  if (fact.state === "stopped") return { site: fact.site, words: STOP_LINE_WORDS[fact.stopped] };
  const driver = browserDriverOf(task, fact);
  return { site: fact.site, words: DRIVER_WORDS[driver], driver };
}

/** The checks' dot by CI state, as the merge card's strip draws it. */
const CHECKS_DOT: Record<NonNullable<TaskDeliveryView["ci"]>, FactDotState> = {
  green: "ok",
  merged: "ok",
  red: "failed",
  pending: "running",
  "no-pr": "idle",
};

const REVIEW_DOT: Record<NonNullable<TaskDeliveryView["reviewVerdict"]>, FactDotState> = {
  pass: "ok",
  findings: "warn",
  blocked: "failed",
};

/**
 * The task's change where the project lives - its label (`#N`, or the sent-up
 * branch), its page and its noun - whether or not the work is still live;
 * null while it has none.
 */
export function taskChangeOf(facts: NonNullable<TaskView["delivery"]>): TaskChange | null {
  const label = facts.changeLabel ?? (facts.prNumber ? `#${facts.prNumber}` : undefined);
  if (!facts.prUrl && !label) return null;
  return {
    noun: facts.prNumber || label?.startsWith("#") ? "Pull request" : "Branch",
    label: label ?? null,
    url: facts.prUrl ?? null,
  };
}

/**
 * The change and its checks while the work is live; a closed task says them
 * once, on its closing line (the record's A10), and keeps only a review's
 * verdict. Null when there is nothing to say. The words are the merge
 * card's (`CHECK_WORDS`), a change no reading reached yet `not read yet`.
 */
function deliveryOf(task: Pick<TaskView, "status" | "delivery">): TaskDelivery | null {
  const facts = task.delivery;
  if (!facts) return null;
  const live = task.status !== "done" && task.status !== "dropped";
  const change = live ? taskChangeOf(facts) : null;
  const ci = facts.ci ?? "no-pr";
  const checks =
    live && (change || ci !== "no-pr")
      ? {
          dot: CHECKS_DOT[ci],
          words: ci === "no-pr" ? CHECKS_NOT_READ_WORDS : CHECK_WORDS[ci],
          at: facts.ciAt ?? null,
        }
      : null;
  const review = facts.reviewVerdict
    ? {
        dot: REVIEW_DOT[facts.reviewVerdict],
        words: `${REVIEW_WORDS[facts.reviewVerdict]}${facts.reviewRisk ? ` · risk ${facts.reviewRisk}` : ""}`,
      }
    : null;
  return change || checks || review ? { change, checks, review } : null;
}
