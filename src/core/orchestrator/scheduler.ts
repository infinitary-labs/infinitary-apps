import { randomUUID } from "node:crypto";
import {
  type AutomationEventItem,
  eventsWords,
  fillScheduleDetails,
  RULE_NOTES_MAX_CHARS,
  ruleNotesTooLong,
} from "@shared/automation";
import type { FmEvent } from "@shared/events";
import { HEARTBEAT_RULE_ID } from "@shared/heartbeat";
import { formatDateTime } from "@shared/i18n/format";
import type { DecisionRecord } from "@shared/provenance";
import { cutText } from "@shared/textCut";
import { scanKnowledgeThreat } from "../knowledge/threatScan";
import type { InboxRow } from "../storage/inboxStore";
import {
  MIN_INTERVAL_MINUTES,
  type RecordedRun,
  type RuleNotesVersion,
  type RuleState,
  type RunCancelReason,
  type ScheduleRecord,
  type ScheduleSpec,
  type ScheduleStore,
} from "../storage/scheduleStore";
import { isTimeZone, localTimeZone, nextZonedFire } from "./calendar";
import { HEARTBEAT_LINE, HEARTBEAT_MINUTES, type HeartbeatBeat } from "./heartbeat";
import type { Ticker } from "./ticker";
import type { TypedWake, WakeFacts } from "./wakes";

/**
 * The cron side of the shared substrate (R3): due schedules wake the
 * Firstmate agent with their prompt as an [fm-op] through the durable
 * inbox, and the agent handles it with its normal judgment and tools -
 * answer as a card, spawn a crewmate, or surface nothing.
 *
 * Guardrails carry the honesty: a recurring schedule never fires more often
 * than every MIN_INTERVAL_MINUTES, every creation and cancellation is a
 * feed line, and fires missed while the app was closed run once at boot,
 * flagged as catch-up - never N times.
 */

/**
 * The durable inbox as the scheduler follows its deliveries
 * (docs/automation.md, "Deliveries"): it reads a waiting delivery's row,
 * rewrites it while it is unsent, and takes it back.
 */
export type SchedulerInbox = {
  get(id: number): Pick<InboxRow, "deliveredAt" | "attempts" | "failures" | "cuts"> | undefined;
  withdraw(ids: readonly number[]): number[];
  revise(id: number, body: TypedWake): boolean;
};

/** An event a rule listens for, as the integrations find it by id or name. */
export type ListenedEvent = {
  /** The integration's id, which the rule keeps. */
  integration: string;
  /** Which connection the id stands for now, which the rule keeps beside it. */
  connection: string;
  /** Its name as the person reads it. */
  name: string;
  event: string;
  label: string;
  /** How often to look, in ticks. */
  every: number;
  /** A `required` one must be named, since the integration cannot look without it. */
  filters?: readonly { name: string; label: string; defaultValue?: string; required?: true }[];
  /** The integration says when something arrives, so a rule finds its place as soon as it listens. */
  atOnce?: boolean;
  /** The person paused the integration: it answers no look, and its rules wait without looking. */
  paused?: boolean;
  /** Why a filter's value could never match, refused when the rule is saved; undefined when it can. */
  checkFilter?: (filter: Record<string, string> | undefined) => string | undefined;
};

/**
 * Why an edit or delete of a brought rule is refused: the runbook that
 * brought it owns it (docs/automation.md, "The heartbeat").
 */
// i18n-exempt: served to the first mate's schedule tools; Settings offers no edit or delete for this rule
export const BROUGHT_RULE_REFUSAL =
  "This automation comes with the Heartbeat runbook, so it cannot be edited or deleted. Pause it, or turn the runbook off in Settings, Runbooks.";

/** One look's answer: where to look from next and what arrived. */
export type EventLook = { cursor: string; items: AutomationEventItem[]; resynced?: boolean };

export type EventFinder = Pick<SchedulerEvents, "find">;

/** One reading of what is connected that finds and looks as the integrations do. */
export type EventReading = Pick<SchedulerEvents, "find" | "look">;

/**
 * The integrations as an event rule reaches them (docs/automation.md,
 * "Events"): find the event a rule names, and look at it from a cursor.
 */
export type SchedulerEvents = {
  find(integration: string, event: string): ListenedEvent | undefined;
  /**
   * One reading of what is connected that finds and looks as `find` and
   * `look` do, for a caller asking about many rules at once (the Automation
   * list, the tick); without it, each lookup and each look reads again.
   */
  snapshot?(): EventReading;
  /**
   * Look from a cursor, only while the id stands for `connection`; throws
   * when it cannot look now (paused, gone, replaced), and the rule waits.
   * `task` names the task a hold's rule hands what arrived to, which then
   * holds the outside words (docs/automation.md, "A rule that ends a hold");
   * absent, they reach the first mate.
   */
  look(
    integration: string,
    event: string,
    cursor: string | null,
    filter: Record<string, string> | undefined,
    connection: string,
    task?: string,
  ): Promise<EventLook>;
};

/** A run as the history shows it: where its delivery stands now. */
export type RunView = RecordedRun & {
  state: "waiting" | "retrying" | "handled" | "cancelled" | "screened" | "sent";
};

export type SchedulerOptions = {
  store: ScheduleStore;
  /**
   * Delivers the fired prompt to the Firstmate agent (the durable inbox),
   * stamped with its origin - always `scheduled` - which is what keeps a
   * scheduled turn from creating a durable note. Answers the id of the
   * inbox row it queued, which the run follows; any other answer is none.
   */
  notify: (wake: TypedWake, origin: "scheduled") => unknown;
  /** Absent, deliveries are recorded but neither folded, recalled nor followed. */
  inbox?: SchedulerInbox;
  broadcastEvent: (event: FmEvent) => void;
  /** The host's one clock (the ticker's); absent reads `Date.now()`. */
  now?: () => number;
  /**
   * A project a rule may be about, by id: its key and name while it is
   * live, undefined once it is gone or archived. Absent, any id is taken.
   */
  projectOf?: (id: string) => { key: string; name: string } | undefined;
  /** Absent, no event rule can be made, and none looks. */
  events?: SchedulerEvents;
  /**
   * The event screen (docs/automation.md, "The event screen"): a rule that
   * says what it waits for has each look's new events asked about, and
   * answers them with those plainly not it marked `screened`. Absent, or
   * for a rule that says nothing, every event reaches the first mate.
   */
  screen?: (
    rule: { waitsFor: string; event: string },
    items: readonly AutomationEventItem[],
  ) => Promise<AutomationEventItem[]>;
  /**
   * Told the events of an event rule's delivery once a first mate turn
   * handled it, by the integration the rule listens to (the inbox's
   * receipts, docs/integrations.md "The inbox").
   */
  handled?: (integration: string, events: string[], at: number) => void;
  /**
   * Show a kept card again (docs/automation.md, "A rule that shows a card"):
   * a rule that names a card raises it when it runs, instead of waking the
   * first mate. Absent, such a run raises nothing.
   */
  raise?: (cardId: string) => void;
  /**
   * End a started task's hold (docs/automation.md, "A rule that ends a
   * hold"): a rule that names a task ends the hold whose gate names the
   * rule, with the events that arrived, instead of waking the first mate.
   * Absent, such a run ends nothing.
   */
  endHold?: (taskId: string, ruleId: string, events: string) => void;
  /**
   * Told each rule that is saved or turned on and ends enabled, so the
   * event screen can be offered for one with an Only if condition while it
   * is off (docs/automation.md, "Offering the screen"). Absent, nothing is
   * offered.
   */
  enabled?: (record: ScheduleRecord) => void;
  /**
   * The automation a task was filed or started while answering, and when
   * (the task's saved origin, INF-2326): a turn that handled several runs
   * links each only to the tasks its own rule started in that turn
   * (docs/automation.md, "Deliveries"). Absent, no task has one.
   */
  startedBy?: (taskId: string) => { ruleId: string; at: number } | undefined;
  /**
   * The beat due now for the rule the heartbeat wake brings
   * (docs/automation.md, "The heartbeat"), or undefined when none is.
   * Absent, that rule never runs.
   */
  heartbeat?: (now: number) => HeartbeatBeat | undefined;
};

