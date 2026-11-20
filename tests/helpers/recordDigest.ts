import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { listRecord } from "../../src/core/homeMove/record.ts";
import { scratchDir } from "./scratchDirs.ts";

/**
 * A first mate's record by its content (docs/devices.md, "Keeping a copy on
 * another computer"): each database by its rows, table by table, and every
 * other file by its bytes, keyed by its place in the record. A home's live
 * record and a copy compare equal when the copy holds every change.
 *
 * A database is read from a copy of its file and log in a scratch folder,
 * so reading adds nothing beside the original and takes none of its locks.
 * One that does not open, or fails SQLite's own integrity check, throws.
 */
export function recordDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of listRecord(root, null, { kinds: false })) {
    out[entry.path] = isDatabase(entry.path)
      ? databaseDigest(entry.abs)
      : createHash("sha256").update(readFileSync(entry.abs)).digest("hex");
  }
  return out;
}

function isDatabase(path: string): boolean {
  return /\.(db|sqlite|sqlite3)$/.test(path);
}

/** One database's rows, read from a scratch copy; throws when it does not open whole. */
export function databaseDigest(file: string): string {
  const copy = join(scratchDir("infinitary-record-digest-"), "read.db");
  copyFileSync(file, copy);
  if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
  const db = new Database(copy, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new Error(`${file} fails its integrity check: ${String(integrity)}`);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const hash = createHash("sha256");
    for (const { name } of tables) {
      hash.update(name);
      for (const row of db.prepare(`SELECT * FROM "${name}"`).raw().all())
        hash.update(JSON.stringify(row));
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}
