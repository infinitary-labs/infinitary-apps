import type { FmUsage } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import { openingReasoning, type ThinkingLevel } from "../session/session";
import { isRecord } from "./acpConnection";

/**
 * Readings of what the Agent Client Protocol carries, as plain functions:
 * the words in a content block, a tool call's name and arguments, the
 * models and thinking levels a session offers, and a turn's usage. The
 * input is `unknown` and anything unrecognized reads as nothing, the rule
 * the other backends' normalizers keep (`claudeEvents.ts`, `piEvents.ts`).
 */

/** The words of one content block; an image or a resource has none. */
export function contentText(content: unknown): string {
  if (!isRecord(content)) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

/**
 * The tool a call names, as the session's own tools name it when it is
 * one of them: the program may name an MCP tool with its server before it
 * (`infinitary/report`, `mcp_infinitary_report`). Any other call is named
 * by its kind, in the Pi dialect's words where one matches (`bash`,
 * `read`, `edit`), so a crewmate's Activity reads it as it reads Pi's.
 */
export function toolNameOf(update: Record<string, unknown>, own: ReadonlySet<string>): string {
  const title = typeof update.title === "string" ? update.title.trim() : "";
  const raw = isRecord(update.rawInput) ? update.rawInput : undefined;
  // Longest first, so `mcp_infinitary_emit_card` is emit_card, never a shorter name it ends in.
  const names = [...own].sort((a, b) => b.length - a.length);
  for (const candidate of [title, raw?.name, raw?.tool, raw?.toolName]) {
    if (typeof candidate !== "string") continue;
    if (own.has(candidate)) return candidate;
    if (!/infinitary/i.test(candidate)) continue;
    const named = names.find(
      (name) => /[/_:.]$/.test(candidate.slice(0, -name.length)) && candidate.endsWith(name),
    );
    if (named) return named;
  }
  switch (update.kind) {
    case "execute":
      return "bash";
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "delete":
    case "move":
    case "search":
    case "fetch":
    case "think":
      return update.kind;
    default:
      return title || "tool";
  }
}

/** A call's arguments: the program's raw input, its `arguments` when it nests them. */
export function toolArgsOf(update: Record<string, unknown>): Record<string, unknown> {
  const raw = update.rawInput;
  if (!isRecord(raw)) return {};
  if (isRecord(raw.arguments)) return raw.arguments;
  return raw;
}

/** The words a finished call answered with: its text content, else its raw output. */
export function toolResultText(update: Record<string, unknown>): string {
  const pieces: string[] = [];
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (isRecord(item) && item.type === "content") pieces.push(contentText(item.content));
    }
  }
  const text = pieces.filter(Boolean).join("\n");
  if (text) return text;
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw !== undefined && raw !== null) return JSON.stringify(raw);
  return "";
}

/** A model the session offers, and how the client chooses it. */
export type OfferedModel = { id: string; name: string };

export type ModelChoice = {
  current: string | undefined;
  offered: OfferedModel[];
  /** The config option that chooses the model, when the session offers one; else `session/set_model`. */
  configId?: string;
};

/**
 * The models a new or reopened session offers, from its `configOptions`
 * model selector or, on a program that sends none, its `models` list.
 */
export function modelChoiceOf(response: unknown): ModelChoice {
  if (!isRecord(response)) return { current: undefined, offered: [] };
  const option = selectOptions(response.configOptions).find(
    (candidate) => candidate.category === "model" || candidate.id === "model",
  );
  if (option) {
    return { current: option.current, offered: option.values, configId: option.id };
  }
  const models = isRecord(response.models) ? response.models : undefined;
  const offered: OfferedModel[] = [];
  if (Array.isArray(models?.availableModels)) {
    for (const model of models.availableModels) {
      if (isRecord(model) && typeof model.modelId === "string") {
        offered.push({
          id: model.modelId,
          name: typeof model.name === "string" ? model.name : model.modelId,
        });
      }
    }
  }
  return {
    current: typeof models?.currentModelId === "string" ? models.currentModelId : undefined,
    offered,
  };
}

/**
 * Infinitary offers Gemini models only (INF-3776): Google's forum reply
 * that permits apps like this one scopes them to the Gemini models in the
 * person's plan, though the program offers others to every client since
 * its 1.5.1.
 */
export function isGeminiModel(model: OfferedModel): boolean {
  return /gemini/i.test(model.id) || /gemini/i.test(model.name);
}

/**
 * The Gemini model a session runs on: the one asked for, which must be an
 * offered Gemini model, else the program's current one when it is Gemini,
 * else the first Gemini model it offers. A string is the refusal's words.
 */
