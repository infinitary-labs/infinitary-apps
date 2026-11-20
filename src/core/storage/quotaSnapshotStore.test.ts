import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "./db";
import { QUOTA_SNAPSHOTS_KEPT, QuotaSnapshotStore } from "./quotaSnapshotStore";

function snapshot(fetchedAt: number): QuotaSnapshotView {
  return {
    generatedAt: `2026-09-26T00:00:${String(fetchedAt % 60).padStart(2, "0")}Z`,
    fetchedAt,
    providers: [{ provider: "grok", label: "Grok", status: "ok", stale: false, windows: [] }],
  };
}

describe("QuotaSnapshotStore", () => {
  it("has no reading before the first refresh, then hands back the newest as written", () => {
    const store = new QuotaSnapshotStore(openInMemoryDatabase());
    expect(store.latestJson()).toBeUndefined();
    store.record(snapshot(1));
    store.record(snapshot(2));
    expect(JSON.parse(store.latestJson() ?? "null")).toEqual(snapshot(2));
  });

  it("keeps only the newest readings", () => {
    const db = openInMemoryDatabase();
    const store = new QuotaSnapshotStore(db);
    for (let at = 1; at <= QUOTA_SNAPSHOTS_KEPT + 5; at += 1) store.record(snapshot(at));
    const kept = db.prepare("SELECT fetched_at FROM quota_snapshots ORDER BY id").all() as {
      fetched_at: number;
    }[];
    expect(kept).toHaveLength(QUOTA_SNAPSHOTS_KEPT);
    expect(kept[0]?.fetched_at).toBe(6);
    expect(JSON.parse(store.latestJson() ?? "null")).toEqual(snapshot(QUOTA_SNAPSHOTS_KEPT + 5));
  });
});
