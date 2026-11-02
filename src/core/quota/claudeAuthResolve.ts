import { KEYCHAIN_VALUE_FAILURE_DETAIL, type KeychainValueFailure } from "@shared/quota";
import type { ClaudeStoreRead } from "../claude/claudeQuota";
import type { ManagedAuth } from "./auth";
import { keychainFailureOutcome, type ProviderOutcome } from "./outcome";

/**
 * Map a Claude store read onto what the quota sensor should do with it.
 * A saved expiry date is not a rejection. A Keychain lock or blocked session stays
 * retryable. An empty or unreadable store is "not knowing", never a sign-in.
 * `details` words a Keychain failure: with a Retry on this Mac, and with why
 * it is not read on a computer that runs work.
 */
export function managedFromClaudeStore(
  result: ClaudeStoreRead,
  details: Record<KeychainValueFailure, string> = KEYCHAIN_VALUE_FAILURE_DETAIL,
): {
  managed?: ManagedAuth;
  unresolved?: ProviderOutcome;
} {
  if (result.state === "present") {
    return {
      managed: {
        apiKey: result.auth.accessToken,
        usingOAuth: true,
        ...(result.identity.label ? { account: result.identity.label } : {}),
      },
    };
  }
  if (result.state === "unreadable" && result.reason) {
    return { unresolved: keychainFailureOutcome(result.reason, details) };
  }
  return {};
}
