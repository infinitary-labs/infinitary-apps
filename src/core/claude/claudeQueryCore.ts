import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FmEvent } from "@shared/events";
import type { SessionImage } from "../session/session";
import {
  type ClaudeNormalizeResult,
  type ClaudeNormalizerState,
  createNormalizerState,
  fmEventsFromClaudeMessage,
} from "./claudeEvents";

/**
 * The core both Claude sessions stand on - the rolling and the one-shot
 * session (session.ts): the push-to-pull input queue, the user message the
 * client reads, and the pump that reads the client's messages, normalizes
 * them and settles the awaited turn. They differ only in WHEN a turn is
 * over and what a failed one says, so each supplies those decisions and
 * nothing else is written twice.
 */

/**
 * A hand-rolled queue, because the input side of a streaming-input session
 * is push (the orchestrator prompts and steers whenever it likes) while the
 * SDK wants pull (an async iterable). Closing it ends the session cleanly.
 */
export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  /** Consumers awaiting a message. A list, so an overlapped read is not lost. */
  private readonly waiting: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiting = this.waiting.shift();
    if (waiting) {
      waiting({ value: message, done: false });
      return;
    }
    this.buffered.push(message);
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const buffered = this.buffered.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

/**
 * One user message as the client reads it. `uuid` stamps it, so the client
 * can acknowledge it by that id when a turn takes it in (a rolling session
 * asks for the acknowledgement; a one-shot does not).
 */
export function userMessage(
  text: string,
  priority?: SDKUserMessage["priority"],
  images?: SessionImage[],
  uuid?: string,
): SDKUserMessage {
  const imageBlocks = (images ?? []).flatMap((image) => {
    if (
      image.mimeType !== "image/png" &&
      image.mimeType !== "image/jpeg" &&
      image.mimeType !== "image/gif" &&
      image.mimeType !== "image/webp"
    ) {
      return [];
    }
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType,
          data: image.data,
        },
      },
    ];
  });
  const content =
    imageBlocks.length === 0
      ? text
      : ([{ type: "text" as const, text }, ...imageBlocks] as SDKUserMessage["message"]["content"]);
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    ...(uuid ? { uuid: uuid as SDKUserMessage["uuid"] } : {}),
  };
}

/** How an interrupted turn settles, mirroring the Pi seam's rejection. */
export const INTERRUPTED_MESSAGE = "The turn was interrupted.";

/**
 * The pump / apply / settle core. `E` is what the session tells its
 * subscribers: the session contract's events.
 *
 * Every message is normalized once (`fmEventsFromClaudeMessage`). A result
 * is routed by the one rule both sessions share: a typed failure is the
 * provider failing the turn, unless it is only the host's own interrupt
 * landing (a cut-off answering an interrupt is still news, and consumes
 * it); an interrupt with no failure is the interrupt; anything else is a
 * clean result. What each of those means for the awaited turn is the
 * session's own (`resultFailed`, `resultInterrupted`, `resultClean`).
 */
export abstract class ClaudeQueryCore<E extends { type: string }> {
  private readonly listeners = new Set<(event: E) => void>();
  /** Events seen before anyone subscribed; replayed on the first subscribe. */
  private pending: E[] = [];
  /** The normalizer's running state; a session that swaps clients starts it over per client. */
  protected normalizer: ClaudeNormalizerState = createNormalizerState();
  protected turn: { resolve: () => void; reject: (error: Error) => void } | undefined;
  /** An interrupt is in flight; the turn it cuts short settles as interrupted. */
  protected interrupting = false;
  protected disposed = false;

  constructor(protected readonly taskId: string) {}

  subscribe(listener: (event: E) => void): () => void {
    this.listeners.add(listener);
    const replay = this.pending;
    this.pending = [];
    for (const event of replay) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Consume one query's messages for as long as it runs. */
  protected async pumpQuery(query: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const message of query) {
        this.apply(message);
      }
    } catch (caught) {
      if (!this.disposed) this.streamFailed(caught, query);
    } finally {
      this.streamEnded(query);
    }
  }

  private apply(message: unknown): void {
    const result = fmEventsFromClaudeMessage(message, this.taskId, this.normalizer);
    const type = (message as { type?: unknown } | null)?.type;
    this.observe(message, result);
    if (type !== "result") {
      this.emitAll(result.events);
      return;
    }
    const interruptLanded = this.interrupting && !result.failure?.cutOff;
    if (result.failure && !interruptLanded) {
      this.interrupting = false;
      this.resultFailed(result, result.failure);
    } else if (this.interrupting) {
      this.interrupting = false;
      this.resultInterrupted(result);
    } else {
      this.resultClean(result);
    }
  }

  /** Every message, before it is routed: ids, model, activity, the session's own signals. */
  protected abstract observe(message: unknown, result: ClaudeNormalizeResult): void;
  /** The provider failed a turn; its class, when it has one, rides `failure.cutOff`. */
  protected abstract resultFailed(
    result: ClaudeNormalizeResult,
    failure: NonNullable<ClaudeNormalizeResult["failure"]>,
  ): void;
  /** The host's own interrupt landed. */
  protected abstract resultInterrupted(result: ClaudeNormalizeResult): void;
  /** A turn finished on its own. */
  protected abstract resultClean(result: ClaudeNormalizeResult): void;
  /** The client's stream threw: nothing further arrives on it. */
  protected abstract streamFailed(caught: unknown, stream: AsyncIterable<unknown>): void;
  /** The client's stream is over, however it ended. */
  protected abstract streamEnded(stream: AsyncIterable<unknown>): void;

  protected emit(event: E): void {
    if (this.listeners.size === 0) {
      this.pending.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  /** A normalized FmEvent is always one of `E`: both sessions' unions contain FmEvent. */
  protected emitAll(events: readonly FmEvent[]): void {
    for (const event of events) this.emit(event as unknown as E);
  }

  protected settleTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.resolve();
  }

  protected rejectTurn(caught: unknown): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.reject(caught instanceof Error ? caught : new Error(String(caught)));
  }
}
