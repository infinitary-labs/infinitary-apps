import { readFileSync } from "node:fs";
import { CardStore } from "@core/storage/cardStore";
import { openInMemoryDatabase } from "@core/storage/db";
import { TaskEventStore } from "@core/storage/taskEventStore";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "./helpers/database";
import { recordedStatements } from "./helpers/statementCheck";
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

// INF-3596: the census read each prepare's caller from a stack the module
// runner mapped to its source, every time. A migrated record prepares about
// four thousand statements, and the tests that open one per case took most
// of the pull request check's 30 minutes on its two-processor machines.
describe("the statement census", () => {
  it("maps a call path to its source once, however often it prepares", () => {
    const open = () => openInMemoryDatabase().close();
    open();
    const format = Error.prepareStackTrace;
    let maps = 0;
    Error.prepareStackTrace = (error, sites) => {
      maps += 1;
      return format
        ? format(error, sites)
        : [String(error), ...sites.map((site) => `    at ${site}`)].join("\n");
    };
    try {
      open();
    } finally {
      Error.prepareStackTrace = format;
    }
    expect(maps).toBe(0);
  });

  it("names the line of the app's source that prepared a statement", () => {
    const sql = "SELECT COUNT(*) AS n FROM task_events WHERE kind = ? AND at > ?";
    const file = "src/core/storage/taskEventStore.ts";
    const line =
      readFileSync(file, "utf8")
        .split("\n")
        .findIndex((text) => text.includes(`.prepare("${sql}")`)) + 1;
    expect(line, `${file} prepares the lookup`).toBeGreaterThan(0);
    const db = freshDatabase();
    try {
      new TaskEventStore(db).countByKindSince("ask", 0);
    } finally {
      db.close();
    }
    expect(recordedStatements().get(sql)).toBe(`${file}:${line}`);
  });
});
