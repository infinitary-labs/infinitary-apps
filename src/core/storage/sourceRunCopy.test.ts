import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase } from "./db";
import { KnowledgeStore } from "./knowledgeStore";
import { recordPersistedFormat } from "./savedDataCompatibility";
import { keepRecordBeforeSourceRun, SOURCE_RUN_COPY_DIR } from "./sourceRunCopy";

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
  it("keeps the record as it stood, once", () => {
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
});
