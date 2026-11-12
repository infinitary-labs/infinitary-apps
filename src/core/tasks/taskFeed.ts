import { type FeedLine, reportSummary, taskFeedKind } from "@shared/feed";
import { formatNumber } from "@shared/i18n/format";
import { englishOf, type Said, said, saidLine, saidPart, saidSchema } from "@shared/i18n/said";
import { plainProblem, typedFailureOf } from "@shared/plainProblem";
import { droppedSaid } from "../orchestrator/settleWords";
import type { ActivityStore } from "../storage/activityStore";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
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
export const DISCARDED_LINE = englishOf(said("feedDiscarded"));

/** An answered task's own line when its close names no choice and no use. */
export const ANSWERED_LINE = englishOf(said("feedAnswered"));

/** The checks' state a `ci` event names, as its line says it. */
const CHECKS_SAID: Record<string, Said> = {
  green: said("feedChecksPassed"),
  red: said("feedChecksFailed"),
  pending: said("feedChecksRunning"),
  "no-pr": said("feedChecksNoPull"),
  merged: said("feedChecksMergedOutside"),
};

/** A review's risk level, as its line says it; another level is said as recorded. */
function riskWords(risk: string) {
  return risk === "low"
    ? saidPart("riskLow")
    : risk === "medium"
      ? saidPart("riskMedium")
      : risk === "high"
        ? saidPart("riskHigh")
        : risk;
}

/**
 * The fact a host line saved beside its words (`data.said`, docs/i18n.md
 * "Saved facts"), when it is one this version can read.
 */
