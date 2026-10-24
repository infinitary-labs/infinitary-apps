import {
  type AutomationEventItem,
  type AutomationSpec,
  automationEventFilterSchema,
} from "@shared/automation";
import type { AppDatabase } from "./db";

/**
 * Persistent cron prompts (R3): each row is a schedule whose fires wake the
 * Firstmate agent with its prompt. Five spec shapes only - every N minutes,
 * daily at a time, on chosen weekdays at a time, once at a moment, or each
 * time an integration's event arrives - parsed by the agent from natural
 * language; no cron expressions. A daily or
 * weekly time keeps its IANA time zone; a daily rule made before time
 * zones has none and follows this computer's clock (docs/automation.md).
 */

export type ScheduleSpec = AutomationSpec;

export type ScheduleRecord = {
  id: string;
  spec: ScheduleSpec;
  prompt: string;
  nextFire: number;
  createdAt: number;
  /** Code-stamped authority; absent legacy provenance never grants permission. */
  captainRequested?: boolean;
  /** What the captain calls it; absent for a rule nobody named. */
  name?: string;
  /** The project its prompt is about (a project id); absent for none. */
  projectId?: string;
  /**
   * Only an enabled rule fires; a draft waits for the captain to turn it
   * on, and a completed one-time rule stays until its delivery settles.
   */
  state: RuleState;
  /** Counts saved edits; a delivery names the revision it was planned under. */
  revision: number;
  /**
   * An event rule's place at its integration: where its next look starts.
   * Absent until its first look, and again after it is turned on, resumed
   * or pointed at another event, so what came meanwhile never fires.
   */
  cursor?: string;
  /**
   * Which connection an event rule's integration id stood for when it was
   * pointed there (docs/integrations.md, "Which connection"). Absent on a
   * rule saved before connections had one: it waits until its integration
   * is picked again.
   */
  connection?: string;
};

export type RuleState = "draft" | "enabled" | "paused" | "completed";

/**
 * Where a delivery stands, as recorded: `waiting` until a turn handles it
 * or it is recalled. Null on a run recorded before deliveries were
 * followed (migration 80).
 */
export type RunDelivery = "waiting" | "handled" | "cancelled";

/** Why a waiting delivery was recalled. */
export type RunCancelReason = "edited" | "paused" | "cleared";

/** One fire of a rule, as the history shows it. */
export type ScheduleRun = {
  scheduleId: string;
  revision: number;
  plannedAt: number;
  firedAt: number;
  catchUp: boolean;
  /** Further occurrences folded into this one, by downtime or while it waited. */
  missed: number;
  prompt: string;
  /** The events an event rule's run carries, each by its own id; absent on a scheduled run. */
  events?: AutomationEventItem[];
};

/** A run as it is stored: its delivery and what that delivery led to. */
export type RecordedRun = ScheduleRun & {
  id: number;
  /** The inbox row carrying it while it is not yet handled. */
  inboxId: number | null;
  delivery: RunDelivery | null;
  settledAt: number | null;
  cancelReason: RunCancelReason | null;
  /** Task ids the turn that handled it touched. */
  tasks: string[];
  /** Card ids that turn showed. */
  cards: string[];
};

/** Where a fire leaves its rule: its next fire and state, and an event rule's cursor. */
export type Advance = { nextFire: number; state: RuleState; cursor?: string };

/** Completed history is kept this long and this many per rule (docs/automation.md). */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RUN_RETENTION_CAP = 1000;

/** The recurring floor (R3 guardrail): never more often than this. */
export const MIN_INTERVAL_MINUTES = 15;

type Row = {
  id: string;
  spec_kind: ScheduleSpec["kind"];
  interval_minutes: number | null;
  hour: number | null;
  minute: number | null;
  at: number | null;
  prompt: string;
  next_fire: number;
  created_at: number;
  captain_requested: number;
  name: string | null;
  state: RuleState;
  revision: number;
  /** A weekly rule's weekdays, comma-separated, 0 for Sunday. */
  days: string | null;
  time_zone: string | null;
  project_id: string | null;
  event_integration: string | null;
  event_name: string | null;
  event_filter: string | null;
  event_cursor: string | null;
  event_connection: string | null;
};

