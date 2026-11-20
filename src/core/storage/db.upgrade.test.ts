import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import * as db from "./db";
import { type AppDatabase, assertSavedDataCompatible, DATABASE_VERSION, openDatabase } from "./db";
import { UnsupportedSavedDataError } from "./savedDataCompatibility";

// Guardrails for the database's split into owners (INF-2625's plan, the
// database row: "an upgraded database matches a fresh one table for table;
// no two saved-version numbers are equal"). A saved database records the
// version of every migration it ran, so each one keeps its number and its
// effect wherever its code lives.

/** Every named saved-version boundary db.ts exports, read from the module itself. */
function namedVersions(): [string, number][] {
  return Object.entries(db).filter(
    (entry): entry is [string, number] =>
      entry[0].endsWith("_VERSION") && typeof entry[1] === "number",
  );
}

/** Every table, column, index and view as SQLite records it. */
function schemaOf(database: AppDatabase): unknown[] {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function appliedVersions(database: AppDatabase): number[] {
  return (
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map((row) => row.version);
}

it("names each saved-version boundary by a distinct migration of the ledger", () => {
  // DATABASE_VERSION is the ledger's length, so it shares the newest migration's number.
  const named = namedVersions().filter(([name]) => name !== "DATABASE_VERSION");
  // The read sees the boundaries db.ts names, so the checks below cannot pass on none.
  expect(named.map(([name]) => name)).toEqual(
    expect.arrayContaining(["CREW_RESPONSE_VERSION", "CHANGES_VERSION", "INTERIM_ANSWERS_VERSION"]),
  );
  for (const [name, version] of named) {
    expect({ name, inLedger: Number.isInteger(version) && version >= 1 }).toEqual({
      name,
      inLedger: true,
    });
    expect(version).toBeLessThanOrEqual(DATABASE_VERSION);
  }
  const versions = named.map(([, version]) => version);
  expect(new Set(versions).size).toBe(versions.length);
});

it("upgrades a database one saved version at a time, and from the first, to the fresh database's schema", () => {
  const fresh = openDatabase(scratchDir("infinitary-db-fresh-"));
  const expected = schemaOf(fresh);
  expect(appliedVersions(fresh)).toHaveLength(DATABASE_VERSION);
  fresh.close();

  // Every release the captain's computer may have run, opened in turn.
  const stepped = scratchDir("infinitary-db-stepped-");
  for (let version = 1; version < DATABASE_VERSION; version++) {
    openDatabase(stepped, version).close();
  }
  const upgraded = openDatabase(stepped);
  expect(schemaOf(upgraded)).toEqual(expected);
  expect(appliedVersions(upgraded)).toHaveLength(DATABASE_VERSION);
  upgraded.close();

  const first = scratchDir("infinitary-db-first-");
  openDatabase(first, 1).close();
  const jumped = openDatabase(first);
  expect(schemaOf(jumped)).toEqual(expected);
  jumped.close();
});

it("refuses a firstmate.db that is not a database, and leaves its bytes alone", () => {
  const dir = scratchDir("infinitary-db-corrupt-");
  const path = join(dir, "firstmate.db");
  // A file cut short by a failed disk or a copy that never finished.
  writeFileSync(path, "SQLite format 3\0 cut short");
  const before = readFileSync(path);
  expect(() => assertSavedDataCompatible(dir)).toThrow(UnsupportedSavedDataError);
  expect(() => openDatabase(dir)).toThrow(UnsupportedSavedDataError);
  expect(readFileSync(path)).toEqual(before);
});

it("keeps a version-16 status this build does not know, rather than guessing another", () => {
  const dir = scratchDir("infinitary-db-status-");
  const old = openDatabase(dir, 16);
  // A status a newer build or a hand edit wrote.
  old
    .prepare(
      `INSERT INTO tasks (id, kind, title, prompt, repo_id, repo_dir, worktree_dir, branch, status, created_at)
       VALUES ('later', 'work', 'Draw the chart', 'brief', NULL, '/repo', '/worktrees/later', 'fm/task-later', 'paused', 1000)`,
    )
    .run();
  old.close();
  const upgraded = openDatabase(dir, 19);
  expect(
    upgraded.prepare("SELECT status, activity, closed_reason FROM tasks WHERE id = 'later'").get(),
  ).toEqual({ status: "paused", activity: null, closed_reason: null });
  upgraded.close();
});

it("leaves an unreadable saved delivery, settle or shape as saved through the task-record migrations", () => {
  const dir = scratchDir("infinitary-db-unreadable-");
  const old = openDatabase(dir, db.TASK_EXECUTION_VERSION - 1);
  const tasks = new TaskService({ db: old, strict: true });
  seedTask(tasks, { id: "torn", title: "Fix the axis", status: "queued" });
  // Each written half by a crash in the middle of a save.
  old
    .prepare(
      "UPDATE tasks SET delivery_json = '{\"mode\":', pending_settle_json = '{\"mode\":', shape_json = '{\"kind\":' WHERE id = 'torn'",
    )
    .run();
  old.close();
  const saved = () =>
    upgraded
      .prepare("SELECT delivery_json, pending_settle_json, shape_json FROM tasks WHERE id = 'torn'")
      .get();
  const count = (table: string) =>
    (upgraded.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const upgraded = openDatabase(dir, db.TASK_DELIVERY_RECORDS_VERSION);
  expect(saved()).toEqual({
    delivery_json: '{"mode":',
    pending_settle_json: '{"mode":',
    shape_json: '{"kind":',
  });
  expect(count("task_execution")).toBe(0);
  expect(count("task_policies")).toBe(0);
  expect(count("task_delivery_evidence")).toBe(0);
  expect(count("task_permissions")).toBe(0);
  upgraded.close();
});

it("leaves an open card's unreadable actions as saved through migration 29", () => {
  const dir = scratchDir("infinitary-db-card-actions-");
  const old = openDatabase(dir, 28);
  const insert = old.prepare(
    `INSERT INTO cards (id, task_id, kind, priority, title, meta, body, actions_json, status, created_at)
     VALUES (?, 't1', 'decision', 30, 'The PR is ready', 'm', '<p>b</p>', ?, 'ready', ?)`,
  );
  insert.run("card-torn", '[{"id":"merge-pr"', 1);
  insert.run("card-object", '{"id":"merge-pr"}', 2);
  old.close();
  const upgraded = openDatabase(dir, 29);
  expect(upgraded.prepare("SELECT id, actions_json FROM cards ORDER BY id").all()).toEqual([
    { id: "card-object", actions_json: '{"id":"merge-pr"}' },
    { id: "card-torn", actions_json: '[{"id":"merge-pr"' },
  ]);
  expect(upgraded.prepare("SELECT count(*) AS n FROM card_effect_backfill").get()).toEqual({
    n: 0,
  });
  upgraded.close();
});
