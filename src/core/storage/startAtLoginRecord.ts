import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Whether the app starts at login, as the data folder remembers it (the
 * Infinitary rename, FI3-1780 step 3). The system keeps that setting per
 * app, so an app with a new identity cannot read the old one's: the old app
 * writes it here each time it opens and each time the person changes it,
 * and the new app, once it has moved this folder in, turns its own on when
 * the record says on (src/core/folderMove/). The record only ever follows
 * the system's own setting; nothing reads it to decide what the app does.
 * A first mate a command started has no login item of its own to read, so
 * it answers from this record while no window is open beside it
 * (docs/run.md, "The window opened beside it").
 */
export const START_AT_LOGIN_RECORD = "start-at-login.json";

const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  startAtLogin: z.boolean(),
});

/** Records the setting; a folder that cannot take the file keeps what it had. */
export function recordStartAtLogin(dataDir: string, startAtLogin: boolean): void {
  const path = join(dataDir, START_AT_LOGIN_RECORD);
  const pending = `${path}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify({ schemaVersion: 1, startAtLogin })}\n`, {
      mode: 0o600,
    });
    renameSync(pending, path);
  } catch {
    // Remembering is a courtesy for a later app; the setting itself is the system's.
  }
}

/** What the folder remembers, or undefined when it remembers nothing it can read. */
export function readStartAtLogin(dataDir: string): boolean | undefined {
  try {
    const parsed = recordSchema.safeParse(
      JSON.parse(readFileSync(join(dataDir, START_AT_LOGIN_RECORD), "utf8")),
    );
    return parsed.success ? parsed.data.startAtLogin : undefined;
  } catch {
    return undefined;
  }
}
