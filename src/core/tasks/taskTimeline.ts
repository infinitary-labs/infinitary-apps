import type { CardMessage, CardObservation, CardObservationKind } from "@shared/cards";
import { reportSummary } from "@shared/feed";
import {
  TIMELINE_SCHEMA_VERSION,
  type TimelineContentKind,
  type TimelineEntry,
  type TimelineLink,
  type TimelineSource,
} from "@shared/timeline";
import type { CardStore } from "../storage/cardStore";
import type { TaskEvent, TaskEventKind } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";
import type { SourcedAction } from "./crewActions";
import { ACTIVITY_PLACES, reportHeadline } from "./recordActivity";
import { type ReportEntry, reportEntryOf } from "./reportEntry";
import type { TaskService } from "./taskService";

/**
 * The one reader of a task's durable entries (INF-1296 piece 1,
 * docs/task-record.md "The unified timeline"). It normalizes, read-only,
 * what the owners keep - the task's events and the events of other tasks
 * that concern it, its cards' evidence and thread lines, and the actions in
 * its crewmate's kept sessions - into `TimelineEntry` rows. It copies
 * nothing, writes nothing, wakes nothing and grants nothing: an entry is a
 * reference, and `expand` reads the exact record it names from its owner.
 *
 * Order: entries with a recorded time by that time; at a tie, by source
 * (task events, card evidence, thread lines, actions), then each source's
 * own order. A tie across sources is presentation order, never a claimed
 * cause. An entry whose source holds no time stays undated, ahead of the
 * dated ones in its source's order. One occurrence recorded by two owners
 * folds into one entry only where an owner named the other's record
 * (`aliases`); matching words or nearby times never fold anything.
 */

/** Every task event kind's content kind; a new event kind fails the build until it has one. */
export const EVENT_CONTENT: Record<TaskEventKind, TimelineContentKind> = {
  created: "filing",
  ask: "ask",
  answered: "answer",
  briefed: "brief",
  dispatched: "dispatch",
  steered: "steer",
  progress: "progress",
  report: "report",
  failed: "failure",
  card_raised: "card-raised",
  card_resolved: "card-choice",
  status: "status",
  linked: "link",
  unlinked: "link",
  moved: "move",
  pr_opened: "change",
  ci: "check",
  landed: "merge",
  merged: "merge",
  triaged: "triage",
  note: "note",
  compacted: "compacted",
  interrupted: "interruption",
  decided: "decision",
  escalated: "escalation",
  review: "review",
  cap_reset: "cap-reset",
  replied: "reply",
};

/** Every card observation kind's content kind; a thread line's reference folds into its line. */
export const OBSERVATION_CONTENT: Record<CardObservationKind, TimelineContentKind> = {
  offer: "card-offer",
  availability: "card-availability",
  action: "card-choice",
  message_ref: "card-message",
  exit: "card-exit",
  effect_receipt: "effect-result",
  seen: "card-seen",
};

/** Observations a view may fold: where a card stood on the stage, and that it was seen. */
const QUIET_OBSERVATIONS: ReadonlySet<CardObservationKind> = new Set(["availability", "seen"]);

/** The longest a summary reads; a longer first line ends in an ellipsis. */
const SUMMARY_CHARS = 200;

/**
 * What a paged read stands on: the newest record of each source it saw on
 * its first page. Later pages read up to the same cut, so work that
 * arrives meanwhile never shifts or repeats a page.
 */
export type TimelineCut = {
  event: number;
  observation: number;
  message: number;
  /** Each kept session file read, by name, and how many actions it held. */
  actions: Record<string, number>;
};

export type TimelinePage = {
  entries: TimelineEntry[];
  /** Where the next page starts, or null when this page reached the cut's end. */
  cursor: string | null;
};

/** The exact record an entry names, as its owner holds it. */
export type TimelineRecord =
  | {
      source: "task-event";
      event: TaskEvent;
      /** A report, as its typed entry. */
      report?: ReportEntry;
      /** A brief receipt, read back whole as it was served. */
      brief?: string;
    }
  | { source: "card-observation"; observation: CardObservation }
  | { source: "card-message"; message: CardMessage }
  | { source: "session-action"; action: SourcedAction };

/**
 * An entry opened: the record it names, or why it cannot be read - `gone`
 * when its owner no longer holds it (an erased card, a compacted event, a
 * session file no longer kept), `unknown` for an id that is not one of
 * this task's entries. Never a later revision in its place.
 */
