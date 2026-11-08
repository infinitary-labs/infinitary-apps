import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ModelsCatalogView,
  modelsCatalogViewSchema,
  type QuotaSnapshotView,
  quotaSnapshotViewSchema,
} from "../../src/shared/quota";

/** The reading a journey supplies: the fixture reader stamps `fetchedAt` when it is left out. */
export type QuotaFixtureSnapshot = Omit<QuotaSnapshotView, "fetchedAt"> & { fetchedAt?: number };

/**
 * INF-2394 measure 4: the finished-reading stand-in owns both files consumed by quota fixtures.
 * The journey supplies its actual readings and timestamps, never a second file envelope.
 * The catalog is optional, as it is to the reader: without one, routing runs on the slots alone.
 * Each file is checked against the schema the reader parses it with, so a reading the app would
 * refuse fails here, at the journey's own line, rather than as a quietly empty allowance.
 * @journey-area src/core/quota/
 */
export function seedQuotaFixture(
  dir: string,
  snapshot: QuotaFixtureSnapshot,
  catalog?: ModelsCatalogView,
): string {
  quotaSnapshotViewSchema.parse({ fetchedAt: Date.now(), ...snapshot });
  if (catalog) modelsCatalogViewSchema.parse(catalog);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  if (catalog) writeFileSync(join(dir, "models.json"), JSON.stringify(catalog));
  return dir;
}
