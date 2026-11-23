import { constants, DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlAnswer, SqlParam, SqlRefusal, SqlValue } from "@shared/personal/contracts";
import { isPublishedView, SQL_LIMITS, type SqlRequest, sqlRefusal } from "@shared/sql";
import { registerViewFunctions } from "../storage/views";

/**
 * The query engine behind the `sql` read (plugin data surface, Phase B). It
 * runs in its own process (./sqlProcess.ts) - never on the core's thread,
 * never on the core's connection - and is the only code that opens the
 * database file for a plugin.
 *
 * A plugin can never write, ATTACH, or reach a table. Three layers say so:
 *
 * 1. The connection is read-only: opened `readOnly` with `PRAGMA
 *    query_only`, no extension loading, the defensive flag on.
 * 2. NAMES are proven before anything runs. The query is first compiled on
 *    a scratch in-memory database whose only tables are the views the plugin
 *    declared, as empty tables with the same columns, under an authorizer
 *    that admits SELECT, functions, recursion and reads of those names (and
 *    the JSON table functions) and nothing else. SQLite's own resolver is
 *    the allowlist: a statement that compiles there can name nothing but a
 *    declared view, a CTE of its own, or `json_each`. This is why no view is
 *    trusted by the authorizer's "innermost view" argument - a CTE of the
 *    query's own can carry any name, a published view's included, and on
 *    the real connection it would read raw tables under that name.
 * 3. On the real connection an authorizer admits only read actions and no
 *    `sqlite_*` table, whatever the scratch pass let through.
 *
 * Caps: at most SQL_LIMITS.rows rows and SQL_LIMITS.resultBytes of JSON,
 * cut at a whole row with `truncated`; the time cap is the process owner's
 * (./sqlService.ts kills the process, because nothing can interrupt one
 * native SQLite step from JavaScript).
 *
 * Liveness: an answer is kept per (views, sql, params) until `PRAGMA
 * data_version` moves - i.e. until any other connection commits - so the
 * re-read a subscriber's host runs after every app event costs a pragma
 * when nothing changed.
 */

const JSON_TABLE_FUNCTIONS: ReadonlySet<string> = new Set(["json_each", "json_tree"]);

/** Actions a read may compile to; everything else is a write or a schema change. */
const READ_ACTIONS: ReadonlySet<number> = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

const CACHE_ENTRIES = 64;

const NOT_READONLY = sqlRefusal("sql_not_readonly", "only a read (one SELECT) is run");
const SCRATCH_ENTRIES = 16;

type Denial = { kind: "write" } | { kind: "undeclared"; name: string };

type Scratch = { db: DatabaseSync; declared: ReadonlySet<string> };

