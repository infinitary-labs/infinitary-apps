import { REFRESH_TOKEN_LAPSED } from "@shared/credentialHealth";
import {
  isKeychainValueFailure,
  KEYCHAIN_VALUE_FAILURE_DETAIL,
  type KeychainValueFailure,
} from "@shared/quota";
import type { ClaudeQuotaAuthResult } from "../claude/claudeQuota";
import type { ManagedAuth } from "./auth";
import { keychainFailureOutcome, type ProviderOutcome } from "./outcome";

/**
 * Map a Claude store read onto what the quota sensor should do with it.
 * `unrenewable` is local proof the refresh token has lapsed: auth_required
 * without asking the vendor. A Keychain lock or blocked session stays
 * retryable. An empty or unreadable store is "not knowing", never a sign-in.
 * `details` words a Keychain failure: with a Retry on this Mac, and with why
 * it is not read on a computer that runs work.
 */
export function managedFromClaudeAuthResult(
  result: ClaudeQuotaAuthResult,
  details: Record<KeychainValueFailure, string> = KEYCHAIN_VALUE_FAILURE_DETAIL,
): {
  managed?: ManagedAuth;
  unresolved?: ProviderOutcome;
} {
  if (result.status === "resolved") {
    return { managed: { apiKey: result.auth.accessToken, usingOAuth: true } };
  }
  if (result.status === "unrenewable") {
    return {
      unresolved: { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED },
    };
  }
  if (result.status === "locked") {
    return { unresolved: keychainFailureOutcome(result.reason, details) };
  }
  if (result.reason && isKeychainValueFailure(result.reason)) {
    return { unresolved: keychainFailureOutcome(result.reason, details) };
  }
  return {};
}
