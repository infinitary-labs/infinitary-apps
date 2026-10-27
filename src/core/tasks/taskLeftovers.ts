import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { lstat, mkdir, readdir, rename, rm } from "../plainFs";
import {
  OLDER_TEMP_MARKER_NAME,
  ownedTempUnsafe,
  TEMP_DIR_NAME,
  TEMP_MARKER_NAME,
} from "./taskTemp";

/**
 * What the app keeps in a task's folder for itself, never removed here:
 * the session record (D2), the host's copies of card pictures, card body
 * files, the source cards a brief named, a placed conversation's state and
 * panel captures. Everything else in the folder is the crewmate's.
 */
export const APP_KEPT_PARTS: ReadonlySet<string> = new Set([
  "sessions",
  "cards",
  "card-bodies",
  "source-cards",
  "placed",
  "captures",
]);

/** Removes only leftovers, never following a link, through the folder's own writer. */
export async function removeTaskLeftovers(
  folder: string,
  trashDir: string,
  taskId: string,
  keptParts: ReadonlySet<string>,
  deleteInBackground: (dir: string) => void,
): Promise<{ removedFiles: string[]; bytes: number }> {
  const stat = await lstat(folder).catch(() => undefined);
  if (!stat?.isDirectory()) return { removedFiles: [], bytes: 0 };
  const names = (await readdir(folder)).filter((name) => !keptParts.has(name)).sort();
  if (names.length === 0) return { removedFiles: [], bytes: 0 };
  // A provisioned temporary folder that still holds a volume stays. The
  // close-time pass retries it; a recursive delete must not enter the volume.
  const tempUnsafe = names.includes(TEMP_DIR_NAME) && (await ownedTempUnsafe(folder));
  const safe = names.filter(
    (name) =>
      !tempUnsafe ||
      (name !== TEMP_DIR_NAME && name !== TEMP_MARKER_NAME && name !== OLDER_TEMP_MARKER_NAME),
  );
  if (safe.length === 0) return { removedFiles: [], bytes: 0 };
  let bytes = 0;
  for (const name of safe) bytes += await sizeOf(join(folder, name));
  const aside = join(trashDir, `${taskId}-files-${randomUUID().slice(0, 8)}`);
  const movable = await mkdir(aside, { recursive: true }).then(
    () => true,
    () => false,
  );
  for (const name of safe) {
    const from = join(folder, name);
    const moved =
      movable &&
      (await rename(from, join(aside, name)).then(
        () => true,
        () => false,
      ));
    if (!moved) await rm(from, { recursive: true, force: true });
  }
  if (movable) deleteInBackground(aside);
  return { removedFiles: safe, bytes };
}

/** The bytes under a path, its links counted as links and never followed. */
async function sizeOf(path: string): Promise<number> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (const entry of entries) total += await sizeOf(join(path, entry));
  return total;
}

/** "leftover files removed: the evidence folder and 2 other things its crewmate left, 1.4 GB" */
export function removedWords(names: readonly string[], bytes: number): string {
  const others = names.filter((name) => name !== "evidence").length;
  const things = `${others} ${others === 1 ? "thing" : "things"} its crewmate left`;
  const what = !names.includes("evidence")
    ? things
    : others > 0
      ? `the evidence folder and ${others} other ${others === 1 ? "thing" : "things"} its crewmate left`
      : "the evidence folder";
  return `leftover files removed: ${what}, ${fileSizeWords(bytes)}`;
}
