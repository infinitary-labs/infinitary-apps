import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wallAt } from "../orchestrator/calendar";

/**
 * The update check's active mark (docs/sharing.md, "The update check's
 * active mark"): a copy's first answered read of the release feed each
 * Pacific day carries `Infinitary-Active: day`, and the first of each
 * Pacific month `day, month`, so the download server can count copies in
 * use without any identifier. It goes whatever the Diagnostics switch says.
 *
 * The copy keeps only the last day and month it marked, in one file in its
 * data root, written only after the server answered: a failed or offline
 * read leaves the mark for the next one. Nothing else is kept: no counter,
 * no ID, no time of day.
 */
export const ACTIVE_MARK_HEADER = "Infinitary-Active";
export const ACTIVE_MARK_FILE = "active-mark.json";
/** The stats page's day, so a copy counts at most once per day there. */
export const ACTIVE_MARK_TIME_ZONE = "America/Los_Angeles";

export type ActiveMarkValue = "day" | "day, month";
/** One read's mark: its header value, and what the reader calls once the server answered. */
export type ActiveMark = { value: ActiveMarkValue; answered: () => void };
export type ActiveMarks = {
  /** The mark the next feed read carries, or null when this Pacific day is already marked. */
  next: () => ActiveMark | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const two = (value: number) => String(value).padStart(2, "0");

/** The Pacific calendar day and month a moment falls in, as `2026-11-19` and `2026-11`. */
export function pacificDay(at: number): { day: string; month: string } {
  const wall = wallAt(at, ACTIVE_MARK_TIME_ZONE);
  const month = `${wall.year}-${two(wall.month)}`;
  return { day: `${month}-${two(wall.day)}`, month };
}

type Marked = { day: string; month: string };

/** What the file says, or nothing for a file missing, unreadable or not this shape. */
function readMarked(path: string): Marked | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object") return null;
    const { day, month } = data as Record<string, unknown>;
    return typeof day === "string" &&
      DAY.test(day) &&
      typeof month === "string" &&
      MONTH.test(month)
      ? { day, month }
      : null;
  } catch {
    return null;
  }
}

function writeMarked(dataRoot: string, path: string, marked: Marked): void {
  mkdirSync(dataRoot, { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, ...marked }), { mode: 0o600 });
  renameSync(temporary, path);
}

export function createActiveMarks(dataRoot: string, now: () => number = Date.now): ActiveMarks {
  const path = join(dataRoot, ACTIVE_MARK_FILE);
  return {
    next() {
      // Read each time, so a relaunch or another process's mark is seen.
      const marked = readMarked(path);
      const today = pacificDay(now());
      if (marked?.day === today.day) return null;
      return {
        value: marked?.month === today.month ? "day" : "day, month",
        answered: () => {
          try {
            writeMarked(dataRoot, path, today);
          } catch {
            // A mark that could not be kept goes again on the next read: never more than once a read.
          }
        },
      };
    },
  };
}