type RunRow = {
  id: number;
  schedule_id: string;
  revision: number;
  planned_at: number;
  fired_at: number;
  catch_up: number;
  missed: number;
  prompt: string;
  inbox_id: number | null;
  delivery: RunDelivery | null;
  settled_at: number | null;
  cancel_reason: RunCancelReason | null;
  tasks: string | null;
  cards: string | null;
  events: string | null;
};

function itemsOf(json: string | null): AutomationEventItem[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is AutomationEventItem =>
            typeof item?.id === "string" && typeof item?.summary === "string",
        )
      : undefined;
  } catch {
    return undefined;
  }
}

function idsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function runOf(row: RunRow): RecordedRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    revision: row.revision,
    plannedAt: row.planned_at,
    firedAt: row.fired_at,
    catchUp: row.catch_up === 1,
    missed: row.missed,
    prompt: row.prompt,
    ...(itemsOf(row.events) ? { events: itemsOf(row.events) } : {}),
    inboxId: row.inbox_id,
    delivery: row.delivery,
    settledAt: row.settled_at,
    cancelReason: row.cancel_reason,
    tasks: idsOf(row.tasks),
    cards: idsOf(row.cards),
  };
}

function specOf(row: Row): ScheduleSpec {
  switch (row.spec_kind) {
    case "every":
      return { kind: "every", minutes: row.interval_minutes ?? MIN_INTERVAL_MINUTES };
    case "daily":
      return {
        kind: "daily",
        hour: row.hour ?? 0,
        minute: row.minute ?? 0,
        ...(row.time_zone ? { timeZone: row.time_zone } : {}),
      };
    case "weekly":
      return {
        kind: "weekly",
        days: (row.days ?? "").split(",").filter(Boolean).map(Number),
        hour: row.hour ?? 0,
        minute: row.minute ?? 0,
        timeZone: row.time_zone ?? "UTC",
      };
    case "once":
      return { kind: "once", at: row.at ?? row.next_fire };
    case "event":
      return {
        kind: "event",
        integration: row.event_integration ?? "",
        event: row.event_name ?? "",
        ...(row.event_filter !== null
          ? { filter: automationEventFilterSchema.parse(JSON.parse(row.event_filter)) }
          : {}),
      };
  }
}

/** The spec's own columns, in the order `insert` and `save` write them. */
function specColumns(spec: ScheduleSpec) {
  return [
    spec.kind,
    spec.kind === "every" ? spec.minutes : null,
    spec.kind === "daily" || spec.kind === "weekly" ? spec.hour : null,
    spec.kind === "daily" || spec.kind === "weekly" ? spec.minute : null,
    spec.kind === "once" ? spec.at : null,
    spec.kind === "weekly" ? [...spec.days].sort((a, b) => a - b).join(",") : null,
    (spec.kind === "daily" || spec.kind === "weekly") && spec.timeZone ? spec.timeZone : null,
    spec.kind === "event" ? spec.integration : null,
    spec.kind === "event" ? spec.event : null,
    spec.kind === "event" && spec.filter ? JSON.stringify(spec.filter) : null,
  ] as const;
}

