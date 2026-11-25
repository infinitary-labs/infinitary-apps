import type {
  AnthropicMessagesCompat,
  Api,
  CacheRetention,
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type CustomCapabilityProfile,
  type CustomModelCost,
  type CustomStatedReasoning,
  customUnprofiledRetentions,
} from "@shared/customApi";
import { CustomApiError } from "./customApiPolicy";
import type { CustomApiProtocol, CustomModelLimits } from "./customApiProtocol";
import { createCatalogRuntime, withHonestReasoning } from "./modelRuntime";

/** No provider URL heuristics, credentials or ambient configuration enter a custom request. */
export const CUSTOM_PI_BASE = "http://firstmate-custom.invalid/v1";
/** Pi's Anthropic adapter appends `/v1/messages` itself. */
export const CUSTOM_PI_MESSAGES_BASE = "http://firstmate-custom.invalid";
export type CustomCapabilities = {
  profile: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
  cacheRetentions: CacheRetention[];
};

const chatPolicy: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
};
const responsesPolicy: OpenAIResponsesCompat = {
  supportsDeveloperRole: false,
  supportsMidConvoSystemMessages: false,
  supportsLongCacheRetention: false,
  supportsStrictMode: false,
  supportsOpenAIGrammarTools: false,
  supportsAdditionalTools: false,
  supportsToolSearch: false,
  supportsExplicitPromptCacheMode: false,
  supportsMaxOutputTokens: true,
  sessionAffinityFormat: "openai-nosession",
};

/** Claude's Messages format: Pi's own request shape, with no routing or session headers. */
const messagesPolicy: AnthropicMessagesCompat = {
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
};

/**
 * What a model may ask for. A profile's snapshot says it; a Messages model with
 * no profile may use Pi's short cache, the one setting its adapter always honors.
 */
export function customCacheRetentions(
  protocol: CustomApiProtocol,
  capabilities?: Pick<CustomCapabilities, "cacheRetentions">,
): CacheRetention[] {
  if (capabilities) return capabilities.cacheRetentions;
  return customUnprofiledRetentions(protocol);
}

/**
 * Pi's catalog as this computer knows it now: each Pi runtime's models, which
 * hold the pi.dev overlay it last fetched over the bundled list, then the
 * bundled list for anything no runtime holds. Only Pi's own providers count,
 * so a custom connection's own lines never become another one's profile.
 * Make one per read: the catalog grows when a refresh lands.
 */
