import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMoveRecord } from "../../../src/core/folderMove/record";
import { dataFolderRefusal } from "../../../src/core/storage/dataFolderRefusal";
import { openDatabase } from "../../../src/core/storage/db";
import { isProfileRetired } from "../../../src/core/storage/retiredProfile";
import { seedTask } from "../../../src/core/tasks/seedTask";
import { TaskService } from "../../../src/core/tasks/taskService";
import { readSavedData } from "../../e2e/savedData";

const id = "installer-saved-work";
const title = "Finish the installation guide";
const draft = "Keep the introduction and the annotated installation notes.\n";

/** INF-640: a real saved task and a person's draft survive replacement and the old-folder handover. */
export function seedSavedWork(root: string) {
  const db = openDatabase(root);
  try {
    seedTask(new TaskService({ db, strict: true }), {
      id,
      title,
      status: "queued",
      startPolicy: "on-request",
    });
  } finally {
    db.close();
  }
  mkdirSync(join(root, "personal-workspace"), { recursive: true });
  writeFileSync(join(root, "personal-workspace", "installation-guide.md"), draft);
}
/** The original stays as a refused recovery copy; only the new folder is opened. */
export function assertSavedWorkMoved(from: string, to: string): void {
  const move = readMoveRecord(to);
  assert.equal(move?.state, "done", "The saved-work handover must finish");
  assert.equal(move?.from, from);
  assert.equal(move?.to, to);
  assert(isProfileRetired(from), "The recovery copy must be retired");
  assert(dataFolderRefusal(from), "The app must refuse the recovery copy");
  assert.equal(dataFolderRefusal(to), null, "The app must be able to open the new folder");
  assert(savedWorkPresent(from), "The original task and draft must remain recoverable");
  assert(savedWorkPresent(to), "The task and draft must survive the handover");
}

export function savedWorkPresent(root: string): boolean {
  const row = readSavedData(root, (db) =>
    db.prepare("SELECT title FROM tasks WHERE id = ?").get(id),
  ) as { title: string } | undefined;
  return (
    row?.title === title &&
    readFileSync(join(root, "personal-workspace", "installation-guide.md"), "utf8") === draft
  );
}
