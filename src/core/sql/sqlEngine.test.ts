import { join } from "node:path";
import type { SqlAnswer, SqlRows } from "@shared/personal/contracts";
import { SQL_LIMITS, type SqlRequest } from "@shared/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AppDatabase, openDatabase } from "../storage/db";
import { SqlEngine } from "./sqlEngine";

/**
 * The engine over a real database file, the way the query process opens it:
 * the core's own connection writes (better-sqlite3, WAL), the engine reads
 * through its own read-only one. Every refusal here is a query a plugin
 * could actually send.
 */

let dir: string;
let core: AppDatabase;
let engine: SqlEngine;

beforeEach(() => {
  dir = scratchDir("infinitary-sql-engine-");
  core = openDatabase(dir);
  const usage = core.prepare(
    "INSERT INTO usage_events (task_id, provider, model, input, output, at) VALUES (?, 'openai-codex', 'gpt-6-sol', ?, ?, ?)",
  );
  usage.run("firstmate", 100, 10, 1_000);
  usage.run("firstmate", 200, 20, 2_000);
  core
    .prepare(
      "INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at) VALUES ('c1', NULL, 'card', 1, 'Secret', '', 'the captain''s words', '[]', 'open', 1)",
    )
    .run();
  engine = new SqlEngine(join(dir, "firstmate.db"));
});

afterEach(() => {
  engine.close();
  core.close();
});

function ask(sql: string, views: string[] = ["v_usage_v1"], params?: SqlRequest["params"]) {
  return engine.query({ sql, views: views as SqlRequest["views"], ...(params ? { params } : {}) });
}

function rows(answer: SqlAnswer): SqlRows {
  if ("refused" in answer) throw new Error(`refused ${answer.refused}: ${answer.message}`);
  return answer;
}

function refusal(answer: SqlAnswer): string {
  return "refused" in answer ? answer.refused : "answered";
}

