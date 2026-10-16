import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ReasoningCapabilities } from "@shared/modelSlots";
import type { Reasoning } from "@shared/reasoning";
import { openingReasoning, type ThinkingLevel } from "../session/session";
import type { ModelRuntime } from "./types";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const CHOICES: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

/** The same corrected model definition drives menus and opening requests. */
export function piReasoningCapabilities(
  model: ReturnType<ModelRuntime["getModel"]>,
): ReasoningCapabilities | undefined {
  if (!model) return undefined;
  if (!model.reasoning) return { levels: [], fixed: "off" };
  const map = model.thinkingLevelMap;
  const supported = getSupportedThinkingLevels(model);
  const tokens = new Set<string>();
  const levels = CHOICES.filter((level) => {
    const token = map?.[level];
    if (!supported.includes(level)) return false;
    const identity = token ?? level;
    if (tokens.has(identity)) return false;
    tokens.add(identity);
    return true;
  });
  return levels.length ? { levels } : undefined;
}

/** Preserve inherited clamping and Quick's one-offered-rung adjustment. */
export function clampThinkingLevel(
  ref: { provider: string; id: string },
  runtime: ModelRuntime,
  requested: ThinkingLevel | undefined,
  quick = false,
): Reasoning & { level: Exclude<Reasoning["level"], "default"> } {
  const model = runtime.getModel(ref.provider, ref.id);
  if (!model?.reasoning) return { level: "off" };
  const available = getSupportedThinkingLevels(model);
  const supported = THINKING_LEVELS.filter((level) => available.includes(level));
  return (
    openingReasoning(THINKING_LEVELS, supported, requested ?? "medium", quick) ?? { level: "off" }
  );
}
