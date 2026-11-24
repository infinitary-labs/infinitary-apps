import { z } from "zod";
import { HERE } from "./deviceNames";
import { formatNumber } from "./i18n/format.ts";

export const CUSTOM_TOKEN_FAILURE = {
  message:
    "The token command failed. Renew your organization’s sign-in, or edit the command and save again.",
  row: "The token command failed. Renew your organization’s sign-in, or press Edit and save the command again.",
  status: "Token command failed",
} as const;

export const customNetworkModeSchema = z.enum(["public", "private", "local"]);
export type CustomNetworkMode = z.infer<typeof customNetworkModeSchema>;
/**
 * The words for the network an address points to, as the form shows them under it.
 * `who` names the computer that reads the address: this Mac, or that computer.
 */
export function customNetworkLabel(network: CustomNetworkMode, who: string = HERE.this): string {
  if (network === "local") return `On ${who}`;
  if (network === "private") return "Your organization's network";
  return "Public internet";
}
/**
 * One DNS answer for an address's name, and the kind of network it points to:
 * `reserved` is a range Infinitary never sends to without an exception.
 */
export const customApiAnswerSchema = z.object({
  address: z.string().max(64),
  kind: z.enum(["local", "private", "public", "reserved"]),
});
export type CustomApiAnswer = z.infer<typeof customApiAnswerSchema>;
/** Why a custom connection's step failed, as a closed category the form places at its field. */
export const customApiFailureCategorySchema = z.enum([
  "address",
  "destination",
  "credential",
  "header",
  "redirect",
  "key-rejected",
  "access-refused",
  "not-found",
  "rate-limit",
  "server",
  "certificate",
  "network",
  "timeout",
  "stalled",
  "cancelled",
  "closed",
  "oversized",
  "malformed",
  "certificate-policy",
  "incompatible",
  "limits",
  "context-limit",
]);
export type CustomApiFailureCategory = z.infer<typeof customApiFailureCategorySchema>;
export const customProtocolSchema = z.enum([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
export const customCacheRetentionSchema = z.enum(["none", "short", "long"]);
/** What a model with no capability profile may ask for: Messages may cache short, the rest not at all. */
export function customUnprofiledRetentions(
  protocol: z.infer<typeof customProtocolSchema>,
): z.infer<typeof customCacheRetentionSchema>[] {
  return protocol === "anthropic-messages" ? ["none", "short"] : ["none"];
}
/**
 * A model saved without a cache setting: Claude's Messages format caches by
 * Pi's own default (short); the OpenAI formats stay off until a profile unlocks it.
 */
export function customDefaultCacheRetention(
  protocol: z.infer<typeof customProtocolSchema>,
): z.infer<typeof customCacheRetentionSchema> {
  return protocol === "anthropic-messages" ? "short" : "none";
}
export const customCapabilityProfileSchema = z.object({
  id: z.string(),
  label: z.string(),
  protocol: customProtocolSchema,
  cacheRetentions: z.array(customCacheRetentionSchema),
});
export type CustomCapabilityProfile = z.infer<typeof customCapabilityProfileSchema>;
/**
 * The profile a model line takes before anyone chooses one: the first on its
 * protocol, in catalog order, listing exactly the line's model ID - the rule
 * the name and price lookup follows. A profile's ID is `provider/model`, and
 * a provider's ID holds no slash.
 */
export function customExactProfile(
  profiles: readonly CustomCapabilityProfile[],
  protocol: z.infer<typeof customProtocolSchema>,
  modelId: string,
): string | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  return profiles.find(
    (profile) =>
      profile.protocol === protocol && profile.id.slice(profile.id.indexOf("/") + 1) === id,
  )?.id;
}
/** US dollars per million tokens, the catalog's unit; zero is a real price, never unknown. */
const customPriceSchema = z.number().finite().nonnegative().max(1_000_000);
/** A price left out takes the catalog match's, else stays unknown. */
export const customModelCostSchema = z.object({
  input: customPriceSchema.optional(),
  output: customPriceSchema.optional(),
  cacheRead: customPriceSchema.optional(),
  cacheWrite: customPriceSchema.optional(),
});
export type CustomModelCost = z.infer<typeof customModelCostSchema>;
/**
 * How much recent history a rolling session keeps and how much room its
 * summary reserves, in tokens. Either replaces Pi's own cap, and both stay
 * within the room the model's window leaves.
 */
export const customCompactionSchema = z.object({
  keepRecentTokens: z.number().int().positive().max(100_000_000).optional(),
  reserveTokens: z.number().int().positive().max(100_000_000).optional(),
});
export type CustomCompaction = z.infer<typeof customCompactionSchema>;
export const CUSTOM_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
/**
 * Reasoning a connection file states for a model with no catalog profile:
 * the provider's own value for each level (null where it refuses one) and
 * the few compatibility settings that say how the server reads reasoning
 * and history. Checked like a profile's, at every level it offers.
 */
export const customStatedReasoningSchema = z.object({
  thinkingLevelMap: z
    .partialRecord(z.enum(CUSTOM_THINKING_LEVELS), z.string().max(64).nullable())
    .optional(),
  compat: z.record(z.string().max(64), z.union([z.boolean(), z.string().max(64)])).optional(),
});
export type CustomStatedReasoning = z.infer<typeof customStatedReasoningSchema>;
export const customModelInputSchema = z.object({
  id: z.string().min(1).max(256),
  context: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  /** Absent on older connections: reasoning off and explicit caching off. */
  reasoningProfile: z.string().max(512).optional(),
  cacheRetention: customCacheRetentionSchema.optional(),
  /**
   * What the person calls the model and what it costs, both winning over the
   * catalog match. Neither is part of a model's check, so editing them never
   * checks it again.
   */
  name: z.string().trim().min(1).max(128).optional(),
  cost: customModelCostSchema.optional(),
  /**
   * What a connection file says the model reads. Absent (a typed line), the
   * check tries a picture; without `image`, it sends none and the model stays text-only.
   */
  input: z
    .array(z.enum(["text", "image"]))
    .max(2)
    .optional(),
  /** A connection file's own reasoning for a model with no profile. */
  statedReasoning: customStatedReasoningSchema.optional(),
  /** Wins over the connection's, one value at a time. */
  compaction: customCompactionSchema.optional(),
});
/**
 * An extra header the organisation's server needs on every request. A secret
 * value is never returned by any view; an empty secret value on a draft of the
 * same address keeps the value already saved under that name.
 */
export const customHeaderInputSchema = z.object({
  name: z.string().max(128),
  value: z.string().max(8192),
  secret: z.boolean(),
});
export type CustomHeaderInput = z.infer<typeof customHeaderInputSchema>;
export const CUSTOM_API_MAX_HEADERS = 20;
export const customApiInputSchema = z.object({
  label: z.string().trim().min(1).max(64),
  baseUrl: z.string().max(4096),
  mode: customNetworkModeSchema,
  protocol: customProtocolSchema,
  /** The only secret-bearing request; never returned by any view. */
  key: z.string().max(8192),
  noKey: z.boolean(),
  /** Settings-approved shell command; only its stdout token stays in memory. */
  tokenCommand: z
    .object({ command: z.string().min(1), refreshSeconds: z.number().int().positive() })
    .optional(),
  /** Absent in connections saved before FI3-974. */
  headers: z.array(customHeaderInputSchema).max(CUSTOM_API_MAX_HEADERS).default([]),
  approvedDestination: z.string().max(4096),
  // Legacy field name retained for saved-data compatibility; approves HTTP in any mode.
  unencryptedLocalApproved: z.boolean(),
  certificates: z
    .object({ pem: z.string().max(65536), fingerprints: z.array(z.string()).max(8) })
    .optional(),
  allowStorageDefault: z.boolean(),
  storageApproved: z.boolean(),
  /** May be empty while a draft reads the server's model list; saving needs one. */
  models: z.array(customModelInputSchema).max(100),
  /** Same-address candidate only. A changed address creates a new connection. */
  replaceAccountId: z.string().optional(),
  /** Re-edit a private draft without returning its literal key to the UI. */
  sourceDraftId: z.string().optional(),
  /** Reuse the same connection's public CAs after fingerprint approval. */
  useExistingCertificates: z.boolean().optional(),
  /**
   * The canonical address the person made an exception for, after the form
   * told them what DNS answered: its name may then point to reserved or mixed
   * networks. Absent, the network check refuses those answers, as always.
   */
  addressException: z.string().max(4096).optional(),
  compaction: customCompactionSchema.optional(),
  /**
   * The provider's key in the connection file this connection was approved
   * from: its identity there, so the file's later edits reach it.
   */
  file: z.string().min(1).max(256).optional(),
  /**
   * The first mate's computer's connection this one was approved from on a
   * computer that runs work (its account id there), so that connection's
   * later edits reach it. A connection follows the file or the home, never both.
   */
  home: z.string().min(1).max(256).optional(),
});
export type CustomApiInput = z.infer<typeof customApiInputSchema>;
/**
 * What Save and Fetch from server send. There is no network choice: the core
 * reads it from the address's DNS answers, and a same-address edit keeps the
 * class the connection was saved with.
 */
export const customApiConnectInputSchema = customApiInputSchema.omit({ mode: true });
export type CustomApiConnectInput = z.infer<typeof customApiConnectInputSchema>;
/** One model from the server's own list; a limit it does not state stays absent. */
export const customListedModelSchema = z.object({
  id: z.string().min(1).max(256),
  context: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
});
export type CustomListedModel = z.infer<typeof customListedModelSchema>;
type CustomModelLimits = Pick<z.infer<typeof customModelInputSchema>, "id" | "context" | "output">;

const tokens = (count: number) => formatNumber(count);
/** A model's limits in words. Zero or absent is unknown, never a measured limit. */
export function customLimitsText(context?: number, output?: number): string {
  if (context && output) return `${tokens(context)} context · ${tokens(output)} output tokens`;
  if (context) return `${tokens(context)} context tokens · output limit unknown`;
  if (output) return `${tokens(output)} output tokens · context limit unknown`;
  return "Limits unknown";
}

/** Fill only the limits a person left blank from the server's list; a typed number stands. */
export function withListedLimits<T extends CustomModelLimits>(
  models: readonly T[],
  listed: readonly CustomListedModel[],
): T[] {
  return models.map((model) => {
    const found = listed.find((entry) => entry.id === model.id);
    if (!found || (model.context && model.output)) return model;
    return {
      ...model,
      context: model.context || found.context || 0,
      output: model.output || found.output || 0,
    };
  });
}
export const customCertificateViewSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  fingerprint: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
});
export const customApiReviewSchema = z.object({
  destination: z.string(),
  certificates: z.array(customCertificateViewSchema),
  suggestion: z.string().optional(),
});
export type CustomApiReview = z.infer<typeof customApiReviewSchema>;
export const customApiViewSchema = z.object({
  draftId: z.string().optional(),
  accountId: z.string().optional(),
  label: z.string(),
  baseUrl: z.string(),
  mode: customNetworkModeSchema,
  protocol: customProtocolSchema,
  keyPresent: z.boolean(),
  tokenCommand: z
    .object({ command: z.string(), refreshSeconds: z.number().int().positive() })
    .optional(),
  tokenCommandFailed: z.boolean().optional(),
  noKey: z.boolean(),
  /** A secret header's value is never returned. */
  headers: z
    .array(z.object({ name: z.string(), secret: z.boolean(), value: z.string().optional() }))
    .default([]),
  enabled: z.boolean(),
  allowStorageDefault: z.boolean(),
  /** The person made an exception for this address's DNS answers. */
  addressException: z.boolean().optional(),
  compaction: customCompactionSchema.optional(),
  /**
   * A connection approved from the connection file: its key there, and
   * whether the file still says what was approved here. `changed` (its
   * address, protocol or headers) and `missing` hold it until approved again.
   */
  file: z.object({ name: z.string(), state: z.enum(["current", "changed", "missing"]) }).optional(),
  /**
   * A connection approved from the first mate's computer's own, on a computer
   * that runs work: its account id there, and whether what that computer
   * last sent still says what was approved here, as `file` says.
   */
  home: z.object({ name: z.string(), state: z.enum(["current", "changed", "missing"]) }).optional(),
  certificates: z.array(customCertificateViewSchema),
  models: z.array(
    customModelInputSchema.extend({
      checked: z.boolean(),
      readsPictures: z.boolean().optional(),
      state: z.enum([
        "untested",
        "checking",
        "checked",
        "unreachable",
        "key-rejected",
        "incompatible",
      ]),
      failure: z.string().optional(),
      /** Why the last check failed, for the form to place at the row or field at fault. */
      category: customApiFailureCategorySchema.optional(),
    }),
  ),
});
export type CustomApiView = z.infer<typeof customApiViewSchema>;
export const customApiFailureSchema = z.object({
  category: customApiFailureCategorySchema,
  /** A base address to offer instead, when the one entered ends in an operation. */
  suggestion: z.string().optional(),
  /** `address`: the address, key or form was refused; `list`: the server's model list failed. */
  stage: z.enum(["address", "list"]),
});
export type CustomApiFailure = z.infer<typeof customApiFailureSchema>;
/**
 * A prepared draft, the server's own model list with its limits filled into
 * blank rows, or why the address or the list failed. A draft survives a list
 * failure, so it can still be saved paused.
 */
export const customApiConnectResultSchema = z.object({
  view: customApiViewSchema.optional(),
  listed: z.array(customListedModelSchema).optional(),
  failure: customApiFailureSchema.optional(),
});
export type CustomApiConnectResult = z.infer<typeof customApiConnectResultSchema>;
/** The live line under the address: where it sends, and the network its name points to now. */
export const customApiAddressSchema = z.object({
  destination: z.string().optional(),
  network: customNetworkModeSchema.optional(),
  suggestion: z.string().optional(),
  failure: customApiFailureCategorySchema.optional(),
  /** `destination`: what DNS answered for the name, each with the network it points to. */
  answers: z.array(customApiAnswerSchema).optional(),
  /** `destination`: the person may make an exception for this address. */
  exceptionOffered: z.boolean().optional(),
});
export type CustomApiAddress = z.infer<typeof customApiAddressSchema>;
export const CUSTOM_API_PROVIDER_PREFIX = "fm-custom-";
export function isCustomApiProvider(provider: string): boolean {
  return /^fm-custom-[a-f0-9]{16}$/.test(provider);
}

export const CUSTOM_READS_PICTURES = "Reads pictures";
