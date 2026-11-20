import type {
  HostKeychain,
  HostKeychainOutcome,
  HostKeychainQuery,
  HostKeychainUnlockOutcome,
} from "@core/host";
import { KEYCHAIN_READ_INCOMPLETE_CODE } from "@shared/quota";
import { z } from "zod";

/** One request per fresh process: native calls never run on the host's main thread. */
export type KeychainLockState = "locked" | "unlocked" | "absent" | "unknown";
export type KeychainRequest =
  | { operation: "find" | "read" | "unlock"; query: HostKeychainQuery }
  | { operation: "status"; keychainPath: string }
  /** Unlock one keychain file by its path, with macOS's own dialog, instead of the store an item search finds. */
  | { operation: "unlock-store"; keychainPath: string; interactive?: boolean };

export const keychainRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.enum(["find", "read", "unlock"]),
    query: z.object({
      service: z.string(),
      account: z.string().optional(),
      interactive: z.boolean().optional(),
    }),
  }),
  z.object({ operation: z.literal("status"), keychainPath: z.string() }),
  z.object({
    operation: z.literal("unlock-store"),
    keychainPath: z.string(),
    interactive: z.boolean().optional(),
  }),
]);

const answerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.string() }),
  z.object({
    kind: z.literal("found"),
    modifiedAt: z.string().optional(),
    locked: z.boolean().optional(),
    account: z.string().optional(),
  }),
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("failed"), code: z.number().optional(), message: z.string() }),
  z.object({ kind: z.literal("unlocked") }),
  z.object({
    kind: z.literal("status"),
    state: z.enum(["locked", "unlocked", "absent", "unknown"]),
  }),
]);
export type KeychainAnswer =
  | HostKeychainOutcome
  | HostKeychainUnlockOutcome
  | { kind: "status"; state: KeychainLockState };

function parseAnswer(raw: unknown): KeychainAnswer | undefined {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const answer = parsed.data;
  if (answer.kind === "found")
    return {
      kind: "found",
      ...(answer.modifiedAt !== undefined ? { modifiedAt: answer.modifiedAt } : {}),
      ...(answer.locked !== undefined ? { locked: answer.locked } : {}),
      ...(answer.account !== undefined ? { account: answer.account } : {}),
    };
  if (answer.kind === "failed")
    return {
      kind: "failed",
      message: answer.message,
      ...(answer.code !== undefined ? { code: answer.code } : {}),
    };
  return answer;
}

/** Existing single-item read and unlock-dialog allowances, now covering the whole child. */
export const KEYCHAIN_READ_TIMEOUT_MS = 5_000;
export const KEYCHAIN_DIALOG_TIMEOUT_MS = 120_000;

export type KeychainProcess = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
  kill(): unknown;
};
export type ForkKeychainProcess = (modulePath: string, args: string[]) => KeychainProcess;

const incomplete = (): Extract<HostKeychainOutcome, { kind: "failed" }> => ({
  kind: "failed",
  code: KEYCHAIN_READ_INCOMPLETE_CODE,
  message: "The saved-password read did not finish.",
});

export type KeychainProcessOptions = {
  helperPath: string;
  fork: ForkKeychainProcess;
  allowInteraction?: boolean;
  readTimeoutMs?: number;
  dialogTimeoutMs?: number;
};

/** All native operations, including startup lock status, share this lifecycle. */
export function createKeychainRequester(options: KeychainProcessOptions) {
  const inFlight = new Map<string, Promise<KeychainAnswer>>();
  const request = (input: KeychainRequest): Promise<KeychainAnswer> => {
    const interactive =
      input.operation !== "status" &&
      input.operation !== "find" &&
      options.allowInteraction === true &&
      (input.operation === "unlock-store" ? input.interactive : input.query.interactive) === true;
    const message: KeychainRequest =
      input.operation === "status"
        ? input
        : input.operation === "unlock-store"
          ? { operation: "unlock-store", keychainPath: input.keychainPath, interactive }
          : {
              operation: input.operation,
              query: {
                service: input.query.service,
                ...(input.query.account !== undefined ? { account: input.query.account } : {}),
                interactive,
              },
            };
    const key = JSON.stringify(message);
    const running = inFlight.get(key);
    if (running) return running;
    const attempt = new Promise<KeychainAnswer>((resolve) => {
      let child: KeychainProcess;
      try {
        // Arguments contain lookup metadata only. Credential values return on private IPC.
        child = options.fork(options.helperPath, [key]);
      } catch {
        resolve(incomplete());
        return;
      }
      let answer: KeychainAnswer | undefined;
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        interactive
          ? (options.dialogTimeoutMs ?? KEYCHAIN_DIALOG_TIMEOUT_MS)
          : (options.readTimeoutMs ?? KEYCHAIN_READ_TIMEOUT_MS),
      );
      child.on("message", (raw) => {
        answer = parseAnswer(raw);
      });
      child.once("error", () => {
        clearTimeout(timer);
        child.kill();
        resolve(incomplete());
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (timedOut && interactive) {
          resolve({ kind: "failed", message: "The password dialog timed out without an answer." });
        } else {
          resolve(!timedOut && code === 0 && answer ? answer : incomplete());
        }
      });
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
  return request;
}

/** The desktop allows explicit permission requests; a work computer never does. */
export function createProcessKeychain(options: KeychainProcessOptions): HostKeychain {
  const request = createKeychainRequester(options);
  const read = async (
    operation: "find" | "read",
    query: HostKeychainQuery,
  ): Promise<HostKeychainOutcome> => {
    const answer = await request({ operation, query });
    return answer.kind === "unlocked" || answer.kind === "status" ? incomplete() : answer;
  };
  return {
    findGenericPassword: (query) => read("find", query),
    readGenericPassword: (query) => read("read", query),
    ...(options.allowInteraction
      ? {
          unlockKeychain: async (query: HostKeychainQuery) => {
            if (query.interactive !== true)
              return {
                kind: "failed" as const,
                code: -25308,
                message: "User interaction is not allowed.",
              };
            const answer = await request({ operation: "unlock", query });
            return answer.kind === "unlocked" || answer.kind === "failed"
              ? answer
              : {
                  kind: "failed" as const,
                  message: "The saved-password store could not be unlocked.",
                };
          },
        }
      : {}),
  };
}

/** One keychain file, by its path: its lock read silently, and an explicit unlock with macOS's own dialog. */
export type KeychainFile = {
  status(keychainPath: string): Promise<KeychainLockState>;
  unlock(keychainPath: string): Promise<HostKeychainUnlockOutcome>;
};

/**
 * Each call is its own fresh child, so the silent status read never latches
 * the unlock's process (docs/architecture.md, "The latch").
 */
export function createProcessKeychainFile(options: KeychainProcessOptions): KeychainFile {
  const request = createKeychainRequester(options);
  return {
    status: async (keychainPath) => {
      const answer = await request({ operation: "status", keychainPath });
      return answer.kind === "status" ? answer.state : "unknown";
    },
    unlock: async (keychainPath) => {
      if (options.allowInteraction !== true)
        return { kind: "failed", code: -25308, message: "User interaction is not allowed." };
      const answer = await request({ operation: "unlock-store", keychainPath, interactive: true });
      return answer.kind === "unlocked" || answer.kind === "failed"
        ? answer
        : { kind: "failed", message: "The saved-password store could not be unlocked." };
    },
  };
}
