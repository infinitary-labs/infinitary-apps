import type { FeedLine } from "@shared/feed";
import type { AppDatabase } from "./db";

/**
 * The persisted activity feed (P10): the last RETAINED lines survive a
 * restart, so reopening the app shows what happened rather than an empty
 * feed. The retention purge (D-13) clears it with everything else.
 */

const RETAINED = 200;

export class ActivityStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Writes a line and returns its row, for a settled run to rewrite. */
  record(line: Omit<FeedLine, "at">): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO activity_events (kind, text, at) VALUES (?, ?, ?)")
      .run(line.kind, line.text, this.now());
    this.db
      .prepare(
        "DELETE FROM activity_events WHERE id NOT IN (SELECT id FROM activity_events ORDER BY id DESC LIMIT ?)",
      )
      .run(RETAINED);
    return Number(lastInsertRowid);
  }

  /**
   * A settled run's later step (docs/orchestrator-contract.md, "Settled
   * runs"): the run's line, in its place, takes the step's words and time.
   */
  rewrite(id: number, line: Omit<FeedLine, "at">): void {
    this.db
      .prepare("UPDATE activity_events SET kind = ?, text = ?, at = ? WHERE id = ?")
      .run(line.kind, line.text, this.now(), id);
  }

  /** A settled run that came back where it started leaves no line. */
  withdraw(id: number): void {
    this.db.prepare("DELETE FROM activity_events WHERE id = ?").run(id);
  }

  /** Oldest first, ready for the renderer's newest-at-the-bottom feed. */
  recent(limit = 20): FeedLine[] {
    const rows = this.db
      .prepare(
        "SELECT kind, text, at FROM (SELECT * FROM activity_events ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
      )
      .all(limit) as FeedLine[];
    return rows;
  }

  clear(): void {
    this.db.prepare("DELETE FROM activity_events").run();
  }
}
