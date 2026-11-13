import { checkSnapshotState, currentCheckSummary } from "./checkSnapshot";
import { type ChecksSpan, checksSpanOf, runChecksSpanOf } from "./checksSpan";
import type { FactDotState } from "./factDot";
import { type ModelChoice, type ModelChoiceCandidate, modelChoiceLine } from "./modelChoice";
import { type ModelReason, modelReasonLine } from "./modelReason";
import type { Slot } from "./modelSlots";
import { type Reasoning, reasoningNote } from "./reasoning";
import {
  browserDriverOf,
  DRIVER_WORDS,
  STOP_LINE_WORDS,
  type TaskBrowserDriver,
  type TaskBrowserFact,
} from "./taskBrowser";
import type { TaskPlan } from "./taskPlan";
import { type TaskStatusInput, type TaskStatusReading, taskStatusOf } from "./taskPresentation";
import type {
  RunChecks,
  TaskActionLine,
  TaskActivityLine,
  TaskActivityRow,
  TaskDeliveryView,
  TaskEventKind,
  TaskView,
} from "./tasks";
import type { TaskWait } from "./taskWaits";
import {
  CHECK_WORDS,
  CHECKS_NOT_READ_WORDS,
  PULL_REQUEST_WORDS,
  REVIEW_EARLIER_WORDS,
  REVIEW_WORDS,
  RUN_CHECK_WORDS,
} from "./vocabulary";

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
  "why",
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

/**
 * The checks' newest reading: its dot, its word (`failed`), when it was
 * read, and how long they have run or took by the host's own times (INF-587).
 */
export type TaskChecks = {
  /** A refused reading has a reason, not an ongoing-work label. */
  problem?: string;
  dot: FactDotState;
  words: string;
  /**
   * The checks as one state (`running`, `passed`, `failed`), the hover
   * preview's (INF-2528); `words` carries the counts the task card shows.
   */
  state: string;
  at: number | null;
  span: ChecksSpan | null;
};

/** An independent review's verdict, with its risk (`findings · risk high`). */
export type TaskReview = { dot: FactDotState; words: string };

/** The delivery cells of the fact strip: the live change, its checks, a review's verdict. */
export type TaskDelivery = {
  change: TaskChange | null;
  checks: TaskChecks | null;
  review: TaskReview | null;
};

/** The record's Why this model: the captain's words for what decided, and the comparison. */
export type TaskModelWhy = {
  /** What chose the model or its level (`modelReasonLine`). */
  line: string | null;
  /** How the allowance decided between models (`modelChoiceLine`). */
  choice: string | null;
  /** No comparison was saved and the captain's own choice did not decide (before INF-1714). */
  unrecorded: boolean;
  /** The compared models, named, ranked as decided; null when none was saved. */
  comparison: {
    floorPercent: number;
    candidates: (ModelChoiceCandidate & { name: string })[];
  } | null;
};

export type TaskFacts = {
  waits?: readonly TaskWait[];
  key: string;
  status: TaskStatusReading;
  title: string;
  /**
   * The crewmate's own newest doing (`nowOf`, INF-557), with the words that
   * name its pull request where it has a page: undefined until the record
   * is read, null when it has none.
   */
  now: { text: string; at: number; change?: TaskActivityLine["change"] } | null | undefined;
  /**
   * The plan the crewmate reported last (FI3-734): undefined until the
   * record is read, null when it never reported one.
   */
  plan: TaskPlan | null | undefined;
  /** The model's name through the one lookup; null before assignment. */
  model: string | null;
  /**
   * How hard the task is (its Difficulty): the level its routing asked for,
   * or the level its crewmate is served on when the record cannot say.
   */
  tier: Slot | null;
  /** The reasoning its session opened at. */
  reasoning: Reasoning | null;
  /** Why the reasoning sits lower than its level asks; null when it does not. */
  reason: string | null;
  /**
   * Why this model (INF-1714): the rule's reason and how the allowance
   * compared, which only the task record shows; null before assignment or
   * when the record cannot say.
   */
  why: TaskModelWhy | null;
  delivery: TaskDelivery | null;
  /**
   * Every pull request on a task with more than one (INF-2490), which the
   * record lists; absent on a task with one or none, whose strip names it.
   */
  pullRequests?: TaskPullRequestLine[];
  /** Only the record's read carries it: null while the task has no browser here. */
  browser: TaskBrowserLine | null;
};

