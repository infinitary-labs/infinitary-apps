import { type ChildProcess, spawn } from "node:child_process";

/**
 * One Agent Client Protocol connection: JSON-RPC 2.0, one message per line,
 * over the stdin and stdout of the program it started (`agy acp`). It
 * speaks the protocol's framing and nothing of its methods: requests out,
 * their answers back, the program's notifications and its own requests
 * (a permission question) handed to the owner. Anything on a line that is
 * not a JSON-RPC message is ignored, and the program's stderr is kept as
 * the last few lines, for a note when it stops.
 */

/** A JSON-RPC error the program answered with: its code and its own words. */
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** The protocol's code for a session that needs a sign-in first (ACP `auth_required`). */
export const ACP_AUTH_REQUIRED = -32000;

/** What a request the program makes of the client is answered with. */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type AcpLaunch = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** How many of the program's last stderr lines a stop names. */
const KEPT_STDERR_LINES = 20;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class AcpConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private readonly stderr: string[] = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exited: Promise<void>;
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly exitListeners = new Set<() => void>();

  constructor(
    launch: AcpLaunch,
    private readonly onRequest: AcpRequestHandler,
  ) {
    this.child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise<void>((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal };
        const error = new Error(this.stoppedText());
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
        for (const listener of this.exitListeners) listener();
        resolve();
      };
      // Its last stderr lines may still be in the pipe at exit: read them
      // first, unless a program it started keeps the pipe open.
      this.child.once("exit", (code, signal) => {
        const stderr = this.child.stderr;
        if (!stderr || stderr.readableEnded) {
          done(code, signal);
          return;
        }
        const timer = setTimeout(() => done(code, signal), 250);
        stderr.once("end", () => {
          clearTimeout(timer);
          done(code, signal);
        });
      });
      // A program that never started (no such file) reports here, not on exit.
      this.child.once("error", (error) => {
        this.stderr.push(error.message);
        done(null, null);
      });
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.stderr.push(line);
        if (this.stderr.length > KEPT_STDERR_LINES) this.stderr.shift();
      }
    });
    // A write to a program that already stopped surfaces through `exit`.
    this.child.stdin?.on("error", () => {});
  }

  /** Whether the program is still running. */
  get alive(): boolean {
    return this.exitInfo === undefined;
  }

  /** The program's own process id, while it runs. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves once the program has exited. */
  closed(): Promise<void> {
    return this.exited;
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** One request: resolves with its result, rejects with its error or the program's stop. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error(this.stoppedText()));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.alive) this.send({ jsonrpc: "2.0", method, params });
  }

  /** Ends the program: its input first, then a signal if it lingers. */
  async close(graceMs = 2_000): Promise<void> {
    if (!this.alive) return;
    this.child.stdin?.end();
    const timer = setTimeout(() => {
      if (this.alive) this.child.kill("SIGTERM");
    }, graceMs);
    const hard = setTimeout(() => {
      if (this.alive) this.child.kill("SIGKILL");
    }, graceMs * 2);
    await this.exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }

  /** The sentence a stop is told with, with the program's last words when it left any. */
  stoppedText(): string {
    const tail = this.stderr.slice(-3).join(" ").trim();
    return tail ? `Antigravity stopped: ${tail}` : "Antigravity stopped.";
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        for (const listener of this.notificationListeners) listener(method, message.params);
        return;
      }
      void this.answer(id, method, message.params);
      return;
    }
    if (typeof id !== "number") return;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const { code, message: words, data } = message.error;
      waiting.reject(
        new AcpError(
          typeof code === "number" ? code : 0,
          typeof words === "string" ? words : "Antigravity refused the request.",
          data,
        ),
      );
      return;
    }
    waiting.resolve(message.result);
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (caught) {
      const error =
        caught instanceof AcpError
          ? { code: caught.code, message: caught.message }
          : { code: -32601, message: caught instanceof Error ? caught.message : String(caught) };
      this.send({ jsonrpc: "2.0", id, error });
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
