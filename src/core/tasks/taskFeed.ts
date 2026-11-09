import { type FeedLine, reportSummary, taskFeedKind } from "@shared/feed";
import { plainProblem, typedFailureOf } from "@shared/plainProblem";
import { CHECK_WORDS } from "@shared/vocabulary";
import { droppedLine } from "../orchestrator/settleWords";
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

/**
 * The fold every settle line of a task shares (INF-1845): the captain's
 * click ("Merging #709"), what became of it ("Cannot merge: ...", a kept
 * merge's wait), and the close that merged or discarded it. Activity shows
 * only the newest, so one merge is one line; the timeline keeps each.
 */
export const SETTLE_FOLD = "settle";

/** A discarded task's own line: its close says it, with nothing more to add. */
export const DISCARDED_LINE = "Discarded";

/** An answered task's own line when its close names no choice and no use. */
export const ANSWERED_LINE = "Answered";

/** The fold a timeline event's feed line belongs to, if any (`recentFeed`). */
function foldOf(event: TaskEvent): string | undefined {
  const once = text(event.data?.feedOnce);
  if (once) return once;
  if (event.kind === "merged" || event.kind === "landed") return SETTLE_FOLD;
  if (event.kind === "status" && event.data?.reason === "discarded") return SETTLE_FOLD;
  return undefined;
}

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
      // A finished report is followed by its task's own Finished line, so
      // it writes none of its own (INF-1845).
      if (data.finished === true) return null;
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
      // The close carries the change and where it went in (INF-1845).
      line = text(data.line) ?? "Merged";
      break;
    case "status": {
      const reason = text(data.reason);
      const sentence = text(data.closingSentence);
      const carriedBy = text(data.carriedBy);
      if (status === "done" && reason === "superseded" && carriedBy) {
        // Work another task carries on (INF-1825): one line, no note.
        line = `Carried on by ${carriedBy}`;
      } else if (status === "dropped" && sentence) {
        // A drop the first mate made carries its own sentence (INF-547):
        // the line says what the drop was, the same words as its note.
        line = droppedLine(sentence);
      } else if (data.container === true) {
        // A parent that carried no crewmate closed with its children (the
        // container rule): its line says what became of the work under it.
        line =
          reason === "finished"
            ? "Done: everything under it is finished"
            : "Stopped: nothing under it went ahead";
      } else if (reason === "answered" && text(data.choice)) {
        // The captain's own choice on the answer's card (INF-1845).
        line = `You chose "${text(data.choice)}"`;
      } else if (
        reason === "answered" &&
        (typeof data.basisOf === "string" ||
          typeof data.waitedOnBy === "string" ||
          data.reported === true)
      ) {
        // An answer the next task took as its basis, a step a live task
        // waited on, or a step whose reported answer the first mate passed
        // on itself (settle_task done, why answered): it was used, not thrown away.
        line = `Answered: ${event.text.replace(/^answered - /, "")}`;
      } else if (reason === "answered") {
        line = ANSWERED_LINE;
      } else if (reason === "discarded") {
        line = DISCARDED_LINE;
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
    // A model the backend chose on its own, or a project folder a merge
    // left behind, is worth a look.
    kind:
      event.kind === "note" &&
      ((data.fallback !== undefined && text(data.servedModel)) || data.folderRefresh !== undefined)
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
 * merged with the task-less activity lines, cut to `limit`. Programs and
 * their direct parts occupy one progress row; their full events stay on
 * each record. The event store folds before limiting, so a program's many
 * parts cannot crowd unrelated work out of the retained view (INF-1137).
 * A line its writer marked to show once per task (`data.feedOnce`, such
 * as queued guidance going out, or a settle's `SETTLE_FOLD`) appears only
 * at its newest; the timeline keeps every one.
 */
export function recentFeed(tasks: TaskService, activity: ActivityStore, limit: number): FeedLine[] {
  const records = new Map<string, TaskRecord | undefined>();
  const shown = new Set<string>();
  // Newest first, so the first of a fold seen is the one that stays.
  const taskLines = tasks.listFeedEvents(limit).flatMap((event) => {
    const once = foldOf(event);
    if (once) {
      const fold = `${event.taskId}\u0000${once}`;
      if (shown.has(fold)) return [];
      shown.add(fold);
    }
    if (!records.has(event.taskId)) records.set(event.taskId, tasks.get(event.taskId));
    const record = records.get(event.taskId);
    if (!record) return [];
    const parent = record.parentId ? tasks.get(record.parentId) : undefined;
    const program = parent?.shape?.program ? parent : record.shape?.program ? record : undefined;
    if (program) {
      const parts = tasks.graph.children(program.id);
      const done = parts.filter((part) => part.status === "done").length;
      const dropped = parts.filter((part) => part.status === "dropped").length;
      return [
        {
          taskKey: program.key,
          at: event.at,
          kind:
            program.status === "dropped" || dropped > 0
              ? ("warn" as const)
              : program.status === "done"
                ? ("ok" as const)
                : ("info" as const),
          text: `${done}/${parts.length} parts done${dropped ? ` · ${dropped} stopped` : ""} · ${program.title}`,
        },
      ];
    }
    const line = taskFeedLine(record, event);
    return line ? [line] : [];
  });
  // Both halves oldest first before the stable merge, so lines that share
  // a millisecond keep the order they were written in.
  return [...taskLines.reverse(), ...activity.recent(limit)]
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}
