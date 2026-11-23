import type { Readable, Writable } from "node:stream";

/**
 * Google Chrome's own protocol over its private pipe (docs/task-browser.md,
 * "Google Chrome as a second engine"): Chrome started with
 * `--remote-debugging-pipe` reads commands on its fourth descriptor and
 * writes answers and events on its fifth, each message one JSON text ended
 * by a zero byte. Nothing listens on a port, so no other program on the
 * computer, a crewmate's shell among them, can reach it.
 *
 * One connection carries every page: a command for a page names its
 * session, and so does each event the page sends.
 */

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string; code?: number };
};

/** An event Chrome sent: its name, its fields, and the page session it came from. */
export type CdpListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => void;

/** A command Chrome answered with an error, or one the closed pipe never answered. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

export class CdpPipe {
  private nextId = 0;
  private readonly waiting = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<CdpListener>();
  private readonly closedListeners = new Set<() => void>();
  private pending: Buffer[] = [];
  private closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.on("data", (chunk: Buffer) => this.read(chunk));
    input.on("close", () => this.close());
    input.on("error", () => this.close());
    out.on("error", () => this.close());
  }

  /** Whether Chrome's end is gone: every command now fails at once. */
  get isClosed(): boolean {
    return this.closed;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(method, "Chrome is gone"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.out.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  on(listener: CdpListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closedListeners.add(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, wait] of this.waiting) wait.reject(new CdpError(wait.method, "Chrome is gone"));
    this.waiting.clear();
    for (const listener of this.closedListeners) listener();
    this.closedListeners.clear();
    this.listeners.clear();
  }

  private read(chunk: Buffer): void {
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      this.pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.pending).toString("utf8");
      this.pending = [];
      this.deliver(text);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
  }

  private deliver(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const wait = this.waiting.get(message.id);
      if (!wait) return;
      this.waiting.delete(message.id);
      if (message.error) {
        wait.reject(new CdpError(wait.method, message.error.message ?? "refused"));
      } else {
        wait.resolve(message.result ?? {});
      }
      return;
    }
    if (!message.method) return;
    for (const listener of [...this.listeners]) {
      listener(message.method, message.params ?? {}, message.sessionId);
    }
  }
}
