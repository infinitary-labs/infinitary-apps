import { reportSummary } from "@shared/feed";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { DROP_BEFORE_START, DROPPED_BEFORE_START_ACTIVITY } from "@shared/recordDrop";
import { CI_ROUND_CAP, withoutIntentLead } from "@shared/rigor";
import type {
  TaskActionLine,
  TaskActivityLine,
  TaskActivityRow,
  TaskEventKind,
  TaskEventView,
} from "@shared/tasks";
import type { TaskConcernRelation } from "../storage/taskEventStore";

/**
 * Where an event reads in a record's Activity (docs/task-record.md, "What
 * Activity holds"): a `row` of its own, `folded` under the row it led to,
 * or `evidence` the timeline keeps for whoever digs, never in Activity.
 */
export type ActivityPlace = "row" | "folded" | "evidence";

/**
 * Every event kind's place, the code copy of the table in
 * docs/task-record.md, "What Activity holds". A new kind fails the build
 * until it has one. A row kind folds when its own typed facts say it is
 * minor, and a folded kind is a row when they say it matters - each case is
 * the table's, and `condenseActivity` reads them below.
 */
export const ACTIVITY_PLACES: Record<TaskEventKind, ActivityPlace> = {
  created: "row",
  ask: "row",
  answered: "row",
  briefed: "evidence",
  dispatched: "row",
  steered: "row",
  progress: "row",
  report: "row",
  failed: "row",
  card_raised: "row",
  card_resolved: "row",
  status: "folded",
  linked: "row",
  unlinked: "row",
  moved: "row",
  pr_opened: "row",
  ci: "row",
  landed: "row",
  merged: "row",
  triaged: "row",
  note: "row",
  compacted: "row",
  interrupted: "row",
  decided: "evidence",
  escalated: "row",
  review: "row",
  cap_reset: "row",
  replied: "row",
};

/**
 * An event another task wrote that concerns this one (docs/task-record.md,
 * "Whom an event concerns"), as the record reads it: the task that wrote it,
 * how that task stands to this one, and the task a replacement carried it
 * through. Its kind keeps its place in `ACTIVITY_PLACES`.
 */
export type ConcernedEventView = TaskEventView & {
  /**
   * The task that wrote it, and its change's label (`#N`) when it has one,
   * with the change's page where the host has one.
   */
  from: { id: string; key: string; change?: string; changeUrl?: string };
  relation: TaskConcernRelation;
  /** The key of the task it replaced, through which the event reached this one. */
  via?: string;
};

/** What the record reads besides its own timeline. */
export type ActivityContext = {
  /** A card's title by its id, for a reply under it. */
  cardTitle?: (cardId: string) => string | undefined;
  /** The events of other tasks that concern this one, in timeline order. */
  concerned?: readonly ConcernedEventView[];
  /** Another task's key by its id, for the replacement a drop names. */
  keyOf?: (taskId: string) => string | undefined;
  /** What the task's crewmate did, oldest first (`CrewActions`). */
  actions?: readonly TaskActionLine[];
};

/**
 * The record's Activity: every event of the timeline but the evidence, in
 * time order, read in plain words from typed fields only, never from the
 * words (the task popup audit, A8; FI3-1189's rule 2, "fold instead of
 * hiding"). Nothing else is left out: a minor event folds under the next
 * row of the task's own, the one it led to, and what no row followed yet
 * folds under the newest one. `TaskDetail.events` keeps the timeline whole.
 *
 * - a host note is news or bookkeeping as its writer declared
 *   (`data.news`); bookkeeping folds, and so does a host note written
 *   before writers declared;
 * - a status line that does not close the task folds;
 * - a `ci` reading with the same result as the last one shown, or with no
 *   change to read, folds;
 * - a report folds the progress line of the task's own just before it,
 *   which it restates, and reads as its one-line summary (on the record,
 *   that line opens to the whole report);
 * - `ci`, `pr_opened` and `dispatched` read in plain words, the model by
 *   the name the captain knows it by, and so does a move to another model
 *   (the host's `note` naming `servedModel`);
 * - a reply the captain typed under a card reads as the captain's words
 *   and the card's title (`cardTitle`), not the whole message its
 *   crewmate was sent, and a reply its crewmate or Firstmate wrote there
 *   reads as its first sentence under the card's title;
 * - a move a panel made on the captain's click says which panel
 *   (`data.panel`, docs/ui-plugins.md "A panel's cards");
 * - another task's event that concerns this one (FI3-1189's rule 1) is a
 *   row naming that task (`from`), in its time: what happened to it, by how
 *   it stands to this one (`concernedWords`). It takes no fold, and the
 *   far end of a filing folds under it, since the filing's own note says it.
 *
 * What the crewmate did (`context.actions`, oldest first, read from its
 * kept session by `CrewActions`; FI3-1189's rule 3) folds the same way, as
 * a row's `actions`: under the first of the task's own rows recorded at or
 * after it, and what no row followed yet under the newest of them.
 */
