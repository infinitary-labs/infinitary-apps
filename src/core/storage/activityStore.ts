import type { FeedLine } from "@shared/feed";
import { saidSchema } from "@shared/i18n/said";
import type { AppDatabase } from "./db";

/**
 * The persisted activity feed (P10): the last RETAINED lines survive a
 * restart, so reopening the app shows what happened rather than an empty
 * feed. The retention purge (D-13) clears it with everything else.
 */

const RETAINED = 200;

/** A line's fact as saved beside its words (docs/i18n.md, "Saved facts"). */
function saidJson(line: Omit<FeedLine, "at">): string | null {
  return line.said ? JSON.stringify(line.said) : null;
}

/** A saved fact this version can read; any other is left out, and the line shows its words. */
function savedFact(json: string | null) {
  if (!json) return undefined;
  try {
    const parsed = saidSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class ActivityStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Writes a line and returns its row, for a settled run to rewrite. */
  record(line: Omit<FeedLine, "at">): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO activity_events (kind, text, said_json, at) VALUES (?, ?, ?, ?)")
      .run(line.kind, line.text, saidJson(line), this.now());
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
      .prepare("UPDATE activity_events SET kind = ?, text = ?, said_json = ?, at = ? WHERE id = ?")
      .run(line.kind, line.text, saidJson(line), this.now(), id);
  }

  /** A settled run that came back where it started leaves no line. */
  withdraw(id: number): void {
    this.db.prepare("DELETE FROM activity_events WHERE id = ?").run(id);
  }

  /** Oldest first, ready for the renderer's newest-at-the-bottom feed. */
  recent(limit = 20): FeedLine[] {
    const rows = this.db
      .prepare(
        "SELECT kind, text, said_json, at FROM (SELECT * FROM activity_events ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
      )
      .all(limit) as (Omit<FeedLine, "said"> & { said_json: string | null })[];
    return rows.map(({ said_json, ...line }) => {
      const said = savedFact(said_json);
      return said ? { ...line, said } : line;
    });
  }

  clear(): void {
    this.db.prepare("DELETE FROM activity_events").run();
  }
}
