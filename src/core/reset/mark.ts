import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * The reset mark (docs/reset.md): a file beside the data folder, never in it,
 * that says the person reset Infinitary and the next start wipes the folder
 * before anything opens it. Beside, because the wipe renames the folder and
 * nothing inside it may be held while it does.
 *
 * The mark names no path and no command: the start that finishes it works out
 * every place from its own platform, home folder and flavor, so a mark written
 * by anything but the app can only ask for the wipe the app itself would do.
 */
export const RESET_MARK_SUFFIX = ".reset";
/** The lock a start holds while it finishes a reset; it follows the move lock's stale rules. */
export const RESET_LOCK_SUFFIX = ".reset-lock";
/** What the folder is renamed to before it is deleted, followed by the finishing start's process number. */
export const RESETTING_SUFFIX = ".resetting-";

/**
 * The kinds of state outside the folder a reset clears. The running app
 * clears what it can before it quits and writes the rest here; the start
 * that wipes the folder clears these once more, so a kind is never left only
 * because the running app could not reach it.
 */
export const RESET_OUTSIDE_KINDS = [
  /** Secrets', approvals' and the standby lock's items in the system's password store. */
  "password-store",
  /** The run agent, the login item and every other entry that starts the app. */
  "start-entries",
  /** What a Mac keeps for the app outside the folder: preferences, caches, saved window state, logs. */
  "app-files",
  /** The key Chromium keeps in the password store for the window's saved data. */
  "safe-storage",
  /** The key lines phones placed in this account's `authorized_keys`. */
  "phone-keys",
  /** The command's link Settings made and the agent skill it wrote. */
  "command-link",
] as const;
export type ResetOutsideKind = (typeof RESET_OUTSIDE_KINDS)[number];

/**
 * Where a reset stands, each step resumable: `asked` until the folder is
 * renamed aside, `moved` until the renamed folder and the older copies are
 * gone, `outside` while the outside kinds are cleared. The mark is deleted
 * last, so a start cut off at any step carries on from it.
 */
export const RESET_STAGES = ["asked", "moved", "outside"] as const;
export type ResetStage = (typeof RESET_STAGES)[number];

export const resetMarkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stage: z.enum(RESET_STAGES),
  /** When the person confirmed the reset (ISO). */
  askedAt: z.string().min(1).max(64),
  /** Outside kinds still to clear. */
  outside: z.array(z.enum(RESET_OUTSIDE_KINDS)).max(RESET_OUTSIDE_KINDS.length),
  /**
   * Starts that could not delete a folder renamed aside, which still holds
   * the old sign-ins and records; the mark stays at `moved` for a few.
   */
  asideTries: z.number().int().min(0).max(100).optional(),
});
export type ResetMark = z.infer<typeof resetMarkSchema>;

export function resetMarkPath(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}${RESET_MARK_SUFFIX}`);
}

export function resetLockPath(dataDir: string): string {
  return join(dirname(dataDir), `${basename(dataDir)}${RESET_LOCK_SUFFIX}`);
}

/**
 * Reads the mark. Undefined when there is none, or when the file cannot be
 * opened at all: a start that could not rewrite or remove such a mark would
 * wipe the fresh folder at every start after. A mark that opens but does not
 * parse, as one cut off while written by an older or newer version, still
 * asks for the wipe from its first step, since only a reset writes a file of
 * this name and the start must never open the folder it asked to remove.
 */
export function readResetMark(dataDir: string): ResetMark | undefined {
  let raw: string;
  try {
    raw = readFileSync(resetMarkPath(dataDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = resetMarkSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : unreadable();
  } catch {
    return unreadable();
  }
}

function unreadable(): ResetMark {
  return {
    schemaVersion: 1,
    stage: "asked",
    askedAt: new Date(0).toISOString(),
    outside: [...RESET_OUTSIDE_KINDS],
  };
}

/** Writes the mark whole or not at all, readable by this account alone. */
export function writeResetMark(dataDir: string, mark: ResetMark): void {
  const path = resetMarkPath(dataDir);
  const pending = `${path}.${process.pid}.tmp`;
  writeFileSync(pending, `${JSON.stringify(resetMarkSchema.parse(mark))}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

export function removeResetMark(dataDir: string): void {
  rmSync(resetMarkPath(dataDir), { force: true });
}

/** The mark the running app writes once the person confirmed. */
export function askedResetMark(outside: readonly ResetOutsideKind[], now = new Date()): ResetMark {
  return {
    schemaVersion: 1,
    stage: "asked",
    askedAt: now.toISOString(),
    outside: RESET_OUTSIDE_KINDS.filter((kind) => outside.includes(kind)),
  };
}
