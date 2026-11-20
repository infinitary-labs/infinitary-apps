import { ActivityStore } from "@core/storage/activityStore";
import { openInMemoryDatabase } from "@core/storage/db";
import { seedTask } from "@core/tasks/seedTask";
import { recentFeed } from "@core/tasks/taskFeed";
import { TaskService } from "@core/tasks/taskService";
import { SQL_VIEWS } from "@shared/sql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshDatabase } from "./database";

beforeEach(() => {
  // Migration-created rows have timestamps; compare both paths on one clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it("clones the fully migrated schema while keeping writes, transactions and connections private", () => {
  const original = openInMemoryDatabase();
  const first = freshDatabase();
  const second = freshDatabase();
  try {
    const schema = (db: typeof first) =>
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    expect(schema(first)).toEqual(schema(original));
    expect(first.prepare("SELECT * FROM schema_migrations").all()).toEqual(
      original.prepare("SELECT * FROM schema_migrations").all(),
    );
    for (const pragma of ["foreign_keys", "journal_mode", "synchronous", "busy_timeout"]) {
      expect(first.pragma(pragma), pragma).toEqual(original.pragma(pragma));
    }
    const tables = original
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    for (const { name } of tables) {
      expect(first.prepare(`SELECT * FROM "${name}"`).all(), name).toEqual(
        original.prepare(`SELECT * FROM "${name}"`).all(),
      );
    }
    first.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("private", "first");
    expect(second.prepare("SELECT * FROM settings WHERE key = ?").get("private")).toBeUndefined();
    second.exec("BEGIN");
    second.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("private", "second");
    second.exec("ROLLBACK");
    expect(first.prepare("SELECT value FROM settings WHERE key = ?").get("private")).toEqual({
      value: "first",
    });
    expect(second.prepare("SELECT * FROM settings WHERE key = ?").get("private")).toBeUndefined();
    first.close();
    expect(second.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    const third = freshDatabase();
    try {
      expect(third.prepare("SELECT * FROM settings WHERE key = ?").get("private")).toBeUndefined();
    } finally {
      third.close();
    }
  } finally {
    if (first.open) first.close();
    second.close();
    original.close();
  }
});

it("reads every published view and authors a seeded task's feed on each cloned connection", () => {
  const original = openInMemoryDatabase();
  const first = freshDatabase();
  const second = freshDatabase();
  try {
    for (const db of [original, first, second]) {
      const tasks = new TaskService({ db, strict: true, now: () => Date.now() });
      seedTask(tasks, { id: "guard", title: "Fixture guard", status: "running" });
      const feed = recentFeed(tasks, new ActivityStore(db), 20).map((line) => ({
        at: line.at,
        kind: line.kind,
        text: line.text,
        task_key: line.taskKey ?? null,
      }));
      expect(feed).toContainEqual(expect.objectContaining({ task_key: "SCR-1", kind: "info" }));
      expect(db.prepare("SELECT * FROM v_feed_v1 ORDER BY at, text").all()).toEqual(
        feed.sort((a, b) => a.at - b.at || a.text.localeCompare(b.text)),
      );
    }
    for (const view of SQL_VIEWS) {
      expect(first.prepare(`SELECT * FROM ${view}`).all(), view).toEqual(
        original.prepare(`SELECT * FROM ${view}`).all(),
      );
      expect(second.prepare(`SELECT * FROM ${view}`).all(), view).toEqual(
        original.prepare(`SELECT * FROM ${view}`).all(),
      );
    }
  } finally {
    original.close();
    first.close();
    second.close();
  }
});
