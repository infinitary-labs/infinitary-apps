import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { CustomApiError } from "./customApiPolicy";
import { type CustomGeneration, generateCustomApi } from "./customApiProtocol";
import type { CustomApiTransport } from "./customApiTransport";

/** Only checked capabilities and the requested level enter the guarded Pi path. */
export function customApiStream(
  acquire: (
    modelId: string,
    signal?: AbortSignal,
  ) => Promise<{
    transport: CustomApiTransport;
    release: () => void;
    generation: Omit<CustomGeneration, "context">;
  }>,
): StreamFunction<string, SimpleStreamOptions> {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      let release: (() => void) | undefined;
      try {
        const acquired = await acquire(model.id, options?.signal);
        release = acquired.release;
        await generateCustomApi(
          acquired.transport,
          {
            ...acquired.generation,
            maxOutput: Math.min(model.maxTokens, options?.maxTokens ?? model.maxTokens),
            context,
            provider: model.provider,
            cost: model.cost,
            reasoning: options?.reasoning,
            sessionId: options?.sessionId,
          },
          options?.signal,
          (event) => stream.push(event),
        );
      } catch (error) {
        const safe = error instanceof CustomApiError ? error : new CustomApiError("malformed");
        const unknown = Number.NaN;
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? "aborted" : "error",
          errorMessage: safe.message,
          usage: {
            input: unknown,
            output: unknown,
            cacheRead: unknown,
            cacheWrite: unknown,
            totalTokens: unknown,
            cost: {
              input: unknown,
              output: unknown,
              cacheRead: unknown,
              cacheWrite: unknown,
              total: unknown,
            },
          },
        };
        stream.push({
          type: "error",
          reason: message.stopReason as "error" | "aborted",
          error: message,
        });
      } finally {
        release?.();
        stream.end();
      }
    };
    void run();
    return stream;
  };
}
