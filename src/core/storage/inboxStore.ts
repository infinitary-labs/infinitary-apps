import { createHash } from "node:crypto";
import { SERVED_ORIGINS, type ServedOrigin, type ServedWakeOrigin } from "@shared/servedFrame";
import type { TypedWake, WakeBody, WakeEnvelope } from "../orchestrator/wakes";
import type { AppDatabase } from "./db";

/**
 * The durable inbox (migration 12): fm_inbox generalized to every recipient.
 * One lane per recipient - "firstmate" for the orchestrator's [fm-op]
 * traffic, a task id for guidance addressed to that crewmate - with the
 * source mechanism's semantics (firstmate's fm-task-inbox-lib.sh, adapted
 * to one Electron process):
 *
 * - Enqueue is delivery: the durable row is the message; the in-process
 *   delivery attempt is only the doorbell, free to re-ring.
 * - Acknowledge after handling: a row is deleted only when the turn that
 *   consumed it ended without error. A failed turn releases the row for
 *   retry; a process death leaves it in-flight, and the boot sweep resets
 *   in-flight rows to pending (at-least-once - a rare duplicate is chosen
 *   over a silent loss, exactly the source's trade). A turn a quit or crash
 *   cut is not the crewmate refusing the guidance either: the reset gives
 *   its attempt back and counts the cut in `cuts` (migration 74), so the
 *   replay says what it is and repeated quits never spend the ladder.
 * - The retry ladder: one delivery attempt per grace period, counted in
 *   `attempts`. Task-lane rows whose budget is spent escalate loudly and
 *   stop retrying; the firstmate lane never escalates - its rows simply
 *   keep waiting at the grace cadence, because operational messages have
 *   nowhere else to go.
 *
 * - The honest retry (migration 45, captain's Q1 of 2026-09-26): a turn the
 *   PROVIDER failed is not the crewmate refusing the guidance, and a task
 *   lane has nowhere else to go either. Such a release spends no attempt:
 *   it counts in `failures` and backs off (`INBOX_BACKOFF_MS`, then every
 *   15 minutes, forever), so the row is delivered on the first attempt
 *   after the provider answers again. Only refusals - a steer or a resume
 *   that throws, a sign-in failure - spend the ladder's attempts.
 *
 * - Wakes dedupe by content (interaction P0, WI-3; migration 22): a wake
 *   identical to the last one on its lane and ref is not a new event, so
 *   `enqueueWake` records nothing for it. The last one is the newest live
 *   row, or the newest acked row while it is inside the dedupe window
 *   (`inbox_acks` remembers it, since the ack deletes the row). This
 *   dedupes content, never delivery attempts: a row that exists is
 *   delivered, released, and reset at boot exactly as before.
 *
 * - A wake that goes out once per fact names it (`TypedWake.once`; migration
 *   49): `enqueueWake` records the name for the wake's task in `inbox_once`,
 *   in the transaction that queues the row, and never queues a wake with
 *   that name about that task again - across a restart, an intervening wake
 *   and any time after the ack, none of which the content dedupe covers.
 *   A host steer that goes out once per fact records its name the same way
 *   (`enqueueSteerOnce`); a plain `enqueue` never reads or records one.
 *
 * - Every firstmate- and supervision-lane row carries its `origin` (migration
 *   32, `ServedOrigin`): the emitter says what the message is, so the reader
 *   classifies it structurally and never by the `[fm-op]`/`[user]` wording
 *   in the payload. Task-lane rows (guidance to a crewmate) carry none.
 *
 * - The payload is a typed wake envelope (migration 48, the primitives
 *   review's P3; `orchestrator/wakes.ts`): `{v, facts, ways}` for every
 *   wake the host composes, `{v, text}` for prose someone wrote. A row
 *   read back IS the envelope, with its `origin` and `ref` columns; the
 *   reader renders it with `renderWake` where it is served, never here. A
 *   typed wake's content identity is its origin and facts, never its
 *   wording; prose keeps the hash of its text.
 *
 * Not an event bus: every row has exactly one recipient and one
 * acknowledgement - no fan-out - which is what keeps ack-after-handling
 * and the ladder coherent.
 */

