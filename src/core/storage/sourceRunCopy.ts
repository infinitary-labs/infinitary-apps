import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { KNOWLEDGE_DB_FILE } from "./knowledgeStore";
import { privateCopy } from "./privateCopy";

/**
 * The copy of the saved record a run from source keeps before it first opens
 * the person's own data folder (docs/saved-data-compatibility.md, "A run from
 * source"). `pnpm dev` opens the folder the installed app keeps, and newer
 * source may migrate the record past what the installed app opens; the copy
 * is what to go back to. Kept once: the folder's presence says a run from
 * source opened this record before.
 */
export const SOURCE_RUN_COPY_DIR = "before-source-run";

/**
 * The files whose formats a newer build may move forward: the database with
 * its write-ahead log, the knowledge collection's, and the format marker.
 * Each is copied as it stands while this run holds the folder's lock, so a
 * database and its log are copied as one state.
 */
export const SOURCE_RUN_COPY_FILES = [
  "firstmate.db",
  "firstmate.db-wal",
  "saved-data-format.json",
  join("knowledge", KNOWLEDGE_DB_FILE),
  join("knowledge", `${KNOWLEDGE_DB_FILE}-wal`),
] as const;

/**
 * Keeps the copy, before anything opens the record, and answers where it
 * is; null when a run from source kept one before. The copy is made beside
 * its final place and moved there whole, so a start that ends partway keeps
 * nothing and the next start copies again. `copy` is `privateCopy`, which
 * clones where the disk can.
 */
export function keepRecordBeforeSourceRun(
  dataDir: string,
  copy: (from: string, to: string) => void = privateCopy,
): string | null {
  const kept = join(dataDir, SOURCE_RUN_COPY_DIR);
  if (existsSync(kept)) return null;
  const partial = `${kept}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true, mode: 0o700 });
  for (const file of SOURCE_RUN_COPY_FILES) {
    const from = join(dataDir, file);
    if (!existsSync(from)) continue;
    const to = join(partial, file);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copy(from, to);
  }
  renameSync(partial, kept);
  return kept;
}
