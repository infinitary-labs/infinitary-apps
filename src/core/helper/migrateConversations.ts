import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readMoveRecord } from "../folderMove/record";
import { joinRecord } from "../pi/recordJoin";

/**
 * Protocol 9 retires per-open folder recovery, not the saved turns it protects
 * (INF-416 piece L; captain: migrate before removal).
 * PlacedTasks invokes this before it reads any task. The marker commits only
 * after every record is recovered; joinRecord is idempotent after a crash.
 * Historical words and the older recovery copy are never rewritten.
 */
export function migrateConversations(dataDir: string): void {
  const move = readMoveRecord(dirname(dataDir));
  if (!move || (move.state !== "done" && move.state !== "committed")) return;
  const marker = join(dataDir, "conversation-folders.json");
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, "utf8")) as { from?: string; at?: string };
    if (saved.from === move.from && saved.at === move.at) return;
  }
  const tasks = join(dataDir, "tasks");
  if (!existsSync(tasks)) return;
  for (const task of readdirSync(tasks, { withFileTypes: true })) {
    if (!task.isDirectory()) continue;
    const sessions = join(tasks, task.name, "sessions");
    if (!existsSync(sessions)) continue;
    const before = join(move.from, "work", "tasks", task.name, "sessions");
    if (!existsSync(before)) continue;
    for (const file of readdirSync(before, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const source = join(before, file.name);
      const target = join(sessions, file.name);
      if (statSync(source).mtimeMs <= Date.parse(move.at)) continue;
      const theirs = readFileSync(source, "utf8");
      if (!existsSync(target)) {
        writeFileSync(target, theirs, { mode: 0o600 });
        continue;
      }
      const ours = readFileSync(target, "utf8");
      if (theirs.split("\n", 1)[0] !== ours.split("\n", 1)[0])
        throw new Error(
          `Cannot recover ${task.name}'s conversation: the records name different conversations.`,
        );
      joinRecord(source, target);
    }
  }
  writeFileSync(`${marker}.next`, `${JSON.stringify({ from: move.from, at: move.at })}\n`, {
    mode: 0o600,
  });
  renameSync(`${marker}.next`, marker);
}
