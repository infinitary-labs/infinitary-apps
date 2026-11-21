import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { DATABASE_VERSION, openDatabase, readDatabaseSnapshot } from "./db";
import { KnowledgeStore } from "./knowledgeStore";
import { recordPersistedFormat } from "./savedDataCompatibility";
import { formatChangeDue, keepRecordBeforeSourceRun, SOURCE_RUN_COPY_DIR } from "./sourceRunCopy";

/** A data folder the installed app left: its record with one task in it. */
function installedFolder(): string {
  const dir = scratchDir("infinitary-source-copy-");
  const db = openDatabase(dir);
  seedTask(new TaskService({ db, strict: true }), {
    id: "kept-task",
    title: "Write the release notes",
    status: "completed",
  });
  db.close();
  return dir;
}

describe("the copy a run from source keeps before it opens the person's record", () => {
  // INF-5635's plan, piece 1: before pnpm dev first opens the installed app's
  // folder, it keeps a copy of the saved record to go back to.
  it("keeps the record as it stood, and no new copy while this build changes nothing in how it is saved", () => {
    const dir = installedFolder();
    const kept = keepRecordBeforeSourceRun(dir, copyFileSync);
    expect(kept).toBe(join(dir, SOURCE_RUN_COPY_DIR));
    const copy = openDatabase(kept as string);
    try {
      expect(new TaskService({ db: copy, strict: true }).get("kept-task")?.title).toBe(
        "Write the release notes",
      );
    } finally {
      copy.close();
    }
    // A later start keeps no new copy over the first.
    expect(keepRecordBeforeSourceRun(dir, copyFileSync)).toBeNull();
  });

  it("copies again after a start that ended partway, keeping nothing it did not finish", () => {
    const dir = installedFolder();
    let copies = 0;
    expect(() =>
      keepRecordBeforeSourceRun(dir, (from, to) => {
        copies += 1;
        if (copies === 2) throw new Error("the disk filled up");
        copyFileSync(from, to);
      }),
    ).toThrow("the disk filled up");
    expect(existsSync(join(dir, SOURCE_RUN_COPY_DIR))).toBe(false);
    const kept = keepRecordBeforeSourceRun(dir, copyFileSync);
    expect(kept && readdirSync(kept)).toContain("firstmate.db");
    expect(readdirSync(dir)).not.toContain(`${SOURCE_RUN_COPY_DIR}.partial`);
  });

  it("keeps the knowledge collection's database and the format marker with the record", () => {
    const dir = installedFolder();
    recordPersistedFormat(dir);
    KnowledgeStore.open(join(dir, "knowledge")).close();
    const kept = keepRecordBeforeSourceRun(dir, copyFileSync) as string;
    expect(readdirSync(kept).sort()).toEqual([
      "firstmate.db",
      "knowledge",
      "saved-data-format.json",
    ]);
    expect(readdirSync(join(kept, "knowledge"))).toContain("knowledge.db");
  });

  // The review of piece 1 (F1): an empty first copy must not stand in for the
  // first real record a folder gets later.
  it("keeps nothing for a folder with no record yet, and keeps the first record it gets", () => {
    const dir = scratchDir("infinitary-source-copy-empty-");
    expect(keepRecordBeforeSourceRun(dir, copyFileSync)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    const db = openDatabase(dir);
    seedTask(new TaskService({ db, strict: true }), {
      id: "later-task",
      title: "Moved in later",
      status: "completed",
    });
    db.close();
    const kept = keepRecordBeforeSourceRun(dir, copyFileSync);
    expect(kept && readdirSync(kept)).toContain("firstmate.db");
  });

  // The captain's answer on the review of piece 1 (F2, before-format-change):
  // copy again before a newer version changes how the data is saved.
  it("keeps a fresh copy, replacing the older one, before a build that would migrate the record", () => {
    const dir = scratchDir("infinitary-source-copy-older-");
    // A record an installed build one migration behind this one left.
    openDatabase(dir, DATABASE_VERSION - 1).close();
    expect(formatChangeDue(dir)).toBe(true);
    const appliedIn = (folder: string) =>
      readDatabaseSnapshot(
        join(folder, "firstmate.db"),
        (db) =>
          (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
      );
    const first = keepRecordBeforeSourceRun(dir, copyFileSync);
    expect(first && appliedIn(first)).toBe(DATABASE_VERSION - 1);
    // A start that quit before opening the record copies again over the first.
    expect(keepRecordBeforeSourceRun(dir, copyFileSync)).toBe(first);
    expect(readdirSync(dir).filter((name) => name.startsWith(SOURCE_RUN_COPY_DIR))).toEqual([
      SOURCE_RUN_COPY_DIR,
    ]);
    // Once this build opened and migrated it, the next start keeps no new copy,
    // and the kept one is still the record from just before the migration.
    openDatabase(dir).close();
    expect(formatChangeDue(dir)).toBe(false);
    expect(keepRecordBeforeSourceRun(dir, copyFileSync)).toBeNull();
    expect(appliedIn(join(dir, SOURCE_RUN_COPY_DIR))).toBe(DATABASE_VERSION - 1);
  });
});
