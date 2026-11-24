import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CUSTOM_THINKING_LEVELS,
  type CustomCompaction,
  type CustomModelCost,
  type CustomStatedReasoning,
  customCacheRetentionSchema,
  customProtocolSchema,
} from "@shared/customApi";
import type {
  CustomApiFileView,
  CustomFileConnection,
  CustomFileDefinition,
  CustomFileWarning,
} from "@shared/customApiFile";
import { cutText } from "@shared/textCut";

/**
 * A connection file is Pi's own models.json (pi.dev/schemas/models.schema.json),
 * read with Infinitary's stricter rules: each `providers` entry with a base
 * address and one of the three protocols is one connection. Infinitary's own
 * settings sit in an `infinitary` object, so a later Pi key never collides
 * with them. Nothing in the file can send a key: each computer keeps its own.
 */

/** Pi's compatibility settings that say how a server reads reasoning and history; no other travels. */
const REASONING_COMPAT: Record<string, "boolean" | "string"> = {
  supportsReasoningEffort: "boolean",
  thinkingFormat: "string",
  requiresThinkingAsText: "boolean",
  requiresReasoningContentOnAssistantMessages: "boolean",
  requiresToolResultName: "boolean",
  requiresAssistantAfterToolResult: "boolean",
  thinkingTokenBudgetField: "string",
  supportsThinkingTokenBudget: "boolean",
  supportsMidConvoEffort: "boolean",
  forceAdaptiveThinking: "boolean",
  allowEmptySignature: "boolean",
};
/** The Pi model settings Infinitary reads; the rest are said to go unused. */
const MODEL_KEYS = new Set([
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "compat",
  "headers",
  "samplingParams",
  "samplingParamsByThinkingLevel",
  "infinitary",
]);
const MAX_MODELS = 100;

class Invalid extends Error {}
type Warning = CustomFileConnection["warnings"][number];
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Pi's own reading: `//` line comments and trailing commas are allowed, and
 * text inside strings is left alone.
 */
function stripJsonComments(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail?: string) => tail ?? (match[0] === '"' ? match : ""),
    );
}

/** The file's connections, each with what it refuses or warns of; `invalid` when it is not a models.json. */
export function readCustomApiFile(text: string): Omit<CustomApiFileView, "path"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return { failure: "invalid", connections: [] };
  }
  if (!isObject(parsed) || !isObject(parsed.providers))
    return { failure: "invalid", connections: [] };
  const builtin = new Set<string>(getBuiltinProviders());
  return {
    connections: Object.entries(parsed.providers).map(([name, entry]) => {
      const warnings: Warning[] = [];
      try {
        if (name.length > 256 || !isObject(entry)) throw new Invalid();
        if (builtin.has(name)) return { name, refused: "built-in", warnings };
        if (typeof entry.baseUrl !== "string" || !entry.baseUrl.trim())
          return { name, refused: "address", warnings };
        const protocol = customProtocolSchema.safeParse(entry.api);
        if (!protocol.success) return { name, refused: "protocol", warnings };
        return {
          name,
          warnings,
          definition: definitionOf(name, entry, protocol.data, warnings),
        };
      } catch (error) {
        if (!(error instanceof Invalid)) throw error;
        return { name, refused: "invalid", warnings: [] };
      }
    }),
  };
}

