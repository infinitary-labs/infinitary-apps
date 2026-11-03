import { createDarwinKeychain, loadDarwinKeychainApi } from "./darwinKeychain";
import { serveKeychainRequest } from "./keychainProcessRuntime";

// Entry only. Loading the framework, metadata, ACL checks and value access all stay here.
const api = loadDarwinKeychainApi();
void serveKeychainRequest(
  createDarwinKeychain(api, async (path) => api?.unlockKeychain?.(path) ?? -25308),
  (path) => api?.keychainStatus?.(path) ?? "unknown",
);
