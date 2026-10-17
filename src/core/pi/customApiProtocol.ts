import {
  type AssistantMessage,
  type AssistantMessageEvent,
  getCurrentTools,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { customDefaultCacheRetention } from "@shared/customApi";
import { type CustomCapabilities, customCacheRetentions } from "./customApiModels";
import { readCustomApiWithPi } from "./customApiPi";
import { CustomApiError } from "./customApiPolicy";
import type { CustomApiTransport } from "./customApiTransport";

export type CustomApiProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";
export type CustomResponsesPolicy =
  | { kind: "no-store" }
  | { kind: "server-default"; consentRevision: string };
/** Lossless Pi request, transcript and reply profiles need fresh proof. */
export function customApiProfile(protocol: CustomApiProtocol) {
  if (protocol === "anthropic-messages") return "pi-capabilities-messages-v1";
  return protocol === "openai-completions" ? "pi-capabilities-v4" : "pi-capabilities-v3";
}
export type CustomModelLimits = { context: number; output: number };
export type CustomGeneration = {
  protocol: CustomApiProtocol;
  model: string;
  limits: CustomModelLimits;
  storage: CustomResponsesPolicy;
  context: TranscriptContext;
  maxOutput?: number;
  readsPictures?: boolean;
  capabilities?: CustomCapabilities;
  cacheRetention?: SimpleStreamOptions["cacheRetention"];
  reasoning?: SimpleStreamOptions["reasoning"];
  sessionId?: string;
  provider?: string;
  cost?: Model<CustomApiProtocol>["cost"];
};

export function assertCustomModelLimits(limits: CustomModelLimits): void {
  if (
    !Number.isSafeInteger(limits.context) ||
    !Number.isSafeInteger(limits.output) ||
    limits.context <= 0 ||
    limits.output <= 0 ||
    limits.output >= limits.context
  )
    throw new CustomApiError("limits");
}

/** Admission and output protection are Firstmate's; Pi owns model mechanics. */
export async function generateCustomApi(
  transport: CustomApiTransport,
  input: CustomGeneration,
  signal?: AbortSignal,
  onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
  try {
    input = { ...input, context: recentCustomPictures(input.context) };
    assertCustomGeneration(input);
    if (signal?.aborted) throw new CustomApiError("cancelled");
    return await readCustomApiWithPi(transport, input, signal, onEvent);
  } catch (error) {
    throw error instanceof CustomApiError ? error : new CustomApiError("malformed");
  }
}

function assertCustomGeneration(input: CustomGeneration): void {
  assertCustomModelLimits(input.limits);
  if (
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(input.protocol) ||
    !input.model ||
    input.model.length > 256 ||
    (input.storage.kind !== "no-store" &&
      (input.storage.kind !== "server-default" || !input.storage.consentRevision.trim()))
  )
    throw new CustomApiError("incompatible");
  if (
    input.maxOutput !== undefined &&
    (!Number.isSafeInteger(input.maxOutput) || input.maxOutput <= 0)
  )
    throw new CustomApiError("limits");
  const retention = input.cacheRetention ?? customDefaultCacheRetention(input.protocol);
  if (!customCacheRetentions(input.protocol, input.capabilities).includes(retention))
    throw new CustomApiError("incompatible");
  // Pi sizes the request and compacts. A documented window is not a reason to
  // refuse before anything is sent (INF-202, captain: rely on Pi).
  assertPairedHistory(input.context.messages);
  const tools = getCurrentTools(input.context.messages);
  if (
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    tools.some((tool) => !toolName.test(tool.name))
  )
    throw new CustomApiError("incompatible");
}

export const customToolName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const customCallId = /^[A-Za-z0-9_-]{1,128}(?:\|[A-Za-z0-9_+/=.-]{1,512})?$/;
const toolName = customToolName;

function assertPairedHistory(messages: readonly Message[]): void {
  const seen = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of messages) {
    // Pi removes failed attempts from requests; don't demand their unexecuted tools.
    if (message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)) continue;
    if (message.role === "toolResult") {
      if (
        pending.get(message.toolCallId) !== message.toolName ||
        !pending.delete(message.toolCallId)
      )
        throw new CustomApiError("incompatible");
      continue;
    }
    if (pending.size > 0) throw new CustomApiError("incompatible");
    if (message.role !== "assistant") continue;
    for (const call of message.content) {
      if (call.type !== "toolCall") continue;
      if (!customCallId.test(call.id) || !toolName.test(call.name) || seen.has(call.id))
        throw new CustomApiError("incompatible");
      seen.add(call.id);
      pending.set(call.id, call.name);
    }
  }
  if (pending.size > 0) throw new CustomApiError("incompatible");
}

export function customPictures(
  input: Pick<CustomGeneration, "context" | "readsPictures">,
): ImageContent[] {
  if (!input.readsPictures) return [];
  return input.context.messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.filter((part): part is ImageContent => part.type === "image"),
  );
}

/** Preserve the transcript; only the request projection drops old tool pictures. */
function recentCustomPictures(context: TranscriptContext): TranscriptContext {
  let kept = 0;
  const messages = [...context.messages]
    .reverse()
    .map((message) => {
      if (
        message.role !== "toolResult" ||
        !message.content.some((part) => part.type === "image") ||
        ++kept <= 2
      )
        return message;
      return {
        ...message,
        content: [
          ...message.content.filter((part) => part.type !== "image"),
          { type: "text" as const, text: "(tool image omitted: model does not support images)" },
        ],
      };
    })
    .reverse();
  return { ...context, messages };
}
