import { existsSync, lstatSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { HomeMoveFacts } from "@shared/homeMove";

/**
 * Room the destination keeps free once the move has written everything
 * (docs/devices.md, "The Ready list"): it also covers what the move cannot
 * size before it starts, such as the started tasks that cross first.
 */
export const MOVE_RESERVE_BYTES = 20 * 1024 ** 3;

/** The bytes free for this user on the disk that holds a folder. */
export type FreeBytes = (dir: string) => number;

export const statfsFree: FreeBytes = (dir) => {
  const stats = statfsSync(dir);
  return Math.floor(Number(stats.bavail) * Number(stats.bsize));
};

/** `dir`, or the nearest folder above it that exists, since a move's folders may not yet. */
export function nearestFolder(dir: string): string {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

/** Free space on the disk that holds `dir`, or null when it cannot be read. */
export function freeAt(dir: string, free: FreeBytes = statfsFree): number | null {
  try {
    return free(nearestFolder(dir));
  } catch {
    return null;
  }
}

/** Whether two folders, or the nearest existing ones above them, are on one disk. */
export function oneDisk(a: string, b: string): boolean {
  try {
    return lstatSync(nearestFolder(a)).dev === lstatSync(nearestFolder(b)).dev;
  } catch {
    return true;
  }
}

/** What a move writes, in bytes, as the Ready list counts it before the move starts. */
export type MoveSize = {
  /** Every file of the record. */
  record: number;
  /** Each project's packed objects, which cross as a bundle and are cloned again there. */
  projects: number;
  /** The record's databases, which the destination rewrites in place for its own paths. */
  database: number;
};

/**
 * The destination's disk a move falls short on, with what it has and needs,
 * or null when it fits or nothing could be read. The record arrives once:
 * each file waits in the holding folder and is renamed into the data
 * folder, copied only across disks, and each project's bundle stands beside
 * its clone until the arrival ends.
 */
export function spaceShort(
  size: MoveSize,
  facts: Pick<HomeMoveFacts, "freeBytes" | "holdingFreeBytes">,
): { free: number; needs: number } | null {
  const { record, projects, database } = size;
  const placed = record + projects + database + MOVE_RESERVE_BYTES;
  const disks =
    facts.holdingFreeBytes === undefined
      ? [{ free: facts.freeBytes, needs: placed + projects }]
      : [
          { free: facts.holdingFreeBytes, needs: record + projects },
          { free: facts.freeBytes, needs: placed },
        ];
  let short: { free: number; needs: number } | null = null;
  for (const { free, needs } of disks)
    if (free !== null && free < needs && (!short || needs - free > short.needs - short.free))
      short = { free, needs };
  return short;
}