/** Delivery-attempt spacing, matching the source's FM_TASK_INBOX_GRACE_SECS. */
export const INBOX_GRACE_MS = 90_000;
/**
 * The wake-diet coalescing window (interaction P3, WI-13): a first pending
 * wake is held this long for its siblings so near-simultaneous wakes drain as
 * one turn instead of one turn each. Anchored to the oldest pending row's
 * `createdAt` and checked against the clock, not a wall-timer, so a replay's
 * frozen clock coalesces exactly as production's real one does. A captain turn
 * never waits it out - it carries the pending rows with it.
 */
export const WAKE_COALESCE_MS = 3_000;
/** Attempts before a task-lane row escalates (FM_TASK_INBOX_RING_MAX). */
export const INBOX_ATTEMPT_MAX = 3;
/**
 * The honest retry's backoff after the nth provider failure of a row (the
 * captain's Q1): 90 s, 3 min, 5 min, 10 min, then every 15 min, forever.
 */
export const INBOX_BACKOFF_MS: readonly number[] = [
  90_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
];
const INBOX_BACKOFF_CEILING_MS = 15 * 60_000;

/** How long a row that has now failed at the provider `failures` times waits. */
export function inboxBackoffMs(failures: number): number {
  return INBOX_BACKOFF_MS[Math.max(failures, 1) - 1] ?? INBOX_BACKOFF_CEILING_MS;
}
/** The orchestrator's own lane. */
export const FIRSTMATE_RECIPIENT = "firstmate";
/** The supervision session's lane (design B); its owner drains it. */
export const SUPERVISION_RECIPIENT = "supervision";
/**
 * How long an acked wake still counts as the lane's last one (WI-3). Long
 * enough to swallow a replay storm (Sep 14: one stale text re-sent for five
 * minutes), short enough that a real recurrence later is heard again.
 */
export const INBOX_DEDUPE_WINDOW_MS = 5 * 60_000;

/** The content identity of prose (the `content_hash` column of a `{v, text}` row). */
export function inboxContentHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** The payload's schema version (migration 48): every row carries it. */
export const WAKE_ENVELOPE_VERSION = 1;

/**
 * The content identity a wake is deduped by: `{origin, ref, facts}` for a
 * typed wake (the ref is the lane's, matched by the query), and the text's
 * own hash for prose - so a prose row from before the envelope still
 * dedupes the same prose after it.
 */
export function wakeIdentity(body: WakeBody, origin: ServedOrigin | null): string {
  if (typeof body === "string") return inboxContentHash(body);
  return inboxContentHash(canonicalJson({ origin, facts: body.facts }));
}

/** The payload column's JSON for a wake body. */
export function encodeWake(body: WakeBody): string {
  return JSON.stringify(
    typeof body === "string"
      ? { v: WAKE_ENVELOPE_VERSION, text: body }
      : { v: WAKE_ENVELOPE_VERSION, facts: body.facts, ways: body.ways },
  );
}

/**
 * A payload column read back as the envelope's body. A row that is not an
 * envelope - prose an older build wrote after this one migrated the table -
 * is read as the prose it is.
 */
function decodeWake(payload: string): Pick<WakeEnvelope, "v" | "facts" | "ways" | "text"> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (isEnvelope(parsed)) {
      return {
        v: WAKE_ENVELOPE_VERSION,
        ...(parsed.facts !== undefined ? { facts: parsed.facts } : {}),
        ...(parsed.ways !== undefined ? { ways: parsed.ways } : {}),
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      };
    }
  } catch {
    // Not JSON: prose.
  }
  return { v: WAKE_ENVELOPE_VERSION, text: payload };
}

