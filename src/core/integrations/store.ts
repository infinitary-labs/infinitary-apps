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
 * Name-repair explanations and off actions past an older build's count live
 * separately: older builds strictly parse settings.json, so adding a field
 * there, or a longer off list, would lose every saved setting.
 */

const SETTINGS_FILE = "settings.json";
const REPAIRS_FILE = "name-repairs.json";
const MORE_OFF_FILE = "actions-off.json";
const CONNECTIONS_FILE = "connections.json";

/**
 * The most off actions an older build's strict reader takes in one
 * settings.json entry (INF-1407); one more and it reads every setting as
 * the defaults. A connection that has had more keeps its whole off list in
 * actions-off.json, and settings.json its first ones.
 */
export const OLDER_BUILD_OFF_MAX = 64;

const actionNameSchema = z.string().min(1).max(48);
const entrySchema = z
  .object({
    name: integrationNameSchema.optional(),
    paused: z.boolean().optional(),
    // Any length: a build before INF-1407 wrote every off action here.
    off: z.array(actionNameSchema).optional(),
  })
  .strict();
export type IntegrationSettings = z.infer<typeof entrySchema> & {
  renamed?: z.infer<typeof integrationRenameSchema>;
};

const idSchema = z.string().min(1).max(48);
const fileSchema = z.record(idSchema, entrySchema);
const moreOffSchema = z.record(idSchema, z.array(actionNameSchema));
const repairsSchema = z.record(
  idSchema,
  z.strictObject({
    name: integrationNameSchema,
    renamed: integrationRenameSchema,
  }),
);

/**
 * Which connection an id stands for now (docs/integrations.md, "Which
 * connection"): a reference made once for each connection and never
 * reused, and the account it was first signed in as, if any.
 */
const connectionsSchema = z.record(
  idSchema,
  z.strictObject({ ref: z.string().min(1).max(64), account: z.string().max(320).nullable() }),
);
export type IntegrationConnectionRefs = z.infer<typeof connectionsSchema>;

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
    // A whole off list applies only while the connection still has its
    // settings: an older build that forgot the connection leaves it behind.
    // Joined, an action off in either file stays off.
    for (const [id, off] of Object.entries(this.moreOff())) {
      const entry = all[id];
      if (entry) entry.off = [...new Set([...(entry.off ?? []), ...off])].sort();
    }
    return all;
  }

  /**
   * Keep the old settings shape readable, with name-bound explanations and
   * the whole off lists an older build cannot read alongside it.
   */
  write(all: Record<string, IntegrationSettings>): void {
    const settings: z.infer<typeof fileSchema> = {};
    const repairs: z.infer<typeof repairsSchema> = {};
    const more: z.infer<typeof moreOffSchema> = {};
    const kept = this.moreOff();
    for (const [id, { renamed, ...entry }] of Object.entries(all)) {
      settings[id] = entry;
      // Once a connection has had more off actions than an older build
      // reads, its whole list stays here while any is off, so dropping back
      // under the count never depends on two files written together.
      if (entry.off && (entry.off.length > OLDER_BUILD_OFF_MAX || (kept[id] && entry.off.length))) {
        more[id] = entry.off;
        settings[id] = { ...entry, off: entry.off.slice(0, OLDER_BUILD_OFF_MAX) };
      }
      if (renamed && entry.name) repairs[id] = { name: entry.name, renamed };
    }
    // Write explanations and whole off lists first: if interrupted, they
    // apply only beside the matching settings, and joined with the older
    // settings every action off in the new list is still off.
    this.writeFile(REPAIRS_FILE, repairs);
    this.writeFile(MORE_OFF_FILE, more);
    this.writeFile(SETTINGS_FILE, settings);
  }

  /** Each connection's whole off list past an older build's count; unreadable reads as none. */
  private moreOff(): z.infer<typeof moreOffSchema> {
    try {
      return moreOffSchema.parse(JSON.parse(readFileSync(join(this.root, MORE_OFF_FILE), "utf8")));
    } catch {
      return {};
    }
  }

  /** Each id's connection reference; an unreadable file reads as none, so every one is made again. */
  connections(): IntegrationConnectionRefs {
    try {
      return connectionsSchema.parse(
        JSON.parse(readFileSync(join(this.root, CONNECTIONS_FILE), "utf8")),
      );
    } catch {
      return {};
    }
  }

  writeConnections(refs: IntegrationConnectionRefs): void {
    this.writeFile(CONNECTIONS_FILE, refs);
  }

  /** INF-950: connection-bound grants live beside the older strict settings file. */
  approvals(): Record<string, Record<string, string>> {
    try {
      return z
        .record(z.string(), z.record(z.string(), z.string()))
        .parse(JSON.parse(readFileSync(join(this.root, "action-approvals.json"), "utf8")));
    } catch {
      return {};
    }
  }

  writeApprovals(value: Record<string, Record<string, string>>): void {
    this.writeFile("action-approvals.json", value);
  }

  /**
   * Each action's rule mark by connection reference (INF-2993): a fresh one
   * whenever its rule or its switch changes, so an Allow for the rest of
   * this task chosen under an older mark has ended. An unreadable file reads
   * as none, which ends every allowance chosen under a mark.
   */
  ruleMarks(): Record<string, Record<string, string>> {
    try {
      return z
        .record(z.string(), z.record(z.string(), z.string()))
        .parse(JSON.parse(readFileSync(join(this.root, "rule-marks.json"), "utf8")));
    } catch {
      return {};
    }
  }

  writeRuleMarks(value: Record<string, Record<string, string>>): void {
    this.writeFile("rule-marks.json", value);
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
