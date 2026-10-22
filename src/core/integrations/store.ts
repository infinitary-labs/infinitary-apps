import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationNameSchema, integrationRenameSchema } from "@shared/integrations";
import { z } from "zod";

/**
 * The integrations' own settings (docs/integrations.md, "Where it lives"):
 * one file, `userData/integrations/settings.json` (0600 in a 0700 folder),
 * keyed by integration id - its name, whether it is paused, and which
 * actions are off. No sign-in is kept here: a kind's sign-in stays with
 * its own owner. `IntegrationsService` is its one writer.
 * Name-repair explanations live separately: older builds strictly parse
 * settings.json, so adding a field there would lose every saved setting.
 */

const SETTINGS_FILE = "settings.json";
const REPAIRS_FILE = "name-repairs.json";

const entrySchema = z
  .object({
    name: integrationNameSchema.optional(),
    paused: z.boolean().optional(),
    off: z.array(z.string().min(1).max(48)).max(64).optional(),
  })
  .strict();
export type IntegrationSettings = z.infer<typeof entrySchema> & {
  renamed?: z.infer<typeof integrationRenameSchema>;
};

const idSchema = z.string().min(1).max(48);
const fileSchema = z.record(idSchema, entrySchema);
const repairsSchema = z.record(
  idSchema,
  z.strictObject({
    name: integrationNameSchema,
    renamed: integrationRenameSchema,
  }),
);

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
    let all: Record<string, IntegrationSettings>;
    try {
      all = fileSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("[integrations] the settings file could not be read; using defaults");
      return {};
    }
    // A missing or unreadable explanation never discards the settings. Match
    // its resulting name so a rename by an older app cannot show stale words.
    try {
      const repairs = repairsSchema.parse(
        JSON.parse(readFileSync(join(this.root, REPAIRS_FILE), "utf8")),
      );
      for (const [id, repair] of Object.entries(repairs)) {
        const entry = all[id];
        if (entry?.name === repair.name) entry.renamed = repair.renamed;
      }
    } catch {
      // Older installations have no name-repair file.
    }
    return all;
  }

  /** Keep the old settings shape readable, with name-bound explanations alongside it. */
  write(all: Record<string, IntegrationSettings>): void {
    const settings: z.infer<typeof fileSchema> = {};
    const repairs: z.infer<typeof repairsSchema> = {};
    for (const [id, { renamed, ...entry }] of Object.entries(all)) {
      settings[id] = entry;
      if (renamed && entry.name) repairs[id] = { name: entry.name, renamed };
    }
    // Write explanations first: if interrupted, they apply only after the
    // corresponding atomic settings write, and the old name can be repaired again.
    this.writeFile(REPAIRS_FILE, repairs);
    this.writeFile(SETTINGS_FILE, settings);
  }

  /** Write whole, never readable by anyone else even mid-write. */
  private writeFile(name: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, name);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}
