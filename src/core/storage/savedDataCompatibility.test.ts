import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { recordNewerMigration } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { assertSavedDataCompatible, openDatabase, openInMemoryDatabase } from "./db";
import { UnsupportedSavedDataError } from "./savedDataCompatibility";

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

describe("saved-data compatibility before writable initialization", () => {
  it("opens fresh, current and supported older databases", () => {
    const current = openInMemoryDatabase();
    const expected = current.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
    current.close();
    for (const through of [undefined, 1, 40]) {
      const dir = scratchDir("fm-compat-supported-");
      openDatabase(dir, through).close();
      const db = openDatabase(dir);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual(expected);
      db.close();
      expect(JSON.parse(readFileSync(join(dir, "saved-data-format.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        revision: 1,
      });
    }
  });

  it("refuses future migrations without altering database, views or saved files", () => {
    const dir = scratchDir("fm-compat-future-");
    const db = openDatabase(dir);
    recordNewerMigration(db);
    db.close();
    writeFileSync(join(dir, "saved-conversation.jsonl"), "protected notes\n");
    const before = snapshot(dir);
    expect(() => openDatabase(dir)).toThrow(UnsupportedSavedDataError);
    expect(snapshot(dir)).toEqual(before);
  });

  it("sees a future migration committed only in WAL without changing the source sidecars", () => {
    const dir = scratchDir("fm-compat-wal-");
    const db = openDatabase(dir);
    try {
      db.pragma("wal_autocheckpoint = 0");
      recordNewerMigration(db);
      const before = snapshot(dir);
      expect(() => assertSavedDataCompatible(dir)).toThrow(UnsupportedSavedDataError);
      expect(snapshot(dir)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.each([
    "{",
    '{"schemaVersion":1,"revision":2}',
    '{"schemaVersion":2,"revision":1}',
    '{"schemaVersion":1,"revision":1,"unknown":true}',
  ])("refuses unsupported format %s without writing", (format) => {
    const dir = scratchDir("fm-compat-format-");
    openDatabase(dir).close();
    writeFileSync(join(dir, "saved-data-format.json"), format);
    const before = snapshot(dir);
    expect(() => openDatabase(dir)).toThrow(UnsupportedSavedDataError);
    expect(snapshot(dir)).toEqual(before);
  });

  it("does not guess a database with unknown tables or invalid migration history", () => {
    const dir = scratchDir("fm-compat-unknown-");
    const db = new Database(join(dir, "firstmate.db"));
    db.exec("CREATE TABLE unknown_data (value TEXT)");
    db.close();
    expect(() => assertSavedDataCompatible(dir)).toThrow(UnsupportedSavedDataError);
    const known = scratchDir("fm-compat-gap-");
    const old = openDatabase(known);
    old.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(0);
    old.close();
    expect(() => assertSavedDataCompatible(known)).toThrow(UnsupportedSavedDataError);
  });
});