export type TimelineExpansion =
  | { id: string; status: "available"; record: TimelineRecord }
  | { id: string; status: "unavailable"; reason: "gone" | "unknown" };

export type TaskTimelineOptions = {
  tasks: TaskService;
  /** The card evidence and threads; without it the timeline holds the task's events and actions. */
  cards?: Pick<
    CardStore,
    "observationsForTask" | "observationById" | "messagesForTask" | "messageById"
  >;
  /** What the task's crewmate did, from its kept sessions (`CrewActions.sourced`). */
  actions?: (task: TaskRecord) => readonly SourcedAction[];
};

type SortKey = { dated: boolean; at: number; rank: number; order: (number | string)[] };
type Placed = { entry: TimelineEntry; key: SortKey };

const SOURCE_RANK: Record<TimelineSource, number> = {
  "task-event": 0,
  "card-observation": 1,
  "card-message": 2,
  "session-action": 3,
};

export class TaskTimeline {
  constructor(private readonly options: TaskTimelineOptions) {}

  /** The task's whole timeline, in order. */
  entries(taskId: string): TimelineEntry[] {
    return this.collect(taskId).placed.map((item) => item.entry);
  }

  /**
   * One page of the task's timeline: the first `limit` entries, or those
   * after `cursor` up to the cut the first page took. Without `limit` the
   * page runs to the cut's end.
   */
  read(taskId: string, options: { limit?: number; cursor?: string } = {}): TimelinePage {
    const from = options.cursor ? parseCursor(options.cursor) : undefined;
    const { placed, cut } = this.collect(taskId, from?.cut);
    const after = from?.after;
    const rest = after ? placed.filter((item) => compareKeys(item.key, after) > 0) : placed;
    const limit = options.limit ?? rest.length;
    const page = rest.slice(0, Math.max(0, limit));
    const last = page.at(-1);
    return {
      entries: page.map((item) => item.entry),
      cursor: last && rest.length > page.length ? cursorOf(cut, last.key) : null,
    };
  }

  /** The exact record one of the task's entries names, read from its owner now. */
  expand(taskId: string, id: string): TimelineExpansion {
    const unknown = { id, status: "unavailable" as const, reason: "unknown" as const };
    const gone = { id, status: "unavailable" as const, reason: "gone" as const };
    const [source, ...rest] = id.split(":");
    const tail = rest.join(":");
    const { tasks, cards } = this.options;
    switch (source) {
      case "task-event": {
        const eventId = Number(tail);
        if (!Number.isInteger(eventId)) return unknown;
        const event = tasks.event(eventId);
        if (!event) return gone;
        if (event.taskId !== taskId && !tasks.concerning(taskId).some((e) => e.id === eventId))
          return unknown;
        const record: TimelineRecord = {
          source: "task-event",
          event,
          ...(event.kind === "report" ? { report: reportEntryOf(event) } : {}),
          ...(event.kind === "briefed" ? { brief: tasks.servedBrief(event) } : {}),
        };
        return { id, status: "available", record };
      }
      case "card-observation": {
        if (!cards) return gone;
        const observation = cards.observationById(tail);
        if (!observation) return gone;
        if (observation.taskId !== taskId) return unknown;
        return { id, status: "available", record: { source: "card-observation", observation } };
      }
      case "card-message": {
        const messageId = Number(tail);
        if (!Number.isInteger(messageId)) return unknown;
        if (!cards) return gone;
        const message = cards.messageById(messageId);
        if (!message) return gone;
        if (!cards.messagesForTask(taskId, messageId).some((m) => m.id === messageId))
          return unknown;
        return { id, status: "available", record: { source: "card-message", message } };
      }
      case "session-action": {
        const at = tail.lastIndexOf(":");
        const file = tail.slice(0, at);
        const index = Number(tail.slice(at + 1));
        if (at < 0 || !Number.isInteger(index)) return unknown;
        const task = tasks.get(taskId);
        const action = task
          ? this.options.actions?.(task).find((a) => a.file === file && a.index === index)
          : undefined;
        return action
          ? { id, status: "available", record: { source: "session-action", action } }
          : gone;
      }
      default:
        return unknown;
    }
  }