const TICK_MS = 60 * 1000;

/**
 * An event rule whose every look failed across this many ticks, an hour on
 * the minute tick, shows as failing and the first mate hears of it once
 * (docs/automation.md, "When every look fails"). Counted in ticks, as a
 * rule's cadence is, so a development run's shortened tick gets there sooner.
 */
export const LOOKS_FAILING_TICKS = 60;
/** At least this many failed looks: one failed look changes nothing, whatever the cadence. */
export const LOOKS_FAILING_LOOKS = 2;
/** The most of a failed look's answer that is kept as its reason. */
const FAILURE_EXCERPT = 300;

/** An event rule's failed looks in a row, for the revision it looked as. */
type FailedLooks = {
  revision: number;
  /** The tick of the first failed look in the row, and when it was. */
  sinceTick: number;
  since: number;
  /** The tick of the newest failed look, and the event's cadence in ticks. */
  lastTick: number;
  every: number;
  looks: number;
  /** What the newest failed look answered, cut short. */
  reason: string;
  /** The first mate was told of this row. */
  told: boolean;
};
const PROMPT_EXCERPT = 80;
const PREVIEW_COUNT = 3;

/** `projectId` null takes the project off; undefined keeps it. */
export type RuleChanges = {
  name?: string;
  /**
   * An event rule listens to whatever its integration's id stands for now:
   * the person picked it again (docs/automation.md, "Events"). Without it,
   * an edit that keeps the integration keeps the connection the rule had.
   */
  reconnect?: boolean;
  spec?: ScheduleSpec;
  prompt?: string;
  projectId?: string | null;
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Most occurrences a catch-up counts one by one before it stops counting. */
const MISSED_COUNT_CAP = 10_000;

function label(record: Pick<ScheduleRecord, "name" | "prompt">): string {
  return record.name ?? cutText(record.prompt, PROMPT_EXCERPT);
}

function recalledText(count: number): string {
  return count > 0 ? ` (${count} unsent ${count === 1 ? "prompt" : "prompts"} taken back)` : "";
}

/**
 * What each change to a rule says (docs/automation.md, "Where it shows"):
 * its own feed line, or the words of the trail a caller leaves for it.
 */
export const automationWords = {
  created: (draft: boolean, spec: ScheduleSpec, prompt: string) =>
    `${draft ? "Automation saved as a draft" : "Scheduled"} - ${scheduleText(spec)}: ${cutText(prompt, PROMPT_EXCERPT)}`,
  saved: (turnedOn: boolean, spec: ScheduleSpec, prompt: string, recalled = 0) =>
    `${turnedOn ? "Automation turned on" : "Automation saved"} - ${scheduleText(spec)}: ${cutText(prompt, PROMPT_EXCERPT)}${recalledText(recalled)}`,
  paused: (rule: Pick<ScheduleRecord, "name" | "prompt">, recalled = 0) =>
    `Automation paused - ${label(rule)}${recalledText(recalled)}`,
  resumed: (rule: Pick<ScheduleRecord, "name" | "prompt">) => `Automation resumed - ${label(rule)}`,
  pausedAll: (count: number, recalled = 0) =>
    `Automation paused - ${count} ${count === 1 ? "rule" : "rules"}${recalledText(recalled)}`,
  cancelled: (prompt: string) => `Schedule cancelled - ${cutText(prompt, PROMPT_EXCERPT)}`,
  notes: (rule: Pick<ScheduleRecord, "name" | "prompt">, cleared: boolean) =>
    `Automation notes ${cleared ? "cleared" : "saved"} - ${label(rule)}`,
  resynced: (rule: Pick<ScheduleRecord, "name" | "prompt">, integration: string) =>
    `Automation lost its place in ${integration} and listens again from now; nothing was sent for the gap - ${label(rule)}`,
};

/**
 * Who says a change's words: absent, the change is its own feed line; a
 * caller that leaves its own trail for the change (the dispatcher's, for
 * Settings → Automation and the first mate) takes them instead.
 */
export type SaysChange = { say?: (text: string) => void };

function validate(spec: ScheduleSpec, prompt: string, now: number): void {
  if (!prompt) throw new Error("The schedule needs a prompt.");
  if (spec.kind === "every" && spec.minutes < MIN_INTERVAL_MINUTES) {
    throw new Error(`Recurring schedules run at most every ${MIN_INTERVAL_MINUTES} minutes.`);
  }
  if (
    (spec.kind === "daily" || spec.kind === "weekly") &&
    (spec.hour < 0 || spec.hour > 23 || spec.minute < 0 || spec.minute > 59)
  ) {
    throw new Error("daily_at needs a valid HH:MM time.");
  }
  if (
    spec.kind === "weekly" &&
    (spec.days.length === 0 ||
      spec.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    throw new Error("Pick at least one day of the week.");
  }
  if ((spec.kind === "daily" || spec.kind === "weekly") && spec.timeZone !== undefined) {
    if (!isTimeZone(spec.timeZone)) {
      throw new Error(
        `"${spec.timeZone}" is not a time zone. Use a name such as America/Los_Angeles.`,
      );
    }
  }
  if (spec.kind === "once" && spec.at <= now) {
    throw new Error("A one-shot schedule needs a future time.");
  }
}

/** The same schedule written one way: a weekly rule's days sorted, each once. */
function normalized(spec: ScheduleSpec): ScheduleSpec {
  return spec.kind === "weekly"
    ? { ...spec, days: [...new Set(spec.days)].sort((a, b) => a - b) }
    : spec;
}

/** Occurrences beyond the one that fires, folded in because `now` is late. */
export function missedOccurrences(spec: ScheduleSpec, due: number, now: number): number {
  if (spec.kind === "once" || spec.kind === "event") return 0;
  if (spec.kind === "every") return Math.max(0, Math.floor((now - due) / (spec.minutes * 60_000)));
  // A calendar's days are not all the same length: count them one by one.
  let missed = 0;
  for (let at = computeNextFire(spec, due); at <= now && missed < MISSED_COUNT_CAP; missed++) {
    at = computeNextFire(spec, at);
  }
  return missed;
}

/** The zone a rule's times are read in: its own, or this computer's for one that keeps none. */
export function timeZoneOf(spec: ScheduleSpec): string {
  return (spec.kind === "daily" || spec.kind === "weekly") && spec.timeZone
    ? spec.timeZone
    : localTimeZone();
}

/** Pure: the first occurrence after `now`, an interval staying on its anchor. */
export function resumeFire(spec: ScheduleSpec, anchor: number, now: number): number {
  if (spec.kind === "every") {
    const period = spec.minutes * 60_000;
    return anchor > now ? anchor : anchor + (Math.floor((now - anchor) / period) + 1) * period;
  }
  return computeNextFire(spec, now);
}

/** Pure: the next fire strictly after `from`. */
export function computeNextFire(spec: ScheduleSpec, from: number): number {
  switch (spec.kind) {
    case "every":
      return from + spec.minutes * 60_000;
    case "weekly":
      return nextZonedFire(from, spec.hour, spec.minute, spec.timeZone, spec.days);
    case "daily": {
      if (spec.timeZone) return nextZonedFire(from, spec.hour, spec.minute, spec.timeZone);
      // Made before time zones: this computer's clock, as it always was.
      const next = new Date(from);
      next.setHours(spec.hour, spec.minute, 0, 0);
      if (next.getTime() <= from) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    case "once":
      return spec.at;
    case "event":
      // An event rule has no time of its own: it looks on its cadence.
      return from;
  }
}

/** The schedule phrased for the feed and the context block. */
export function scheduleText(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "every":
      return `every ${spec.minutes} minutes`;
    case "daily":
      return `every day at ${clockText(spec.hour, spec.minute)}${spec.timeZone ? ` (${spec.timeZone})` : ""}`;
    case "weekly":
      return `every ${weekdaysText(spec.days)} at ${clockText(spec.hour, spec.minute)} (${spec.timeZone})`;
    case "once":
      return `once at ${formatDateTime(spec.at)}`;
    case "event":
      return `on each ${spec.event} from ${spec.integration}${spec.waitsFor ? `, only if "${spec.waitsFor}"` : ""}`;
  }
}

function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Sunday", "Monday and Thursday", "Monday, Wednesday and Friday". */
function weekdaysText(days: readonly number[]): string {
  const names = [...new Set(days)].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day] ?? "");
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
}