export class SqlEngine {
  private readonly db: DatabaseSync;
  /** While true the real connection's authorizer admits the engine's own statements. */
  private internal = true;
  private denial: Denial | null = null;
  private dataVersion: number | null = null;
  private readonly answers = new Map<string, SqlAnswer>();
  private readonly scratches = new Map<string, Scratch>();
  private readonly columnsOf = new Map<string, string[]>();
  private readonly now: () => number;

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      defensive: true,
    });
    this.db.exec("PRAGMA query_only = ON");
    registerViewFunctions(this.db);
    this.db.setAuthorizer((action, table) => {
      if (this.internal) return constants.SQLITE_OK;
      if (!READ_ACTIONS.has(action)) {
        this.denial ??= { kind: "write" };
        return constants.SQLITE_DENY;
      }
      if (action === constants.SQLITE_READ && table?.toLowerCase().startsWith("sqlite_")) {
        this.denial ??= { kind: "undeclared", name: table };
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
  }

  close(): void {
    for (const scratch of this.scratches.values()) scratch.db.close();
    this.scratches.clear();
    this.db.close();
  }

  query(request: SqlRequest): SqlAnswer {
    const declared = [...new Set(request.views)].sort();
    const params = request.params ?? [];
    const version = this.pragmaDataVersion();
    if (version !== this.dataVersion) {
      this.dataVersion = version;
      this.answers.clear();
    }
    const key = JSON.stringify([declared, request.sql, params]);
    const kept = this.answers.get(key);
    if (kept) return kept;
    const answer = this.run(request.sql, params, declared);
    if (this.answers.size >= CACHE_ENTRIES) {
      const oldest = this.answers.keys().next().value;
      if (oldest !== undefined) this.answers.delete(oldest);
    }
    this.answers.set(key, answer);
    return answer;
  }

  private pragmaDataVersion(): number {
    this.internal = true;
    const row = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }

  private run(sql: string, params: SqlParam[], declared: string[]): SqlAnswer {
    const started = this.now();
    const proof = this.prove(sql, declared);
    if (proof) return proof;

    // Armed from compile through the last row: SQLite re-compiles a
    // statement mid-step when the schema moved, and asks again when it does.
    this.internal = false;
    this.denial = null;
    try {
      return this.execute(sql, params, declared, started);
    } finally {
      this.internal = true;
    }
  }

  private execute(sql: string, params: SqlParam[], declared: string[], started: number): SqlAnswer {
    let statement: StatementSync;
    try {
      statement = this.db.prepare(sql);
    } catch (error) {
      return this.refusalFor(error, declared);
    }

    const columns = statement.columns().map((column) => column.name);
    if (columns.length === 0) return NOT_READONLY;
    const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
    if (duplicate !== undefined) {
      return sqlRefusal(
        "sql_invalid",
        `two columns are named "${duplicate}"; give one of them its own name with AS`,
      );
    }

    const rows: Record<string, SqlValue>[] = [];
    let bytes = 2;
    let truncated = false;
    try {
      for (const raw of statement.iterate(...params)) {
        if (rows.length === SQL_LIMITS.rows) {
          truncated = true;
          break;
        }
        const row: Record<string, SqlValue> = {};
        for (const column of columns) {
          const value = (raw as Record<string, unknown>)[column];
          if (value === null || typeof value === "string" || typeof value === "number") {
            row[column] = value;
          } else if (typeof value === "bigint") {
            row[column] = Number(value);
          } else {
            return sqlRefusal(
              "sql_invalid",
              `the column "${column}" holds binary data; select text or numbers`,
            );
          }
        }
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes + size > SQL_LIMITS.resultBytes) {
          if (rows.length === 0) {
            return sqlRefusal(
              "sql_too_large",
              `one row is over ${SQL_LIMITS.resultBytes / 1024} KB; select fewer or shorter columns`,
            );
          }
          truncated = true;
          break;
        }
        bytes += size;
        rows.push(row);
      }
    } catch (error) {
      return sqlRefusal("sql_invalid", messageOf(error));
    }
    return { columns, rows, truncated, elapsedMs: roundMs(this.now() - started) };
  }

  /**
   * Compiles the query on the scratch schema of the declared views, so
   * SQLite's resolver itself proves which names it reaches. Null means it
   * may run; otherwise the refusal.
   */
  private prove(sql: string, declared: string[]): SqlRefusal | null {
    const scratch = this.scratchFor(declared);
    this.denial = null;
    try {
      // A read answers with columns. A statement with none - VACUUM is one,
      // and it never meets the authorizer - is not a read, whatever it is.
      if (scratch.db.prepare(sql).columns().length === 0) return NOT_READONLY;
    } catch (error) {
      return this.refusalFor(error, declared);
    }
    return null;
  }

  private refusalFor(error: unknown, declared: string[]): SqlRefusal {
    const denial = this.denial;
    this.denial = null;
    const named = declared.length > 0 ? declared.join(", ") : "none";
    if (denial?.kind === "write") return NOT_READONLY;
    const missing = denial?.kind === "undeclared" ? denial.name : noSuchTable(error);
    if (missing !== null) {
      return sqlRefusal(
        "sql_view_not_declared",
        `the query reads "${missing}", which the manifest's sql does not name (it names: ${named})`,
      );
    }
    return sqlRefusal("sql_invalid", messageOf(error));
  }

  private scratchFor(declared: string[]): Scratch {
    const published = declared.filter((name) => isPublishedView(name) && this.viewColumns(name));
    const key = published.join(",");
    const kept = this.scratches.get(key);
    if (kept) {
      this.scratches.delete(key);
      this.scratches.set(key, kept);
      return kept;
    }
    const db = new DatabaseSync(":memory:", { allowExtension: false, defensive: true });
    registerViewFunctions(db);
    for (const name of published) {
      const columns = (this.viewColumns(name) ?? []).map(quoted).join(", ");
      db.exec(`CREATE TABLE ${quoted(name)} (${columns})`);
    }
    const allowed: ReadonlySet<string> = new Set(published);
    db.setAuthorizer((action, table, _column, database) => {
      if (action === constants.SQLITE_READ) {
        // A read with no schema is of the query's own CTE (`count(*)` over
        // one reports it); a table always belongs to a schema.
        if (database === null) return constants.SQLITE_OK;
        if (table !== null && (allowed.has(table) || JSON_TABLE_FUNCTIONS.has(table))) {
          return constants.SQLITE_OK;
        }
        this.denial ??= { kind: "undeclared", name: table ?? "?" };
        return constants.SQLITE_DENY;
      }
      if (READ_ACTIONS.has(action)) return constants.SQLITE_OK;
      this.denial ??= { kind: "write" };
      return constants.SQLITE_DENY;
    });
    const scratch = { db, declared: allowed };
    if (this.scratches.size >= SCRATCH_ENTRIES) {
      const [oldestKey, oldest] = this.scratches.entries().next().value ?? [];
      if (oldestKey !== undefined && oldest) {
        oldest.db.close();
        this.scratches.delete(oldestKey);
      }
    }
    this.scratches.set(key, scratch);
    return scratch;
  }

  private viewColumns(name: string): string[] | null {
    const kept = this.columnsOf.get(name);
    if (kept) return kept;
    this.internal = true;
    const exists = this.db
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'view' AND name = ?")
      .get(name);
    if (!exists) return null;
    const columns = this.db
      .prepare(`SELECT * FROM ${quoted(name)} LIMIT 0`)
      .columns()
      .map((column) => column.name);
    this.columnsOf.set(name, columns);
    return columns;
  }
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noSuchTable(error: unknown): string | null {
  const match = /no such table: (\S+)/.exec(messageOf(error));
  return match?.[1] ?? null;
}

function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
