import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The integrations' own settings (docs/integrations.md, "Where it lives"):
 * one file, `userData/integrations/settings.json` (0600 in a 0700 folder),
 * keyed by integration id - its name, whether it is paused, and which
 * actions are off. No sign-in is kept here: a kind's sign-in stays with
 * its own owner. `IntegrationsService` is its one writer.
 */

const SETTINGS_FILE = "settings.json";

const entrySchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    paused: z.boolean().optional(),
    off: z.array(z.string().min(1).max(48)).max(64).optional(),
  })
  .strict();
export type IntegrationSettings = z.infer<typeof entrySchema>;

const fileSchema = z.record(z.string().min(1).max(48), entrySchema);

export class IntegrationSettingsStore {
  constructor(readonly root: string) {}

  /** Every integration's settings; an unreadable file reads as none, with a warning. */
  read(): Record<string, IntegrationSettings> {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, SETTINGS_FILE), "utf8");
    } catch {
      return {};
    }
    try {
      return fileSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("[integrations] the settings file could not be read; using defaults");
      return {};
    }
  }

  /** Write the one file whole, never readable by anyone else even mid-write. */
  write(all: Record<string, IntegrationSettings>): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, SETTINGS_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
