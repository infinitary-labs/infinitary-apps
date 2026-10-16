import {
  type AssistantMessage,
  type AssistantMessageEvent,
  calculateCost,
  getCurrentTools,
  getSupportedThinkingLevels,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple as streamMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { customDefaultCacheRetention } from "@shared/customApi";
import { CUSTOM_PI_BASE, CUSTOM_PI_MESSAGES_BASE, customPiModel } from "./customApiModels";
import { CustomApiError } from "./customApiPolicy";
import {
  type CustomGeneration,
  customCallId,
  customPictures,
  customToolName,
} from "./customApiProtocol";
import type { CustomApiTransport } from "./customApiTransport";

const AVAILABILITY_KEY = "firstmate-custom-availability-only";
const FRAME_ALLOWANCE = 16_384;
const PI_TIMEOUT_MS = 60 * 60_000 + 5_000;

type CustomOperation = "chat/completions" | "responses" | "messages";
function customOperation(protocol: CustomGeneration["protocol"]): CustomOperation {
  if (protocol === "anthropic-messages") return "messages";
  return protocol === "openai-completions" ? "chat/completions" : "responses";
}

/** Pi builds and reads; the connection alone controls transport and publication. */
export async function readCustomApiWithPi(
  transport: CustomApiTransport,
  input: CustomGeneration,
  signal?: AbortSignal,
  onEvent?: (event: AssistantMessageEvent) => void,
): Promise<AssistantMessage> {
  const output = Math.min(input.maxOutput ?? input.limits.output, input.limits.output);
  const operation = customOperation(input.protocol);
  const retention = input.cacheRetention ?? customDefaultCacheRetention(input.protocol);
  let refusal: CustomApiError | undefined;
  const remember = (error: unknown) => {
    if (!refusal && error instanceof CustomApiError) refusal = error;
    return error;
  };
  const presence = new Set<UsageCount>();
  const model = customPiModel(input);
  if (
    input.capabilities?.reasoning &&
    input.reasoning &&
    !getSupportedThinkingLevels(model).includes(input.reasoning)
  ) {
    // Pi may clamp upward; the connection must never raise Firstmate's requested care.
    throw new CustomApiError("incompatible");
  }
  const options: SimpleStreamOptions = {
    apiKey: AVAILABILITY_KEY,
    maxTokens: output,
    maxRetries: 0,
    cacheRetention: retention,
    ...(input.capabilities?.reasoning && input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(retention !== "none" && input.sessionId ? { sessionId: input.sessionId } : {}),
    timeoutMs: PI_TIMEOUT_MS,
    signal,
    env: {},
    onPayload: (payload) => enforcePolicy(input, payload),
    onProviderStreamEvent: (event) => observeUsagePresence(event, presence),
    fetch: async (request, init) => {
      try {
        const response = await transport.request(
          operation,
          await pinnedBody(request, init, operation, remember),
          combinedSignal(signal, init?.signal, request),
          input.limits.context,
          customPictures(input).reduce(
            (bytes, image) => bytes + image.data.length + image.mimeType.length + 128,
            0,
          ),
        );
        return guardFrames(response, FRAME_ALLOWANCE + 4 * output, remember);
      } catch (error) {
        throw remember(error);
      }
    },
  };
  const stream =
    input.protocol === "anthropic-messages"
      ? streamMessages(model as Model<"anthropic-messages">, input.context, options)
      : input.protocol === "openai-completions"
        ? streamCompletions(model as Model<"openai-completions">, input.context, options)
        : streamResponses(model as Model<"openai-responses">, input.context, options);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  if (signal?.aborted) throw new CustomApiError("cancelled");
  if (refusal) throw refusal;
  if (message.stopReason === "aborted") throw new CustomApiError("cancelled");
  if (message.stopReason === "error" || message.stopReason === "pending")
    throw new CustomApiError(
      /finish_reason|terminal response|unfinished tool|incomplete/i.test(message.errorMessage ?? "")
        ? "incompatible"
        : "malformed",
    );
  validateReply(message, input);
  // Signatures, thinking, tool arguments and all other retained fields are checked too.
  transport.assertSafeOutput([message]);
  restoreUnknownUsage(message.usage, model, presence);
  for (const event of events) onEvent?.(event);
  return message;
}

/** Narrow transport/storage policy, not a second request serializer. */
function enforcePolicy(input: CustomGeneration, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new CustomApiError("malformed");
  const body = { ...payload } as Record<string, unknown>;
  if (body.model !== input.model || body.stream !== true) throw new CustomApiError("incompatible");
  const limit = Math.min(input.maxOutput ?? input.limits.output, input.limits.output);
  const limits = ["max_tokens", "max_completion_tokens", "max_output_tokens"].filter(
    (key) => body[key] !== undefined,
  );
  if (limits.length !== 1) throw new CustomApiError("incompatible");
  for (const field of limits) {
    const value = body[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new CustomApiError("incompatible");
    // Responses has its own minimum; the connection's documented cap still wins.
    body[field] = Math.min(value, limit);
  }
  for (const key of [
    "previous_response_id",
    "conversation",
    "background",
    "service_tier",
    "session_id",
  ]) {
    if (body[key] !== undefined && body[key] !== null) throw new CustomApiError("incompatible");
    delete body[key];
  }
  if (input.protocol === "openai-responses" && input.storage.kind === "no-store")
    body.store = false;
  else delete body.store;
  if (input.protocol === "anthropic-messages") {
    // Pi's adapter owns the request; the connection admits no account tag or routing field.
    delete body.metadata;
    delete body.service_tier;
  }
  if ((input.cacheRetention ?? customDefaultCacheRetention(input.protocol)) === "none") {
    delete body.prompt_cache_key;
    delete body.prompt_cache_retention;
    // Pi's explicit off is allowed: it requests no caching, never server storage.
  }
  return body;
}

function validateReply(message: AssistantMessage, input: CustomGeneration): void {
  if (!["stop", "toolUse", "length"].includes(message.stopReason))
    throw new CustomApiError("incompatible");
  const tools = getCurrentTools(input.context.messages);
  const calls = message.content.filter((block) => block.type === "toolCall");
  for (const call of calls) {
    if (
      !customCallId.test(call.id) ||
      !customToolName.test(call.name) ||
      !tools.some((tool) => tool.name === call.name) ||
      !call.arguments ||
      typeof call.arguments !== "object" ||
      Array.isArray(call.arguments)
    )
      throw new CustomApiError("incompatible");
  }
  const text = message.content.some((block) => block.type === "text" && block.text.trim());
  if (
    (message.stopReason !== "length" && !text && calls.length === 0) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    throw new CustomApiError("incompatible");
}

type UsageCount = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens";
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
/** Presence only. Pi owns normalization, cache subtraction and pricing. */
function observeUsagePresence(event: unknown, present: Set<UsageCount>): void {
  const raw = record(event);
  // Anthropic's start event nests the counts under `message`; its delta carries them on the event.
  const usage = record(raw.usage ?? record(raw.response).usage ?? record(raw.message).usage);
  const prompt = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const output = record(usage.completion_tokens_details ?? usage.output_tokens_details);
  const values: Record<UsageCount, unknown> = {
    input: usage.prompt_tokens ?? usage.input_tokens,
    output: usage.completion_tokens ?? usage.output_tokens,
    cacheRead:
      prompt.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens,
    cacheWrite: prompt.cache_write_tokens ?? usage.cache_creation_input_tokens,
    reasoning: output.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
  for (const [key, value] of Object.entries(values))
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      present.add(key as UsageCount);
}
function restoreUnknownUsage(
  usage: Usage,
  model: Model<CustomGeneration["protocol"]>,
  present: Set<UsageCount>,
): void {
  // A rate absent from the catalog is not zero. A missing rate only matters
  // for a nonzero normalized category; do arithmetic before unknown markers.
  const rates = { ...model.cost };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
    if (usage[key] === 0 && !Number.isFinite(rates[key])) rates[key] = 0;
  calculateCost({ ...model, cost: rates }, usage);
  const totalCost = usage.cost.total;
  // Keep Pi's context total before unknown category markers: servers may
  // report input/output without total_tokens, and Pi's compactor needs their sum.
  const totalTokens = calculateContextTokens(usage);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
    if (!present.has(key)) {
      if (key === "reasoning") delete usage.reasoning;
      else {
        usage[key] = Number.NaN;
        usage.cost[key] = Number.NaN;
      }
    }
  }
  const counted = present.has("input") && present.has("output");
  usage.totalTokens = present.has("totalTokens") || counted ? totalTokens : Number.NaN;
  usage.cost.total = counted ? totalCost : Number.NaN;
}

async function pinnedBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
  operation: CustomOperation,
  remember: (error: unknown) => unknown,
): Promise<string> {
  const rawUrl =
    request instanceof Request
      ? request.url
      : request instanceof URL
        ? request.href
        : String(request);
  const url = new URL(rawUrl);
  const method = (
    init?.method ?? (request instanceof Request ? request.method : "GET")
  ).toUpperCase();
  // Pi's Anthropic client asks for `/v1/messages?beta=true`; the connection sends its own path.
  const path =
    operation === "messages"
      ? url.origin + url.pathname === `${CUSTOM_PI_MESSAGES_BASE}/v1/messages` &&
        (url.search === "" || url.search === "?beta=true")
      : url.href === `${CUSTOM_PI_BASE}/${operation}` && !url.search;
  if (method !== "POST" || !path || url.hash) {
    throw remember(new CustomApiError("malformed"));
  }
  const raw = init?.body ?? (request instanceof Request ? await request.text() : undefined);
  const body = await textOf(raw);
  if (body === undefined) throw remember(new CustomApiError("malformed"));
  return body;
}

async function textOf(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return undefined;
}

function combinedSignal(
  caller: AbortSignal | undefined,
  init: AbortSignal | null | undefined,
  request: RequestInfo | URL,
): AbortSignal | undefined {
  const requestSignal = request instanceof Request ? request.signal : undefined;
  const signals = [caller, init ?? undefined, requestSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function guardFrames(
  response: Response,
  maxFrames: number,
  remember: (error: unknown) => unknown,
): Response {
  if (!response.body) return response;
  const source = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let held = "";
  let frames = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await source.read();
        const verdict = observe(chunk.value ?? new Uint8Array(), chunk.done);
        if (verdict) {
          remember(verdict);
          controller.error(verdict);
          await source.cancel().catch(() => undefined);
          return;
        }
        if (chunk.value) controller.enqueue(chunk.value);
        if (chunk.done) controller.close();
      } catch (error) {
        const refusal = remember(error);
        controller.error(refusal);
      }
    },
    cancel(reason) {
      remember(reason);
      return source.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, headers: response.headers });

  function observe(bytes: Uint8Array, done: boolean): CustomApiError | undefined {
    let text = held + decoder.decode(bytes, { stream: !done });
    held = "";
    if (!done && text.endsWith("\r")) {
      text = text.slice(0, -1);
      held = "\r";
    }
    text = text.replace(/\r\n/g, "\n");
    let boundary = text.indexOf("\n\n");
    while (boundary >= 0) {
      frames++;
      if (frames > maxFrames) return new CustomApiError("oversized");
      text = text.slice(boundary + 2);
      boundary = text.indexOf("\n\n");
    }
    held = text + held;
    if (done && held.trim()) return new CustomApiError("malformed");
    return undefined;
  }
}
