import { createHash } from "node:crypto";
import type { RepetitionNotice, ToolObservation } from "@shared/toolCompletion";
import type { AppDatabase } from "./db";
import { prepared } from "./statements";

/** TaskService's indexed derived state. All writes share its task/inbox database. */
export const REPETITION_TABLES = `
  CREATE TABLE task_repetition_cursors (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, stream TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY (task_id, stream)
  );
  CREATE TABLE task_repetitions (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, operation TEXT NOT NULL, result TEXT NOT NULL,
    tool TEXT NOT NULL, count INTEGER NOT NULL,
    first_source TEXT NOT NULL, first_call TEXT NOT NULL, first_at REAL NOT NULL,
    latest_source TEXT NOT NULL, latest_call TEXT NOT NULL, latest_at REAL NOT NULL,
    notice TEXT,
    PRIMARY KEY (task_id, operation)
  );
`;

type Operation = {
  result: string;
  tool: string;
  count: number;
  first_source: string;
  first_call: string;
  first_at: number;
  latest_source: string;
  latest_call: string;
  latest_at: number;
  notice: string | null;
};

export class TaskRepetitionStore {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Position, one operation, notice identity and inbox enqueue commit together.
   * The callback must queue through the existing inbox, on this database.
   * Throwing before commit leaves the work computer's fact unacknowledged.
   */
  consume(task: string, event: ToolObservation, enqueue: (notice: RepetitionNotice) => void): void {
    this.db.transaction(() => {
      const last = prepared(
        this.db,
        "SELECT sequence FROM task_repetition_cursors WHERE task_id = ? AND stream = ?",
      ).get(task, event.stream) as { sequence: number } | undefined;
      if (event.sequence <= (last?.sequence ?? 0)) return;
      if (event.sequence !== (last?.sequence ?? 0) + 1)
        throw new Error("Completion source has an ordering gap");
      if (event.fact.kind === "guidance") {
        prepared(this.db, "DELETE FROM task_repetitions WHERE task_id = ?").run(task);
      } else {
        const fact = event.fact;
        const previous = prepared(
          this.db,
          "SELECT * FROM task_repetitions WHERE task_id = ? AND operation = ?",
        ).get(task, fact.operation) as Operation | undefined;
        const same = previous?.result === fact.result;
        const next: Operation = {
          result: fact.result,
          tool: fact.toolName,
          count: same ? previous.count + 1 : 1,
          first_source: same ? previous.first_source : event.source,
          first_call: same ? previous.first_call : fact.callId,
          first_at: same ? previous.first_at : event.at,
          latest_source: event.source,
          latest_call: fact.callId,
          latest_at: event.at,
          notice: same ? previous.notice : null,
        };
        // Captain's accepted INF-1996 choice: original plus two repeats.
        const notices = next.count === 3 && next.notice === null;
        if (notices)
          next.notice = `repetition:${createHash("sha256")
            .update(JSON.stringify([task, event.stream, event.sequence]))
            .digest("hex")}`;
        prepared(
          this.db,
          `INSERT INTO task_repetitions
          (task_id, operation, result, tool, count, first_source, first_call, first_at, latest_source, latest_call, latest_at, notice)
          VALUES (@task, @operation, @result, @tool, @count, @first_source, @first_call, @first_at, @latest_source, @latest_call, @latest_at, @notice)
          ON CONFLICT (task_id, operation) DO UPDATE SET
            result=excluded.result, tool=excluded.tool, count=excluded.count,
            first_source=excluded.first_source, first_call=excluded.first_call, first_at=excluded.first_at,
            latest_source=excluded.latest_source, latest_call=excluded.latest_call, latest_at=excluded.latest_at, notice=excluded.notice`,
        ).run({ task, operation: fact.operation, ...next });
        if (notices && next.notice)
          enqueue({
            identity: next.notice,
            toolName: next.tool,
            count: next.count,
            // The streak's results are identical, error flag included, so the
            // latest completion's flag is every one's.
            outcome: fact.failed === undefined ? "unknown" : fact.failed ? "failed" : "worked",
            first: { source: next.first_source, callId: next.first_call, at: next.first_at },
            latest: { source: next.latest_source, callId: next.latest_call, at: next.latest_at },
          });
      }
      prepared(
        this.db,
        `INSERT INTO task_repetition_cursors VALUES (?, ?, ?)
        ON CONFLICT (task_id, stream) DO UPDATE SET sequence = excluded.sequence`,
      ).run(task, event.stream, event.sequence);
    })();
  }
}