function isEnvelope(value: unknown): value is Partial<WakeEnvelope> {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.v !== WAKE_ENVELOPE_VERSION) return false;
  if (typeof envelope.text === "string") return true;
  const facts = envelope.facts as Record<string, unknown> | null | undefined;
  return typeof facts === "object" && facts !== null && typeof facts.kind === "string";
}

/** JSON with every object's keys sorted, so equal facts hash equal whatever built them. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );
}

/**
 * One inbox row: the wake envelope (`v`, `origin`, `ref`, and `facts` and
 * `ways` or `text`) and its delivery state.
 */
export type InboxRow = WakeEnvelope & {
  id: number;
  recipient: string;
  createdAt: number;
  /** Set while a live session holds the row, awaiting the handling ack. */
  deliveredAt: number | null;
  attempts: number;
  lastAttemptAt: number | null;
  /** Task-lane ladder spent: surfaced loudly, retries stopped. */
  escalatedAt: number | null;
  /** Provider failures this row has met since it last went through (the honest retry). */
  failures: number;
  /** When this row first failed at the provider; null while it never has. */
  failingSince: number | null;
  /** When the row is next due; null means now. */
  nextAttemptAt: number | null;
  /** Turns serving this row that a quit or crash cut short; each was given its attempt back. */
  cuts: number;
};

type Row = {
  id: number;
  recipient: string;
  payload: string;
  created_at: number;
  delivered_at: number | null;
  attempts: number;
  last_attempt_at: number | null;
  escalated_at: number | null;
  failures: number | null;
  failing_since: number | null;
  next_attempt_at: number | null;
  cuts: number | null;
  ref: string | null;
  origin: string | null;
};

function originOf(value: string | null): ServedOrigin | null {
  return SERVED_ORIGINS.find((origin) => origin === value) ?? null;
}

function fromRow(row: Row): InboxRow {
  return {
    ...decodeWake(row.payload),
    id: row.id,
    recipient: row.recipient,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    escalatedAt: row.escalated_at,
    failures: row.failures ?? 0,
    failingSince: row.failing_since,
    nextAttemptAt: row.next_attempt_at,
    cuts: row.cuts ?? 0,
    ref: row.ref,
    origin: originOf(row.origin),
  };
}

function placeholders(ids: readonly unknown[]): string {
  return ids.map(() => "?").join(", ");
}

