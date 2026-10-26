import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime } from "../../src/core/pi/modelRuntime";
import type { ModelRuntime } from "../../src/core/pi/types";
import { scratchDir } from "./scratchDirs";

/**
 * A real Pi runtime, built the way the app builds one (`createModelRuntime`),
 * on its own store whose one provider is a local stub of the model's API in
 * the Anthropic dialect (`startStubApi`), offering more output than any
 * role's cap. Its catalog refresh asks the same stub, so nothing reaches the
 * network, and it resolves once that refresh has settled. No sign-in is read.
 * `others` are further models of the same provider it serves, for a world
 * where routing chooses between them.
 */
export async function piStubRuntime(
  baseUrl: string,
  model: { provider: string; id: string; input?: ("text" | "image")[] },
  others: readonly string[] = [],
): Promise<ModelRuntime> {
  const store = join(scratchDir("infinitary-pi-stub-store-"), "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const modelsPath = join(store, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [model.provider]: {
          name: "Stub",
          baseUrl,
          api: "anthropic-messages",
          apiKey: "stub-key",
          models: [model.id, ...others].map((id) => ({
            id,
            name: "Stub",
            input: model.input ?? ["text"],
            maxTokens: 32_000,
          })),
        },
      },
    }),
  );
  let refreshed: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    refreshed = resolve;
  });
  const runtime = await createModelRuntime({
    authPath: join(store, "auth.json"),
    modelsPath,
    catalogBaseUrl: baseUrl,
    onCatalogRefreshed: () => refreshed(),
  });
  await settled;
  return runtime;
}
