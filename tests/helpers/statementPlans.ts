import { type AppDatabase, openInMemoryDatabase } from "@core/storage/db";
import { KnowledgeStore } from "@core/storage/knowledgeStore";
import { createUsageDays } from "@core/storage/usageDays";
import { BOUNDED_TABLES, WALKS } from "./statementWalks";

/** A statement the app prepared, and the steps of its plan that read a growing table whole. */
export type PlannedStatement = {
  sql: string;
  /** Where the app prepared it (path:line), when the census saw it. */
  origin?: string;
  /** The plan's whole-table walks and temporary sorts of growing tables, in plan order. */
  walks: string[];
};

/** The unexplained statements of `planned`, each once, as the check reports them. */
export type UnexplainedWalk = {
  origin?: string;
  sql: string;
  walks: string[];
  ledgered?: string[];
};

export type Planner = { db: AppDatabase; growing: ReadonlySet<string>; viewSql: string };

let cached: Planner[] | undefined;

/**
 * Freshly migrated databases to plan against, one per schema the app keeps:
 * its own record and the knowledge collection.
 */
export function planners(): Planner[] {
  if (cached) return cached;
  const knowledge = KnowledgeStore.inMemory() as unknown as { db: AppDatabase };
  const record = openInMemoryDatabase();
  // The usage ledger's daily totals are made by their first read, not a
  // migration (usageDays.ts), so the planner makes them to plan their reads.
  createUsageDays(record);
  cached = [plannerFor(record), plannerFor(knowledge.db)];
  return cached;
}

/** A planner over `db`'s schema. A table is growing unless BOUNDED_TABLES names the code that trims it, so a new table starts growing. */
export function plannerFor(db: AppDatabase): Planner {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const views = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view'").all() as {
    sql: string;
  }[];
  return {
    db,
    growing: new Set(tables.map((t) => t.name).filter((name) => !(name in BOUNDED_TABLES))),
    viewSql: views.map((v) => v.sql).join("\n"),
  };
}

/**
 * The plan of `sql` on the first planner whose schema compiles it, reduced to
 * its walks; null when no current schema compiles it (a migration's statement
 * against an older schema, which runs once). Parameters bind as NULL: a plan
 * is chosen before any value is known.
 */
export function planStatement(from: Planner[], sql: string): PlannedStatement | null {
  for (const planner of from) {
    let explain: ReturnType<AppDatabase["prepare"]>;
    try {
      explain = planner.db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    } catch {
      continue;
    }
    const details = runWithNulls(explain, sql).map((row) => row.detail);
    return { sql, walks: walksOf(details, sql, planner) };
  }
  return null;
}

/** Every step of `sql`'s plan on `db`, its parameters bound as NULL; null when `db`'s schema does not compile it. */
export function planDetails(db: AppDatabase, sql: string): string[] | null {
  let explain: ReturnType<AppDatabase["prepare"]>;
  try {
    explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  } catch {
    return null;
  }
  return runWithNulls(explain, sql).map((row) => row.detail);
}

function runWithNulls(
  explain: ReturnType<AppDatabase["prepare"]>,
  sql: string,
): { detail: string }[] {
  const named = Object.fromEntries(namedParameters(sql).map((name) => [name, null]));
  const positional: null[] = [];
  for (;;) {
    try {
      const args: unknown[] = Object.keys(named).length > 0 ? [...positional, named] : positional;
      const all = explain.all.bind(explain) as (...params: unknown[]) => { detail: string }[];
      return all(...args);
    } catch (error) {
      if (!(error instanceof RangeError) || !/Too few parameter values/.test(error.message))
        throw error;
      positional.push(null);
    }
  }
}

/** The `:name`, `@name` and `$name` parameters outside strings, quoted names and comments. */
function namedParameters(sql: string): string[] {
  const bare = sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
    " ",
  );
  return [...new Set([...bare.matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ""))];
}

const NOT_ALIASES = new Set(
  "WHERE ON USING JOIN LEFT RIGHT INNER OUTER CROSS NATURAL FULL ORDER GROUP LIMIT SET VALUES SELECT UNION EXCEPT INTERSECT WINDOW HAVING INDEXED NOT AS".split(
    " ",
  ),
);

/** Each alias in `sql` and the tables it names: a plan names a table by its alias. */
function aliases(sql: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const m of sql.matchAll(
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi,
  )) {
    const [, table = "", alias] = m;
    if (alias && !NOT_ALIASES.has(alias.toUpperCase()))
      found.set(alias, new Set([...(found.get(alias) ?? []), table]));
  }
  return found;
}

/**
 * The steps of a plan that read a growing table whole: a SCAN of one, and a
 * temporary b-tree (a sort, grouping or distinct pass that SQLite builds
 * because no index gives the order) in a statement that walks one. A
 * temporary b-tree over the rows an index sought sorts only those rows.
 */
function walksOf(details: string[], sql: string, planner: Planner): string[] {
  // The statement's own aliases first; an alias two views share may name either table.
  const named = new Map([...aliases(planner.viewSql), ...aliases(sql)]);
  const walk = (detail: string) => {
    const name = /^SCAN (\S+)/.exec(detail)?.[1];
    // A virtual table (full-text search, json_each) is read through its own index.
    if (!name || detail.includes(" VIRTUAL TABLE")) return false;
    if (planner.growing.has(name)) return true;
    return [...(named.get(name) ?? [])].some((table) => planner.growing.has(table));
  };
  const walks = details.some(walk);
  return details.filter(
    (detail) => walk(detail) || (walks && detail.startsWith("USE TEMP B-TREE")),
  );
}

/** A statement's text with its whitespace collapsed, the ledger's key. */
export function statementKey(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * The statements whose walks the ledger does not name exactly: a new walk,
 * or a ledgered one the statement no longer makes, which shrinks the ledger.
 */
export function unexplainedWalks(planned: PlannedStatement[]): UnexplainedWalk[] {
  const unexplained = new Map<string, UnexplainedWalk>();
  for (const statement of planned) {
    const key = statementKey(statement.sql);
    const ledgered = WALKS[key]?.walks;
    const same =
      ledgered !== undefined &&
      ledgered.length === statement.walks.length &&
      ledgered.every((walk, index) => walk === statement.walks[index]);
    if (statement.walks.length === 0 && ledgered === undefined) continue;
    if (same) continue;
    if (!unexplained.has(key))
      unexplained.set(key, {
        ...(statement.origin ? { origin: statement.origin } : {}),
        sql: key,
        walks: statement.walks,
        ...(ledgered ? { ledgered } : {}),
      });
  }
  return [...unexplained.values()];
}