export class Scheduler {
  private unregister: (() => void) | undefined;
  private readonly now: () => number;
  /** Ticks counted since start: an event rule looks every `every` of them. */
  private ticks = 0;
  /** The tick each event rule last looked at. */
  private readonly looked = new Map<string, number>();
  private readonly looking = new Map<string, Promise<void>>();
  /** Rules asked to look at once while a look was running: they look again after it. */
  private readonly again = new Set<string>();
  /** Each event rule's failed looks in a row, cleared by a look that answers. */
  private readonly failedLooks = new Map<string, FailedLooks>();

  constructor(private readonly options: SchedulerOptions) {
    const now = options.now;
    this.now = now ? () => now() : () => Date.now();
  }

  /** Boot: one catch-up pass for fires missed while closed, then the tick. */
  start(ticker: Ticker): void {
    if (this.unregister) return;
    this.tick(this.now(), { catchUp: true });
    this.unregister = ticker.register("schedules", TICK_MS, (now) => this.tick(now));
  }

  stop(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /**
   * Fire everything due. Recurrences advance from `now`, not from the
   * missed moment, so an overdue schedule fires exactly once; the further
   * occurrences it folded in are counted, not replayed. Each fire is
   * recorded and the rule advanced in one transaction with the delivery.
   * At most one delivery per rule waits unsent: a rule that comes due
   * while one does folds the occurrence into it instead.
   */
  tick(now: number, options: { catchUp?: boolean } = {}): void {
    this.reconcile(now);
    this.retire();
    this.ticks += 1;
    for (const id of this.failedLooks.keys())
      if (!this.options.store.get(id)) this.failedLooks.delete(id);
    // One reading of what is connected for every rule's find and look:
    // reading it per rule, and again per look, stalled the main process on
    // each tick (INF-6885).
    const reading = this.reading();
    for (const record of this.options.store.list()) {
      if (record.spec.kind === "event") {
        this.listen(record, false, reading);
        continue;
      }
      if (record.state !== "enabled" || record.nextFire > now) continue;
      if (record.brought) {
        this.beat(record, now, options.catchUp === true);
        continue;
      }
      const missed = missedOccurrences(record.spec, record.nextFire, now);
      const next =
        record.spec.kind === "once" || record.card || record.task
          ? { nextFire: record.nextFire, state: "completed" as const }
          : { nextFire: computeNextFire(record.spec, now), state: "enabled" as const };
      const project = record.projectId ? this.options.projectOf?.(record.projectId) : undefined;
      const unsent = this.unsent(record);
      if (unsent && this.fold(record, unsent, missed, next, project)) continue;
      const catchUp = options.catchUp === true || missed > 0;
      const prompt = fillScheduleDetails(record.prompt, {
        plannedAt: record.nextFire,
        timeZone: timeZoneOf(record.spec),
        missed,
      });
      this.options.store.recordFire(
        {
          scheduleId: record.id,
          revision: record.revision,
          plannedAt: record.nextFire,
          firedAt: now,
          catchUp,
          missed,
          prompt,
        },
        next,
        now,
        (run) =>
          this.deliver(record, run, now, () =>
            wakeOf(record, { prompt, catchUp, missed, run }, project),
          ),
      );
    }
  }

  /**
   * The brought heartbeat rule's turn on a tick, once its interval passed:
   * a beat due while the app was closed is dropped, never caught up; no beat
   * goes while one is still waiting; otherwise it runs only when the
   * heartbeat says a beat is due, and marks the beat's new rows told.
   */
  private beat(record: ScheduleRecord, now: number, catchUp: boolean): void {
    if (catchUp) {
      this.options.store.setNextFire(record.id, computeNextFire(record.spec, now));
      return;
    }
    if (this.options.store.waiting(record.id).length > 0) return;
    const beat = this.options.heartbeat?.(now);
    if (!beat) return;
    const fired = this.options.store.recordFire(
      {
        scheduleId: record.id,
        revision: record.revision,
        plannedAt: now,
        firedAt: now,
        catchUp: false,
        missed: 0,
        prompt: beat.prompt,
      },
      { nextFire: computeNextFire(record.spec, now), state: "enabled" },
      now,
      (run) =>
        this.deliver(record, run, now, () =>
          wakeOf(record, { prompt: beat.prompt, catchUp: false, missed: 0, run }, undefined),
        ),
    );
    if (fired) beat.seen();
  }

  /**
   * Keep the rule the heartbeat wake brings (docs/automation.md, "The
   * heartbeat"): while `on`, one rule every 55 minutes, turned on and stamped
   * as the captain's, since turning the runbook on is their click; once
   * off, the rule goes and its runs stay under the 30-day rule. A rule
   * already there keeps its state, so a paused one stays paused.
   */
  keepBrought(on: boolean): void {
    const now = this.now();
    this.options.store.trimRuns(HEARTBEAT_RULE_ID, now);
    const record = this.options.store.get(HEARTBEAT_RULE_ID);
    if (on && !record) {
      const spec: ScheduleSpec = { kind: "every", minutes: HEARTBEAT_MINUTES };
      this.options.store.insert({
        id: HEARTBEAT_RULE_ID,
        spec,
        prompt: HEARTBEAT_LINE,
        nextFire: computeNextFire(spec, now),
        createdAt: now,
        captainRequested: true,
        // i18n-exempt: the runbook's name, as its manifest gives it
        name: "Heartbeat",
        state: "enabled",
        revision: 1,
      });
      this.announce(automationWords.created(false, spec, HEARTBEAT_LINE), {});
    } else if (!on && record) {
      this.recall(record.id, "edited");
      this.options.store.removeKeepingRuns(record.id);
      this.announce(automationWords.cancelled(record.prompt), {});
    }
  }

  /**
   * A run's delivery, inside its transaction: a rule that names a card
   * raises it and its run is handled at once, naming the card; one that
   * names a task ends that task's hold with the events that arrived, its
   * run handled at once and naming the task; any other wakes the first
   * mate through the inbox and answers the row it queued.
   */
  private deliver(
    record: ScheduleRecord,
    run: number,
    now: number,
    wake: () => TypedWake,
    events = "",
  ): number | null {
    if (record.task) {
      this.options.endHold?.(record.task, record.id, events);
      this.options.store.settle(run, {
        delivery: "handled",
        at: now,
        tasks: [record.task],
        cards: [],
      });
      return null;
    }
    if (record.card) {
      this.options.raise?.(record.card);
      this.options.store.settle(run, {
        delivery: "handled",
        at: now,
        tasks: [],
        cards: [record.card],
      });
      return null;
    }
    const queued = this.options.notify(wake(), "scheduled");
    return typeof queued === "number" ? queued : null;
  }

  /**
   * Once a rule's look now running has answered: whether it holds its place
   * in its event, so the next event after this fires it. A one-run rule's
   * maker confirms it only then (docs/automation.md, "A rule that ends a
   * hold"): a look that started is not yet a place, since a source such as
   * Gmail or an MCP server answers its first look over the network.
   */
  async placed(id: string): Promise<boolean> {
    for (let look = this.looking.get(id); look; look = this.looking.get(id)) await look;
    const record = this.options.store.get(id);
    return record?.state === "enabled" && record.cursor !== undefined;
  }

  /**
   * A rule a save or resume left turned on, as it stands now: a linked rule
   * (a put-off's or a hold's) that the save or resume sent to take its place
   * again, with no cursor yet, once that first look answered; any other rule
   * at once, without waiting for an ordinary look. A rule deleted meanwhile
   * is refused as gone, never answered as it was.
   */
  async armed(record: ScheduleRecord): Promise<ScheduleRecord> {
    if (record.state === "enabled" && (record.card || record.task) && record.cursor === undefined)
      await this.placed(record.id);
    return this.require(record.id);
  }

  /** Every look still running has answered and been acted on: for a test. */
  async settled(): Promise<void> {
    while (this.looking.size > 0) await Promise.all([...this.looking.values()]);
  }

  /**
   * An enabled event rule looks at its event when its cadence comes round
   * (docs/automation.md, "Events"), one look per rule at a time; the tick
   * does not wait for it. `now` looks whatever the cadence says, and a rule
   * still looking looks again once that look ends, so nothing dropped
   * meanwhile waits for the next minute.
   */
  private listen(record: ScheduleRecord, now = false, reading?: EventReading): void {
    const events = this.options.events;
    if (!events || record.state !== "enabled" || record.spec.kind !== "event") {
      this.failedLooks.delete(record.id);
      return;
    }
    if (this.looking.has(record.id)) {
      if (now) this.again.add(record.id);
      return;
    }
    const found = (reading ?? events).find(record.spec.integration, record.spec.event);
    // A rule that does not look now has no row of failed looks to carry on.
    if (!found || found.connection !== record.connection || found.paused) {
      this.failedLooks.delete(record.id);
      return;
    }
    const last = this.looked.get(record.id);
    if (!now && last !== undefined && this.ticks - last < found.every) return;
    this.looked.set(record.id, this.ticks);
    const look = this.look(record, found, reading)
      .catch((error: unknown) =>
        console.warn(
          `[automation] ${record.id} could not look at ${found.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        this.looking.delete(record.id);
        if (!this.again.delete(record.id)) return;
        const current = this.options.store.get(record.id);
        if (current) this.listen(current, true);
      });
    this.looking.set(record.id, look);
  }

  /**
   * Something arrived at an integration that can say so at once (the
   * inbox's drop, docs/integrations.md "The inbox"): every turned-on rule
   * listening to it looks now rather than at the next minute.
   */
  lookNow(integration: string): void {
    const reading = this.reading();
    for (const record of this.options.store.list())
      if (record.spec.kind === "event" && record.spec.integration === integration)
        this.listen(record, true, reading);
  }

  /**
   * A rule on an event its integration says at once finds its place now,
   * so the next arrival fires it rather than only setting its place; so
   * does a one-run rule (a put-off's or a hold's) on any event, since the
   * first event after it is made is the one it waits for, and a later first
   * look would only take its place past that event.
   */
  private placeAtOnce(record: ScheduleRecord): void {
    if (record.spec.kind !== "event") return;
    if (
      record.card ||
      record.task ||
      this.options.events?.find(record.spec.integration, record.spec.event)?.atOnce
    )
      this.listen(record, true);
  }

  /**
   * One more failed look in the rule's row (docs/automation.md, "When every
   * look fails"). Once the row spans `LOOKS_FAILING_TICKS` the rule shows as
   * failing, and the first mate hears of it once: `once` names the rule's
   * revision and place, so a restart that starts the row again tells nothing
   * new about a rule that has not moved.
   */
  private lookFailed(record: ScheduleRecord, found: ListenedEvent, error: unknown): void {
    if (record.spec.kind !== "event") return;
    const kept = this.failedLooks.get(record.id);
    const row: FailedLooks =
      kept && kept.revision === record.revision
        ? kept
        : {
            revision: record.revision,
            sinceTick: this.ticks,
            since: this.now(),
            lastTick: this.ticks,
            every: found.every,
            looks: 0,
            reason: "",
            told: false,
          };
    row.looks += 1;
    row.lastTick = this.ticks;
    row.reason = cutText(error instanceof Error ? error.message : String(error), FAILURE_EXCERPT);
    this.failedLooks.set(record.id, row);
    if (row.told || !this.failingByLooks(row)) return;
    const current = this.options.store.get(record.id);
    if (current?.state !== "enabled" || current.revision !== record.revision) return;
    row.told = true;
    this.options.notify(
      {
        facts: {
          kind: "automation-looks-failing",
          rule: { id: record.id, name: label(record) },
          integration: found.name,
          event: found.label,
          since: new Date(row.since).toISOString(),
          looks: row.looks,
          reason: row.reason,
        },
        once: `automation-looks-failing:${record.id}:${record.revision}:${record.cursor ?? ""}`,
      },
      "scheduled",
    );
  }

  /**
   * Each failed look stands for its whole cadence, so thirty looks two ticks
   * apart are the hour; read at the newest failed look, so the rule turns
   * failing only when a look fails, the moment the first mate is told.
   */
  private failingByLooks(row: FailedLooks): boolean {
    return (
      row.looks >= LOOKS_FAILING_LOOKS &&
      row.lastTick - row.sinceTick + row.every >= LOOKS_FAILING_TICKS
    );
  }

  /**
   * Why a turned-on event rule gets nothing new: every look failed for an
   * hour, since when and what the newest answered. Undefined for any other
   * rule, and once a look answers.
   */
  lookingFails(
    record: Pick<ScheduleRecord, "id" | "state" | "revision">,
  ): { since: number; reason: string } | undefined {
    const row = this.failedLooks.get(record.id);
    if (record.state !== "enabled" || !row || row.revision !== record.revision) return undefined;
    return this.failingByLooks(row) ? { since: row.since, reason: row.reason } : undefined;
  }

  listeners(integration: string): number {
    return this.options.store
      .list()
      .filter(
        (record) =>
          record.state === "enabled" &&
          record.spec.kind === "event" &&
          record.spec.integration === integration,
      ).length;
  }

  /**
   * One look from the rule's cursor. A first look only finds its place. A
   * lost cursor starts again from now and sends nothing, with a feed line.
   * An event a run of this rule already carried is never sent again. What
   * is new is one run, recorded with the new cursor in one transaction with
   * its delivery, or folded into the rule's delivery still waiting unsent.
   * A rule changed, paused or deleted meanwhile drops the answer.
   */
  private async look(
    record: ScheduleRecord,
    found: ListenedEvent,
    reading?: EventReading,
  ): Promise<void> {
    const events = this.options.events;
    if (!events || record.spec.kind !== "event") return;
    let answer: EventLook;
    try {
      answer = await (reading ?? events).look(
        found.integration,
        found.event,
        record.cursor ?? null,
        record.spec.filter,
        found.connection,
        record.task,
      );
    } catch (error: unknown) {
      this.lookFailed(record, found, error);
      return;
    }
    this.failedLooks.delete(record.id);
    const unchanged = () => {
      const current = this.options.store.get(record.id);
      return current &&
        current.state === "enabled" &&
        current.revision === record.revision &&
        current.cursor === record.cursor
        ? current
        : undefined;
    };
    let current = unchanged();
    if (!current) return;
    if (answer.resynced) {
      this.options.store.setCursor(record.id, answer.cursor);
      this.announce(automationWords.resynced(record, found.name), {});
      return;
    }
    const carried = this.options.store.carried(record.id);
    const fresh = record.cursor === undefined ? [] : newItems(answer.items, carried);
    if (fresh.length === 0) {
      if (answer.cursor !== record.cursor) this.options.store.setCursor(record.id, answer.cursor);
      return;
    }
    // The event screen asks about each new event while the rule waits; a
    // rule changed meanwhile drops the answer, as a slow look's is, and the
    // rule is read again either way, since a move of repositories changes
    // its project without a new revision (INF-5005).
    const waitsFor = record.spec.waitsFor?.trim();
    const screen = waitsFor ? this.options.screen : undefined;
    const items =
      waitsFor && screen
        ? await screen({ waitsFor, event: `${found.label} in ${found.name}` }, fresh).catch(
            () => fresh,
          )
        : fresh;
    if (screen) {
      current = unchanged();
      if (!current) return;
    }
    const kept = items.filter((item) => !item.screened);
    const now = this.now();
    const next = {
      nextFire: now,
      state: record.card || record.task ? ("completed" as const) : ("enabled" as const),
      cursor: answer.cursor,
    };
    if (kept.length === 0) {
      // Nothing for the first mate: one settled run lists what was kept from it.
      this.options.store.recordScreened(
        {
          scheduleId: record.id,
          revision: record.revision,
          plannedAt: now,
          firedAt: now,
          catchUp: false,
          missed: 0,
          prompt: eventsWords(items),
          events: items,
        },
        // A rule that shows a card or ends a hold waits on: nothing was delivered.
        { ...next, state: "enabled" as const },
        now,
      );
      return;
    }
    // The rule as it stands now: a move of repositories (INF-5005) changes
    // its project without a new revision while the look or screen ran.
    const rule = current;
    const project = rule.projectId ? this.options.projectOf?.(rule.projectId) : undefined;
    const unsent = this.unsent(rule);
    if (unsent?.events && this.foldEvents(rule, unsent, items, next, project, found)) return;
    const prompt = fillScheduleDetails(record.prompt, {
      plannedAt: now,
      timeZone: localTimeZone(),
      missed: 0,
      events: eventsWords(kept),
    });
    this.options.store.recordFire(
      {
        scheduleId: record.id,
        revision: record.revision,
        plannedAt: now,
        firedAt: now,
        catchUp: false,
        missed: 0,
        prompt,
        events: items,
      },
      next,
      now,
      (run) =>
        this.deliver(
          rule,
          run,
          now,
          () =>
            wakeOf(
              rule,
              {
                prompt,
                catchUp: false,
                missed: 0,
                run,
                events: eventsFact(found, kept.length, rule.spec),
              },
              project,
            ),
          eventsWords(kept),
        ),
    );
  }

  /** New events join the rule's delivery still waiting unsent; false once a turn holds it. */
  private foldEvents(
    record: ScheduleRecord,
    run: RecordedRun,
    fresh: readonly AutomationEventItem[],
    next: { nextFire: number; state: RuleState; cursor: string },
    project: { key: string; name: string } | undefined,
    found: ListenedEvent,
  ): boolean {
    const inbox = this.options.inbox;
    if (!inbox || run.inboxId === null) return false;
    const inboxId = run.inboxId;
    const events = [...(run.events ?? []), ...fresh];
    const delivered = events.filter((item) => !item.screened);
    const prompt = fillScheduleDetails(record.prompt, {
      plannedAt: run.plannedAt,
      timeZone: localTimeZone(),
      missed: 0,
      events: eventsWords(delivered),
    });
    const wake = wakeOf(
      record,
      {
        prompt,
        catchUp: false,
        missed: 0,
        run: run.id,
        waited: true,
        events: eventsFact(found, delivered.length, record.spec),
      },
      project,
    );
    return this.options.store.foldFire(
      run.id,
      { scheduleId: record.id, missed: 0, prompt, events },
      next,
      () => inbox.revise(inboxId, wake),
    );
  }

  /**
   * A turn's decision record (docs/automation.md, "Deliveries"): each
   * delivery it served and acknowledged is handled, linked to the tasks and
   * cards the turn touched - less the tasks the turn's other messages were
   * about - and the turn's closing words as what the run found. A turn that
   * handled several runs links each only to the tasks its own rule filed or
   * started in that turn, so two runs never list the same work. A delivery
   * released for a retry keeps waiting.
   */
  noteDecision(record: DecisionRecord, said?: string): void {
    const found = said?.trim();
    if (record.disposition.inbox !== "acked" || !record.served) return;
    const segments = [
      ...record.served.prompt.segments,
      ...record.served.steers.flatMap((steer) => steer.segments),
    ];
    const about = new Set(segments.flatMap((segment) => (segment.ref ? [segment.ref] : [])));
    const inboxIds = new Set(segments.flatMap((segment) => segment.inboxId ?? []));
    const runs = [...inboxIds].flatMap((inboxId) => {
      const run = this.options.store.runByInbox(inboxId);
      return run?.delivery === "waiting" ? [run] : [];
    });
    const touched = record.disposition.tasks.filter((task) => !about.has(task));
    const tasksOf = (scheduleId: string): string[] =>
      runs.length < 2
        ? touched
        : touched.filter((task) => {
            const started = this.options.startedBy?.(task);
            return started?.ruleId === scheduleId && started.at >= record.startedAt;
          });
    for (const run of runs) {
      this.options.store.settle(run.id, {
        delivery: "handled",
        at: record.endedAt,
        tasks: tasksOf(run.scheduleId),
        cards: record.disposition.cards,
        ...(found ? { found } : {}),
      });
      const spec = this.options.store.get(run.scheduleId)?.spec;
      const carried = (run.events ?? []).filter((event) => !event.screened);
      if (spec?.kind === "event" && carried.length)
        this.options.handled?.(
          spec.integration,
          carried.map((event) => event.id),
          record.endedAt,
        );
    }
    this.retire();
  }

  /**
   * A one-time rule that ran leaves Automation once its delivery settled
   * (docs/automation.md, "A rule"): deleted with its history, with a feed
   * line. One whose delivery still waits stays until a turn handles it or
   * it is taken back, so finishing never withdraws its own prompt.
   */
  private retire(): void {
    for (const record of this.options.store.list()) {
      if (record.state !== "completed" || this.options.store.waiting(record.id).length > 0) {
        continue;
      }
      this.options.store.delete(record.id);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Automation finished and removed - ${label(record)}`,
      });
    }
  }

