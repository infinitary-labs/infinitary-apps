import { randomUUID } from "node:crypto";
import { fillScheduleDetails } from "@shared/automation";
import type { FmEvent } from "@shared/events";
import type { DecisionRecord } from "@shared/provenance";
import type { InboxRow } from "../storage/inboxStore";
import {
  MIN_INTERVAL_MINUTES,
  type RecordedRun,
  type RuleState,
  type RunCancelReason,
  type ScheduleRecord,
  type ScheduleSpec,
  type ScheduleStore,
} from "../storage/scheduleStore";
import { isTimeZone, localTimeZone, nextZonedFire } from "./calendar";
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

/** A run as the history shows it: where its delivery stands now. */
export type RunView = RecordedRun & {
  state: "waiting" | "retrying" | "handled" | "cancelled" | "sent";
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
};

const TICK_MS = 60 * 1000;
const PROMPT_EXCERPT = 80;
const PREVIEW_COUNT = 3;

/** `projectId` null takes the project off; undefined keeps it. */
export type RuleChanges = {
  name?: string;
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

function label(record: ScheduleRecord): string {
  return record.name ?? record.prompt.slice(0, PROMPT_EXCERPT);
}

/** " (1 unsent prompt taken back)", or nothing when none was. */
function recalledText(count: number): string {
  return count > 0 ? ` (${count} unsent ${count === 1 ? "prompt" : "prompts"} taken back)` : "";
}

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
  if (spec.kind === "once") return 0;
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
      return `once at ${new Date(spec.at).toLocaleString()}`;
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
  /** The registration on the host's ticker, undone at stop. */
  private unregister: (() => void) | undefined;
  private readonly now: () => number;

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
    for (const record of this.options.store.list()) {
      if (record.state !== "enabled" || record.nextFire > now) continue;
      const missed = missedOccurrences(record.spec, record.nextFire, now);
      const next =
        record.spec.kind === "once"
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
        (run) => {
          const queued = this.options.notify(
            wakeOf(record, { prompt, catchUp, missed, run }, project),
            "scheduled",
          );
          return typeof queued === "number" ? queued : null;
        },
      );
    }
  }

  /**
   * A turn's decision record (docs/automation.md, "Deliveries"): each
   * delivery it served and acknowledged is handled, linked to the tasks and
   * cards the turn touched - less the tasks the turn's other messages were
   * about. A delivery released for a retry keeps waiting.
   */
  noteDecision(record: DecisionRecord): void {
    if (record.disposition.inbox !== "acked" || !record.served) return;
    const segments = [
      ...record.served.prompt.segments,
      ...record.served.steers.flatMap((steer) => steer.segments),
    ];
    const about = new Set(segments.flatMap((segment) => (segment.ref ? [segment.ref] : [])));
    for (const segment of segments) {
      if (segment.inboxId === undefined) continue;
      const run = this.options.store.runByInbox(segment.inboxId);
      if (run?.delivery !== "waiting") continue;
      this.options.store.settle(run.id, {
        delivery: "handled",
        at: record.endedAt,
        tasks: record.disposition.tasks.filter((task) => !about.has(task)),
        cards: record.disposition.cards,
      });
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
    options: { draft?: boolean } = {},
  ): ScheduleRecord {
    const spec = normalized(given);
    const trimmed = prompt.trim();
    const now = this.now();
    validate(spec, trimmed, now);
    this.checkProject(projectId);
    const draft = options.draft === true || (!captainRequested && spec.kind !== "once");
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
    };
    this.options.store.insert(record);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `${draft ? "Automation saved as a draft" : "Scheduled"} - ${scheduleText(spec)}: ${trimmed.slice(0, PROMPT_EXCERPT)}`,
    });
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
  update(id: string, changes: RuleChanges, options: { enable?: boolean } = {}): ScheduleRecord {
    const record = this.require(id);
    const now = this.now();
    const spec = normalized(changes.spec ?? record.spec);
    const prompt = (changes.prompt ?? record.prompt).trim();
    validate(spec, prompt, now);
    const name = changes.name === undefined ? record.name : changes.name.trim() || undefined;
    const projectId =
      changes.projectId === undefined ? record.projectId : changes.projectId || undefined;
    if (projectId !== record.projectId) this.checkProject(projectId);
    const rescheduled = JSON.stringify(spec) !== JSON.stringify(record.spec);
    const edited = rescheduled || prompt !== record.prompt || projectId !== record.projectId;
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
    };
    const recalled = edited ? this.recall(id, "edited") : 0;
    this.options.store.save(next);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text:
        state === "enabled" && record.state !== "enabled"
          ? `Automation turned on - ${scheduleText(spec)}: ${prompt.slice(0, PROMPT_EXCERPT)}${recalledText(recalled)}`
          : `Automation saved - ${scheduleText(spec)}: ${prompt.slice(0, PROMPT_EXCERPT)}${recalledText(recalled)}`,
    });
    return next;
  }

  /** Stop new runs, and take back the deliveries no turn was handed yet. */
  pause(id: string): ScheduleRecord {
    const record = this.require(id);
    if (record.state !== "enabled") return record;
    const next = { ...record, state: "paused" as const };
    const recalled = this.recall(id, "paused");
    this.options.store.save(next);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Automation paused - ${label(record)}${recalledText(recalled)}`,
    });
    return next;
  }

  /**
   * Back to enabled at the next FUTURE occurrence: the paused interval is
   * not replayed, and an interval keeps its anchor.
   */
  resume(id: string): ScheduleRecord {
    const record = this.require(id);
    if (record.state === "enabled") return record;
    if (record.state === "draft") {
      throw new Error("This automation is a draft. Review it and turn it on from its sheet.");
    }
    const now = this.now();
    if (record.spec.kind === "once" && record.spec.at <= now) {
      throw new Error("That time has passed. Pick a new future date to run it again.");
    }
    const next: ScheduleRecord = {
      ...record,
      state: "enabled",
      nextFire: resumeFire(record.spec, record.nextFire, now),
    };
    this.options.store.save(next);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Automation resumed - ${label(record)}`,
    });
    return next;
  }

  /**
   * Pause every enabled rule, taking back their deliveries no turn was
   * handed yet; drafts, paused and completed ones stay as they are.
   */
  pauseAll(): number {
    let count = 0;
    let recalled = 0;
    for (const record of this.options.store.list()) {
      if (record.state !== "enabled") continue;
      recalled += this.recall(record.id, "paused");
      this.options.store.save({ ...record, state: "paused" });
      count += 1;
    }
    if (count > 0) {
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Automation paused - ${count} ${count === 1 ? "rule" : "rules"}${recalledText(recalled)}`,
      });
    }
    return count;
  }

  /** The next dates a schedule would run, for the preview: no effect at all. */
  preview(spec: ScheduleSpec, count = PREVIEW_COUNT): number[] {
    const now = this.now();
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
  cancel(id: string): boolean {
    const record = this.options.store.get(id);
    if (!record) return false;
    const inbox = this.options.inbox;
    if (inbox) {
      inbox.withdraw(
        this.options.store
          .waiting(id)
          .flatMap((run) => (run.inboxId === null ? [] : [run.inboxId])),
      );
    }
    this.options.store.delete(id);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Schedule cancelled - ${record.prompt.slice(0, PROMPT_EXCERPT)}`,
    });
    return true;
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

  /** Every rule, whatever its state: what Automation shows. */
  rules(): ScheduleRecord[] {
    return this.options.store.list();
  }

  /** The rules that can still run, drafts included: what the Firstmate's context lists. */
  list(): ScheduleRecord[] {
    return this.options.store.list().filter((record) => record.state !== "completed");
  }
}

/** A rule's scheduled wake: its prompt as sent, its authority, the rule and its project. */
function wakeOf(
  record: ScheduleRecord,
  run: { prompt: string; catchUp: boolean; missed: number; run: number; waited?: true },
  project: { key: string; name: string } | undefined,
): TypedWake {
  const facts: WakeFacts = {
    kind: "scheduled",
    prompt: run.prompt,
    catchUp: run.catchUp,
    captainRequested: record.captainRequested === true,
    ...(run.missed > 0 ? { missed: run.missed } : {}),
    ...(run.waited ? { waited: true as const } : {}),
    run: run.run,
    rule: { id: record.id, ...(record.name ? { name: record.name } : {}) },
    ...(project ? { project } : {}),
  };
  return { facts };
}
