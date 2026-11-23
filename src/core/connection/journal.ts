import { randomUUID } from "node:crypto";
import { channelIn, type Spelling } from "@shared/codeNames";
import { type ConnectionCursor, REPLACED_PUSH_CHANNEL } from "@shared/connection";

/**
 * One numbered push, already written as the frame every client is sent, and
 * its channel, which a client reading another spelling gets respelled
 * (`pushFrameIn`).
 */
export type JournalEntry = {
  readonly seq: number;
  readonly channel: string;
  readonly frame: string;
};

export type JournalLimits = {
  /** The most pushes kept for catch-up. */
  entries: number;
  /** The most frame bytes kept for catch-up; the newest push is kept whenever any is. */
  bytes: number;
};

/**
 * Enough for a short drop - a sleeping lid, a network change - to catch up
 * push by push; a longer one reloads. Whole-board and whole-stack pushes are
 * the large ones, so the byte bound is the one that usually decides.
 */
export const DEFAULT_JOURNAL_LIMITS: JournalLimits = { entries: 4_096, bytes: 16 * 1024 * 1024 };

/**
 * The connection's numbering (docs/connection.md): every core push gets the
 * next `seq` in this journal's `epoch`, and the newest pushes are kept so a
 * device that dropped can be handed exactly what it missed. A cursor from
 * another epoch, or older than what is kept, cannot be caught up and is told
 * to reload.
 */
export class EventJournal {
  readonly epoch = randomUUID();
  private head = 0;
  private bytes = 0;
  private readonly kept: JournalEntry[] = [];

  constructor(private readonly limits: JournalLimits = DEFAULT_JOURNAL_LIMITS) {}

  get seq(): number {
    return this.head;
  }

  /**
   * Numbers one push and keeps it; `frameOf` writes the frame for that number,
   * on `channel`. With `keep` false the push is numbered and nothing is kept,
   * the earlier pushes included: a cursor behind it reloads, and one at it
   * still has nothing to catch up on.
   */
  record(frameOf: (seq: number) => string, channel = "", keep = true): JournalEntry {
    const entry = { seq: ++this.head, channel, frame: frameOf(this.head) };
    if (!keep) {
      this.kept.length = 0;
      this.bytes = 0;
      return entry;
    }
    this.kept.push(entry);
    this.bytes += Buffer.byteLength(entry.frame);
    while (
      this.kept.length > 1 &&
      (this.kept.length > this.limits.entries || this.bytes > this.limits.bytes)
    ) {
      const dropped = this.kept.shift();
      if (dropped) this.bytes -= Buffer.byteLength(dropped.frame);
    }
    return entry;
  }

  /**
   * The pushes after a cursor, in order, or null when that cursor cannot be
   * caught up: another epoch, ahead of this journal, or older than it keeps.
   */
  since(cursor: ConnectionCursor): JournalEntry[] | null {
    if (this.lost(cursor)) return null;
    return this.kept.filter((entry) => entry.seq > cursor.seq);
  }

  /**
   * Why a cursor cannot be caught up, or null when it can: it is from
   * another epoch (the home restarted or stopped listening), ahead of this
   * journal, or older than the pushes it keeps.
   */
  lost(cursor: ConnectionCursor): "another-epoch" | "ahead" | "older" | null {
    if (cursor.epoch !== this.epoch) return "another-epoch";
    if (cursor.seq > this.head) return "ahead";
    const oldest = this.kept[0]?.seq ?? this.head + 1;
    return cursor.seq < oldest - 1 ? "older" : null;
  }
}

/**
 * The pushes whose every one carries a whole list, each with the channels it
 * replaces: the card list replaces every earlier card list, and the whole
 * board every earlier board and every change to one. A replay sends only
 * what the newest of each leaves (docs/connection.md, "Catching up").
 */
export const WHOLE_LISTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["inf:cards", new Set(["inf:cards"])],
  ["inf:tasks", new Set(["inf:tasks", "inf:tasks:delta"])],
]);

/** One push of a replay, or the empty push standing in for a whole list a later one replaces. */
export type ReplayEntry = { readonly entry: JournalEntry; readonly replaced: boolean };

/** The empty push that stands in for a replaced whole list, numbered as it was. */
export function replacedFrame(seq: number, channel = REPLACED_PUSH_CHANNEL): string {
  return JSON.stringify({ t: "push", seq, channel, payload: null });
}

/**
 * What a replay of `missed` sends: each push in order, except one that a
 * later whole list in the replay replaces, which goes as an empty push under
 * its number.
 */
export function replayOf(missed: readonly JournalEntry[]): ReplayEntry[] {
  // The newest push of each whole list, and from it the newest whole list each channel is replaced by.
  const newest = new Map<string, number>();
  for (const entry of missed)
    if (WHOLE_LISTS.has(entry.channel)) newest.set(entry.channel, entry.seq);
  const replacedBefore = new Map<string, number>();
  for (const [whole, seq] of newest)
    for (const channel of WHOLE_LISTS.get(whole) ?? [])
      replacedBefore.set(channel, Math.max(seq, replacedBefore.get(channel) ?? 0));
  return missed.map((entry) => ({
    entry,
    replaced: entry.seq < (replacedBefore.get(entry.channel) ?? 0),
  }));
}

/** The bytes a replay sends, before any respelling or projection for one device. */
export function replayBytes(replay: readonly ReplayEntry[]): number {
  let total = 0;
  for (const { entry, replaced } of replay)
    total += Buffer.byteLength(replaced ? replacedFrame(entry.seq) : entry.frame);
  return total;
}

/**
 * A numbered push's frame with its channel in `spelling`; the rest is the
 * same bytes, so every device is still sent the same push under the same
 * number. A frame not written as the journal writes one goes as it is.
 */
export function pushFrameIn(entry: JournalEntry, spelling: Spelling): string {
  const channel = channelIn(entry.channel, spelling);
  if (channel === entry.channel) return entry.frame;
  const head = (name: string) => `{"t":"push","seq":${entry.seq},"channel":${JSON.stringify(name)}`;
  const was = head(entry.channel);
  return entry.frame.startsWith(was) ? head(channel) + entry.frame.slice(was.length) : entry.frame;
}
