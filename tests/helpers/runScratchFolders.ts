import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/** The run owns these paths even after a worker removes its scratch directories. */
export const RUN_ROOT_ENV = "INFINITARY_TEST_RUN_ROOT";
export const SCRATCH_FOLDERS_FILE = ".scratch-folders.jsonl";

/** One append per directory, shared by the run's workers, including short socket paths. */
export function recordScratchFolder(dir: string): void {
  const root = process.env[RUN_ROOT_ENV];
  if (!root || dir === root || dir.startsWith(`${root}${sep}`)) return;
  // The root already covers its own scratch. Resolve external paths while
  // they exist: /tmp becomes /private/tmp on a Mac, and an unlinked holder
  // still names that real spelling.
  appendFileSync(join(root, SCRATCH_FOLDERS_FILE), `${JSON.stringify(realpathSync(dir))}\n`);
}

export function readScratchFolders(root: string): string[] {
  try {
    return readFileSync(join(root, SCRATCH_FOLDERS_FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
