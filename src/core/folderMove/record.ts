import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RETIRED_PROFILE_MARKER } from "../storage/retiredProfile";

/**
 * The record a one-time move keeps in the folder it builds (./move.ts):
 * staged first, then the folder itself once committed. It is the move's
 * journal - each state is written before the step that depends on it, so a
 * move stopped at any point resumes from the last state written - and, once
 * done, the reason this folder is never moved into again. A folder whose
 * person kept its own work when both held some carries `kept-own`, so the
 * question is not asked again.
 */
export const MOVE_RECORD = "folder-move.json";

export const MOVE_STATES = ["verified", "committed", "done", "kept-own"] as const;
export type MoveState = (typeof MOVE_STATES)[number];

/** A file outside both folders the move changed, with what it held before and after. */
const outsideChangeSchema = z.strictObject({
  path: z.string().min(1),
  before: z.string(),
  after: z.string(),
});
export type OutsideChange = z.infer<typeof outsideChangeSchema>;

const moveRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(MOVE_STATES),
  from: z.string().min(1),
  to: z.string().min(1),
  at: z.string().min(1),
  /** What the copy counted, so the record says what came over. */
  counts: z
    .strictObject({
      files: z.number().int().nonnegative(),
      dirs: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
      bytes: z.number().nonnegative(),
    })
    .optional(),
  /** Sockets and pipes the copy skipped, relative to the folder. */
  skipped: z.array(z.string()).optional(),
  /** Files inside the folder whose paths the move rewrote, relative to it. */
  rewritten: z.array(z.string()).optional(),
  /** Git's links in repositories outside the folder, changed after the commit. */
  outside: z.array(outsideChangeSchema).optional(),
  /** Claude's own session folders copied under this folder's paths. */
  claude: z.array(z.strictObject({ from: z.string(), to: z.string() })).optional(),
  /** Where this folder's own work went when the person chose the older folder's. */
  setAside: z.string().optional(),
});
export type MoveRecord = z.infer<typeof moveRecordSchema>;

/** The record in `dir`, or undefined when there is none or it cannot be read. */
export function readMoveRecord(dir: string): MoveRecord | undefined {
  try {
    const parsed = moveRecordSchema.safeParse(
      JSON.parse(readFileSync(join(dir, MOVE_RECORD), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeWhole(path: string, body: string): void {
  const pending = `${path}.tmp`;
  writeFileSync(pending, body, { mode: 0o600 });
  renameSync(pending, path);
}

/** Writes the record whole: a reader sees the old record or the new one, never half. */
export function writeMoveRecord(dir: string, record: MoveRecord): void {
  writeWhole(
    join(dir, MOVE_RECORD),
    `${JSON.stringify(moveRecordSchema.parse(record), null, 2)}\n`,
  );
}

/**
 * Retires the older folder (src/core/storage/retiredProfile.ts): Firstmate
 * 3000 never opens it again, and it stays as it was, the move's recovery
 * copy. The marker names where the work went.
 */
export function writeRetiredMarker(from: string, to: string, at: string): void {
  writeWhole(
    join(from, RETIRED_PROFILE_MARKER),
    `${JSON.stringify({ schemaVersion: 1, movedTo: to, at }, null, 2)}\n`,
  );
}