  /** The newest delivery of this rule's revision still waiting unsent, if any. */
  private unsent(record: ScheduleRecord): RecordedRun | undefined {
    const inbox = this.options.inbox;
    if (!inbox) return undefined;
    return this.options.store
      .waiting(record.id)
      .filter((run) => run.revision === record.revision && run.inboxId !== null)
      .reverse()
      .find((run) => inbox.get(run.inboxId as number)?.deliveredAt === null);
  }

  /**
   * Fold one more occurrence into a delivery still waiting unsent: it keeps
   * its planned time, counts the occurrence and those it missed, and its
   * message says so. False when the message reached a turn meanwhile.
   */
  private fold(
    record: ScheduleRecord,
    run: RecordedRun,
    missed: number,
    next: { nextFire: number; state: RuleState },
    project: { key: string; name: string } | undefined,
  ): boolean {
    const inbox = this.options.inbox;
    if (!inbox || run.inboxId === null) return false;
    const inboxId = run.inboxId;
    const total = run.missed + 1 + missed;
    const prompt = fillScheduleDetails(record.prompt, {
      plannedAt: run.plannedAt,
      timeZone: timeZoneOf(record.spec),
      missed: total,
    });
    const wake = wakeOf(
      record,
      { prompt, catchUp: true, missed: total, run: run.id, waited: true },
      project,
    );
    return this.options.store.foldFire(
      run.id,
      { scheduleId: record.id, missed: total, prompt },
      next,
      () => inbox.revise(inboxId, wake),
    );
  }

