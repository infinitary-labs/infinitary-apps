import { createDarwinKeychain, loadDarwinKeychainApi, mapUnlock } from "./darwinKeychain";
import { serveKeychainRequest } from "./keychainProcessRuntime";

// Entry only. Loading the framework, metadata, ACL checks and value access all stay here.
const api = loadDarwinKeychainApi();
void serveKeychainRequest(
  createDarwinKeychain(api, async (path) => api?.unlockKeychain?.(path) ?? -25308),
  (path) => api?.keychainStatus?.(path) ?? "unknown",
  // Reached only by an unlock-store request with interaction allowed, as this
  // child's first touch of any store, so macOS may still show its dialog.
  async (path) => mapUnlock(api?.unlockKeychain?.(path) ?? -25308),
);
