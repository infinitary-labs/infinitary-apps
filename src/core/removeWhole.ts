import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Deletes a folder or file, whole; true once it is gone. A folder in it
 * that a build or a job left read-only is made writable to its owner, and the delete
 * tried once more.
 */
export function removeAll(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    // Tried once more below.
  }
  try {
    writable(path);
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function writable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, (stat.mode & 0o7777) | 0o700);
  for (const entry of readdirSync(path)) writable(join(path, entry));
}