  /**
   * Take back a rule's deliveries no turn was handed yet, each cancelled
   * with why; one a turn holds goes on. Answers how many were taken back.
   */
  private recall(id: string, reason: RunCancelReason): number {
    const inbox = this.options.inbox;
    if (!inbox) return 0;
    return this.options.store.transaction(() => {
      const waiting = this.options.store.waiting(id).filter((run) => run.inboxId !== null);
      const taken = new Set(inbox.withdraw(waiting.map((run) => run.inboxId as number)));
      const at = this.now();
      let count = 0;
      for (const run of waiting) {
        if (!taken.has(run.inboxId as number)) continue;
        this.options.store.settle(run.id, { delivery: "cancelled", at, reason });
        count += 1;
      }
      return count;
    });
  }

  /**
   * A waiting delivery whose message is gone without a turn handling it -
   * Firstmate's conversation was cleared - is cancelled, so it never reads
   * as waiting forever.
   */
  private reconcile(now: number): void {
    const inbox = this.options.inbox;
    if (!inbox) return;
    for (const run of this.options.store.waiting()) {
      if (run.inboxId !== null && inbox.get(run.inboxId)) continue;
      this.options.store.settle(run.id, { delivery: "cancelled", at: now, reason: "cleared" });
    }
  }

  /**
   * Create one schedule; validation is loud, creation is a feed line. A
   * draft is saved but never runs until the captain turns it on, and so is
   * a recurring rule nobody directed: new ongoing rules need the captain.
   */
  create(
    given: ScheduleSpec,
    prompt: string,
    captainRequested = false,
    name?: string,
    projectId?: string,
    options: { draft?: boolean; card?: string; task?: string } & SaysChange = {},
  ): ScheduleRecord {
    const { spec, connection } = this.checkEvent(normalized(given));
    const trimmed = prompt.trim();
    const now = this.now();
    validate(spec, trimmed, now);
    this.checkProject(projectId);
    if (options.task && spec.kind !== "event")
      throw new Error("Only an event rule ends a hold; the hold's own time ends it otherwise.");
    // A rule that ends a hold runs once and is no ongoing rule: it runs
    // without the captain's turn-on, as a put-off's rule does (INF-5145).
    const draft =
      options.draft === true || (!captainRequested && spec.kind !== "once" && !options.task);
    const record: ScheduleRecord = {
      id: randomUUID().slice(0, 8),
      spec,
      prompt: trimmed,
      nextFire: computeNextFire(spec, now),
      createdAt: now,
      captainRequested,
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(projectId ? { projectId } : {}),
      state: draft ? "draft" : "enabled",
      revision: 1,
      ...(connection ? { connection } : {}),
      ...(options.card ? { card: options.card } : {}),
      ...(options.task ? { task: options.task } : {}),
    };
    this.options.store.insert(record);
    this.announce(automationWords.created(draft, spec, trimmed), options);
    this.placeAtOnce(record);
    if (record.state === "enabled") this.options.enabled?.(record);
    return record;
  }

