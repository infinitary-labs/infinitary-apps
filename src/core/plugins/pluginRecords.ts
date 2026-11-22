import type { PluginCapabilities } from "@shared/plugins/manifest";
import type { AppDatabase } from "../storage/db";

/**
 * The installed-plugin record (one plugin vehicle, Phase A item 2;
 * migration 43): the ONE writer of the `plugins` table. A row says where a
 * panel or guidance runbook came from, what it was pinned to, and - the part that matters -
 * the capabilities the captain CONSENTED to, and for a runbook what each
 * of its panels may do. The host serves a plugin those
 * and nothing else, whatever the files on disk later ask for.
 *
 * `pending` is an install or an update the installer has staged and put
 * in front of the captain on the consent card; it becomes the installed
 * row only on his "Add it". A row with no `installedAt` was never added:
 * it is a pending install alone, and turning it down deletes it.
 */
export const PLUGIN_INSTALL_SOURCES = ["npm", "git", "path"] as const;
export type PluginInstallSource = (typeof PLUGIN_INSTALL_SOURCES)[number];

/** A plugin as it was staged: fetched, pinned, and checked, waiting to go in. */
export type StagedPlugin = {
  kind?: "panel" | "runbook";
  source: PluginInstallSource;
  /** What the captain named: a package spec, a git address, a folder. */
  spec: string;
  /** npm `<name>@<version> <integrity>`, a git commit, or `sha256:<hex>` of a folder's files. */
  pinned: string;
  name: string;
  version: string;
  title: string;
  capabilities: PluginCapabilities;
  /** A runbook's panels and what each asks, by folder, as its add card names them. */
  panels?: Record<string, PluginCapabilities>;
  stagedAt: number;
};

export type PluginRecord = {
  id: string;
  kind: "panel" | "runbook";
  source: PluginInstallSource | null;
  spec: string | null;
  pinned: string | null;
  name: string | null;
  version: string | null;
  /** What the captain agreed to; null while it was never added. */
  capabilities: PluginCapabilities | null;
  /**
   * What the captain agreed each of an added runbook's panels may do, by
   * folder; null for a panel, or a runbook added before its card asked.
   */
  panels: Record<string, PluginCapabilities> | null;
  installedAt: number | null;
  updatedAt: number;
  pending: StagedPlugin | null;
};

type Row = {
  id: string;
  kind: "panel" | "runbook";
  source: string | null;
  spec: string | null;
  pinned: string | null;
  name: string | null;
  version: string | null;
  capabilities_json: string | null;
  panels_json: string | null;
  installed_at: number | null;
  updated_at: number;
  pending_json: string | null;
};

export class PluginRecords {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): PluginRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  installed(): PluginRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM plugins WHERE installed_at IS NOT NULL ORDER BY id")
        .all() as Row[]
    ).map(fromRow);
  }

  pending(): PluginRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM plugins WHERE pending_json IS NOT NULL ORDER BY id")
        .all() as Row[]
    ).map(fromRow);
  }

  /** Stages an install or an update; a second stage for the same id replaces the first. */
  stage(id: string, staged: StagedPlugin): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO plugins (id, updated_at, pending_json) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET pending_json = excluded.pending_json, updated_at = excluded.updated_at`,
      )
      .run(id, at, JSON.stringify(staged));
  }

  /**
   * The staged plugin goes in: its source, pin, name, version and the
   * capabilities it asked for become the record, in one statement. The first
   * install stamps `installedAt`; an update keeps it.
   */
  commit(id: string, staged: StagedPlugin): PluginRecord {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO plugins (id, kind, source, spec, pinned, name, version, capabilities_json, panels_json, installed_at, updated_at, pending_json)
         VALUES (@id, @kind, @source, @spec, @pinned, @name, @version, @capabilities, @panels, @at, @at, NULL)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, source = excluded.source, spec = excluded.spec, pinned = excluded.pinned,
           name = excluded.name, version = excluded.version,
           capabilities_json = excluded.capabilities_json, panels_json = excluded.panels_json,
           installed_at = COALESCE(plugins.installed_at, excluded.installed_at),
           updated_at = excluded.updated_at, pending_json = NULL`,
      )
      .run({
        id,
        kind: staged.kind ?? "panel",
        source: staged.source,
        spec: staged.spec,
        pinned: staged.pinned,
        name: staged.name,
        version: staged.version,
        capabilities: JSON.stringify(staged.capabilities),
        panels: staged.panels ? JSON.stringify(staged.panels) : null,
        at,
      });
    return this.get(id) as PluginRecord;
  }

  /** The captain turned the staged plugin down: an update leaves the installed one as it was. */
  dropPending(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE plugins SET pending_json = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), id);
      this.db.prepare("DELETE FROM plugins WHERE id = ? AND installed_at IS NULL").run(id);
    })();
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
  }
}

function fromRow(row: Row): PluginRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: (row.source as PluginInstallSource | null) ?? null,
    spec: row.spec,
    pinned: row.pinned,
    name: row.name,
    version: row.version,
    capabilities: row.capabilities_json
      ? (JSON.parse(row.capabilities_json) as PluginCapabilities)
      : null,
    panels: row.panels_json
      ? (JSON.parse(row.panels_json) as Record<string, PluginCapabilities>)
      : null,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    pending: row.pending_json ? (JSON.parse(row.pending_json) as StagedPlugin) : null,
  };
}
