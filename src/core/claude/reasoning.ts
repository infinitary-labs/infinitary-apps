import type { ReasoningCapabilities } from "@shared/modelSlots";
import type { Reasoning } from "@shared/reasoning";
import { openingReasoning, type SessionSpec, type ThinkingLevel } from "../session/session";

export function claudeReasoningCapabilities(model: string | undefined): ReasoningCapabilities {
  const adjustable =
    model &&
    (/(?:^|-)(?:opus|sonnet|fable)(?:-|$)/.test(model) ||
      /^claude-haiku-5-5(?:-\d{8})?$/.test(model));
  return adjustable ? { levels: [...CLAUDE_EFFORT_RUNGS] } : { levels: [], fixed: "default" };
}

const CLAUDE_EFFORT_RUNGS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

/**
 * The effort a coding session opens at on the spec's model (FI3-439). The
 * client offers effort on Haiku 5.5, not Haiku 4.5; supported models accept the
 * coding rungs, capped to the request and one rung lower for Quick care. An
 * unknown model is left to the client rather than asked for a level it may
 * not support, so it keeps the model's own, as legacy Haiku does.
 */
export function claudeCodingReasoning(
  spec: Pick<SessionSpec, "model" | "thinking">,
): Reasoning & { level: ThinkingLevel | "default" } {
  const model = spec.model?.id;
  const offered = claudeReasoningCapabilities(model).levels;
  const level = spec.thinking.level;
  const opened =
    level === "off"
      ? undefined
      : openingReasoning(CLAUDE_EFFORT_RUNGS, offered, level, spec.thinking.quick === true);
  return opened ?? { level: "default" };
}
