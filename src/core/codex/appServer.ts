import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { hostEnv } from "../hostEnv";

/**
 * One Codex app-server process (docs/codex-client.md): the Codex CLI the
 * person installed, started for one use with its home in a folder the
 * account's store owns, and closed after. It speaks JSON-RPC as one JSON
 * object per line on its standard input and output, without the `jsonrpc`
 * member. Only the account requests Infinitary needs are named here.
 *
 * Nothing it reads or writes is logged: its sign-in lives in its own home,
 * and no answer here carries a token.
 */

/** A request Codex refused with its own error: a clear answer, never a lost one. */
export class CodexRefusal extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The process ended, or stopped answering, before a request had its answer: the outcome is unknown. */
export class CodexUnanswered extends Error {}

// i18n-exempt: transport state for the code that asked; savedReset.ts words what a person reads
const STOPPED = "Codex stopped before it answered.";
// i18n-exempt: transport state for the code that asked; savedReset.ts words what a person reads
const CLOSED = "Codex was closed before it answered.";
// i18n-exempt: transport state for the code that asked; savedReset.ts words what a person reads
const REFUSED = "Codex refused.";

/** Starts the app-server process; a test hands in a stand-in. */
export type StartCodexProcess = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

export const startCodexProcess: StartCodexProcess = (executable, args, env) =>
  spawn(executable, [...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/**
 * The app-server's arguments: standard input and output, and its sign-in
 * kept in a file in its own home rather than the system's password store,
 * so the account's folder holds it whole and removing the account removes it.
 */
export const APP_SERVER_ARGS = [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  'cli_auth_credentials_store="file"',
] as const;

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export class CodexAppServer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private buffer = "";
  private ended: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    // Its own log lines are not ours to keep.
    child.stderr.resume();
    child.on("error", (error) => this.end(new CodexUnanswered(error.message)));
    child.on("close", () => this.end(new CodexUnanswered(STOPPED)));
    child.stdin.on("error", () => {});
  }

  /**
   * Starts Codex's app-server with `home` as its Codex home and greets it as
   * Infinitary, with no experimental capability.
   */
  static async start(input: {
    executable: string;
    home: string;
    version: string;
    start?: StartCodexProcess;
    answerWithinMs?: number;
  }): Promise<CodexAppServer> {
    const server = new CodexAppServer(
      (input.start ?? startCodexProcess)(
        input.executable,
        APP_SERVER_ARGS,
        hostEnv({ CODEX_HOME: input.home }),
      ),
    );
    try {
      await server.request(
        "initialize",
        {
          clientInfo: { name: "infinitary", title: "Infinitary", version: input.version },
          capabilities: null,
        },
        input.answerWithinMs,
      );
      server.notify("initialized");
    } catch (error) {
      server.close();
      throw error;
    }
    return server;
  }

  /**
   * One request and its answer. Codex's own error is a `CodexRefusal`; no
   * answer within `answerWithinMs`, or the process ending first, is a
   * `CodexUnanswered`.
   */
  request<T = unknown>(method: string, params?: unknown, answerWithinMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        answerWithinMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              // i18n-exempt: transport state for the code that asked; savedReset.ts words what a person reads
              reject(new CodexUnanswered(`Codex did not answer ${method} in time.`));
            }, answerWithinMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Hears every notification Codex sends; answers a function that stops hearing. */
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether the process has ended or was closed. */
  get closed(): boolean {
    return this.ended !== undefined;
  }

  close(): void {
    this.end(new CodexUnanswered(CLOSED));
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.end(new CodexUnanswered(error instanceof Error ? error.message : String(error)));
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.message(line);
    }
  }

  private message(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof message.method === "string") {
      // A request Codex asks of its client has an id too; Infinitary asks
      // for nothing that would send one, so it is only heard.
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new CodexRefusal(
          pending.method,
          typeof message.error.code === "number" ? message.error.code : undefined,
          typeof message.error.message === "string" ? message.error.message : REFUSED,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