  /** Every entry up to `cut` (or up to now, which becomes the cut), aliases folded, in order. */
  private collect(taskId: string, cut?: TimelineCut): { placed: Placed[]; cut: TimelineCut } {
    const { tasks, cards } = this.options;
    const upTo = (id: number, bound: number | undefined) => bound === undefined || id <= bound;
    const own = tasks.timeline(taskId).filter((event) => upTo(event.id, cut?.event));
    const concerned = tasks.concerning(taskId).filter((event) => upTo(event.id, cut?.event));
    const observations = cards?.observationsForTask(taskId, cut?.observation) ?? [];
    const messages = cards?.messagesForTask(taskId, cut?.message) ?? [];
    const task = tasks.get(taskId);
    const actions = (task ? (this.options.actions?.(task) ?? []) : []).filter((action) =>
      cut ? action.index < (cut.actions[action.file] ?? 0) : true,
    );
    const taken: TimelineCut = cut ?? {
      event: Math.max(
        newest(own, (e) => e.id),
        newest(concerned, (e) => e.id),
      ),
      observation: newest(observations, (o) => o.seq),
      message: newest(messages, (m) => m.id),
      actions: countByFile(actions),
    };

    const placed = new Map<string, Placed>();
    for (const event of own) placed.set(eventId(event), eventEntry(taskId, event));
    for (const event of concerned) {
      const item = eventEntry(taskId, event);
      item.entry.links.push({ rel: "concern", taskId: event.taskId, relation: event.relation });
      placed.set(eventId(event), item);
    }
    const titles = new Map<string, string>();
    for (const observation of observations) {
      if (observation.kind === "offer") titles.set(observation.id, observation.payload.title);
    }
    const byInteraction = new Map<string, string>();
    for (const observation of observations) {
      if (observation.kind === "action" && observation.interactionId)
        byInteraction.set(observation.interactionId, observationId(observation.id));
    }
    for (const message of messages)
      placed.set(messageId(message.id), messageEntry(taskId, message));
    for (const observation of observations) {
      const thread =
        observation.kind === "message_ref" && observation.messageId !== null
          ? placed.get(messageId(observation.messageId))
          : undefined;
      if (thread) {
        // The thread line's own reference: its line is the entry.
        thread.entry.aliases.push(observationId(observation.id));
        if (observation.offerId)
          thread.entry.links.push({ rel: "reply", to: observationId(observation.offerId) });
        continue;
      }
      placed.set(
        observationId(observation.id),
        observationEntry(taskId, observation, titles, byInteraction),
      );
    }
    // A task event that names the card evidence's record of the same choice
    // or close folds into that record, the exact receipt.
    for (const event of own) {
      const named = event.kind === "card_resolved" ? event.data?.observation : undefined;
      const receipt = typeof named === "string" ? placed.get(observationId(named)) : undefined;
      if (!receipt) continue;
      placed.delete(eventId(event));
      receipt.entry.aliases.push(eventId(event));
    }
    for (const action of actions) {
      const id = `session-action:${action.file}:${action.index}`;
      placed.set(id, actionEntry(taskId, id, action));
    }
    return { placed: [...placed.values()].sort((a, b) => compareKeys(a.key, b.key)), cut: taken };
  }
}

function eventId(event: TaskEvent): string {
  return `task-event:${event.id}`;
}

function observationId(id: string): string {
  return `card-observation:${id}`;
}

function messageId(id: number): string {
  return `card-message:${id}`;
}

function entry(
  fields: Omit<TimelineEntry, "schemaVersion" | "links" | "aliases"> & {
    links?: TimelineLink[];
  },
): TimelineEntry {
  return { schemaVersion: TIMELINE_SCHEMA_VERSION, links: [], aliases: [], ...fields };
}

function eventEntry(taskId: string, event: TaskEvent): Placed {
  const summary =
    event.kind === "report" ? reportHeadline(event.text, event.data?.summary) : event.text;
  return {
    entry: entry({
      id: eventId(event),
      taskId,
      at: event.at,
      actor: { kind: event.actor },
      summary: oneLine(summary),
      content: {
        kind: EVENT_CONTENT[event.kind],
        version: 1,
        ref: { source: "task-event", taskId: event.taskId, eventId: event.id },
      },
      quiet: ACTIVITY_PLACES[event.kind] !== "row",
    }),
    key: { dated: true, at: event.at, rank: SOURCE_RANK["task-event"], order: [event.id] },
  };
}

