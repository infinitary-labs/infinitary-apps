import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime } from "../../src/core/pi/modelRuntime";
import type { ModelRuntime } from "../../src/core/pi/types";
import { scratchDir } from "./scratchDirs";

/** A model's window and price, where a world needs a real catalog entry's. */
export type StubLimits = Pick<
  NonNullable<ReturnType<ModelRuntime["getModel"]>>,
  "contextWindow" | "cost"
>;

/** A Codex model's window and price as Pi's bundled catalog ships them. */
export function codexLimits(id: string): StubLimits {
  const catalog = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json",
      ),
      "utf8",
    ),
  ) as Record<string, Record<string, StubLimits>>;
  const entry = catalog["openai-codex-responses"]?.[`chat:${id}`];
  if (!entry) throw new Error(`Pi's bundled catalog has no Codex model ${id}.`);
  return { contextWindow: entry.contextWindow, cost: entry.cost };
}

/**
 * A real Pi runtime, built the way the app builds one (`createModelRuntime`),
 * on its own store whose one provider is a local stub of the model's API in
 * the Anthropic dialect (`startStubApi`), offering more output than any
 * role's cap. Its catalog refresh asks the same stub, so nothing reaches the
 * network, and it resolves once that refresh has settled. No sign-in is read.
 * `others` are further models of the same provider it serves, for a world
 * where routing chooses between them. A model given `limits` takes that
 * window and price; the rest keep Pi's defaults.
 */
export async function piStubRuntime(
  baseUrl: string,
  model: { provider: string; id: string; input?: ("text" | "image")[]; limits?: StubLimits },
  others: readonly (string | { id: string; limits: StubLimits })[] = [],
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
          models: [model, ...others].map((entry) => {
            const { id, limits } =
              typeof entry === "string" ? { id: entry, limits: undefined } : entry;
            return {
              id,
              name: "Stub",
              input: model.input ?? ["text"],
              maxTokens: 32_000,
              ...limits,
            };
          }),
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
