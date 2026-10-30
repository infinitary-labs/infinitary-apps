import { offeringKey, parseOfferingKey, type SlotModelView } from "./modelSlots";

/** Catalog maker namespaces, not guesses from a human-written model name.
 * OpenRouter has no separate prefix-free name. Remove only a known exact
 * leading prefix for its maker; unknown/custom names keep their wording.
 * Alternate spellings are explicit (x-ai currently serves both names).
 */
const OPENROUTER_MAKERS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["Anthropic"],
  openai: ["OpenAI"],
  google: ["Google"],
  "x-ai": ["xAI", "SpaceXAI"],
  deepseek: ["DeepSeek"],
  elorian: ["Elorian"],
  recursive: ["Recursive"],
  reflection: ["Reflection"],
  "xingchen-agi": ["XingChen"],
  moonshotai: ["MoonshotAI"],
  "z-ai": ["Z.ai"],
  "aion-labs": ["AionLabs"],
  amazon: ["Amazon"],
  apodex: ["Apodex"],
  "arcee-ai": ["Arcee AI"],
  "bytedance-seed": ["ByteDance Seed"],
  cohere: ["Cohere"],
  "dots-studio": ["Dots Studio"],
  fireworks: ["Fireworks"],
  "ibm-granite": ["IBM"],
  inception: ["Inception"],
  inclusionai: ["inclusionAI"],
  kwaipilot: ["Kwaipilot"],
  liquid: ["LiquidAI"],
  meituan: ["Meituan"],
  "meta-llama": ["Meta"],
  meta: ["Meta"],
  minimax: ["MiniMax"],
  mistralai: ["Mistral"],
  "nex-agi": ["Nex AGI"],
  nvidia: ["NVIDIA"],
  openrouter: ["OpenRouter"],
  perceptron: ["Perceptron"],
  poolside: ["Poolside"],
  "prism-ml": ["PrismML"],
  qwen: ["Qwen"],
  relace: ["Relace"],
  sakana: ["Sakana"],
  sao10k: ["Sao10K"],
  stepfun: ["StepFun"],
  tencent: ["Tencent"],
  thinkingmachines: ["Thinking Machines"],
  typesafe: ["TypeSafe"],
  upstage: ["Upstage"],
  xiaomi: ["Xiaomi"],
};

/** Display only: never mutates catalog labels, model IDs or routing records. */
export function modelDisplayName(model: Pick<SlotModelView, "provider" | "id" | "label">): string {
  if (model.provider !== "openrouter") return model.label;
  const namespace = model.id.replace(/^~/, "").split("/")[0] ?? "";
  const makers = Object.hasOwn(OPENROUTER_MAKERS, namespace)
    ? (OPENROUTER_MAKERS[namespace] ?? [])
    : [];
  for (const maker of makers) {
    const prefix = `${maker}: `;
    if (model.label.startsWith(prefix) && model.label.length > prefix.length) {
      return model.label.slice(prefix.length);
    }
  }
  return model.label;
}

/**
 * The one model-name lookup (FI3-565 piece 2): a task's model by the name
 * its Settings → Models row gives it, listed or by name, through
 * `modelDisplayName`; its bare id when no row names it. The core reads the
 * same rows (`ModelSlots.nameOf`) and the renderer reads them from
 * `models.slots()`, so the summary, the record, Activity and the fact strip
 * never name one model two ways.
 */
export function modelNames(
  rows: readonly Pick<SlotModelView, "provider" | "id" | "label">[],
): (model: string) => string {
  const names = new Map(rows.map((row) => [offeringKey(row), modelDisplayName(row)]));
  return (model) => names.get(model) ?? parseOfferingKey(model).id;
}
