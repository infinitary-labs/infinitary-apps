import type { QuotaSnapshotView } from "@shared/quota";
import type { AppDatabase } from "./db";

/**
 * The quota readings a refresh produced (`quota_snapshots`): the newest one
 * restores the last-known reading at boot (stale beats wrong, D-7), and the
 * published views read the newest through `views.ts`. Only the newest
 * `QUOTA_SNAPSHOTS_KEPT` rows stay. The one writer of the table.
 */

export const QUOTA_SNAPSHOTS_KEPT = 50;

export class QuotaSnapshotStore {
  constructor(private readonly db: AppDatabase) {}

  latestJson(): string | undefined {
    const row = this.db
      .prepare("SELECT json FROM quota_snapshots ORDER BY id DESC LIMIT 1")
      .get() as { json: string } | undefined;
    return row?.json;
  }

  record(snapshot: QuotaSnapshotView): void {
    this.db
      .prepare("INSERT INTO quota_snapshots (generated_at, fetched_at, json) VALUES (?, ?, ?)")
      .run(snapshot.generatedAt, snapshot.fetchedAt, JSON.stringify(snapshot));
    this.db
      .prepare(
        `DELETE FROM quota_snapshots WHERE id NOT IN (SELECT id FROM quota_snapshots ORDER BY id DESC LIMIT ${QUOTA_SNAPSHOTS_KEPT})`,
      )
      .run();
  }
}