  /**
   * Save the captain's edit of one rule. A changed schedule, prompt or
   * project is a new revision: the old revision's fires stay in history
   * under its number, and its deliveries no turn was handed yet are taken
   * back. Editing is the captain's own direction, so the rule is stamped
   * so. `enable` is the review's Turn on: a draft runs from now, a paused
   * rule resumes.
   */
  update(
    id: string,
    changes: RuleChanges,
    options: { enable?: boolean } & SaysChange = {},
  ): ScheduleRecord {
    const record = this.require(id);
    if (record.brought) throw new Error(BROUGHT_RULE_REFUSAL);
    const now = this.now();
    const checked = changes.spec ? this.checkEvent(normalized(changes.spec)) : undefined;
    const spec = checked?.spec ?? record.spec;
    // The rule keeps its connection unless the person pointed it at an
    // event again, so an edit never moves it onto a replacement unasked.
    const repointed =
      changes.reconnect === true ||
      (record.spec.kind === "event" &&
        spec.kind === "event" &&
        (record.spec.integration !== spec.integration || record.spec.event !== spec.event));
    const connection =
      spec.kind !== "event"
        ? undefined
        : repointed || record.spec.kind !== "event"
          ? (checked?.connection ?? this.checkEvent(spec).connection)
          : record.connection;
    const prompt = (changes.prompt ?? record.prompt).trim();
    validate(spec, prompt, now);
    const name = changes.name === undefined ? record.name : changes.name.trim() || undefined;
    const projectId =
      changes.projectId === undefined ? record.projectId : changes.projectId || undefined;
    if (projectId !== record.projectId) this.checkProject(projectId);
    // What the rule waits for is read like its prompt: a new revision that
    // keeps the rule's place, never a new schedule.
    const rescheduled =
      JSON.stringify(unscreened(spec)) !== JSON.stringify(unscreened(record.spec)) ||
      connection !== record.connection;
    const edited =
      rescheduled ||
      JSON.stringify(spec) !== JSON.stringify(record.spec) ||
      prompt !== record.prompt ||
      projectId !== record.projectId;
    const state: RuleState =
      options.enable === true ||
      (record.state === "completed" && spec.kind === "once" && spec.at > now)
        ? "enabled"
        : record.state;
    const nextFire =
      record.state === "paused" && state === "enabled" && !rescheduled
        ? resumeFire(spec, record.nextFire, now)
        : rescheduled || state !== record.state
          ? computeNextFire(spec, now)
          : record.nextFire;
    const next: ScheduleRecord = {
      id: record.id,
      spec,
      prompt,
      nextFire,
      createdAt: record.createdAt,
      captainRequested: true,
      ...(name ? { name } : {}),
      ...(projectId ? { projectId } : {}),
      state,
      revision: edited ? record.revision + 1 : record.revision,
      // An event rule keeps its place while it runs on as it was; turned
      // on, resumed or pointed elsewhere, it finds its place again from now.
      ...(record.cursor !== undefined && !rescheduled && state === record.state
        ? { cursor: record.cursor }
        : {}),
      ...(connection ? { connection } : {}),
      ...(record.card ? { card: record.card } : {}),
      ...(record.task ? { task: record.task } : {}),
    };
    const recalled = edited ? this.recall(id, "edited") : 0;
    this.options.store.save(next);
    this.announce(
      automationWords.saved(
        state === "enabled" && record.state !== "enabled",
        spec,
        prompt,
        recalled,
      ),
      options,
    );
    if (next.cursor === undefined) this.placeAtOnce(next);
    if (next.state === "enabled") this.options.enabled?.(next);
    return next;
  }

