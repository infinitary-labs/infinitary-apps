import type {
  AnthropicMessagesCompat,
  CacheRetention,
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type CustomCapabilityProfile, customUnprofiledRetentions } from "@shared/customApi";
import { CustomApiError } from "./customApiPolicy";
import type { CustomApiProtocol, CustomModelLimits } from "./customApiProtocol";
import { withHonestReasoning } from "./modelRuntime";

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

/** Catalog profiles are capabilities, never alternate destinations or credential sources. */
function profiles(): Model<CustomApiProtocol>[] {
  return getBuiltinProviders()
    .flatMap((provider) => getBuiltinModels(provider))
    .filter(
      (model) =>
        model.api === "openai-completions" ||
        model.api === "openai-responses" ||
        model.api === "anthropic-messages",
    ) as Model<CustomApiProtocol>[];
}

export function customCapabilityProfiles(): CustomCapabilityProfile[] {
  return profiles().flatMap((model) => {
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
): CustomCapabilities {
  const source = profiles().find(
    (model) => `${model.provider}/${model.id}` === profile && model.api === protocol,
  );
  if (!source || !withHonestReasoning(source).reasoning) throw new CustomApiError("incompatible");
  return snapshotOf(source, profile);
}

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