function definitionOf(
  name: string,
  entry: Json,
  protocol: CustomFileDefinition["protocol"],
  warnings: Warning[],
): CustomFileDefinition {
  const warn = (kind: CustomFileWarning, key?: string, model?: string) =>
    warnings.push({
      kind,
      ...(key ? { key: cutText(key, 128) } : {}),
      ...(model ? { model } : {}),
    });
  if (entry.apiKey !== undefined) warn("key", "apiKey");
  if (entry.oauth !== undefined) warn("oauth", "oauth");
  if (entry.authHeader !== undefined) warn("auth-header", "authHeader");
  if (entry.modelOverrides !== undefined) warn("model-overrides", "modelOverrides");
  const own = objectOr(entry.infinitary);
  for (const key of Object.keys(own))
    if (key !== "secretHeaders" && key !== "compaction") warn("unused", `infinitary.${key}`);
  const headers: CustomFileDefinition["headers"] = [];
  for (const [header, value] of Object.entries(objectOr(entry.headers))) {
    if (typeof value !== "string") throw new Invalid();
    // Pi reads these as an environment variable or a command's output; neither is ever run here.
    if (value.startsWith("$") || value.startsWith("!")) warn("header-reference", header);
    else headers.push({ name: header, secret: false, value });
  }
  const secret = own.secretHeaders ?? [];
  if (!Array.isArray(secret) || secret.some((header) => typeof header !== "string"))
    throw new Invalid();
  for (const header of secret as string[]) {
    const lower = header.toLowerCase();
    const named = headers.findIndex((entry) => entry.name.toLowerCase() === lower);
    // A secret header's value is typed on each computer, never read from the file.
    if (named >= 0) headers.splice(named, 1);
    headers.push({ name: header, secret: true });
  }
  const names = headers.map((header) => header.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Invalid();
  const compaction = compactionOf(own.compaction);
  const providerCompat = objectOr(entry.compat);
  if (entry.models !== undefined && !Array.isArray(entry.models)) throw new Invalid();
  const listed = (entry.models ?? []) as unknown[];
  if (listed.length > MAX_MODELS) throw new Invalid();
  const models = listed.map((raw) => {
    if (!isObject(raw) || typeof raw.id !== "string" || !raw.id || raw.id.length > 256)
      throw new Invalid();
    const id = raw.id;
    for (const key of Object.keys(raw)) if (!MODEL_KEYS.has(key)) warn("unused", key, id);
    if (
      (raw.baseUrl !== undefined && raw.baseUrl !== entry.baseUrl) ||
      (raw.api !== undefined && raw.api !== entry.api)
    )
      warn("model-address", raw.baseUrl !== undefined ? "baseUrl" : "api", id);
    if (raw.headers !== undefined) warn("model-headers", "headers", id);
    if (raw.samplingParams !== undefined || raw.samplingParamsByThinkingLevel !== undefined)
      warn(
        "sampling",
        raw.samplingParams !== undefined ? "samplingParams" : "samplingParamsByThinkingLevel",
        id,
      );
    const modelOwn = objectOr(raw.infinitary);
    for (const key of Object.keys(modelOwn))
      if (!["cacheRetention", "reasoningProfile", "compaction"].includes(key))
        warn("unused", `infinitary.${key}`, id);
    const context = positive(raw.contextWindow);
    const output = positive(raw.maxTokens);
    const input = inputOf(raw.input);
    const cost = costOf(raw.cost, (key) => warn("unused", key, id));
    const retention = customCacheRetentionSchema.optional().safeParse(modelOwn.cacheRetention);
    if (!retention.success) throw new Invalid();
    const cacheRetention = retention.data;
    if (modelOwn.reasoningProfile !== undefined && typeof modelOwn.reasoningProfile !== "string")
      throw new Invalid();
    const reasoningProfile = (modelOwn.reasoningProfile as string | undefined)?.slice(0, 512);
    const statedReasoning =
      raw.reasoning === true && !reasoningProfile
        ? reasoningOf(raw.thinkingLevelMap, { ...providerCompat, ...objectOr(raw.compat) }, (key) =>
            warn("unused", key, id),
          )
        : undefined;
    if (!statedReasoning) {
      if (raw.thinkingLevelMap !== undefined && !reasoningProfile)
        warn("unused", "thinkingLevelMap", id);
      for (const key of Object.keys({ ...providerCompat, ...objectOr(raw.compat) }))
        warn("unused", `compat.${key}`, id);
    }
    const own = compactionOf(modelOwn.compaction);
    const kept = { ...compaction, ...own };
    if (
      context &&
      output &&
      (kept.keepRecentTokens ?? 0) + (kept.reserveTokens ?? 0) >= context - output
    )
      warn("compaction", "compaction", id);
    const label = typeof raw.name === "string" ? raw.name.trim() : "";
    return {
      id,
      context,
      output,
      input,
      ...(label ? { name: cutText(label, 128) } : {}),
      ...(cost ? { cost } : {}),
      ...(cacheRetention ? { cacheRetention } : {}),
      ...(reasoningProfile ? { reasoningProfile } : {}),
      ...(statedReasoning ? { statedReasoning } : {}),
      ...(own ? { compaction: own } : {}),
    };
  });
  const ids = models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) throw new Invalid();
  const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : name;
  return {
    label: cutText(label, 64),
    baseUrl: (entry.baseUrl as string).trim(),
    protocol,
    headers,
    ...(compaction ? { compaction } : {}),
    models,
  };
}

function objectOr(value: unknown): Json {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Invalid();
  return value;
}

/** A limit the file leaves out is zero: unknown until the server's list says it. */
function positive(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Invalid();
  return value;
}

/** Pi's default is text alone, so a picture is tried only when the file names `image`. */
function inputOf(value: unknown): ("text" | "image")[] {
  if (value === undefined) return ["text"];
  if (!Array.isArray(value) || value.some((kind) => kind !== "text" && kind !== "image"))
    throw new Invalid();
  return [...new Set(value as ("text" | "image")[])];
}

/** US dollars per million tokens, Pi's unit and the catalog's; a price left out stays unknown. */
function costOf(value: unknown, unused: (key: string) => void): CustomModelCost | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Invalid();
  const cost: CustomModelCost = {};
  for (const [key, price] of Object.entries(value)) {
    if (key === "input" || key === "output" || key === "cacheRead" || key === "cacheWrite") {
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000)
        throw new Invalid();
      cost[key] = price;
    } else unused(`cost.${key}`);
  }
  return Object.keys(cost).length ? cost : undefined;
}

function compactionOf(value: unknown): CustomCompaction | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Invalid();
  const compaction: CustomCompaction = {};
  for (const key of ["keepRecentTokens", "reserveTokens"] as const)
    if (value[key] !== undefined) compaction[key] = positive(value[key]);
  return Object.keys(compaction).length ? compaction : undefined;
}

function reasoningOf(
  map: unknown,
  compat: Json,
  unused: (key: string) => void,
): CustomStatedReasoning {
  const stated: CustomStatedReasoning = {};
  if (map !== undefined) {
    if (!isObject(map)) throw new Invalid();
    const levels: NonNullable<CustomStatedReasoning["thinkingLevelMap"]> = {};
    for (const [level, value] of Object.entries(map)) {
      if (!(CUSTOM_THINKING_LEVELS as readonly string[]).includes(level)) throw new Invalid();
      if (value !== null && (typeof value !== "string" || value.length > 64)) throw new Invalid();
      levels[level as (typeof CUSTOM_THINKING_LEVELS)[number]] = value;
    }
    stated.thinkingLevelMap = levels;
  }
  const kept: NonNullable<CustomStatedReasoning["compat"]> = {};
  for (const [key, value] of Object.entries(compat)) {
    const kind = REASONING_COMPAT[key];
    if (!kind) unused(`compat.${key}`);
    else if (typeof value !== kind || (typeof value === "string" && value.length > 64))
      throw new Invalid();
    else kept[key] = value as boolean | string;
  }
  if (Object.keys(kept).length) stated.compat = kept;
  return stated;
}