export type CustomCatalog = readonly Model<Api>[];
export function customCatalog(
  runtimes: readonly Pick<ModelRuntime, "getModels">[] = [],
): CustomCatalog {
  const builtin = new Set<string>(getBuiltinProviders());
  const seen = new Set<string>();
  const models: Model<Api>[] = [];
  const bundled = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
  for (const model of [...runtimes.flatMap((runtime) => runtime.getModels()), ...bundled]) {
    if (!builtin.has(model.provider)) continue;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

/** The first-party provider whose live catalog a protocol's profiles need most. */
const PROTOCOL_PROVIDER: Record<CustomApiProtocol, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
};

/**
 * Where a custom connection's profiles, names and prices come from: the Pi
 * accounts' runtimes, and a catalog-only runtime that fetches the live
 * catalog of the protocol's first-party provider, which no account here may
 * sign in to through Pi (Claude runs through its own client). A new model
 * then reaches the Reasoning list within Pi's 4h refresh, with no release.
 */
export type CustomApiCatalogSource = {
  /** Asks for these protocols' live catalogs in the background; resolves once the stored one is read. */
  want(protocols: Iterable<CustomApiProtocol>): Promise<void>;
  models(): CustomCatalog;
  /** Stops a fetch still running and resolves once nothing more writes the stored catalog. */
  close?(): Promise<void>;
};

export class CustomApiCatalog implements CustomApiCatalogSource {
  private created?: ReturnType<typeof createCatalogRuntime>;
  private ready?: ModelRuntime;
  /** Every ask still running: making the runtime and its fetch both write the store. */
  private readonly running = new Set<Promise<void>>();
  private readonly stop = new AbortController();
  constructor(
    private readonly options: {
      /** Where the fetched catalog is kept, so a launch reads it offline. */
      modelsStorePath?: string;
      /** Test seam: point the catalog at a stand-in pi.dev. */
      catalogBaseUrl?: string;
      /** The Pi accounts' own runtimes, read beside it. */
      runtimes?: () => readonly Pick<ModelRuntime, "getModels">[];
    } = {},
  ) {}

  want(protocols: Iterable<CustomApiProtocol>): Promise<void> {
    if (this.stop.signal.aborted) return Promise.resolve();
    const providers = [...new Set([...protocols].map((protocol) => PROTOCOL_PROVIDER[protocol]))];
    this.created ??= createCatalogRuntime(this.options).then((made) => {
      this.ready = made.runtime;
      return made;
    });
    const read = this.created.then(
      (made) => {
        if (!this.stop.signal.aborted) this.hold(made.fetch(providers, this.stop.signal));
      },
      () => {
        // An unreadable store leaves the accounts' and the bundled catalog.
      },
    );
    this.hold(read);
    return read;
  }

  async close(): Promise<void> {
    this.stop.abort();
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private hold(work: Promise<void>): void {
    this.running.add(work);
    const settle = () => this.running.delete(work);
    work.then(settle, settle);
  }

  models(): CustomCatalog {
    return customCatalog([
      ...(this.options.runtimes?.() ?? []),
      ...(this.ready ? [this.ready] : []),
    ]);
  }
}

/** Catalog profiles are capabilities, never alternate destinations or credential sources. */
function profiles(catalog: CustomCatalog): Model<CustomApiProtocol>[] {
  return catalog.filter(
    (model) =>
      model.api === "openai-completions" ||
      model.api === "openai-responses" ||
      model.api === "anthropic-messages",
  ) as Model<CustomApiProtocol>[];
}

export function customCapabilityProfiles(
  catalog: CustomCatalog = customCatalog(),
): CustomCapabilityProfile[] {
  return profiles(catalog).flatMap((model) => {
    const checked = withHonestReasoning(model);
    if (!checked.reasoning) return [];
    const id = `${model.provider}/${model.id}`;
    const snapshot = snapshotOf(model, id);
    return [
      {
        id,
        label: `${model.name.replace(/^[^:]+:\s*/, "")} · ${model.provider}`,
        protocol: model.api as CustomApiProtocol,
        cacheRetentions: snapshot.cacheRetentions,
      },
    ];
  });
}

/** Captured on preparation and saved with the proof; catalog refreshes cannot alter checked work. */
export function customCapabilities(
  protocol: CustomApiProtocol,
  profile: string,
  catalog: CustomCatalog = customCatalog(),
): CustomCapabilities {
  const source = profiles(catalog).find(
    (model) => `${model.provider}/${model.id}` === profile && model.api === protocol,
  );
  if (!source || !withHonestReasoning(source).reasoning) throw new CustomApiError("incompatible");
  return snapshotOf(source, profile);
}

/**
 * The reasoning a connection file states for a model with no profile, in a
 * profile's own snapshot shape, so the check, the model menu and the actual
 * request read it the same way. Only the reasoning and history settings the
 * file names change the app's own request policy; the server's short cache
 * is offered on the formats whose adapter honors it, never the long one.
 */
export function customStatedCapabilities(
  protocol: CustomApiProtocol,
  stated: CustomStatedReasoning,
): CustomCapabilities {
  const base =
    protocol === "anthropic-messages"
      ? messagesPolicy
      : protocol === "openai-completions"
        ? // A model the file says reasons is sent its level, unless the file says the server refuses one.
          { ...chatPolicy, supportsReasoningEffort: true }
        : responsesPolicy;
  const capabilities: CustomCapabilities = {
    profile: STATED_PROFILE,
    reasoning: true,
    ...(stated.thinkingLevelMap ? { thinkingLevelMap: { ...stated.thinkingLevelMap } } : {}),
    compat: { ...base, ...stated.compat } as CustomCapabilities["compat"],
    cacheRetentions: protocol === "openai-completions" ? ["none"] : ["none", "short"],
  };
  if (!withHonestReasoning(capabilities).reasoning) throw new CustomApiError("incompatible");
  return capabilities;
}
/** The profile name a file's stated reasoning is saved under; no catalog profile has it. */
export const STATED_PROFILE = "connection-file";

function snapshotOf(source: Model<CustomApiProtocol>, profile: string): CustomCapabilities {
  const protocol = source.api;
  const compat: CustomCapabilities["compat"] = { ...source.compat };
  // Only Pi's reasoning/history/cache compatibility travels. Routing, remote
  // tools and permissive terminal handling never become connection policy.
  if ("openRouterRouting" in compat) delete compat.openRouterRouting;
  if ("vercelGatewayRouting" in compat) delete compat.vercelGatewayRouting;
  if ("allowedFallbackModels" in compat) delete compat.allowedFallbackModels;
  const cacheRetentions: CacheRetention[] = ["none"];
  if (
    protocol === "openai-responses" ||
    protocol === "anthropic-messages" ||
    ("cacheControlFormat" in compat && compat.cacheControlFormat === "anthropic")
  )
    cacheRetentions.push("short");
  // Pi defaults this compatibility flag to true; an explicit false restricts the profile.
  if (compat.supportsLongCacheRetention !== false) cacheRetentions.push("long");
  return {
    profile,
    reasoning: true,
    ...(source.thinkingLevelMap ? { thinkingLevelMap: { ...source.thinkingLevelMap } } : {}),
    compat,
    cacheRetentions,
  };
}

/**
 * A model line's prices: each one the person stated, else the catalog
 * match's, else unknown (NaN, never zero). Absent when neither says anything.
 * A catalog entry listing all four rates at zero states no price: such ids
 * are often paid elsewhere, and only a person's own Free may record a zero.
 */
export function customModelCost(
  stated: CustomModelCost | undefined,
  listed: Model<Api>["cost"] | undefined,
): Model<CustomApiProtocol>["cost"] | undefined {
  const catalog =
    listed && [listed.input, listed.output, listed.cacheRead, listed.cacheWrite].some(Boolean)
      ? listed
      : undefined;
  if (!stated && !catalog) return undefined;
  const pick = (key: keyof CustomModelCost) => stated?.[key] ?? catalog?.[key] ?? Number.NaN;
  return {
    ...catalog,
    input: pick("input"),
    output: pick("output"),
    cacheRead: pick("cacheRead"),
    cacheWrite: pick("cacheWrite"),
  };
}

/** The same definition serves checks, the model menu and actual requests. */
export function customPiModel(input: {
  protocol: CustomApiProtocol;
  model: string;
  limits: CustomModelLimits;
  readsPictures?: boolean;
  capabilities?: CustomCapabilities;
  provider?: string;
  name?: string;
  cost?: Model<CustomApiProtocol>["cost"];
}): Model<CustomApiProtocol> {
  const compat = input.capabilities?.compat;
  return {
    id: input.model,
    name: input.name ?? input.model,
    api: input.protocol,
    provider: input.provider ?? "firstmate-custom",
    baseUrl: input.protocol === "anthropic-messages" ? CUSTOM_PI_MESSAGES_BASE : CUSTOM_PI_BASE,
    reasoning: input.capabilities?.reasoning ?? false,
    ...(input.capabilities?.thinkingLevelMap
      ? { thinkingLevelMap: input.capabilities.thinkingLevelMap }
      : {}),
    input: input.readsPictures ? ["text", "image"] : ["text"],
    contextWindow: input.limits.context,
    maxTokens: input.limits.output,
    cost: input.cost ?? {
      input: Number.NaN,
      output: Number.NaN,
      cacheRead: Number.NaN,
      cacheWrite: Number.NaN,
    },
    compat:
      input.protocol === "anthropic-messages"
        ? {
            ...(input.capabilities ? (compat as AnthropicMessagesCompat) : messagesPolicy),
            sendSessionAffinityHeaders: false,
          }
        : input.protocol === "openai-completions"
          ? {
              ...(input.capabilities ? compat : chatPolicy),
              supportsStore: false,
              supportsUsageInStreaming: true,
              supportsFinishReason: true,
              supportsOpenAIGrammarTools: false,
              sendSessionAffinityHeaders: false,
            }
          : {
              ...(input.capabilities ? compat : responsesPolicy),
              supportsMaxOutputTokens: true,
              supportsAdditionalTools: false,
              supportsToolSearch: false,
              supportsOpenAIGrammarTools: false,
              sessionAffinityFormat: "openai-nosession",
            },
  };
}