function observationEntry(
  taskId: string,
  observation: CardObservation,
  titles: ReadonlyMap<string, string>,
  byInteraction: ReadonlyMap<string, string>,
): Placed {
  const links: TimelineLink[] = [];
  const offer = observation.offerId;
  if (offer && offer !== observation.id && observation.kind !== "availability")
    links.push({ rel: "reply", to: observationId(offer) });
  if (observation.kind === "availability" && observation.payload.replaces)
    links.push({ rel: "revision", to: observationId(observation.payload.replaces) });
  if (observation.kind === "effect_receipt") {
    const cause = byInteraction.get(observation.payload.interactionId);
    if (cause) links.push({ rel: "cause", to: cause });
  }
  const title = (offer && titles.get(offer)) ?? undefined;
  return {
    entry: entry({
      id: observationId(observation.id),
      taskId,
      at: observation.recordedAt,
      actor: { kind: observation.actor },
      summary: oneLine(observationSummary(observation, title)),
      content: {
        kind: OBSERVATION_CONTENT[observation.kind],
        version: 1,
        ref: {
          source: "card-observation",
          cardId: observation.cardId,
          lifecycleId: observation.lifecycleId,
          observationId: observation.id,
          offerId: observation.offerId,
          interactionId: observation.interactionId,
          messageId: observation.messageId,
        },
      },
      links,
      quiet: QUIET_OBSERVATIONS.has(observation.kind),
    }),
    key: {
      dated: true,
      at: observation.recordedAt,
      rank: SOURCE_RANK["card-observation"],
      order: [observation.seq],
    },
  };
}

/** An observation in one line, from its typed payload; the card's title where the offer names one. */
function observationSummary(observation: CardObservation, title: string | undefined): string {
  const card = title ? `"${title}"` : "a card";
  switch (observation.kind) {
    case "offer":
      return `Card "${observation.payload.title}"`;
    case "availability":
      return `${card} ${observation.payload.state === "available" ? "on the stage" : "waiting"}`;
    case "action":
      return `${card}: ${observation.payload.label ?? observation.payload.actionId}`;
    case "message_ref":
      return `A line under ${card}`;
    case "exit":
      return `${card} closed: ${observation.payload.reason}`;
    case "effect_receipt":
      return `${card}: its effect ${observation.payload.outcome}`;
    case "seen":
      return `${card} seen`;
  }
}

function messageEntry(taskId: string, message: CardMessage): Placed {
  return {
    entry: entry({
      id: messageId(message.id),
      taskId,
      at: message.at,
      actor: { kind: message.who },
      summary: oneLine(reportSummary(message.text) || message.text),
      content: {
        kind: "card-message",
        version: 1,
        ref: { source: "card-message", cardId: message.cardId, messageId: message.id },
      },
      quiet: false,
    }),
    key: {
      dated: true,
      at: message.at,
      rank: SOURCE_RANK["card-message"],
      order: [message.id],
    },
  };
}

function actionEntry(taskId: string, id: string, action: SourcedAction): Placed {
  // A session line that names no time, before any line that did, has none.
  const dated = action.at > 0;
  return {
    entry: entry({
      id,
      taskId,
      at: dated ? action.at : null,
      actor: { kind: "crewmate" },
      summary: oneLine(action.text),
      content: {
        kind: "session-action",
        version: 1,
        ref: { source: "session-action", file: action.file, index: action.index },
      },
      quiet: true,
    }),
    key: {
      dated,
      at: dated ? action.at : 0,
      rank: SOURCE_RANK["session-action"],
      order: [action.file, action.index],
    },
  };
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.dated !== b.dated) return a.dated ? 1 : -1;
  if (a.at !== b.at) return a.at - b.at;
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.order.length, b.order.length); i++) {
    const x = a.order[i];
    const y = b.order[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function newest<T>(items: readonly T[], idOf: (item: T) => number): number {
  return items.reduce((top, item) => Math.max(top, idOf(item)), 0);
}

function countByFile(actions: readonly SourcedAction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions)
    counts[action.file] = Math.max(counts[action.file] ?? 0, action.index + 1);
  return counts;
}

function oneLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : line;
}

function cursorOf(cut: TimelineCut, after: SortKey): string {
  return Buffer.from(JSON.stringify({ v: 1, cut, after })).toString("base64url");
}

function parseCursor(cursor: string): { cut: TimelineCut; after: SortKey } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      cut?: TimelineCut;
      after?: SortKey;
    };
    if (parsed.v === 1 && parsed.cut && parsed.after)
      return { cut: parsed.cut, after: parsed.after };
  } catch {
    // Falls through to the refusal below.
  }
  throw new Error("That timeline cursor is not one this reader gave.");
}
