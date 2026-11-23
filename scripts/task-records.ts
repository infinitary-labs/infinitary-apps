/**
 * The two operations behind `pnpm export:tasks` (`scripts/export-tasks.ts`):
 * export the task record under a userData to JSONL, and reload an export.
 * This module imports the app core, so the CLI loads it through the Vite
 * module runner (`scripts/moduleRunner.ts`); vitest imports it directly.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { openDatabase } from "../src/core/storage/db.ts";
import { exportTaskRecords, parseTaskExport } from "../src/core/tasks/taskExport.ts";
import { TaskService } from "../src/core/tasks/taskService.ts";

export function exportToFile(userDataDir: string, outPath: string): number {
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    const lines = exportTaskRecords(tasks);
    writeFileSync(outPath, `${lines.join("\n")}\n`);
    return lines.length;
  } finally {
    db.close();
  }
}

export function importFromFile(
  userDataDir: string,
  importPath: string,
): ReturnType<TaskService["archive"]["importRecords"]> {
  const bundle = parseTaskExport(readFileSync(importPath, "utf8"));
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    return tasks.archive.importRecords(bundle);
  } finally {
    db.close();
  }
}
