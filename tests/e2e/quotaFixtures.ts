import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * INF-2394 measure 4: the finished-reading stand-in owns both files consumed by quota fixtures.
 * The journey supplies its actual readings and timestamps, never a second file envelope.
 * @journey-area src/core/quota/
 */
export function seedQuotaFixture(
  dir: string,
  snapshot: { generatedAt: string; providers: unknown[] },
  catalog: { generatedAt: string; models: unknown[] },
): void {
  mkdirSync(dir);
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot));
  writeFileSync(join(dir, "models.json"), JSON.stringify(catalog));
}