describe("the sql engine", () => {
  it("answers a query over a declared view with named columns and rows keyed by them", () => {
    const answer = rows(
      ask(
        "SELECT key, SUM(input + output) AS tokens, MAX(at) AS last_at FROM v_usage_v1 WHERE at > ? GROUP BY task_id",
        ["v_usage_v1"],
        [500],
      ),
    );
    expect(answer.columns).toEqual(["key", "tokens", "last_at"]);
    expect(answer.rows).toEqual([{ key: "FIRSTMATE", tokens: 330, last_at: 2_000 }]);
    expect(answer.truncated).toBe(false);
  });

  it("reaches only what the manifest declared, and never a table", () => {
    const blocked = [
      "SELECT * FROM cards",
      "SELECT * FROM main.cards",
      "SELECT * FROM usage_events",
      "SELECT * FROM sqlite_schema",
      "SELECT * FROM pragma_table_info('cards')",
      // A published view the manifest did not name.
      "SELECT * FROM v_tasks_v1",
      // A view of the query's own name reading a table: the shadow a
      // name-only authorizer would let through.
      "WITH v_usage_v1 AS (SELECT body AS key FROM cards) SELECT key FROM v_usage_v1",
      "WITH v_usage_v1 AS (SELECT body AS key FROM cards) SELECT u.key FROM v_usage_v1 u JOIN main.v_usage_v1 m",
      "SELECT key, (SELECT body FROM cards) AS leak FROM v_usage_v1",
    ];
    for (const sql of blocked) expect(refusal(ask(sql)), sql).toBe("sql_view_not_declared");
    const answer = ask("SELECT body FROM cards");
    expect("refused" in answer && answer.message).toContain('"cards"');
    // With no grant at all, nothing is reachable.
    expect(refusal(ask("SELECT * FROM v_usage_v1", []))).toBe("sql_view_not_declared");
  });

  it("runs reads and nothing else", () => {
    const writes = [
      "INSERT INTO v_usage_v1 (id) VALUES (1)",
      "DELETE FROM v_usage_v1",
      "UPDATE v_usage_v1 SET input = 0",
      "ATTACH DATABASE '/tmp/elsewhere.db' AS other",
      "PRAGMA writable_schema = ON",
      "PRAGMA data_version",
      "CREATE TEMP TABLE x (a)",
      "DROP VIEW v_usage_v1",
      "VACUUM INTO '/tmp/copy.db'",
      "BEGIN",
    ];
    for (const sql of writes) expect(refusal(ask(sql)), sql).toBe("sql_not_readonly");
    // The record is untouched.
    expect(core.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 2 });
  });

  it("allows the query's own shape: CTEs, recursion, JSON table functions", () => {
    const answer = rows(
      ask(
        `WITH RECURSIVE minutes(m) AS (SELECT 0 UNION ALL SELECT m + 1 FROM minutes WHERE m < 2),
              totals AS (SELECT SUM(input) AS input FROM v_usage_v1)
         SELECT m, input, (SELECT COUNT(*) FROM json_each('[1,2,3]')) AS three FROM minutes, totals`,
      ),
    );
    expect(answer.rows).toEqual([
      { m: 0, input: 300, three: 3 },
      { m: 1, input: 300, three: 3 },
      { m: 2, input: 300, three: 3 },
    ]);
    expect(
      rows(ask("WITH mine AS (SELECT input FROM v_usage_v1) SELECT COUNT(*) AS n FROM mine")).rows,
    ).toEqual([{ n: 2 }]);
  });

  it("says what is wrong with a query SQLite cannot run", () => {
    expect(refusal(ask("SELEC key FROM v_usage_v1"))).toBe("sql_invalid");
    expect(refusal(ask("SELECT nope FROM v_usage_v1"))).toBe("sql_invalid");
    expect(refusal(ask("SELECT load_extension('/tmp/x')"))).toBe("sql_invalid");
    expect(refusal(ask("SELECT key, key FROM v_usage_v1"))).toBe("sql_invalid");
    expect(refusal(ask("SELECT randomblob(4) AS b"))).toBe("sql_invalid");
  });

  it("cuts an answer at the row cap and says it did", () => {
    const answer = rows(
      ask(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 2500) SELECT i FROM n",
        [],
      ),
    );
    expect(answer.rows).toHaveLength(SQL_LIMITS.rows);
    expect(answer.rows.at(-1)).toEqual({ i: SQL_LIMITS.rows });
    expect(answer.truncated).toBe(true);
  });

  it("cuts an answer at the byte cap at a whole row, and refuses a row that cannot fit", () => {
    const answer = rows(
      ask(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 1000) SELECT i, printf('%.*c', 1000, 'x') AS pad FROM n",
        [],
      ),
    );
    expect(answer.truncated).toBe(true);
    expect(answer.rows.length).toBeGreaterThan(200);
    expect(answer.rows.length).toBeLessThan(1000);
    expect(Buffer.byteLength(JSON.stringify(answer.rows))).toBeLessThanOrEqual(
      SQL_LIMITS.resultBytes,
    );
    expect(refusal(ask("SELECT printf('%.*c', 300000, 'x') AS huge", []))).toBe("sql_too_large");
  });

  it("answers again from what it has until another connection commits", () => {
    const sql = "SELECT COUNT(*) AS n FROM v_usage_v1";
    const first = ask(sql);
    expect(rows(first).rows).toEqual([{ n: 2 }]);
    // Nothing moved: the same answer, not a re-run.
    expect(ask(sql)).toBe(first);
    core
      .prepare(
        "INSERT INTO usage_events (task_id, provider, model, input, output, at) VALUES ('firstmate', 'x', 'y', 1, 1, 3000)",
      )
      .run();
    const after = ask(sql);
    expect(after).not.toBe(first);
    expect(rows(after).rows).toEqual([{ n: 3 }]);
  });
});
