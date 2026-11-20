import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type JsonObject,
  type SimpleStreamOptions,
  type StreamFunction,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { collapseSystemMessages, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { LocalEndpoint, OllamaProfile } from "./ollamaProfile";

export const LOCAL_OUTPUT_TOKENS = 8192;
export const LOCAL_CONTEXT_RESERVE = LOCAL_OUTPUT_TOKENS + 4096;

export function localInputFits(context: Context, window: number): boolean {
  // Use the same public estimator as Pi's session compactor over the ACTUAL
  // next input, including newly arrived text/tools, not stale measured usage.
  // It is an estimate, not a tokenizer. Native truncate:false is the backstop.
  const transcript = collapseSystemMessages(normalizeContext(context));
  const tokens = transcript.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return tokens <= window - LOCAL_CONTEXT_RESERVE;
}

/**
 * Ollama /v1 ignores num_ctx AND truncate. An estimator cannot prove that
 * arbitrary text fits a tokenizer. Keep Pi's compaction/budgeting, but use
 * native chat's truncate:false + shift:false as the final safety boundary.
 * An underestimate becomes an explicit overflow, never lost instructions.
 */
export function ollamaStream(
  endpoint: LocalEndpoint,
  profile: OllamaProfile,
): StreamFunction<string, SimpleStreamOptions> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const run = async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const timeout = AbortSignal.timeout(options?.timeoutMs ?? 180_000);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        // Pi 0.86+ hands providers a TranscriptContext: the prompt and tools
        // live on the transcript, not on context.systemPrompt / context.tools.
        if (!localInputFits(context, profile.contextWindow)) {
          throw new Error(
            "context_length_exceeded: your first mate needs to shorten this conversation before the local model can answer.",
          );
        }
        const tools = getCurrentTools(context.messages);
        const payload = {
          model: profile.alias,
          messages: nativeMessages(context),
          stream: true,
          truncate: false,
          shift: false,
          // Keep the selected model's native thinking default. Ollama models
          // disagree on boolean vs effort-valued `think`; a global false/low
          // override breaks models that cannot disable thinking. The shared
          // output and request-time budgets still apply to thinking + answer.
          ...(tools.length > 0
            ? {
                tools: tools.map(({ name, description, parameters }) => ({
                  type: "function",
                  function: { name, description, parameters },
                })),
              }
            : {}),
          options: {
            num_ctx: profile.contextWindow,
            num_predict: Math.min(options?.maxTokens ?? model.maxTokens, LOCAL_OUTPUT_TOKENS),
            ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
          },
        };
        // Preserve Pi's request hook; the non-truncation contract is not an
        // extension preference and remains enforced after it.
        const replacement = await options?.onPayload?.(payload, model);
        const response = await fetch(`${endpoint.baseUrl.replace(/\/v1\/?$/, "")}/api/chat`, {
          method: "POST",
          signal,
          redirect: "error",
          headers: {
            ...options?.headers,
            "Content-Type": "application/json",
            Authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify({
            ...((replacement ?? payload) as object),
            truncate: false,
            shift: false,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `Local model request failed (${response.status}).`);
        }
        if (!response.body) throw new Error("The local model returned no response.");
        stream.push({ type: "start", partial: message });
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let done = false;
        const textIndices = new Map<"text" | "thinking", number>();
        const append = (kind: "text" | "thinking", value: string | undefined) => {
          if (!value) return;
          let index = textIndices.get(kind);
          if (index === undefined) {
            index = message.content.length;
            message.content.push(
              kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
            );
            textIndices.set(kind, index);
            stream.push({ type: `${kind}_start`, contentIndex: index, partial: message });
          }
          const block = message.content[index];
          if (block?.type === "text") block.text += value;
          if (block?.type === "thinking") block.thinking += value;
          stream.push({
            type: `${kind}_delta`,
            contentIndex: index,
            delta: value,
            partial: message,
          });
        };
        const consume = (line: string) => {
          if (!line.trim()) return;
          if (done) throw new Error("The local model sent data after ending its response.");
          const chunk = JSON.parse(line) as NativeChunk;
          if (chunk.error) throw new Error(chunk.error);
          append("thinking", chunk.message?.thinking);
          append("text", chunk.message?.content);
          for (const call of chunk.message?.tool_calls ?? []) {
            if (
              !call.function?.name ||
              !call.function.arguments ||
              typeof call.function.arguments !== "object" ||
              Array.isArray(call.function.arguments)
            ) {
              throw new Error("The local model returned an unreadable action. Try again.");
            }
            const toolCall = {
              type: "toolCall" as const,
              id: call.id || randomUUID(),
              name: call.function.name,
              arguments: call.function.arguments,
            } satisfies { type: "toolCall"; id: string; name: string; arguments: JsonObject };
            const contentIndex = message.content.length;
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
          }
          if (chunk.done) {
            done = true;
            if (chunk.done_reason !== "stop" && chunk.done_reason !== "length")
              throw new Error("The local model did not finish its response.");
            message.usage.input = chunk.prompt_eval_count ?? 0;
            message.usage.output = chunk.eval_count ?? 0;
            message.usage.totalTokens = message.usage.input + message.usage.output;
            message.stopReason =
              chunk.done_reason === "length"
                ? "length"
                : message.content.some((block) => block.type === "toolCall")
                  ? "toolUse"
                  : "stop";
          }
        };
        while (true) {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) consume(line);
          if (chunk.done) break;
        }
        consume(pending);
        if (!done)
          throw new Error(
            "The local model connection ended before its answer was complete. Try again.",
          );
        if (message.stopReason === "length")
          throw new Error(
            "The local model ran out of room for its answer. Try again or choose a different model.",
          );
        for (const [kind, contentIndex] of textIndices) {
          const block = message.content[contentIndex];
          const content =
            block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : "";
          stream.push({ type: `${kind}_end`, contentIndex, content, partial: message });
        }
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        const detail =
          error instanceof Error ? error.message : "The local model could not finish its response.";
        // A native tool parser can fail before returning a tool_call. Keep
        // its XML syntax out of the card body and say what the person can do.
        message.errorMessage = /XML syntax error|tool call parsing failed/.test(detail)
          ? "The local model returned an unreadable action. Try again or choose a different model."
          : detail
              .replaceAll(profile.alias, model.id)
              .replaceAll(profile.alias.replace(/:latest$/, ""), model.id);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        await reader?.cancel().catch(() => undefined);
        stream.end();
      }
    };
    void run();
    return stream;
  };
}

type NativeChunk = {
  error?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: JsonObject };
    }>;
  };
};

function nativeMessages(context: TranscriptContext): object[] {
  const prompt = getCurrentSystemPrompt(context.messages);
  const messages: object[] = prompt ? [{ role: "system", content: prompt }] : [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    )
      continue;
    const parts =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const content = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const images = parts.filter((part) => part.type === "image").map((part) => part.data);
    const thinking = parts
      .filter((part) => part.type === "thinking")
      .map((part) => part.thinking)
      .join("\n");
    const calls = parts
      .filter((part) => part.type === "toolCall")
      .map((part) => ({ id: part.id, function: { name: part.name, arguments: part.arguments } }));
    messages.push({
      role: message.role === "toolResult" ? "tool" : message.role,
      content,
      ...(images.length ? { images } : {}),
      ...(thinking ? { thinking } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(message.role === "toolResult"
        ? { tool_name: message.toolName, tool_call_id: message.toolCallId }
        : {}),
    });
  }
  return messages;
}
