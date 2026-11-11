import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect } from "vitest";
import { type PlannedStatement, planners, planStatement, unexplainedWalks } from "./statementPlans";
import { ONE_TIME_CALLERS } from "./statementWalks";

// The statement check (INF-2061, direction B's statement check): every SQL
// statement the app's own code prepares while a test file runs is planned
// against a freshly migrated database once the file ends, and the file fails
// on a whole-table walk or temporary sort of a growing table that the
// walks ledger (statementWalks.ts) does not explain. Five main thread
// freezes were synchronous SQLite whose cost grew with the saved record
// while the tests used a few rows; the plan is what grows, so the plan is
// what this reads (docs/testing.md, "The statement check").

type Census = {
  /** SQL text -> where the app prepared it, for the file now running. */
  file: Map<string, string>;
  /** SQL text -> its plan, kept for the worker's life. */
  plans: Map<string, PlannedStatement | null>;
  /** A call path's unmapped frames -> its `appOrigin`, kept for the worker's life. */
  origins: Map<string, string | undefined>;
  planning: boolean;
};

const CENSUS = Symbol.for("infinitary.statementCensus");
const holder = globalThis as unknown as { [CENSUS]?: Census };
const census: Census = holder[CENSUS] ?? {
  file: new Map(),
  plans: new Map(),
  origins: new Map(),
  planning: false,
};
if (!holder[CENSUS]) {
  holder[CENSUS] = census;
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database.Database, source: string) {
    // The first origin of a statement is the one kept, so a statement this
    // file already recorded costs nothing more.
    if (!census.planning && !census.file.has(source)) {
      const path = callPath();
      if (!census.origins.has(path)) census.origins.set(path, appOrigin());
      const origin = census.origins.get(path);
      if (origin) census.file.set(source, origin);
    }
    return prepare.call(this, source);
  } as typeof prepare;
}
census.file = new Map();

/** The statements the app prepared in the file now running, with where it prepared each. */
export function recordedStatements(): ReadonlyMap<string, string> {
  return census.file;
}

/**
 * Runs a fixture's bulk seeding without recording what it prepares. Reading
 * each prepare's caller costs a stack trace, and a fixture that seeds a
 * record of the captain's size through the app's writers prepares hundreds
 * of thousands of times; those writers' statements are recorded and planned
 * by the files that test them (`tests/scale-check.test.ts`).
 */
export function outsideCensus<T>(work: () => T): T {
  const planning = census.planning;
  census.planning = true;
  try {
    return work();
  } finally {
    census.planning = planning;
  }
}

/** A stack line: its caller, file and line. */
const FRAME = /^at (?:(\S+) \()?((?:file:\/\/)?\/[^()]+?):(\d+):\d+\)?$/;

/** The stack lines an origin reads. */
const FRAMES = 40;

/**
 * Whether the walk up the stack passes over a file (a package, or this
 * check), reads it as the app's own code, or ends there (a test or a helper).
 */
function frameKind(path: string): "pass" | "app" | "end" {
  if (path.includes("/node_modules/") || path.includes("/tests/helpers/statement")) return "pass";
  return path.lastIndexOf("/src/") < 0 || /\.test\.tsx?$/.test(path) ? "end" : "app";
}

/**
 * The stack lines `appOrigin` decides by, as the engine holds them before
 * the module runner maps each to its source: up to the first that ends its
 * walk. A migrated record makes thousands of prepares, and mapping each
 * one's stack would cost a database-backed test most of its time
 * (INF-3596). Unmapped lines map the same way each time, so a call path is
 * mapped once.
 */
function callPath(): string {
  const limit = Error.stackTraceLimit;
  const format = Error.prepareStackTrace;
  Error.stackTraceLimit = FRAMES;
  Error.prepareStackTrace = (_error, sites) => sites;
  try {
    const held: { stack?: NodeJS.CallSite[] } = {};
    Error.captureStackTrace(held, callPath);
    const lines: string[] = [];
    for (const site of held.stack ?? []) {
      const line = `at ${site}`;
      lines.push(line);
      const at = FRAME.exec(line);
      if (at && frameKind(at[2] ?? "") === "end") break;
    }
    return lines.join("\n");
  } finally {
    Error.prepareStackTrace = format;
    Error.stackTraceLimit = limit;
  }
}

/**
 * The first caller outside better-sqlite3 and this file, when it is the
 * app's own code: a test's own statements, and a helper's, are not the app's.
 * A statement prepared under one of ONE_TIME_CALLERS runs once per saved
 * record, never again as the record grows, so it is not the app's either.
 */
function appOrigin(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = FRAMES;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  let origin: string | undefined;
  for (const line of stack.split("\n").slice(1)) {
    const at = FRAME.exec(line.trim());
    if (!at) continue;
    const [, caller, path = "", lineNumber] = at;
    const kind = frameKind(path);
    if (kind === "pass") continue;
    if (kind === "end") return origin;
    const file = path.slice(path.lastIndexOf("/src/") + 1);
    // A call through a module's exports names the function `Module.<name>`.
    const name = caller?.replace(/^Module\./, "");
    if (`${file} ${name}` in ONE_TIME_CALLERS) return undefined;
    // The shared compiler is never where a statement is written.
    if (file !== "src/core/storage/statements.ts") origin ??= `${file}:${lineNumber}`;
  }
  return origin;
}

afterAll(() => {
  const seen = census.file;
  census.file = new Map();
  census.planning = true;
  const planned: PlannedStatement[] = [];
  try {
    for (const [sql, origin] of seen) {
      if (!census.plans.has(sql)) census.plans.set(sql, planStatement(planners(), sql));
      const plan = census.plans.get(sql);
      if (plan) planned.push({ ...plan, origin });
    }
  } finally {
    census.planning = false;
  }
  const dump = process.env.INFINITARY_STATEMENT_CENSUS;
  if (dump) {
    const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(join(dump, name), JSON.stringify(planned));
  }
  expect(
    unexplainedWalks(planned),
    "the app prepared a statement that walks or sorts a growing table: give it an index, or explain it in tests/helpers/statementWalks.ts",
  ).toEqual([]);
});
