import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { checkCatalog } from "../models/catalogChecks";
import { createModelRuntime } from "./modelRuntime";

/**
 * The live half of the Pi catalog check (docs/model-lists.md): the pinned
 * catalog with pi.dev's overlay merged over it, exactly as the app's
 * runtime assembles it, held to the shared contract. A starter pi.dev's
 * newer generation has left behind (the Grok 4.7 case) fails here before it
 * ships, and the digest prints what the overlay brought.
 *
 * It runs where the other live probes run - the mac job of verify.yml,
 * every release and on demand, and a developer's Mac - and never on the
 * Linux PR check, which a pi.dev addition must not be able to break. It is
 * skipped, never passed, where pi.dev does not answer or Pi's offline
 * switch is on.
 *
 * Pi fetches the overlay only for a provider it holds a credential for, so
 * the throwaway store carries placeholder ones. Nothing is sent to any
 * provider: the overlay is an unauthenticated GET to pi.dev.
 */

const PI_PROVIDERS = [
  "openai-codex",
  "xai",
  "kimi-coding",
  "github-copilot",
  "openrouter",
] as const;

const live = process.platform === "darwin" && process.env.PI_OFFLINE === undefined;

async function piDevAnswers(): Promise<boolean> {
  try {
    const response = await fetch("https://pi.dev/api/models/providers/xai", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe.runIf(live)("the live Pi catalog (pi.dev overlay, live catalog probe)", () => {
  it("keeps every Pi default and tracked row current against the live overlay", async (context) => {
    if (!(await piDevAnswers())) {
      context.skip("pi.dev did not answer");
      return;
    }
    const dir = scratchDir("infinitary-pi-live-");
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        xai: { type: "api_key", key: "probe" },
        openrouter: { type: "api_key", key: "probe" },
        "kimi-coding": { type: "api_key", key: "probe" },
        "openai-codex": {
          type: "oauth",
          access: "probe",
          refresh: "probe",
          expires: 4_000_000_000_000,
        },
        "github-copilot": {
          type: "oauth",
          access: "probe",
          refresh: "probe",
          expires: 4_000_000_000_000,
        },
      }),
      { mode: 0o600 },
    );
    let settle: () => void = () => {};
    const refreshed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const runtime = await createModelRuntime({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      onCatalogRefreshed: () => settle(),
    });
    await refreshed;
    const failures: string[] = [];
    for (const providerId of PI_PROVIDERS) {
      const served = runtime.getModels(providerId).map((model) => model.id);
      const result = checkCatalog({ providerId, served });
      console.info(result.digest);
      failures.push(...result.failures);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  }, 60_000);
});
