import { type FeedLine, reportSummary, taskFeedKind } from "@shared/feed";
import { plainProblem, typedFailureOf } from "@shared/plainProblem";
import { CHECK_WORDS } from "@shared/vocabulary";
import type { ActivityStore } from "../storage/activityStore";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "./taskService";

/**
 * The feed as a view over the task record (task-system design section 11,
 * P3). A feed-worthy timeline event (`task_events.feed = 1`) becomes one
 * feed line authored HERE from the event and its record, in one place for
 * both carriers: the live `task_event` FmEvent the core emits after the
 * commit, and `inf:feed:recent`, which reads the same rows back. The few
 * task-less lines (the captain's own turn, a note, a fleet operation, the
 * Firstmate's failed turn) still persist through `activity_events`; the
 * two are merged by time.
 *
 * Task lines carry only the update ("Started", "Reported: summary") and
 * the task key separately; both Activity and the update above the input
 * paint that key before the text. Long titles never crowd out the update.
 * Lines are derived from the record instead of a runtime event, so the feed
 * cannot say something the record does not.
 */

/** What a feed line needs from the record beside the event. */
export type FeedSubject = Pick<TaskRecord, "key" | "assignee" | "delivery">;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The feed line for one timeline event, or null when it stays off the feed. */
export function taskFeedLine(record: FeedSubject, event: TaskEvent): FeedLine | null {
  if (!event.feed) return null;
  const data = event.data ?? {};
  const status = text(data.status);
  let line: string;
  switch (event.kind) {
    case "dispatched":
      line = "Started";
      break;
    case "report": {
      const summary = text(data.summary) ?? reportSummary(event.text);
      line = summary ? `Reported: ${summary}` : "Reported";
      break;
    }
    case "failed": {
      // The raw error stays on the timeline (the record) and in Observe; the
      // feed says what it means (the vocabulary's error row). A turn that
      // failed on a task that lives on (recordTurnFailure marks it
      // non-fatal) reads differently from a task that failed for good.
      const problem = plainProblem(text(data.error) ?? event.text, typedFailureOf(data));
      line = `${data.fatal === false ? "Problem" : "Failed"}: ${problem}`;
      break;
    }
    case "landed":
    case "merged":
      line = "Merged";
      break;
    case "status": {
      const reason = text(data.reason);
      if (data.container === true) {
        // A parent that carried no crewmate closed with its children (the
        // container rule): its line says what became of the work under it.
        line =
          reason === "finished"
            ? "Done: everything under it is finished"
            : "Stopped: nothing under it went ahead";
      } else if (
        reason === "answered" &&
        (typeof data.basisOf === "string" || typeof data.waitedOnBy === "string")
      ) {
        // An answer the next task took as its basis, or a step a live task
        // waited on (settle_task answered): it was used, not thrown away.
        line = `Answered: ${event.text.replace(/^answered - /, "")}`;
      } else if (reason === "released") {
        line = "Released outside this task";
      } else if (reason === "finished" && record.delivery?.mode === "in-place") {
        // The personal workspace (talk-to-personalize Step 4): the work is in
        // place and committed; nothing was decommissioned or landed.
        line = "Built in place";
      } else if (reason === "finished") {
        line = "Finished";
      } else if (reason === "cancelled" && record.assignee) {
        line = "Stopped";
      } else {
        line = `Updated: ${event.text}`;
      }
      break;
    }
    case "escalated": {
      // The rejected attempt's line is the whole escalation's feed presence
      // (S4): what was escalated, to which tier, and which row carries it
      // on. The fresh attempt's own `escalated` row is feed = 0.
      const tier = text(data.tier);
      const continues = text(data.escalated_to);
      line = continues
        ? `Moved to a stronger model: ${tier ? `${tier}; ` : ""}continues as ${continues}`
        : `Updated: ${event.text}`;
      break;
    }
    case "note": {
      // Undelivered guidance (WI-5): the timeline keeps the guidance itself;
      // the feed line stays short and says what happened to it.
      // A filing verdict is the one line the quiet ledger promised. A move
      // to another model (`recordServedModel`), and a feed line written as
      // a row on its task (`data.feedLine`), is said as it was written.
      const why = text(data.why);
      line =
        text(data.ledger) === "verdict"
          ? `First mate: ${event.text}`
          : typeof data.undelivered === "number" && why
            ? `Message undelivered: ${why}`
            : text(data.servedModel) || data.feedLine === true
              ? event.text
              : `Noted: ${event.text}`;
      break;
    }
    // The delivery lines are authored from the facts the event carries, not
    // its text: the timeline keeps the PR number, link and SHA for the
    // record, and the feed says what they mean.
    case "pr_opened":
      line = typeof data.prNumber === "number" ? "Opened a pull request" : "Pushed the branch";
      break;
    case "ci": {
      const rounds = typeof data.ciRounds === "number" ? data.ciRounds : undefined;
      const checks = text(data.ci);
      line =
        data.ciCapAt !== undefined && rounds !== undefined
          ? `${rounds} repairs did not get the checks to pass - your first mate will ask you what to do`
          : checks && CHECK_WORDS[checks]
            ? `The checks ${CHECK_WORDS[checks]}`
            : "Checks updated";
      break;
    }
    case "review": {
      const verdict = text(data.reviewVerdict);
      const risk = text(data.reviewRisk);
      line =
        verdict === "pass"
          ? `Passed its review${risk ? `, ${risk} risk` : ""}`
          : verdict === "findings"
            ? "The review found things to fix"
            : verdict === "blocked"
              ? "The review could not finish"
              : "Review updated";
      break;
    }
    default:
      line = `Updated: ${event.text}`;
  }
  return {
    // A model the backend chose on its own is worth a look.
    kind:
      event.kind === "note" && data.fallback !== undefined && text(data.servedModel)
        ? "warn"
        : taskFeedKind(event.kind, status),
    text: line,
    at: event.at,
    taskKey: record.key,
    event: event.kind,
  };
}

/**
 * The persisted feed, oldest first: the newest feed-worthy timeline events
 * merged with the task-less activity lines, cut to `limit`.
 */
export function recentFeed(tasks: TaskService, activity: ActivityStore, limit: number): FeedLine[] {
  const records = new Map<string, TaskRecord | undefined>();
  const taskLines = tasks.listFeedEvents(limit).flatMap((event) => {
    if (!records.has(event.taskId)) records.set(event.taskId, tasks.get(event.taskId));
    const record = records.get(event.taskId);
    if (!record) return [];
    const line = taskFeedLine(record, event);
    return line ? [line] : [];
  });
  // Both halves oldest first before the stable merge, so lines that share
  // a millisecond keep the order they were written in.
  return [...taskLines.reverse(), ...activity.recent(limit)]
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}
