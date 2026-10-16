import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { modelsCatalogViewSchema, quotaSnapshotViewSchema } from "@shared/quota";
import type { QuotaRefresh } from "./quotaService";

/** Dev/e2e seam: load a snapshot + catalog from files, no provider HTTP. */
export function createFixtureRefresh(
  dir: string,
  now: () => number = () => Date.now(),
): QuotaRefresh {
  return async () => {
    const snapshotRaw = JSON.parse(await readFile(join(dir, "snapshot.json"), "utf8")) as unknown;
    const snapshotParsed = quotaSnapshotViewSchema.safeParse(
      snapshotRaw && typeof snapshotRaw === "object"
        ? { fetchedAt: now(), ...(snapshotRaw as object) }
        : snapshotRaw,
    );
    if (!snapshotParsed.success) {
      throw new Error("quota fixture snapshot.json is not a QuotaSnapshotView");
    }
    let catalog = modelsCatalogViewSchema.safeParse({
      generatedAt: snapshotParsed.data.generatedAt,
      models: [],
    });
    try {
      const modelsRaw = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as unknown;
      const parsed = modelsCatalogViewSchema.safeParse(modelsRaw);
      if (parsed.success) catalog = parsed;
    } catch {
      // models.json is optional; routing degrades without a catalog.
    }
    if (!catalog.success) {
      throw new Error("quota fixture models.json is not a ModelsCatalogView");
    }
    return { snapshot: snapshotParsed.data, catalog: catalog.data };
  };
}
