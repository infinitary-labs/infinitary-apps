import type { ClassifierModel, Provider } from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { OPENCODE_GO_PROVIDER_ID } from "@shared/providers";

/** OpenCode Go's System One address, under the same Go key as its chat models. */
export const OPENCODE_GO_DECISIONS_BASE_URL = "https://opencode.ai/inference/go/systemone/v1";

const listed = (id: string, name: string, input: number, contextWindow: number) =>
  ({
    type: "classifier",
    id,
    name,
    api: "typesafe-system-one",
    provider: OPENCODE_GO_PROVIDER_ID,
    baseUrl: OPENCODE_GO_DECISIONS_BASE_URL,
    input: ["text"],
    // Dollars per million tokens, as OpenCode's own model list states them.
    cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
  }) satisfies ClassifierModel<"typesafe-system-one">;

/**
 * Go's decision models as OpenCode's model list (`/inference/go/v1/models`)
 * names them. Pi 1.5.0 lists none for opencode-go, though its OpenCode Zen
 * provider lists Zen's in this exact shape. The captain chose to add them
 * here until Pi lists them (INF-6873); which of them Decisions offers is
 * `decisionModels.ts`'s choice-capable list, not this one.
 */
// i18n-exempt: model names
export const OPENCODE_GO_DECISION_MODELS: readonly ClassifierModel<"typesafe-system-one">[] = [
  listed("jev-1.14", "Jev 1.14", 0.042, 64_000),
  listed("gpt-6-luna-decision", "GPT-6 Luna Decision", 0.1, 922_000),
  listed("gemini-decision-1", "Gemini Decision 1", 0.1, 262_144),
];

/**
 * Pi's opencode-go provider with Go's decision models and the System One
 * call added. Only a provider that can classify is returned unchanged: the
 * pi.dev catalog overlay may list Go's classifiers on a Pi whose provider
 * still has no `classify`, so a listing alone never retires the wrap, and a
 * model Pi lists replaces ours of the same id. Delete this wrap with the Pi
 * update whose provider classifies.
 */
export function withOpenCodeGoDecisions(stock: Provider): Provider {
  if (stock.classify) return stock;
  const all = () => stock.getAllModels?.() ?? stock.getModels();
  const api = typesafeSystemOneApi();
  return {
    ...stock,
    getAllModels: () => {
      const listed = all();
      return [
        ...listed,
        ...OPENCODE_GO_DECISION_MODELS.filter(
          (ours) => !listed.some((model) => model.type === "classifier" && model.id === ours.id),
        ),
      ];
    },
    classify: (model, context, options) =>
      api.classify(model as ClassifierModel<"typesafe-system-one">, context, options),
  };
}
