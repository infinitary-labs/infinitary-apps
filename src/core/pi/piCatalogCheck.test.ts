import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { modelDisplayName } from "../../shared/modelDisplayName";
import { checkCatalog } from "../models/catalogChecks";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";

/**
 * The Pi-served providers' catalog check (docs/model-lists.md), hermetic:
 * the catalog pinned with the Pi SDK, read through the real runtime factory
 * with the network off. It runs on every PR (`linux-checks`), so a Pi bump
 * that drops a starter id, or a starter row added before Pi carries it -
 * Codex's `gpt-6-astra` named on 2026-09-10 while the pinned 0.84.1 had no
 * GPT-6 until the 0.87.1 bump on 2026-09-23 - fails the PR that does it.
 * The live half, against pi.dev's overlay, is piCatalogProbe.test.ts.
 */

const PI_PROVIDERS = ["openai-codex", "xai", "openrouter"] as const;

let previousOffline: string | undefined;

beforeAll(() => {
  // Pi's own switch: the background overlay refresh stays off, so this
  // reads exactly what the pinned SDK bundles.
  previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
});

afterAll(async () => {
  await catalogRefreshesSettled();
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
});

async function pinnedRuntime() {
  const dir = scratchDir("infinitary-pi-catalog-");
  writeFileSync(join(dir, "auth.json"), "{}", { mode: 0o600 });
  return createModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
}

describe("the pinned Pi catalog (hermetic catalog check)", () => {
  it("covers every maker prefix in the pinned OpenRouter display names without changing identity", async () => {
    const runtime = await pinnedRuntime();
    for (const model of runtime.getModels("openrouter")) {
      const prefix = model.name.indexOf(": ");
      if (prefix < 0) continue;
      const raw = { provider: model.provider, id: model.id, label: model.name };
      expect(modelDisplayName(raw), `${model.id} display name`).toBe(model.name.slice(prefix + 2));
      expect(raw.label).toBe(model.name);
    }
  });

  for (const providerId of PI_PROVIDERS) {
    it(`serves every ${providerId} default and tracked row, none a generation behind`, async () => {
      const runtime = await pinnedRuntime();
      const served = runtime.getModels(providerId).map((model) => model.id);
      expect(served.length, `the pinned catalog has no ${providerId} models`).toBeGreaterThan(0);
      const result = checkCatalog({ providerId, served });
      expect(result.failures, result.failures.join("\n")).toEqual([]);
    });
  }
});
