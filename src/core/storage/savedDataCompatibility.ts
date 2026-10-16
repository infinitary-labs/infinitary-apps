import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Advance this boundary before any incompatible non-database format is written. */
export const PERSISTED_FORMAT_REVISION = 1;
export const SAVED_DATA_REFUSAL_TITLE = "This version cannot open your saved work";
export const SAVED_DATA_REFUSAL_MESSAGE =
  "Your saved work was opened by a newer version of Infinitary. Keep or reinstall a compatible alpha version, or wait for a compatible stable version. Your saved work has not been changed.";

export class UnsupportedSavedDataError extends Error {
  readonly code = "unsupported-saved-data";
  constructor(readonly reason: "database" | "persisted-format") {
    super(SAVED_DATA_REFUSAL_MESSAGE);
    this.name = "UnsupportedSavedDataError";
  }
}

const FORMAT_FILE = "saved-data-format.json";

/** Missing is the supported legacy format; malformed or unknown is never guessed. */
export function assertPersistedFormatsSupported(userDataDir: string): void {
  const path = join(userDataDir, FORMAT_FILE);
  if (!existsSync(path)) return;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).sort().join(",") !== "revision,schemaVersion" ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("revision" in value) ||
      value.revision !== PERSISTED_FORMAT_REVISION
    ) {
      throw new Error("unsupported format");
    }
  } catch {
    throw new UnsupportedSavedDataError("persisted-format");
  }
}

/** Only after compatibility succeeds and database initialization completes. */
export function recordPersistedFormat(userDataDir: string): void {
  const path = join(userDataDir, FORMAT_FILE);
  if (existsSync(path)) return;
  const pending = `${path}.tmp`;
  writeFileSync(
    pending,
    `${JSON.stringify({ schemaVersion: 1, revision: PERSISTED_FORMAT_REVISION })}\n`,
    { mode: 0o600 },
  );
  renameSync(pending, path);
}
