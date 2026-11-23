import type { AppDatabase } from "../storage/db";

/**
 * The panels the host stopped (INF-2205 piece B, docs/personal-panels.md
 * "A stopped panel"): one owner for every source, kept in the home's
 * record so a reload, a restart, a reconnect or a closed notice cannot
 * quietly start a stopped panel again. Only the captain's Retry, or the
 * panel's removal, clears a stop.
 *
 * A stop is keyed by where the panel came from, its id, which runtime -
 * the one on the rail (`live`) or the one a crewmate is building apart
 * (`draft`) - and the code version that was stopped. A live panel stays
 * stopped whatever version it reaches next: a fix does not start itself on
 * the rail, it is tried apart as a draft and the captain's Retry starts it.
 * A draft is stopped only at the version that stopped, so the next save is
 * tried.
 *
 * The incident fields follow the freeze record's (src/core/freeze/
 * freezeRecorder.ts): an `incidentId`, the wall-clock `at` it was noticed
 * as a label, and how long the panel's loop was silent, measured on a
 * monotonic clock. A stop is written before the process is killed, so an
 * app that ends mid-stop keeps it; `termination` then says the kill was
 * never confirmed.
 */
export type PanelSource = "builtin" | "yours" | "installed";
export type PanelRuntimeKind = "live" | "draft";

export type PanelRuntimeIdentity = {
  source: PanelSource;
  id: string;
  runtime: PanelRuntimeKind;
  version: string;
};

/**
 * Why it stopped: its loop went silent past the deadline, or its process
 * ended on its own.
 */
export type PanelStopReason = "unresponsive" | "exited";

export type PanelStop = {
  incidentId: string;
  reason: PanelStopReason;
  /** When it was noticed, ISO wall time: a label only. */
  at: string;
  /** How long its loop was silent, on a monotonic clock; null for one that exited. */
  silentMs: number | null;
  /** The process was seen to end (`confirmed`), or it was written before the kill finished. */
  termination: "pending" | "confirmed" | "unconfirmed";
  version: string;
};

type Row = {
  incident_id: string;
  reason: string;
  at: string;
  silent_ms: number | null;
  termination: string;
  version: string;
};

export class PanelStops {
  constructor(private readonly db: AppDatabase) {}

  /**
   * The stop that holds this runtime, or null: any version for the live
   * runtime, this version for a draft.
   */
  holding(identity: PanelRuntimeIdentity): PanelStop | null {
    const row = (
      identity.runtime === "live"
        ? this.db
            .prepare(
              "SELECT incident_id, reason, at, silent_ms, termination, version FROM panel_stops " +
                "WHERE source = ? AND panel_id = ? AND runtime = ? LIMIT 1",
            )
            .get(identity.source, identity.id, identity.runtime)
        : this.db
            .prepare(
              "SELECT incident_id, reason, at, silent_ms, termination, version FROM panel_stops " +
                "WHERE source = ? AND panel_id = ? AND runtime = ? AND version = ?",
            )
            .get(identity.source, identity.id, identity.runtime, identity.version)
    ) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  record(identity: PanelRuntimeIdentity, stop: Omit<PanelStop, "version">): void {
    this.db
      .prepare(
        "INSERT INTO panel_stops (source, panel_id, runtime, version, incident_id, reason, at, silent_ms, termination) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(source, panel_id, runtime, version) DO UPDATE SET incident_id = excluded.incident_id, " +
          "reason = excluded.reason, at = excluded.at, silent_ms = excluded.silent_ms, termination = excluded.termination",
      )
      .run(
        identity.source,
        identity.id,
        identity.runtime,
        identity.version,
        stop.incidentId,
        stop.reason,
        stop.at,
        stop.silentMs,
        stop.termination,
      );
  }

  terminated(
    identity: PanelRuntimeIdentity,
    incidentId: string,
    termination: "confirmed" | "unconfirmed",
  ): void {
    this.db
      .prepare(
        "UPDATE panel_stops SET termination = ? WHERE source = ? AND panel_id = ? AND runtime = ? AND version = ? AND incident_id = ?",
      )
      .run(
        termination,
        identity.source,
        identity.id,
        identity.runtime,
        identity.version,
        incidentId,
      );
  }

  /** The captain's Retry, or the panel's removal: every stop of this runtime, at any version. */
  clear(identity: Omit<PanelRuntimeIdentity, "version">): boolean {
    const result = this.db
      .prepare("DELETE FROM panel_stops WHERE source = ? AND panel_id = ? AND runtime = ?")
      .run(identity.source, identity.id, identity.runtime);
    return result.changes > 0;
  }
}

function fromRow(row: Row): PanelStop {
  return {
    incidentId: row.incident_id,
    reason: row.reason === "exited" ? "exited" : "unresponsive",
    at: row.at,
    silentMs: row.silent_ms,
    termination:
      row.termination === "confirmed" || row.termination === "unconfirmed"
        ? row.termination
        : "pending",
    version: row.version,
  };
}