/** One line of the record's Pull requests row: its name, its page, its state and whether merging it closes the task. */
export type TaskPullRequestLine = {
  number: number;
  url: string | null;
  words: string;
  closes: boolean;
};

/** The board row, plus what only the record read carries (absent until it answers). */
export type TaskFactsInput = TaskStatusInput & { waits?: readonly TaskWait[] } & Pick<
    TaskView,
    "key" | "title" | "model" | "tier" | "delivery"
  > & {
    activityLog?: readonly TaskActivityRow[];
    said?: TaskActionLine | null;
    plan?: TaskPlan | null;
    reasoning?: Reasoning;
    modelReason?: ModelReason;
    modelChoice?: ModelChoice;
    browser?: TaskBrowserFact;
  };

/** Why this model, from the routing decision's reason and its saved comparison. */
function modelWhyOf(
  task: Pick<TaskFactsInput, "modelReason" | "modelChoice">,
  modelName: (model: string) => string,
): TaskModelWhy | null {
  const line = task.modelReason ? modelReasonLine(task.modelReason) : null;
  const choice = task.modelChoice;
  // A model the captain named or pinned is said by the line alone.
  const compared = choice && choice.decidedBy !== "named" && choice.decidedBy !== "pinned";
  if (!line && !compared) return null;
  const own = task.modelReason?.named || task.modelReason?.pinned;
  return {
    line,
    unrecorded: !choice && !own,
    choice: compared ? modelChoiceLine(choice, modelName) : null,
    comparison: compared
      ? {
          floorPercent: choice.floorPercent,
          candidates: choice.candidates.map((candidate) => ({
            ...candidate,
            name: modelName(candidate.model),
          })),
        }
      : null,
  };
}

/** One projection for the crew summary and the task record, so one task reads the same on both. */
export function taskFactsOf(task: TaskFactsInput, modelName: (model: string) => string): TaskFacts {
  const model = task.model ? modelName(task.model) : null;
  return {
    waits: task.waits,
    key: task.key,
    status: taskStatusOf(task),
    title: task.title,
    now: task.activityLog === undefined ? undefined : nowOf(task.activityLog, task.said ?? null),
    plan: task.activityLog === undefined ? undefined : (task.plan ?? null),
    model,
    // The readout belongs to a model: none of it stands without one.
    tier: model ? (task.modelReason?.asked ?? task.tier) : null,
    reasoning: model ? (task.reasoning ?? null) : null,
    reason: model && task.reasoning ? reasoningNote(task.reasoning) : null,
    why: model ? modelWhyOf(task, modelName) : null,
    delivery: deliveryOf(task),
    ...pullRequestLinesOf(task.delivery),
    browser: task.browser ? browserLineOf(task.browser, task) : null,
  };
}

/**
 * The record's Pull requests row (INF-2490 round two): each pull request
 * merged, or with its own checks as last read (INF-2546); none while the
 * task has one or none.
 */
function pullRequestLinesOf(delivery: TaskView["delivery"]): {
  pullRequests?: TaskPullRequestLine[];
} {
  const pulls = delivery?.pullRequests ?? [];
  if (pulls.length < 2) return {};
  const pullRequests = pulls.map((pull) => ({
    number: pull.number,
    url: pull.url ?? null,
    words: pull.merged
      ? PULL_REQUEST_WORDS.merged
      : `${PULL_REQUEST_WORDS.checks} ${pull.ci && pull.ci !== "no-pr" ? CHECK_WORDS[pull.ci] : CHECKS_NOT_READ_WORDS}`,
    closes: Boolean(pull.closes),
  }));
  return { pullRequests };
}

/** The rows a crewmate's own work writes: a note, a report, a card, a pull request, its checks. */
const DOING_KINDS: ReadonlySet<TaskEventKind> = new Set([
  "progress",
  "report",
  "card_raised",
  "pr_opened",
  "ci",
]);