export class InboxStore {
  /** Invalidation is coalesced after the enclosing synchronous transaction. */
  private readonly changeListeners = new Set<() => void>();
  private changeQueued = false;
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private changed(): void {
    if (this.changeQueued || this.changeListeners.size === 0) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      for (const listener of this.changeListeners) listener();
    });
  }

  /**
   * The clock every time this store stamps or compares - the grace, the
   * honest retry's backoff, the dedupe window - is read from: the host's
   * one clock (the ticker's, `docs/architecture.md` §17).
   */
  private readonly now: () => number;
  /** The spacing between delivery attempts: `INBOX_GRACE_MS` unless a development run shortens it. */
  private readonly graceMs: number;

  constructor(
    private readonly db: AppDatabase,
    options: { now?: () => number; graceMs?: number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.graceMs = options.graceMs ?? INBOX_GRACE_MS;
  }

  /**
   * Durably record one message. The row IS the delivery; returns its id.
   * Always inserts: steers, briefs and job results are the captain's or the
   * crewmate's own acts, and their callers hold the returned id. A message
   * for the firstmate or supervision lane names its `origin`.
   */
  enqueue(recipient: string, body: WakeBody, ref?: string, origin?: ServedOrigin): number {
    this.changed();
    const info = this.db
      .prepare(
        "INSERT INTO inbox (recipient, payload, created_at, ref, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        recipient,
        encodeWake(body),
        this.now(),
        ref ?? null,
        wakeIdentity(body, origin ?? null),
        origin ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * A host steer on a task lane that goes out once per fact (the check
   * watch's, `orchestrator/checkWatch.ts`): the row and its once-name, about
   * the task, in one transaction. It always inserts, as a steer does; the
   * emitter reads `woken` before it steers, so the name keeps a restart
   * between the steer and the emitter's own bookkeeping from sending it
   * twice.
   */
  enqueueSteerOnce(taskId: string, body: TypedWake & { once: string }): number {
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO inbox_once (ref, once_key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(taskId, body.once, this.now());
      return this.enqueue(taskId, body);
    });
  }

  /**
   * Record a wake unless it repeats the lane's last one (WI-3): the same
   * content (`wakeIdentity`) as the newest row on this recipient with this
   * ref, or as the newest acked row there when that ack is newer and inside
   * `INBOX_DEDUPE_WINDOW_MS` - or unless it names a `once` already recorded
   * for its ref, which it records otherwise. Returns the new row's id, or
   * null when the wake carried nothing new and nothing was recorded.
   */
  enqueueWake(
    recipient: string,
    body: WakeBody,
    origin: ServedWakeOrigin,
    ref?: string,
  ): number | null {
    const hash = wakeIdentity(body, origin);
    const once = typeof body === "string" ? undefined : body.once;
    return this.transaction(() => {
      const now = this.now();
      if (
        once !== undefined &&
        this.db
          .prepare(
            "INSERT INTO inbox_once (ref, once_key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .run(ref ?? "", once, now).changes === 0
      ) {
        return null;
      }
      const live = this.db
        .prepare(
          "SELECT id, content_hash FROM inbox WHERE recipient = ? AND ref IS ? ORDER BY id DESC LIMIT 1",
        )
        .get(recipient, ref ?? null) as { id: number; content_hash: string | null } | undefined;
      const acked = this.db
        .prepare(
          "SELECT row_id, content_hash, acked_at FROM inbox_acks WHERE recipient = ? AND ref = ?",
        )
        .get(recipient, ref ?? "") as
        | { row_id: number; content_hash: string; acked_at: number }
        | undefined;
      const repeats =
        acked && (!live || acked.row_id > live.id)
          ? acked.content_hash === hash && now - acked.acked_at <= INBOX_DEDUPE_WINDOW_MS
          : live?.content_hash === hash;
      if (repeats) return null;
      return this.enqueue(recipient, body, ref, origin);
    });
  }

  /**
   * Whether a wake named `once` about `ref` was already queued: what an
   * emitter reads before the side effects of building it again.
   */
  woken(ref: string, once: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM inbox_once WHERE ref = ? AND once_key = ?").get(ref, once) !==
      undefined
    );
  }

  /**
   * The names recorded about `ref` that start with `prefix`: the facts a
   * wake already went out once for, for an emitter that must say later
   * that such a fact ended - across a restart, when no memory holds it.
   */
  wokenNames(ref: string, prefix: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT once_key FROM inbox_once WHERE ref = ? AND substr(once_key, 1, length(?)) = ? ORDER BY at, once_key",
      )
      .all(ref, prefix, prefix) as { once_key: string }[];
    return rows.map((row) => row.once_key);
  }

  /**
   * Move rows to another lane, resetting their ladder: the supervision
   * fallback (design B) - a broken supervision session's pending wakes
   * become ordinary firstmate ops with one UPDATE, today's behavior, never
   * a lost event. Returns how many moved.
   */
  reassign(ids: number[], recipient: string): number {
    this.changed();
    if (ids.length === 0) return 0;
    return this.db
      .prepare(
        `UPDATE inbox SET recipient = ?, attempts = 0, last_attempt_at = NULL, escalated_at = NULL, delivered_at = NULL,
           failures = 0, failing_since = NULL, next_attempt_at = NULL, cuts = 0
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(recipient, ...ids).changes;
  }

  /**
   * Rows due a delivery attempt, oldest first: pending (not in-flight, not
   * escalated) and past their `next_attempt_at` - a fresh row is due
   * immediately, a released one waits out the grace or its backoff.
   * `maxAttempts` (task lanes) additionally excludes rows whose ladder
   * budget is spent; the firstmate lane omits it and retries forever at
   * the grace cadence.
   */
  pending(
    recipient: string,
    now = this.now(),
    options: { maxAttempts?: number; limit?: number } = {},
  ): InboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ${options.maxAttempts !== undefined ? "AND attempts < ?" : ""}
         ORDER BY id LIMIT ?`,
      )
      .all(
        recipient,
        now,
        ...(options.maxAttempts !== undefined ? [options.maxAttempts] : []),
        options.limit ?? 50,
      ) as Row[];
    return rows.map(fromRow);
  }

  /**
   * A delivery attempt begins: in-flight, attempts+1, and the grace clock
   * resets - a row a dead process left in flight is due again one grace
   * after this attempt began.
   */
  markDelivered(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    const now = this.now();
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = ?, attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(now, now, now + this.graceMs, ...ids);
  }

  /** Retire obsolete typed requests; prose and unrelated work retain their delivery. */
  retireTypedWakes(
    recipient: string,
    kinds: readonly NonNullable<WakeEnvelope["facts"]>["kind"][],
  ): number {
    const ids = this.allFor(recipient)
      .filter((row) => row.facts && kinds.includes(row.facts.kind))
      .map((row) => row.id);
    this.ack(ids);
    return ids.length;
  }

  /**
   * Handled: the consuming turn ended without error. The ack is deletion;
   * the newest acked content per lane and ref is remembered for the dedupe
   * window (WI-3), and memories past it are dropped.
   */
  ack(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    const now = this.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO inbox_acks (recipient, ref, row_id, content_hash, acked_at)
           SELECT recipient, COALESCE(ref, ''), id, content_hash, ? FROM inbox
           WHERE id IN (${placeholders(ids)}) AND content_hash IS NOT NULL ORDER BY id
           ON CONFLICT (recipient, ref) DO UPDATE SET
             row_id = excluded.row_id, content_hash = excluded.content_hash, acked_at = excluded.acked_at
           WHERE excluded.row_id > inbox_acks.row_id`,
        )
        .run(now, ...ids);
      this.db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders(ids)})`).run(...ids);
      this.db
        .prepare("DELETE FROM inbox_acks WHERE acked_at < ?")
        .run(now - INBOX_DEDUPE_WINDOW_MS);
    });
  }

  /**
   * The delivery was refused - a steer or a resume that threw, a turn that
   * failed for a reason the ladder was built for: back to pending, due one
   * grace after the attempt began, and the attempt stays spent.
   */
  release(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, next_attempt_at = COALESCE(last_attempt_at, ?) + ?
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(this.now(), this.graceMs, ...ids);
  }

  /**
   * A steer the session accepted but no turn took in (it landed in the
   * turn's own tail): back to pending and due now, with the attempt it was
   * marked with given back - the delivery never happened, so it neither
   * waits out a grace nor spends the ladder's budget.
   */
  reparkUndelivered(ids: number[]): void {
    this.changed();
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), next_attempt_at = NULL
         WHERE id IN (${placeholders(ids)})`,
      )
      .run(...ids);
  }

  /**
   * The turn failed at the provider (the honest retry): back to pending
   * WITHOUT spending the attempt, one more failure counted, and due after
   * the backoff for that count - or at `notBefore` when that is later: a
   * spent allowance is not asked again before it resets (the cut-off
   * contract). Returns the highest failure count among the rows, after
   * this one.
   */
  releaseAfterProviderFailure(ids: number[], options: { notBefore?: number } = {}): number {
    this.changed();
    if (ids.length === 0) return 0;
    const now = this.now();
    const notBefore = options.notBefore ?? 0;
    return this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id, failures FROM inbox WHERE id IN (${placeholders(ids)})`)
        .all(...ids) as { id: number; failures: number }[];
      const update = this.db.prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), failures = ?,
           failing_since = COALESCE(failing_since, ?), next_attempt_at = ?
         WHERE id = ?`,
      );
      let highest = 0;
      for (const row of rows) {
        const failures = row.failures + 1;
        update.run(failures, now, Math.max(now + inboxBackoffMs(failures), notBefore), row.id);
        highest = Math.max(highest, failures);
      }
      return highest;
    });
  }

  /**
   * A lane's provider outage, read from its rows: the most failures any
   * waiting row has met and when the earliest of them first failed. Zero
   * failures means the lane is not in an outage.
   */
  outage(recipient: string): { failures: number; since: number | null } {
    const row = this.db
      .prepare(
        `SELECT MAX(failures) AS failures, MIN(failing_since) AS since FROM inbox
         WHERE recipient = ? AND escalated_at IS NULL AND failures > 0`,
      )
      .get(recipient) as { failures: number | null; since: number | null };
    return { failures: row.failures ?? 0, since: row.since };
  }

  /**
   * The provider answered on this lane: its outage is over, so every row
   * still backing off is due now, with its failures cleared.
   */
  endOutage(recipient: string): void {
    this.changed();
    this.db
      .prepare(
        `UPDATE inbox SET failures = 0, failing_since = NULL, next_attempt_at = NULL
         WHERE recipient = ? AND failures > 0 AND delivered_at IS NULL`,
      )
      .run(recipient);
  }

  /**
   * Whether the lane holds guidance that will still be delivered: not in
   * flight, not set aside, budget not spent - due now or waiting out its
   * grace or backoff. The idle ladder's "moving" witness.
   */
  hasDeliverable(recipient: string, maxAttempts: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM inbox
           WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND attempts < ?
           LIMIT 1`,
        )
        .get(recipient, maxAttempts) !== undefined
    );
  }

  /**
   * Whether a row about `ref` still waits on the recipient's lane - due or
   * backing off, not yet handed to a turn and not set aside: what the idle
   * ladder reads before it counts a wake to the Firstmate as ignored.
   */
  holdsUndelivered(recipient: string, ref: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM inbox
           WHERE recipient = ? AND ref = ? AND delivered_at IS NULL AND escalated_at IS NULL
           LIMIT 1`,
        )
        .get(recipient, ref) !== undefined
    );
  }

  /**
   * Boot sweep: rows a dead process left in-flight go back to pending and
   * re-deliver (at-least-once). A quit or crash cut the turn serving them,
   * which is not the crewmate refusing them: each is given its attempt back
   * and counts one more cut, so the replay says it follows a restart and
   * repeated quits inside one long turn never set it aside. It stays due one
   * grace after its attempt began. Returns how many were reset. The lanes in
   * `keep` stay as they are: their turn went on without this process, on a
   * computer that runs work, which says where it is once it is back.
   */
  resetInFlight(keep: readonly string[] = []): number {
    this.changed();
    const kept = keep.length > 0 ? ` AND recipient NOT IN (${placeholders(keep)})` : "";
    return this.db
      .prepare(
        `UPDATE inbox SET delivered_at = NULL, attempts = MAX(attempts - 1, 0), cuts = cuts + 1
         WHERE delivered_at IS NOT NULL${kept}`,
      )
      .run(...keep).changes;
  }

  /** Pending task-lane rows whose attempt budget is spent, not yet escalated. */
  spent(recipient: string, maxAttempts: number): InboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox
         WHERE recipient = ? AND delivered_at IS NULL AND escalated_at IS NULL AND attempts >= ?
         ORDER BY id`,
      )
      .all(recipient, maxAttempts) as Row[];
    return rows.map(fromRow);
  }

  /** One row by its id, in flight or not; undefined once it was acknowledged or removed. */
  get(id: number): InboxRow | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * The sender takes back messages no turn was handed yet: rows that are
   * not in flight are deleted, and their ids answered. A row a turn holds
   * stays, to be acknowledged or released as usual (docs/inbox.md,
   * "Taking back a message").
   */
  withdraw(ids: readonly number[]): number[] {
    if (ids.length === 0) return [];
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM inbox WHERE id IN (${placeholders(ids)}) AND delivered_at IS NULL ORDER BY id`,
        )
        .all(...ids) as { id: number }[];
      const taken = rows.map((row) => row.id);
      if (taken.length > 0) {
        this.changed();
        this.db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders(taken)})`).run(...taken);
      }
      return taken;
    });
  }

  /**
   * The sender rewrites a message no turn was handed yet: the row keeps its
   * id, place, attempts and backoff, and carries `body` from now on. False
   * when the row is in flight or gone, which changes nothing (docs/inbox.md,
   * "Taking back a message").
   */
  revise(id: number, body: WakeBody): boolean {
    const row = this.db
      .prepare("SELECT origin FROM inbox WHERE id = ? AND delivered_at IS NULL")
      .get(id) as { origin: string | null } | undefined;
    if (!row) return false;
    this.changed();
    this.db
      .prepare(
        "UPDATE inbox SET payload = ?, content_hash = ? WHERE id = ? AND delivered_at IS NULL",
      )
      .run(encodeWake(body), wakeIdentity(body, originOf(row.origin)), id);
    return true;
  }

  /** Ladder spent: surfaced loudly once; excluded from retries thereafter. */
  markEscalated(id: number): void {
    this.changed();
    this.db.prepare("UPDATE inbox SET escalated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Every not-in-flight row for a recipient (pending + escalated), oldest first. */
  allFor(recipient: string): InboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE recipient = ? AND delivered_at IS NULL ORDER BY id")
      .all(recipient) as Row[];
    return rows.map(fromRow);
  }

  /** The rows a live session holds for a recipient, awaiting their ack, oldest first. */
  inFlight(recipient: string): InboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM inbox WHERE recipient = ? AND delivered_at IS NOT NULL ORDER BY id")
      .all(recipient) as Row[];
    return rows.map(fromRow);
  }

  /** Recipients holding undelivered rows - what the tick sweep visits. */
  recipientsWithRows(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT recipient FROM inbox WHERE delivered_at IS NULL")
      .all() as { recipient: string }[];
    return rows.map((row) => row.recipient);
  }

  /** Teardown or reset: the lane's rows go with their owner. */
  deleteFor(recipient: string): void {
    this.changed();
    this.transaction(() => {
      this.db.prepare("DELETE FROM inbox WHERE recipient = ?").run(recipient);
      this.db.prepare("DELETE FROM inbox_acks WHERE recipient = ?").run(recipient);
      this.db.prepare("DELETE FROM inbox_once WHERE ref = ?").run(recipient);
    });
  }

  /**
   * A task closed (interaction P0, WI-2): its own lane goes, and so does
   * every wake still queued ABOUT it on the supervision and firstmate lanes
   * (`ref` names the task) - in-flight rows included, whose later ack or
   * release then touches nothing. Nothing from a dead task is triaged or
   * reaches the Firstmate. Callers run it inside the close's transaction.
   * Returns how many rows went.
   */
  purgeTask(taskId: string): number {
    this.changed();
    this.db.prepare("DELETE FROM inbox_acks WHERE recipient = ? OR ref = ?").run(taskId, taskId);
    this.db.prepare("DELETE FROM inbox_once WHERE ref = ?").run(taskId);
    return this.db
      .prepare("DELETE FROM inbox WHERE recipient = ? OR (ref = ? AND recipient IN (?, ?))")
      .run(taskId, taskId, SUPERVISION_RECIPIENT, FIRSTMATE_RECIPIENT).changes;
  }

  /** One transaction over the inbox and whatever else shares its database. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