export function condenseActivity(
  events: readonly TaskEventView[],
  modelLabel: (model: string) => string,
  context: ActivityContext = {},
): TaskActivityRow[] {
  const {
    cardTitle = () => undefined,
    concerned = [],
    keyOf = () => undefined,
    actions = [],
  } = context;
  const rows: TaskActivityRow[] = [];
  /** Folded lines waiting for the row they led to. */
  let pending: TaskActivityLine[] = [];
  /** What the crewmate did, waiting for the row it led to. */
  let done: TaskActionLine[] = [];
  let next = 0;
  let lastCi: string | undefined;
  /** The task's own change by its label, and its page, once it opened one. */
  let change: string | undefined;
  let changeUrl: string | undefined;
  for (const event of inTimeOrder(events, concerned)) {
    // What the crewmate did by the time of this event led to it.
    for (let action = actions[next]; action && action.at <= event.at; action = actions[++next]) {
      done.push(action);
    }
    if (ACTIVITY_PLACES[event.kind] === "evidence") continue;
    const data = event.data ?? {};
    if ("from" in event) {
      const text = concernedWords(event, keyOf);
      // The pull request the other task opened, or its own change when it merged.
      const named =
        event.kind === "pr_opened"
          ? { label: changeLabelOf(data), url: changeUrlOf(data) }
          : { label: event.from.change, url: event.from.changeUrl };
      const span = changeSpan(text, named.label, named.url);
      const line: TaskActivityLine = {
        id: event.id,
        at: event.at,
        kind: event.kind,
        text,
        from: { id: event.from.id, key: event.from.key },
        ...(span ? { change: span } : {}),
      };
      if (event.kind === "linked" && event.relation === "origin") pending.push(line);
      else rows.push(line);
      continue;
    }
    const line = (words: string): TaskActivityLine => {
      const text =
        typeof data.panel === "string" ? `${words} From the ${data.panel} panel.` : words;
      // Whatever names the task's own pull request links to it.
      const span = changeSpan(text, change, changeUrl);
      return {
        id: event.id,
        at: event.at,
        kind: event.kind,
        text,
        ...(span ? { change: span } : {}),
      };
    };
    const show = (text: string) => {
      rows.push({
        ...line(text),
        ...(pending.length > 0 ? { folded: pending } : {}),
        ...(done.length > 0 ? { actions: done } : {}),
      });
      pending = [];
      done = [];
    };
    const fold = (text: string) => {
      pending.push(line(text));
    };
    switch (event.kind) {
      case "note": {
        const moved = modelMoveOf(data);
        if (moved) {
          const words = modelMoveWords({
            from: moved.from ? modelLabel(moved.from) : undefined,
            to: modelLabel(moved.to),
            fallback: moved.fallback,
          });
          show(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`);
        } else if (isNews(event)) show(event.text);
        else fold(event.text);
        break;
      }
      case "status":
        if (data.status === "done" || data.status === "dropped") {
          show(droppedBeforeStart(event) ?? event.text);
        } else fold(event.text);
        break;
      case "ci": {
        const result = typeof data.ci === "string" ? data.ci : undefined;
        if (!result || result === "no-pr" || result === lastCi) {
          fold(result ? checksSentence(result, change, data.ciRounds) : event.text);
          break;
        }
        lastCi = result;
        show(checksSentence(result, change, data.ciRounds));
        break;
      }
      case "pr_opened": {
        const label = changeLabelOf(data);
        if (label) {
          change = label;
          changeUrl = changeUrlOf(data);
        }
        show(
          !label
            ? event.text
            : typeof data.prNumber === "number"
              ? `Opened pull request ${label}.`
              : `Pushed the branch ${label}.`,
        );
        break;
      }
      case "merged": {
        // The host's receipt names the pull request and prints its address;
        // the record names it as the pull request, linked to that address.
        if (!change) {
          change = changeLabelOf(data);
          changeUrl = changeUrlOf(data);
        }
        show(change?.startsWith("#") ? `Merged pull request ${change}.` : event.text);
        break;
      }
      case "dispatched": {
        const who = typeof data.assignee === "string" ? data.assignee : "A crewmate";
        const model = typeof data.model === "string" && data.model ? data.model : undefined;
        show(model ? `${who} started on ${modelLabel(model)}.` : `${who} started.`);
        break;
      }
      case "steered":
        show(replyWords(event, cardTitle) ?? event.text);
        break;
      case "replied": {
        const title = typeof data.cardId === "string" ? cardTitle(data.cardId) : undefined;
        const named = title ?? (typeof data.title === "string" ? data.title : undefined);
        const who = event.actor === "firstmate" ? "The first mate" : "The crewmate";
        const under = named ? ` under "${named}"` : " under a card";
        show(`${who} replied${under}: ${reportSummary(event.text) || event.text}`);
        break;
      }
      case "report": {
        const restated = rows.findLastIndex((row) => !row.from);
        const before = rows[restated];
        if (before?.kind === "progress") {
          rows.splice(restated, 1);
          const { folded = [], actions: led = [], ...progress } = before;
          pending = [...folded, progress, ...pending];
          done = [...led, ...done];
        }
        show(reportHeadline(event.text, data.summary));
        break;
      }
      default:
        if (ACTIVITY_PLACES[event.kind] === "folded") fold(event.text);
        else show(event.text);
    }
  }
  // Nothing is dropped: what no row followed yet folds under the newest of
  // the task's own rows, and with none the folded events stand as rows.
  done.push(...actions.slice(next));
  if (pending.length > 0 && !rows.some((row) => !row.from)) {
    rows.push(...pending);
    rows.sort((a, b) => a.at - b.at || a.id - b.id);
    pending = [];
  }
  const newest = rows.findLastIndex((row) => !row.from);
  const row = rows[newest];
  if (row && (pending.length > 0 || done.length > 0)) {
    rows[newest] = {
      ...row,
      ...(pending.length > 0 ? { folded: [...(row.folded ?? []), ...pending] } : {}),
      ...(done.length > 0 ? { actions: [...(row.actions ?? []), ...done] } : {}),
    };
  }
  return rows;
}

/** The task's own events and the ones that concern it, merged in timeline order. */
function inTimeOrder(
  own: readonly TaskEventView[],
  concerned: readonly ConcernedEventView[],
): (TaskEventView | ConcernedEventView)[] {
  if (concerned.length === 0) return [...own];
  return [...own, ...concerned].sort((a, b) => a.at - b.at || a.id - b.id);
}

/**
 * Another task's event as this task's Activity reads it (FI3-1189's rule 1):
 * that task by its key and how it stands to this one, then what happened
 * to it, read from typed fields only - a milestone (filed, started, a pull
 * request opened, merged, closed and why, failed), a link at its far end,
 * or a merge refused while it waits on this task.
 */
export function concernedWords(
  event: ConcernedEventView,
  keyOf: (taskId: string) => string | undefined = () => undefined,
): string {
  const key = event.from.key;
  const data = event.data ?? {};
  if (event.kind === "linked" || event.kind === "unlinked") {
    const no = event.kind === "unlinked";
    switch (event.relation) {
      case "waiter":
        return `${key} ${no ? "no longer waits" : "waits"} for this task.`;
      case "origin":
        return no ? `No longer filed from ${key}.` : `Filed while working on ${key}.`;
      case "replacement":
        return `${key} ${no ? "no longer replaces" : "replaces"} this task.`;
      default:
        return `${key} is ${no ? "no longer " : ""}related to this task.`;
    }
  }
  const subject = event.via
    ? `${key}, which replaced ${event.via},`
    : RELATION_WORDS[event.relation](key);
  const happened = milestoneWords(event, keyOf);
  return happened ? `${subject} ${happened}` : `${key}: ${event.text}`;
}

/** The other task as the subject of its row, by how it stands to this one. */
const RELATION_WORDS: Record<TaskConcernRelation, (key: string) => string> = {
  part: (key) => `${key}, a part of this task,`,
  parent: (key) => `${key}, which this task is a part of,`,
  "follow-up": (key) => `${key}, filed by this task,`,
  origin: (key) => `${key}, which this task was filed from,`,
  blocker: (key) => `${key}, which this task waits for,`,
  waiter: (key) => `${key}, which waits for this task,`,
  replacement: (key) => `${key}, which replaced this task,`,
  replaced: (key) => `${key}, which this task replaced,`,
  "built-on": (key) => `${key}, built on this task,`,
  related: (key) => `${key}, related to this task,`,
};

/** What happened to the other task, or undefined when the event is not one the words know. */
function milestoneWords(
  event: ConcernedEventView,
  keyOf: (taskId: string) => string | undefined,
): string | undefined {
  const data = event.data ?? {};
  switch (event.kind) {
    case "created":
      return "was filed.";
    case "dispatched":
      return "started.";
    case "pr_opened": {
      const label = changeLabelOf(data);
      if (!label) return "opened a pull request.";
      return typeof data.prNumber === "number"
        ? `opened pull request ${label}.`
        : `pushed the branch ${label}.`;
    }
    case "merged": {
      const label = event.from.change;
      if (!label) return "was merged.";
      return label.startsWith("#")
        ? `merged pull request ${label}.`
        : `merged the branch ${label}.`;
    }
    case "landed":
      return "was merged.";
    case "failed":
      return "failed.";
    case "status":
      return closedWords(event, keyOf);
    case "note":
      return typeof data.refused === "string" ? "could not merge." : undefined;
    default:
      return undefined;
  }
}

/** How another task closed, and why: the replacement a drop names, or the words it was dropped with. */
function closedWords(
  event: ConcernedEventView,
  keyOf: (taskId: string) => string | undefined,
): string | undefined {
  const data = event.data ?? {};
  if (data.status === "dropped") {
    const replacement = typeof data.replacedBy === "string" ? keyOf(data.replacedBy) : undefined;
    if (replacement) return `was dropped: ${replacement} replaces it.`;
    if (data.reason === "discarded") return "was discarded.";
    const why = event.text.startsWith("dropped - ") ? event.text.slice(10).trim() : "";
    return why ? `was dropped: ${why.replace(/\.$/, "")}.` : "was dropped.";
  }
  if (data.status !== "done") return undefined;
  switch (data.reason) {
    case "answered":
      return "was answered.";
    case "finished":
      return "finished.";
    case "released":
      return "was released.";
    default:
      return "closed.";
  }
}

/**
 * A note's place as its writer declared it (`TaskService.note`'s `news`):
 * one written before writers declared is news unless the host wrote it.
 */
function isNews(event: TaskEventView): boolean {
  const news = event.data?.news;
  return typeof news === "boolean" ? news : event.actor !== "host";
}

/**
 * A reply the captain typed under a card, as the captain's words in the
 * steer's text (`SteerEventData.words`) and the card's title, or a line he
 * typed in the task card's Crewmate tab, as his words; undefined for any
 * other steer, or one recorded before the span was.
 */
function replyWords(
  event: TaskEventView,
  cardTitle: (cardId: string) => string | undefined,
): string | undefined {
  const span = event.data?.words;
  if (!span || typeof span !== "object") return undefined;
  const { from, to } = span as { from?: unknown; to?: unknown };
  if (typeof from !== "number" || typeof to !== "number" || from > to || to > event.text.length) {
    return undefined;
  }
  const words = event.text.slice(from, to).trim();
  if (event.data?.via === CREWMATE_TAB_VIA) {
    return words ? `You told the crewmate: ${words}` : "You told the crewmate something.";
  }
  const cardId = event.data?.cardId;
  const title = typeof cardId === "string" ? cardTitle(cardId) : undefined;
  const under = title ? ` under "${title}"` : " under a card";
  return words ? `You replied${under}: ${words}` : `You replied${under}.`;
}

/**
 * A move to another model, as the timeline and the feed say it
 * (`CrewSupervisor.recordServedModel`), each model by the name the captain
 * knows it by: the backend's own fallback names the model whose safeguards
 * stopped a reply.
 */
export function modelMoveWords(move: { from?: string; to: string; fallback: boolean }): string {
  if (!move.from) return `Moved to ${move.to}`;
  return move.fallback
    ? `Moved from ${move.from} to ${move.to} after ${move.from}'s safeguards stopped a reply`
    : `Moved from ${move.from} to ${move.to}`;
}

/**
 * The launch's feed line naming the tasks a quit, restart or update paused,
 * which carry on by themselves (`CrewSupervisor.announceCarryOn`, INF-1272).
 */
export function carryOnWords(tasks: readonly { key: string; title: string }[]): string {
  const named = tasks.map((task) => `${task.key} “${task.title}”`).join(", ");
  return tasks.length === 1
    ? `The app reopened, and 1 task carries on where it stopped: ${named}.`
    : `The app reopened, and ${tasks.length} tasks carry on where they stopped: ${named}.`;
}

/** The typed facts of a move to another model, as `recordServedModel` writes them. */
function modelMoveOf(
  data: Record<string, unknown>,
): { from?: string; to: string; fallback: boolean } | undefined {
  if (typeof data.servedModel !== "string" || !data.servedModel) return undefined;
  const fallback =
    data.fallback && typeof data.fallback === "object"
      ? (data.fallback as Record<string, unknown>)
      : undefined;
  const from =
    typeof fallback?.from === "string"
      ? fallback.from
      : typeof data.from === "string"
        ? data.from
        : undefined;
  return { to: data.servedModel, ...(from ? { from } : {}), fallback: fallback !== undefined };
}

/**
 * A report's headline: the summary the crewmate gave with it, or its first
 * sentence past any Intent section. A summary stored before reports skipped
 * their Intent section (it still opens with the heading) reads again.
 */
export function reportHeadline(report: string, stored?: unknown): string {
  if (typeof stored === "string" && stored.trim() && withoutIntentLead(stored) === stored) {
    return stored;
  }
  return reportSummary(report) || (typeof stored === "string" && stored) || report;
}

/** A captain drop of work that never started, read from the typed fact. */
function droppedBeforeStart(event: TaskEventView): string | null {
  const data = event.data ?? {};
  if (data[DROP_BEFORE_START] === true && event.actor === "captain" && data.status === "dropped") {
    return DROPPED_BEFORE_START_ACTIVITY;
  }
  return null;
}

/** A change's page, as the forge gave it. */
function changeUrlOf(data: Record<string, unknown>): string | undefined {
  return typeof data.prUrl === "string" ? data.prUrl : undefined;
}

/**
 * Where a line's words name a change by its label (`#612`, or a branch's
 * name): the label as a whole token, with "pull request " or "PR " just
 * before it, so the link reads as the words the line says. Only a change
 * with a page on the web, and only its first mention.
 */
export function changeSpan(
  text: string,
  label: string | undefined,
  url: string | undefined,
): TaskActivityLine["change"] {
  if (!label || !url || !/^https:\/\//.test(url)) return undefined;
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    const before = text[at - 1];
    const after = text[at + label.length];
    if (before && /[\w#/-]/.test(before)) continue;
    if (after && /[\w/-]/.test(after)) continue;
    const lead = /(?:pull request|PR) $/i.exec(text.slice(Math.max(0, at - 13), at));
    return { url, from: lead ? at - lead[0].length : at, to: at + label.length };
  }
  return undefined;
}

function changeLabelOf(data: Record<string, unknown>): string | undefined {
  if (typeof data.changeLabel === "string" && data.changeLabel) return data.changeLabel;
  return typeof data.prNumber === "number" ? `#${data.prNumber}` : undefined;
}

/** A checks event's line: how the checks on its change read, with the round when they failed. */
export function checksSentence(
  result: string,
  change: string | undefined,
  rounds: unknown,
): string {
  const on = change ? ` on ${change.startsWith("#") ? "pull request" : "branch"} ${change}` : "";
  if (result === "green") return `The checks passed${on}.`;
  if (result === "pending") return `The checks are running${on}.`;
  if (result === "merged")
    return `The ${change ? `pull request ${change}` : "pull request"} was merged outside the app.`;
  const round = typeof rounds === "number" ? `, round ${rounds} of ${CI_ROUND_CAP}` : "";
  return `The checks failed${on}${round}.`;
}
