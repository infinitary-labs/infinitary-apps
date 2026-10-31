import { CardStore } from "@core/storage/cardStore";
import { TaskEventStore } from "@core/storage/taskEventStore";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/database";
import {
  plannerFor,
  planners,
  planStatement,
  statementKey,
  unexplainedWalks,
} from "./helpers/statementPlans";
import { WALKS } from "./helpers/statementWalks";

// INF-2061, direction B's statement check (the captain: "figure out a good
// way to guard against any kind of main thread freeze in the future"): a
// statement the app prepares fails the run when it walks or sorts a growing
// table that the ledger does not explain. Its done line: it fails with
// INF-2060's task_events_ref index removed and passes on the record as
// migrated today.

/** The statements `read` prepares on `db`, in order. */
function preparedBy(db: Database.Database, read: () => unknown): string[] {
  const sql: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    sql.push(source);
    return prepare(source);
  }) as typeof db.prepare;
  try {
    read();
  } finally {
    delete (db as Partial<Pick<Database.Database, "prepare">>).prepare;
  }
  return sql;
}

describe("the statement check", () => {
  it("fails on the open-messages lookup once task_events_ref is gone, naming its walk", () => {
    const db = freshDatabase();
    try {
      db.exec("DROP INDEX task_events_ref");
      const sql = preparedBy(db, () => new TaskEventStore(db).taskIdsWithRef("ask", "m1"));
      const planned = sql.flatMap((statement) => planStatement([plannerFor(db)], statement) ?? []);
      expect(unexplainedWalks(planned)).toEqual([
        {
          sql: "SELECT DISTINCT task_id FROM task_events WHERE kind = ? AND ref = ?",
          walks: [expect.stringMatching(/^SCAN task_events\b/)],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("passes the same lookup on the record as migrated today", () => {
    const db = freshDatabase();
    try {
      const sql = preparedBy(db, () => new TaskEventStore(db).taskIdsWithRef("ask", "m1"));
      const planned = sql.flatMap((statement) => planStatement(planners(), statement) ?? []);
      expect(planned).toHaveLength(1);
      expect(unexplainedWalks(planned)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails on the card threads read into each turn once their time index is gone", () => {
    const db = freshDatabase();
    try {
      db.exec("DROP INDEX card_messages_at");
      const sql = preparedBy(db, () => new CardStore(db).threadSummaries(0, 8));
      const planned = sql.flatMap((statement) => planStatement([plannerFor(db)], statement) ?? []);
      expect(unexplainedWalks(planned).map((walk) => walk.walks)).toEqual([
        expect.arrayContaining([expect.stringMatching(/^SCAN card_messages\b/)]),
      ]);
    } finally {
      db.close();
    }
  });

  it("reads a walk through a published view's alias as a walk of the table under it", () => {
    // listDescendants walked every task through task_records' alias until
    // its join read the tree first; the plan names the alias, not the table.
    const planned = planStatement(planners(), "SELECT * FROM task_records WHERE title = ?");
    expect(planned?.walks).toEqual([expect.stringMatching(/^SCAN \w+$/)]);
  });

  it("keeps the ledger to walks the app still makes, so a fixed walk leaves it", () => {
    for (const [key, entry] of Object.entries(WALKS)) {
      expect(statementKey(key), "a ledger key is its statement with whitespace collapsed").toBe(
        key,
      );
      expect(entry.reason.trim(), key).not.toBe("");
      const planned = planStatement(planners(), key);
      expect(planned?.walks, key).toEqual(entry.walks);
    }
  });
});