  /** Stop new runs, and take back the deliveries no turn was handed yet. */
  pause(id: string, options: SaysChange = {}): ScheduleRecord {
    const record = this.require(id);
    if (record.state !== "enabled") return record;
    const next = { ...record, state: "paused" as const };
    const recalled = this.recall(id, "paused");
    this.options.store.save(next);
    this.announce(automationWords.paused(record, recalled), options);
    return next;
  }

  /**
   * Back to enabled at the next FUTURE occurrence: the paused interval is
   * not replayed, and an interval keeps its anchor.
   */
  resume(id: string, options: SaysChange = {}): ScheduleRecord {
    const record = this.require(id);
    if (record.state === "enabled") return record;
    if (record.state === "draft") {
      throw new Error("This automation is a draft. Review it and turn it on from its sheet.");
    }
    const now = this.now();
    if (record.spec.kind === "once" && record.spec.at <= now) {
      throw new Error("That time has passed. Pick a new future date to run it again.");
    }
    // An event rule listens again from now, so the paused time is not replayed.
    const { cursor: _paused, ...kept } = record;
    const next: ScheduleRecord = {
      ...kept,
      state: "enabled",
      nextFire: resumeFire(record.spec, record.nextFire, now),
    };
    this.options.store.save(next);
    this.announce(automationWords.resumed(record), options);
    this.placeAtOnce(next);
    this.options.enabled?.(next);
    return next;
  }

  /**
   * Pause every enabled rule, taking back their deliveries no turn was
   * handed yet; drafts, paused and completed ones stay as they are.
   */
  pauseAll(options: SaysChange = {}): number {
    let count = 0;
    let recalled = 0;
    for (const record of this.options.store.list()) {
      if (record.state !== "enabled") continue;
      recalled += this.recall(record.id, "paused");
      this.options.store.save({ ...record, state: "paused" });
      count += 1;
    }
    if (count > 0) this.announce(automationWords.pausedAll(count, recalled), options);
    return count;
  }

  /** The next dates a schedule would run, for the preview: no effect at all. */
  preview(spec: ScheduleSpec, count = PREVIEW_COUNT): number[] {
    const now = this.now();
    if (spec.kind === "event") return [];
    if (spec.kind === "once") return spec.at > now ? [spec.at] : [];
    const dates: number[] = [];
    let from = now;
    for (let i = 0; i < count; i++) {
      from = computeNextFire(spec, from);
      dates.push(from);
    }
    return dates;
  }

  /**
   * A rule's runs, newest first, each with where its delivery stands now: a
   * waiting one whose message is being tried again is `retrying`.
   */
  history(id: string): RunView[] {
    const inbox = this.options.inbox;
    return this.options.store.runs(id).map((run) => {
      if (run.delivery === null) return { ...run, state: "sent" };
      if (run.delivery !== "waiting") return { ...run, state: run.delivery };
      const row = inbox && run.inboxId !== null ? inbox.get(run.inboxId) : undefined;
      const retrying =
        row !== undefined &&
        (row.failures > 0 || row.cuts > 0 || (row.deliveredAt === null && row.attempts > 0));
      return { ...run, state: retrying ? "retrying" : "waiting" };
    });
  }

  /**
   * Delete one schedule with its history; idempotent, and the feed says so
   * once. Its deliveries no turn was handed yet are taken back; one a turn
   * holds goes on.
   */
  cancel(id: string, options: SaysChange = {}): boolean {
    const record = this.options.store.get(id);
    if (!record) return false;
    if (record.brought) throw new Error(BROUGHT_RULE_REFUSAL);
    const inbox = this.options.inbox;
    if (inbox) {
      inbox.withdraw(
        this.options.store
          .waiting(id)
          .flatMap((run) => (run.inboxId === null ? [] : [run.inboxId])),
      );
    }
    this.options.store.delete(id);
    this.announce(automationWords.cancelled(record.prompt), options);
    return true;
  }

  private announce(text: string, options: SaysChange): void {
    if (options.say) options.say(text);
    else this.options.broadcastEvent({ type: "firstmate_note", text });
  }

  /**
   * An event rule names an event something connected declares: kept by the
   * integration's id, found by its id or its name.
   */
  checkEvent(spec: ScheduleSpec): { spec: ScheduleSpec; connection?: string } {
    if (spec.kind !== "event") return { spec };
    const found = this.options.events?.find(spec.integration, spec.event);
    if (!found) {
      throw new Error(
        `Nothing connected tells "${spec.event}" from "${spec.integration}". The integrations tool lists each one's events.`,
      );
    }
    if (
      Object.keys(spec.filter ?? {}).some(
        (key) => !found.filters?.some((field) => field.name === key),
      )
    )
      throw new Error("This event does not declare that filter.");
    const missing = found.filters?.find(
      (field) => field.required && !spec.filter?.[field.name]?.trim(),
    );
    if (missing) throw new Error(`Name the ${missing.label} for this event.`);
    const unmatched = found.checkFilter?.(spec.filter);
    if (unmatched) throw new Error(unmatched);
    return {
      spec: {
        kind: "event",
        integration: found.integration,
        event: found.event,
        ...(spec.filter ? { filter: spec.filter } : {}),
        ...(spec.waitsFor?.trim() ? { waitsFor: spec.waitsFor.trim() } : {}),
      },
      connection: found.connection,
    };
  }