/**
 * Rows the app writes to the crewmate or about its session, which never
 * stand as its Now: a message it was sent, and a compaction.
 */
const SENT_KINDS: ReadonlySet<TaskEventKind> = new Set(["steered", "compacted"]);

/**
 * The Now line (INF-554's audit, plan approved as INF-557): the crewmate's
 * own newest doing, with that doing's time - the newest of its own rows
 * (`DOING_KINDS`), the last sentence it wrote (`said`) and its newest
 * action, in the description it gave the call or Activity's plain reading
 * of it. A message the app sent it never stands as Now, so a crewmate that
 * did nothing since reads its last doing at its true age. Before it did
 * anything, Now is the newest row of the task's own but those, such as the
 * start line. A row another task wrote is Activity's alone.
 */
export function nowOf(
  log: readonly TaskActivityRow[],
  said: TaskActionLine | null,
): TaskFacts["now"] {
  const own = log.filter((row) => !row.from);
  const row = own.findLast((line) => DOING_KINDS.has(line.kind));
  let newest: { text: string; at: number; change?: TaskActivityLine["change"] } | undefined = row
    ? { text: row.text, at: row.at, ...(row.change ? { change: row.change } : {}) }
    : undefined;
  const actions = own.flatMap((line) => line.actions ?? []);
  for (const doing of said ? [...actions, said] : actions) {
    if (!newest || doing.at > newest.at) newest = { text: doing.text, at: doing.at };
  }
  if (newest) return newest;
  const before = own.findLast((line) => !SENT_KINDS.has(line.kind));
  return before
    ? { text: before.text, at: before.at, ...(before.change ? { change: before.change } : {}) }
    : null;
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

/** A hand-started run's dot by its state. */
const RUN_CHECKS_DOT: Record<RunChecks["state"], FactDotState> = {
  running: "running",
  passed: "ok",
  failed: "failed",
  cancelled: "idle",
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
 * With no change, the checks are the newest run the task started by hand
 * and the app watched (INF-594), when it has one.
 */
function deliveryOf(task: Pick<TaskView, "status" | "delivery">): TaskDelivery | null {
  const facts = task.delivery;
  if (!facts) return null;
  const live = task.status !== "done" && task.status !== "dropped";
  const change = live ? taskChangeOf(facts) : null;
  const ci = facts.ci ?? "no-pr";
  const observed = currentCheckSummary(facts);
  const ciWords = ci === "no-pr" ? CHECKS_NOT_READ_WORDS : CHECK_WORDS[ci];
  const checks =
    live && (observed || change || ci !== "no-pr")
      ? {
          ...(observed?.problem ? { problem: observed.problem } : {}),
          dot: observed?.dot ?? CHECKS_DOT[ci],
          words: observed?.words ?? ciWords,
          state: observed && facts.checks ? checkSnapshotState(facts.checks) : ciWords,
          at: facts.ciAt ?? null,
          span: checksSpanOf(facts),
        }
      : live && facts.runChecks
        ? {
            dot: RUN_CHECKS_DOT[facts.runChecks.state],
            words: RUN_CHECK_WORDS[facts.runChecks.state],
            state: RUN_CHECK_WORDS[facts.runChecks.state],
            at: facts.runChecks.at,
            span: runChecksSpanOf(facts.runChecks),
          }
        : null;
  // The version the review read rides its words; a pass the home says
  // does not cover the version on offer reads as an earlier one (INF-3141).
  const earlier = facts.reviewVerdict === "pass" && facts.reviewCovers === false;
  const review = facts.reviewVerdict
    ? {
        dot: earlier ? ("warn" as const) : REVIEW_DOT[facts.reviewVerdict],
        words: `${earlier ? REVIEW_EARLIER_WORDS : REVIEW_WORDS[facts.reviewVerdict]}${facts.reviewSha ? ` ${facts.reviewSha.slice(0, 7)}` : ""}${facts.reviewRisk ? ` · risk ${facts.reviewRisk}` : ""}`,
      }
    : null;
  return change || checks || review ? { change, checks, review } : null;
}
