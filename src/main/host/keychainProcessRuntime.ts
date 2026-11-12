import type { HostKeychain, HostKeychainQuery, HostKeychainUnlockOutcome } from "@core/host";
import {
  type KeychainAnswer,
  type KeychainLockState,
  keychainRequestSchema,
} from "./keychainProcess";

type ReadStatus = (path: string) => KeychainLockState | Promise<KeychainLockState>;
/** Unlocks one keychain file by its path in this child; the native call checks the path itself. */
export type UnlockStore = (path: string) => Promise<HostKeychainUnlockOutcome>;

const notAllowed = {
  kind: "failed",
  code: -25308,
  message: "User interaction is not allowed.",
} as const;

/** Shared by the utility entry and isolated process fixtures. Never writes a value to stdout. */
export async function answerKeychainRequest(
  reader: HostKeychain,
  raw: string,
  readStatus?: ReadStatus,
  unlockStore?: UnlockStore,
): Promise<KeychainAnswer> {
  try {
    const request = keychainRequestSchema.parse(JSON.parse(raw));
    if (request.operation === "status")
      return { kind: "status", state: (await readStatus?.(request.keychainPath)) ?? "unknown" };
    if (request.operation === "unlock-store")
      return request.interactive === true && unlockStore
        ? await unlockStore(request.keychainPath)
        : notAllowed;
    const { operation, query: input } = request;
    const query: HostKeychainQuery = {
      service: input.service,
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    };
    if (operation === "find")
      return await reader.findGenericPassword({ ...query, interactive: false });
    if (operation === "read") return await reader.readGenericPassword(query);
    if (query.interactive === true && reader.unlockKeychain)
      return await reader.unlockKeychain(query);
    return notAllowed;
  } catch {
    return { kind: "failed", message: "The saved-password request could not be read." };
  }
}

export async function serveKeychainRequest(
  reader: HostKeychain,
  readStatus?: ReadStatus,
  unlockStore?: UnlockStore,
): Promise<void> {
  const parentPort = (process as { parentPort?: { postMessage: (message: unknown) => void } })
    .parentPort;
  // A directly launched helper has no authorized recipient. Do not read at all.
  if (!parentPort && !process.send) process.exit(1);
  const answer = await answerKeychainRequest(
    reader,
    process.argv.at(-1) ?? "",
    readStatus,
    unlockStore,
  );
  if (parentPort) {
    parentPort.postMessage(answer);
    process.exit(0);
  }
  if (process.send) {
    process.send(answer, () => process.exit(0));
    return;
  }
  // A directly launched helper has no authorized recipient. Never print the answer.
  process.exit(1);
}