export function savedSaid(value: unknown): Said | undefined {
  const parsed = saidSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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
  // Each line is a fact worded where it is shown, its English beside it
  // (docs/i18n.md, "Saved facts"); a line said as it was written has none.
  let fact: Said | undefined;
  let written: string | undefined;
  switch (event.kind) {
    case "dispatched":
      fact = said("feedStarted");
      break;
    case "report": {
      // A finished report is followed by its task's own Finished line, so
      // it writes none of its own (INF-1845).
      if (data.finished === true) return null;
      const summary = text(data.summary) ?? reportSummary(event.text);
      fact = summary ? said("feedReported", { summary }) : said("feedReportedBare");
      break;
    }
    case "failed": {
      // The raw error stays on the timeline (the record) and in Observe; the
      // feed says what it means (the vocabulary's error row). A turn that
      // failed on a task that lives on (recordTurnFailure marks it
      // non-fatal) reads differently from a task that failed for good.
      const problem = plainProblem(text(data.error) ?? event.text, typedFailureOf(data));
      fact =
        data.fatal === false ? said("feedProblem", { problem }) : said("feedFailed", { problem });
      break;
    }
    case "landed":
    case "merged":
      // The close carries the change and where it went in (INF-1845).
      fact = savedSaid(data.lineSaid);
      written = fact ? undefined : text(data.line);
      if (!fact && !written) fact = said("feedMerged");
      break;
    case "status": {
      const reason = text(data.reason);
      const sentence = text(data.closingSentence);
      const carriedBy = text(data.carriedBy);
      const choice = text(data.choice);
      if (status === "done" && reason === "superseded" && carriedBy) {
        // Work another task carries on (INF-1825): one line, no note.
        fact = said("feedCarriedOnBy", { key: carriedBy });
      } else if (status === "dropped" && sentence) {
        // A drop the first mate made carries its own sentence (INF-547):
        // the line says what the drop was, the same words as its note.
        fact = droppedSaid(sentence);
      } else if (data.container === true) {
        // A parent that carried no crewmate closed with its children (the
        // container rule): its line says what became of the work under it.
        fact = reason === "finished" ? said("feedContainerFinished") : said("feedContainerStopped");
      } else if (reason === "answered" && choice) {
        // The captain's own choice on the answer's card (INF-1845).
        fact = said("feedYouChose", { choice });
      } else if (
        reason === "answered" &&
        (typeof data.basisOf === "string" ||
          typeof data.waitedOnBy === "string" ||
          data.reported === true)
      ) {
        // An answer the next task took as its basis, a step a live task
        // waited on, or a step whose reported answer the first mate passed
        // on itself (settle_task done, why answered): it was used, not thrown away.
        fact = said("feedAnsweredWith", { answer: event.text.replace(/^answered - /, "") });
      } else if (reason === "answered") {
        fact = said("feedAnswered");
      } else if (reason === "discarded") {
        fact = said("feedDiscarded");
      } else if (reason === "released") {
        fact = said("feedReleased");
      } else if (reason === "finished" && record.delivery?.mode === "in-place") {
        // The personal workspace (talk-to-personalize Step 4): the work is in
        // place and committed; nothing was decommissioned or landed.
        fact = said("feedBuiltInPlace");
      } else if (reason === "finished") {
        fact = said("feedFinished");
      } else if (reason === "cancelled" && record.assignee) {
        fact = said("feedStopped");
      } else {
        fact = said("feedUpdated", { text: event.text });
      }
      break;
    }
    case "escalated": {
      // The rejected attempt's line is the whole escalation's feed presence
      // (S4): what was escalated, to which tier, and which row carries it
      // on. The fresh attempt's own `escalated` row is feed = 0.
      const tier = text(data.tier);
      const continues = text(data.escalated_to);
      fact = !continues
        ? said("feedUpdated", { text: event.text })
        : tier
          ? said("feedMovedOnTier", { tier, key: continues })
          : said("feedMoved", { key: continues });
      break;
    }
    case "note": {
      // Undelivered guidance (WI-5): the timeline keeps the guidance itself;
      // the feed line stays short and says what happened to it.
      // A filing verdict is the one line the quiet ledger promised. A move
      // to another model (`recordServedModel`), and a feed line written as
      // a row on its task (`data.feedLine`), is said as it was written,
      // with the fact its writer saved beside it, if any.
      const why = text(data.why);
      if (text(data.ledger) === "verdict") fact = said("feedFirstMateSaid", { text: event.text });
      else if (typeof data.undelivered === "number" && why) fact = said("feedUndelivered", { why });
      else if (text(data.servedModel) || data.feedLine === true) {
        fact = savedSaid(data.said);
        written = fact ? undefined : event.text;
      } else fact = said("feedNoted", { text: event.text });
      break;
    }
    // The delivery lines are authored from the facts the event carries, not
    // its text: the timeline keeps the PR number, link and SHA for the
    // record, and the feed says what they mean.
    case "pr_opened":
      fact = typeof data.prNumber === "number" ? said("feedPullOpened") : said("feedBranchPushed");
      break;
    case "ci": {
      const rounds = typeof data.ciRounds === "number" ? data.ciRounds : undefined;
      const checks = text(data.ci);
      fact =
        data.ciCapAt !== undefined && rounds !== undefined
          ? said("feedRepairsCapped", { rounds })
          : ((checks ? CHECKS_SAID[checks] : undefined) ?? said("feedChecksUpdated"));
      break;
    }
    case "review": {
      const verdict = text(data.reviewVerdict);
      const risk = text(data.reviewRisk);
      fact =
        verdict === "pass"
          ? risk
            ? said("feedReviewPassedRisk", { risk: riskWords(risk) })
            : said("feedReviewPassed")
          : verdict === "findings"
            ? said("feedReviewFindings")
            : verdict === "blocked"
              ? said("feedReviewBlocked")
              : said("feedReviewUpdated");
      break;
    }
    default:
      fact = said("feedUpdated", { text: event.text });
  }
  return {
    // A model the backend chose on its own, or a project folder a merge
    // left behind, is worth a look.
    kind:
      event.kind === "note" &&
      ((data.fallback !== undefined && text(data.servedModel)) || data.folderRefresh !== undefined)
        ? "warn"
        : taskFeedKind(event.kind, status),
    text: written ?? (fact ? englishOf(fact) : ""),
    ...(fact ? { said: fact } : {}),
    at: event.at,
    taskKey: record.key,
    event: event.kind,
    // Every line but a report's is the host's own words; a report's is the
    // crewmate's summary, whose "this computer" is wherever it ran.
    ...(event.kind === "report" ? {} : { saidHere: true as const }),
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
 * at its newest; the timeline keeps every one. Each line in the first mate's
 * computer's own words says so (`saidHere`), for a computer that controls
 * it to name that computer where the line says this computer.
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
          ...saidLine(
            dropped
              ? said("feedProgramPartsStopped", {
                  done: formatNumber(done),
                  total: formatNumber(parts.length),
                  stopped: formatNumber(dropped),
                  title: program.title,
                })
              : said("feedProgramParts", {
                  done: formatNumber(done),
                  total: formatNumber(parts.length),
                  title: program.title,
                }),
          ),
          saidHere: true as const,
        },
      ];
    }
    const line = taskFeedLine(record, event);
    return line ? [line] : [];
  });
  // Every task-less line but the captain's own turn is the first mate's
  // computer's words (`saidHere`).
  const ownLines = activity
    .recent(limit)
    .map((line): FeedLine => (line.kind === "you" ? line : { ...line, saidHere: true }));
  // Both halves oldest first before the stable merge, so lines that share
  // a millisecond keep the order they were written in.
  return [...taskLines.reverse(), ...ownLines].sort((a, b) => a.at - b.at).slice(-limit);
}