function fromRow(row: Row): ScheduleRecord {
  return {
    id: row.id,
    spec: specOf(row),
    prompt: row.prompt,
    nextFire: row.next_fire,
    createdAt: row.created_at,
    captainRequested: row.captain_requested === 1,
    ...(row.name ? { name: row.name } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    state: row.state,
    revision: row.revision,
    ...(row.event_cursor !== null ? { cursor: row.event_cursor } : {}),
    ...(row.event_connection !== null ? { connection: row.event_connection } : {}),
  };
}

export class ScheduleStore {
  constructor(private readonly db: AppDatabase) {}

  insert(record: ScheduleRecord): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, spec_kind, interval_minutes, hour, minute, at, days, time_zone, event_integration, event_name, event_filter, prompt, next_fire, created_at, captain_requested, name, state, revision, project_id, event_cursor, event_connection)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        ...specColumns(record.spec),
        record.prompt,
        record.nextFire,
        record.createdAt,
        record.captainRequested === true ? 1 : 0,
        record.name ?? null,
        record.state,
        record.revision,
        record.projectId ?? null,
        record.cursor ?? null,
        record.connection ?? null,
      );
  }

  /** Replace a rule's editable fields in one write. */
  save(record: ScheduleRecord): void {
    this.db
      .prepare(
        `UPDATE schedules SET spec_kind = ?, interval_minutes = ?, hour = ?, minute = ?, at = ?, days = ?, time_zone = ?,
           event_integration = ?, event_name = ?, event_filter = ?, prompt = ?, next_fire = ?, captain_requested = ?, name = ?, state = ?,
           revision = ?, project_id = ?, event_cursor = ?, event_connection = ? WHERE id = ?`,
      )
      .run(
        ...specColumns(record.spec),
        record.prompt,
        record.nextFire,
        record.captainRequested === true ? 1 : 0,
        record.name ?? null,
        record.state,
        record.revision,
        record.projectId ?? null,
        record.cursor ?? null,
        record.connection ?? null,
        record.id,
      );
  }

  /**
   * One fire, atomically: the occurrence is recorded as a waiting delivery
   * and the rule advances (or completes) in a single transaction, so a
   * restart can neither lose nor repeat it. False means this
   * rule/revision/occurrence was already recorded, and nothing is delivered
   * again. `deliver` runs inside the transaction with the run's id and
   * answers the inbox row carrying it, so a delivery that throws leaves the
   * rule due.
   */
  recordFire(
    run: ScheduleRun,
    next: Advance,
    now: number,
    deliver: (runId: number) => number | null,
  ): boolean {
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO schedule_runs (schedule_id, revision, planned_at, fired_at, catch_up, missed, prompt, events, delivery)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`,
        )
        .run(
          run.scheduleId,
          run.revision,
          run.plannedAt,
          run.firedAt,
          run.catchUp ? 1 : 0,
          run.missed,
          run.prompt,
          run.events ? JSON.stringify(run.events) : null,
        );
      this.advance(run.scheduleId, next);
      this.trim(run.scheduleId, now);
      if (inserted.changes === 0) return false;
      const runId = Number(inserted.lastInsertRowid);
      const inboxId = deliver(runId);
      this.db.prepare("UPDATE schedule_runs SET inbox_id = ? WHERE id = ?").run(inboxId, runId);
      return true;
    })();
  }

  /**
   * A later occurrence joins a delivery still waiting unsent (at most one
   * waits per rule): the run takes the new count and prompt, the rule
   * advances, and `revise` rewrites the waiting message, all in one
   * transaction. False when the message was handed to a turn meanwhile,
   * which changes nothing.
   */
  foldFire(
    runId: number,
    run: Pick<ScheduleRun, "scheduleId" | "missed" | "prompt" | "events">,
    next: Advance,
    revise: () => boolean,
  ): boolean {
    return this.db.transaction(() => {
      if (!revise()) return false;
      // An event rule's run gathers events, not missed times: it is no catch-up.
      if (run.events)
        this.db
          .prepare("UPDATE schedule_runs SET events = ?, prompt = ? WHERE id = ?")
          .run(JSON.stringify(run.events), run.prompt, runId);
      else
        this.db
          .prepare("UPDATE schedule_runs SET missed = ?, catch_up = 1, prompt = ? WHERE id = ?")
          .run(run.missed, run.prompt, runId);
      this.advance(run.scheduleId, next);
      return true;
    })();
  }

  /** A delivery settles: handled, with what it led to, or cancelled, with why. */
  settle(
    runId: number,
    outcome:
      | { delivery: "handled"; at: number; tasks: readonly string[]; cards: readonly string[] }
      | { delivery: "cancelled"; at: number; reason: RunCancelReason },
  ): void {
    this.db
      .prepare(
        `UPDATE schedule_runs SET delivery = ?, settled_at = ?, cancel_reason = ?, tasks = ?, cards = ?
         WHERE id = ? AND delivery = 'waiting'`,
      )
      .run(
        outcome.delivery,
        outcome.at,
        outcome.delivery === "cancelled" ? outcome.reason : null,
        outcome.delivery === "handled" ? JSON.stringify(outcome.tasks) : null,
        outcome.delivery === "handled" ? JSON.stringify(outcome.cards) : null,
        runId,
      );
  }

  /** Every delivery not yet handled or cancelled, oldest first; one rule's when named. */
  waiting(scheduleId?: string): RecordedRun[] {
    const rows = (
      scheduleId === undefined
        ? this.db
            .prepare("SELECT * FROM schedule_runs WHERE delivery = 'waiting' ORDER BY id")
            .all()
        : this.db
            .prepare(
              "SELECT * FROM schedule_runs WHERE delivery = 'waiting' AND schedule_id = ? ORDER BY id",
            )
            .all(scheduleId)
    ) as RunRow[];
    return rows.map(runOf);
  }

  /** The run an inbox row carries, if any. */
  runByInbox(inboxId: number): RecordedRun | undefined {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE inbox_id = ?").get(inboxId) as
      | RunRow
      | undefined;
    return row ? runOf(row) : undefined;
  }

  /** A rule's fires, newest first. */
  runs(scheduleId: string, limit = 50): RecordedRun[] {
    const rows = this.db
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?")
      .all(scheduleId, limit) as RunRow[];
    return rows.map(runOf);
  }

  /**
   * Every run's prompt and event summaries written again through `scrub`,
   * which answers the text with the words from outside it found due
   * replaced (INF-952; docs/task-retention.md, "Words from outside"). Each
   * event keeps its id, so an event is still delivered once. A delivery
   * still waiting has its own message (`InboxStore.rewritePending`).
   * Answers how many it replaced.
   */
  rewriteRuns(scrub: (text: string, at: number) => { value: string; replaced: number }): number {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id, fired_at, prompt, events FROM schedule_runs WHERE instr(prompt, '[[') > 0 OR instr(COALESCE(events, ''), '[[') > 0",
        )
        .all() as Pick<RunRow, "id" | "fired_at" | "prompt" | "events">[];
      const update = this.db.prepare(
        "UPDATE schedule_runs SET prompt = ?, events = ? WHERE id = ?",
      );
      let replaced = 0;
      for (const row of rows) {
        const prompt = scrub(row.prompt, row.fired_at);
        let events = row.events;
        let count = prompt.replaced;
        if (row.events) {
          try {
            const items = JSON.parse(row.events) as unknown;
            if (Array.isArray(items)) {
              const next = items.map((item) => {
                if (typeof item?.summary !== "string") return item;
                const done = scrub(item.summary, row.fired_at);
                count += done.replaced;
                return done.replaced ? { ...item, summary: done.value } : item;
              });
              events = JSON.stringify(next);
            }
          } catch {
            // Not a list of events: left as it was.
          }
        }
        if (count === 0) continue;
        update.run(prompt.value, events, row.id);
        replaced += count;
      }
      return replaced;
    })();
  }

  /** The rule's next fire and state, and an event rule's new cursor with them. */
  private advance(id: string, next: Advance): void {
    this.db
      .prepare("UPDATE schedules SET next_fire = ?, state = ? WHERE id = ?")
      .run(next.nextFire, next.state, id);
    if (next.cursor !== undefined) this.setCursor(id, next.cursor);
  }

  /** An event rule's place at its integration after a look that fired nothing. */
  setCursor(id: string, cursor: string): void {
    this.db.prepare("UPDATE schedules SET event_cursor = ? WHERE id = ?").run(cursor, id);
  }

  /**
   * The ids of the events this rule's runs carried, as far back as its
   * history keeps: an event is delivered once even when a look overlaps.
   */
  carried(scheduleId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT events FROM schedule_runs WHERE schedule_id = ? AND events IS NOT NULL")
      .all(scheduleId) as { events: string }[];
    return new Set(rows.flatMap((row) => (itemsOf(row.events) ?? []).map((item) => item.id)));
  }

  /**
   * Settled history past 30 days or beyond 1,000 per rule goes; a delivery
   * still waiting stays until it settles.
   */
  private trim(scheduleId: string, now: number): void {
    this.db
      .prepare(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND COALESCE(delivery, '') != 'waiting' AND (fired_at < ? OR id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = ? AND COALESCE(delivery, '') != 'waiting' ORDER BY id DESC LIMIT ?))`,
      )
      .run(scheduleId, now - RUN_RETENTION_MS, scheduleId, RUN_RETENTION_CAP);
  }

  setNextFire(id: string, nextFire: number): void {
    this.db.prepare("UPDATE schedules SET next_fire = ? WHERE id = ?").run(nextFire, id);
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): ScheduleRecord[] {
    const rows = this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Row[];
    return rows.map(fromRow);
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").run(id);
    })();
  }

  /** One transaction over the schedules and whatever else shares their database (the inbox). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  clear(): void {
    this.db.prepare("DELETE FROM schedules").run();
    this.db.prepare("DELETE FROM schedule_runs").run();
  }
}
