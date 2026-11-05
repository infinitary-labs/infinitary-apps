/**
 * Where the app keeps its data, for the offline tools that read it: the
 * platform's userData folder under the newest name that is there, and the
 * rolling Firstmate session the settings row names.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settingFrom } from "../../src/shared/envSettings.ts";
import {
  RELEASE_USER_DATA_FOLDER,
  userDataFoldersNewestFirst,
} from "../../src/shared/userDataFolders.ts";

export function defaultUserDataDir(): string {
  const override = settingFrom(process.env, "USER_DATA_DIR");
  if (override) return override;
  const appData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  // The installed app's folder under its newest name that is there: Firstmate
  // 3000's until the one-time move brings it to Infinitary's.
  const folders = userDataFoldersNewestFirst("release").map((folder) => join(appData, folder));
  return folders.find((folder) => existsSync(folder)) ?? join(appData, RELEASE_USER_DATA_FOLDER);
}

/**
 * A settings value as a string. `SettingsStore.set` stores every value
 * JSON-encoded, so the app writes a path as `"/path"`; a raw string (an
 * older hand-written row) still reads as itself.
 */
export function settingString(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" && parsed ? parsed : null;
  } catch {
    return value || null;
  }
}

/** The rolling Firstmate session file the app last wrote, when recorded. */
export function readFirstmateSessionFile(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'firstmate-session-file'")
      .get() as { value: string } | undefined;
    return settingString(row?.value);
  } catch {
    return null;
  } finally {
    db.close();
  }
}