export function chooseGeminiModel(
  choice: ModelChoice,
  wanted: string | undefined,
): OfferedModel | string {
  // A program that lists nothing offers only its own model.
  const own = choice.offered.length === 0;
  const offered = own
    ? choice.current
      ? [{ id: choice.current, name: choice.current }]
      : []
    : choice.offered;
  if (offered.length === 0) return "Antigravity offered no model to choose.";
  const gemini = offered.filter(isGeminiModel);
  const notGemini = (model: OfferedModel) =>
    `Infinitary runs Antigravity on Gemini models only, and ${model.name} is not one.`;
  if (wanted !== undefined) {
    const found = gemini.find((model) => model.id === wanted);
    if (found) return found;
    const named = offered.find((model) => model.id === wanted);
    return named
      ? notGemini(named)
      : `Antigravity does not offer the model ${wanted} on this sign-in.`;
  }
  const current = gemini.find((model) => model.id === choice.current);
  if (current) return current;
  if (gemini[0]) return gemini[0];
  return own && offered[0]
    ? notGemini(offered[0])
    : "Antigravity offers no Gemini model on this sign-in.";
}

/** The thinking levels a session offers, by the config option that sets them. */
export type ThinkingChoice = { configId: string; levels: Map<ThinkingLevel, string> };

const LEVEL_WORDS: readonly [ThinkingLevel, RegExp][] = [
  ["low", /\blow\b/i],
  ["medium", /\bmedium\b/i],
  ["high", /\bhigh\b/i],
  ["xhigh", /\b(?:max|xhigh|extra high)\b/i],
];

const LEVEL_ORDER: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

export function thinkingChoiceOf(response: unknown): ThinkingChoice | undefined {
  if (!isRecord(response)) return undefined;
  const option = selectOptions(response.configOptions).find(
    (candidate) => candidate.category === "thought_level",
  );
  if (!option) return undefined;
  const levels = new Map<ThinkingLevel, string>();
  for (const value of option.values) {
    const level = LEVEL_WORDS.find(
      ([, pattern]) => pattern.test(value.id) || pattern.test(value.name),
    )?.[0];
    if (level && !levels.has(level)) levels.set(level, value.id);
  }
  return levels.size > 0 ? { configId: option.id, levels } : undefined;
}

/**
 * The level a coding session opens at (FI3-439): the one asked for, or the
 * nearest below it the session offers, one rung lower for Quick care; the
 * model's own when the session offers none or the spec asks for none.
 */
export function openingThinking(
  choice: ThinkingChoice | undefined,
  level: ThinkingLevel | "off",
  quick: boolean,
): { reasoning: Reasoning; value?: string } {
  if (!choice || level === "off") return { reasoning: { level: "default" } };
  const offered = LEVEL_ORDER.filter((rung) => choice.levels.has(rung));
  const opened = openingReasoning(LEVEL_ORDER, offered, level, quick);
  if (!opened) return { reasoning: { level: "default" } };
  return { reasoning: opened, value: choice.levels.get(opened.level) };
}

/** A turn's usage, from a prompt answer's `usage` when the program reports one. */
export function usageOf(response: unknown): FmUsage | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  const usage = response.usage;
  const count = (key: string) =>
    typeof usage[key] === "number" && Number.isFinite(usage[key])
      ? (usage[key] as number)
      : undefined;
  const read: FmUsage = {};
  const input = count("inputTokens");
  const output = count("outputTokens");
  const cacheRead = count("cachedReadTokens");
  const cacheWrite = count("cachedWriteTokens");
  const reasoning = count("thoughtTokens");
  if (input !== undefined) read.input = input;
  if (output !== undefined) read.output = output;
  if (cacheRead !== undefined) read.cacheRead = cacheRead;
  if (cacheWrite !== undefined) read.cacheWrite = cacheWrite;
  if (reasoning !== undefined) read.reasoning = reasoning;
  return Object.keys(read).length > 0 ? read : undefined;
}

/** A version the program names, as three numbers; undefined when it names none. */
export function versionOf(text: unknown): [number, number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(
  version: [number, number, number],
  floor: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index++) {
    const a = version[index] ?? 0;
    const b = floor[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

type SelectOption = { id: string; category?: string; current?: string; values: OfferedModel[] };

/** A session's `configOptions` selectors, their grouped values flattened. */
function selectOptions(options: unknown): SelectOption[] {
  if (!Array.isArray(options)) return [];
  const out: SelectOption[] = [];
  for (const option of options) {
    if (!isRecord(option) || typeof option.id !== "string") continue;
    if (option.type !== undefined && option.type !== "select") continue;
    const values: OfferedModel[] = [];
    const visit = (items: unknown) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!isRecord(item)) continue;
        if (typeof item.value === "string") {
          values.push({
            id: item.value,
            name: typeof item.name === "string" ? item.name : item.value,
          });
        } else if (Array.isArray(item.options)) {
          visit(item.options);
        }
      }
    };
    visit(option.options);
    out.push({
      id: option.id,
      ...(typeof option.category === "string" ? { category: option.category } : {}),
      ...(typeof option.currentValue === "string" ? { current: option.currentValue } : {}),
      values,
    });
  }
  return out;
}
