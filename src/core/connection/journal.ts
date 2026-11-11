import { randomUUID } from "node:crypto";
import type { ConnectionCursor } from "@shared/connection";

/**
 * One numbered push, already written as the frame every client is sent, and
 * its channel, which a client reading another spelling gets respelled
 * (`pushFrameIn`, connection.ts).
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

  /** The newest push's number; 0 before the first. */
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
    if (cursor.epoch !== this.epoch || cursor.seq > this.head) return null;
    const oldest = this.kept[0]?.seq ?? this.head + 1;
    if (cursor.seq < oldest - 1) return null;
    return this.kept.filter((entry) => entry.seq > cursor.seq);
  }
}
