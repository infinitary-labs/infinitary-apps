import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { CUSTOM_TOKEN_FAILURE } from "@shared/customApi";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { assertLiteralBearerKey, CustomApiError } from "./customApiPolicy";

export class CustomApiTokenError extends CustomApiError {
  constructor() {
    super("credential");
    this.message = CUSTOM_TOKEN_FAILURE.message;
  }
}

export type CustomTokenCommand = Readonly<{ command: string; refreshSeconds: number }>;

// The chosen short window: three retired tokens for one minute, in addition
// to the current token and tokens still used by actual HTTP requests.
export const CUSTOM_TOKEN_RECENT_LIMIT = 3;
export const CUSTOM_TOKEN_RECENT_MS = 60_000;

export function assertCustomTokenCommand(settings: CustomTokenCommand): void {
  if (
    !settings.command.trim() ||
    settings.command.includes("\0") ||
    !Number.isSafeInteger(settings.refreshSeconds) ||
    settings.refreshSeconds <= 0
  )
    throw new CustomApiTokenError();
}

/**
 * One connection's private, in-memory token. Settings supplies the command,
 * never a model, project or discovery reply. Shell syntax is intentional.
 * Claude Code's helper allows ten minutes; the existing bearer contract bounds stdout.
 * Stderr is discarded, including on failure, and no child error escapes.
 */
export function customApiToken(settings: CustomTokenCommand) {
  assertCustomTokenCommand(settings);
  let current: string | undefined;
  let refreshed = 0;
  let pending: Promise<string> | undefined;
  let closed = false;
  const lifetime = new AbortController();
  const inUse = new Map<string, number>();
  const recent = new Map<string, number>();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function prune() {
    clearTimeout(expiry);
    const now = Date.now();
    for (const [token, until] of recent) {
      if (until <= now) recent.delete(token);
    }
    while (recent.size > CUSTOM_TOKEN_RECENT_LIMIT) {
      const oldest = recent.keys().next().value;
      if (oldest !== undefined) recent.delete(oldest);
    }
    const until = recent.values().next().value;
    expiry = until === undefined ? undefined : setTimeout(prune, Math.max(1, until - now));
    expiry?.unref();
  }
  function retire(token: string | undefined) {
    if (token === undefined || closed) return;
    recent.delete(token);
    recent.set(token, Date.now() + CUSTOM_TOKEN_RECENT_MS);
    prune();
  }
  function forgetCurrent() {
    const old = current;
    current = undefined;
    retire(old);
  }
  async function get(signal?: AbortSignal, refused?: string): Promise<string> {
    if (closed) throw new CustomApiError("closed");
    if (signal?.aborted) throw new CustomApiError("cancelled");
    // Another request may already have replaced the refused token.
    if (
      current &&
      (refused !== undefined
        ? current !== refused
        : Date.now() - refreshed < settings.refreshSeconds * 1000)
    )
      return current;
    if (refused !== undefined && current === refused) forgetCurrent();
    pending ??= runTokenCommand(settings.command, lifetime.signal)
      .then((token) => {
        if (closed) throw new CustomApiError("closed");
        if (current !== token) retire(current);
        recent.delete(token);
        current = token;
        prune();
        refreshed = Date.now();
        return token;
      })
      .finally(() => {
        pending = undefined;
      });
    // A cancelled caller stops waiting, without cancelling another caller's renewal.
    return await new Promise<string>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new CustomApiError("cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      void pending?.then(
        (token) => {
          cleanup();
          resolve(token);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  return {
    get,
    invalidate(refused: string) {
      if (current === refused) forgetCurrent();
    },
    /** Held until the native request ends, fails or is cancelled, not just until headers. */
    retain(token: string) {
      if (closed) throw new CustomApiError("closed");
      inUse.set(token, (inUse.get(token) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = inUse.get(token);
        if (count === undefined) return;
        if (count > 1) inUse.set(token, count - 1);
        else {
          inUse.delete(token);
          if (token !== current) retire(token);
        }
      };
    },
    secrets() {
      prune();
      return [...new Set([...(current ? [current] : []), ...inUse.keys(), ...recent.keys()])];
    },
    close() {
      closed = true;
      current = undefined;
      inUse.clear();
      recent.clear();
      clearTimeout(expiry);
      lifetime.abort();
    },
  };
}

function runTokenCommand(command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const windows = hostPlatform() === "win32";
    const child = spawn(command, [], {
      shell: true,
      cwd: homedir(),
      env: hostEnv(),
      detached: !windows,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let bytes = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The child may already have exited. */
      }
    };
    const timer = setTimeout(stop, 10 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192 + 2) {
        output = "";
        stop();
      } else if (!failed) output += chunk.toString("utf8");
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      try {
        if (failed || code !== 0 || signal.aborted) throw new CustomApiTokenError();
        const token = output.trim();
        assertLiteralBearerKey(token);
        resolve(token);
      } catch {
        reject(new CustomApiTokenError());
      }
      output = "";
    });
  });
}
