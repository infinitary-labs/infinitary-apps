import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every file under `dir`, as bytes read as text, for a search of what the
 * app keeps there while it runs (docs/e2e-contracts.md, "One writer once the
 * app runs"). A running app moves files as it writes them: Chromium's atomic
 * write renames its `.org.chromium.Chromium.*` file into place, and its
 * temporary folders go, between this listing a folder and reading what the
 * listing named (INF-1504). An entry gone since its folder was listed is not
 * kept, so it is left out; any other failure, and `dir` itself missing,
 * throws, so a search of the wrong folder never passes as finding nothing.
 */
export function savedText(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return unlessGone(path, () => savedText(path));
    if (!entry.isFile()) return [];
    return unlessGone(path, () => [{ file: path, text: readFileSync(path, "latin1") }]);
  });
}

function unlessGone<T>(path: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    const failed = error as NodeJS.ErrnoException;
    if (failed.code === "ENOENT" && failed.path === path) return [];
    throw error;
  }
}