  /**
   * What an event rule listens for, in its integration's words; undefined
   * for a schedule, and for a rule whose integration is not connected or
   * whose id stands for another connection now.
   */
  listening(
    record: Pick<ScheduleRecord, "spec" | "connection">,
    events: EventFinder | undefined = this.options.events,
  ): ListenedEvent | undefined {
    const spec = record.spec;
    const found = spec.kind === "event" ? events?.find(spec.integration, spec.event) : undefined;
    return found && found.connection === record.connection ? found : undefined;
  }

  /**
   * One reading of what is connected, for asking `listening` and `stopped`
   * about many rules at once.
   */
  eventsNow(): EventFinder | undefined {
    return this.reading();
  }

  /** One reading of what is connected, for finding and looking for many rules at once. */
  private reading(): EventReading | undefined {
    const events = this.options.events;
    return events?.snapshot?.() ?? events;
  }

  /**
   * Why an event rule waits though its integration's id is connected
   * (docs/automation.md, "Events"): the id stands for another connection
   * now, or the rule was saved before the app could tell. Undefined for a
   * rule that listens, a schedule, or an integration not connected now.
   */
  stopped(
    record: Pick<ScheduleRecord, "spec" | "connection">,
    events: EventFinder | undefined = this.options.events,
  ): string | undefined {
    const spec = record.spec;
    if (spec.kind !== "event") return undefined;
    const found = events?.find(spec.integration, spec.event);
    if (!found || found.connection === record.connection) return undefined;
    return record.connection === undefined
      ? "It was saved before the app could tell one connection from another, so it waits until its integration is picked again."
      : "Its integration was removed or replaced, so it waits until its integration is picked again.";
  }

  private checkProject(projectId: string | undefined): void {
    if (projectId && this.options.projectOf && !this.options.projectOf(projectId)) {
      throw new Error("That project is not here any more. Pick another, or none.");
    }
  }

  private require(id: string): ScheduleRecord {
    const record = this.options.store.get(id);
    if (!record) throw new Error("That automation is not here. It may already be deleted.");
    return record;
  }

  rule(id: string): ScheduleRecord {
    return this.require(id);
  }

  /** A rule's newest notes version, an empty one when they were cleared, or undefined when it has none. */
  notes(id: string): RuleNotesVersion | undefined {
    return this.options.store.notes(id);
  }

  /** Every version of a rule's notes, newest first (docs/automation.md, "A rule's notes"). */
  notesHistory(id: string): RuleNotesVersion[] {
    this.require(id);
    return this.options.store.notesHistory(id);
  }

  /**
   * A new version of a rule's notes (docs/automation.md, "A rule's notes"):
   * the captain's edit or clear in Settings, or the page a crewmate the
   * rule's run started handed back on its report. It makes no new revision
   * of the rule and takes back no delivery. A page past the limit is
   * refused, never cut; a crewmate's is scanned for planted instructions
   * first. With `expected`, it is saved only while the newest version is
   * still that one (0 for none), and answers undefined otherwise. A page
   * the same as the one standing saves nothing and answers it.
   */
  saveNotes(
    id: string,
    text: string,
    source: { by: "captain" } | { by: "crewmate"; taskId: string },
    options: SaysChange & { expected?: number } = {},
  ): RuleNotesVersion | undefined {
    const record = this.require(id);
    const page = text.trim();
    if (page.length > RULE_NOTES_MAX_CHARS) throw new Error(ruleNotesTooLong(page.length));
    if (source.by === "crewmate") {
      const threat = scanKnowledgeThreat(page);
      if (threat)
        throw new Error(
          `These notes were refused: they hold text that looks like ${threat.pattern === "credential" ? "a credential" : threat.pattern === "url-exfil" ? "a link that sends data out" : "an instruction to ignore your instructions"}. Remove it and hand the notes back again.`,
        );
    }
    const standing = this.options.store.notes(id);
    if (options.expected !== undefined && options.expected !== (standing?.version ?? 0))
      return undefined;
    if ((standing?.text ?? "") === page) return standing;
    const saved = this.options.store.saveNotes(
      id,
      {
        text: page,
        at: this.now(),
        revision: record.revision,
        ...source,
      },
      standing?.version ?? 0,
    );
    if (saved && source.by === "captain")
      this.announce(automationWords.notes(record, page === ""), options);
    return saved;
  }

  /**
   * Every rule about a project becomes about the one it was combined into
   * (INF-5005, `project-move`), so its wake still names a project on the
   * list. Only the project changes: the rule keeps its revision, state and
   * place. Answers how many moved.
   */
  moveProject(from: string, to: string): number {
    let moved = 0;
    for (const record of this.options.store.list()) {
      if (record.projectId !== from) continue;
      this.options.store.save({ ...record, projectId: to });
      moved += 1;
    }
    return moved;
  }

  /** Every rule, whatever its state: what Automation shows. */
  rules(): ScheduleRecord[] {
    return this.options.store.list();
  }

  /** The rules that end a hold: one task's, or every task's (`HoldRules`). */
  linked(taskId?: string): ScheduleRecord[] {
    return this.options.store.linked(taskId);
  }

  /** The rules that can still run, drafts included: what the Firstmate's context lists. */
  list(): ScheduleRecord[] {
    return this.options.store.list().filter((record) => record.state !== "completed");
  }
}

/** A rule's scheduled wake: its prompt as sent, its authority, the rule and its project. */
function wakeOf(
  record: ScheduleRecord,
  run: {
    prompt: string;
    catchUp: boolean;
    missed: number;
    run: number;
    waited?: true;
    events?: { integration: string; label: string; count: number; onlyIf?: string };
  },
  project: { key: string; name: string } | undefined,
): TypedWake {
  const facts: WakeFacts = {
    kind: "scheduled",
    prompt: run.prompt,
    catchUp: run.catchUp,
    captainRequested: record.captainRequested === true,
    ...(run.missed > 0 ? { missed: run.missed } : {}),
    ...(run.waited ? { waited: true as const } : {}),
    ...(run.events ? { events: run.events } : {}),
    run: run.run,
    rule: { id: record.id, ...(record.name ? { name: record.name } : {}) },
    ...(project ? { project } : {}),
  };
  return { facts };
}

/** A spec without what an event rule waits for: the schedule alone. */
function unscreened(spec: ScheduleSpec): ScheduleSpec {
  if (spec.kind !== "event") return spec;
  const { waitsFor: _waitsFor, ...rest } = spec;
  return rest;
}

/** The events a run carries, as its wake names them, with the rule's Only if condition. */
function eventsFact(found: ListenedEvent, count: number, spec: ScheduleSpec) {
  const onlyIf = spec.kind === "event" ? spec.waitsFor?.trim() : undefined;
  return { integration: found.name, label: found.label, count, ...(onlyIf ? { onlyIf } : {}) };
}

/** The items not yet carried by a run of this rule, each once. */
function newItems(
  items: readonly AutomationEventItem[],
  carried: ReadonlySet<string>,
): AutomationEventItem[] {
  const seen = new Set(carried);
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
