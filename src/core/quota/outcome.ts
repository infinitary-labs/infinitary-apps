import {
  KEYCHAIN_VALUE_FAILURE_DETAIL,
  type KeychainValueFailure,
  type QuotaWindowView,
} from "@shared/quota";
import { isAuthFailure, isRateLimited, isSuccess, type QuotaResponse } from "./http";

/**
 * What one provider fetch established. Every distinction the surface is
 * allowed to draw is made here and nowhere else, so a timeout can never again
 * be reported as the same thing as a rate limit.
 */
export type ProviderOutcome = {
  status: "ok" | "auth_required" | "rate_limited" | "unavailable" | "not_measured";
  windows: QuotaWindowView[];
  plan?: string;
  account?: string;
  /** User-facing disclosure for a row with no window. */
  detail?: string;
  /** Sanitized machine reason: our own vocabulary, never vendor text. */
  reason?: string;
  retryAfter?: string;
};

/** No credential could be resolved: nothing was asked of the vendor. */
export const CREDENTIAL_UNAVAILABLE: ProviderOutcome = {
  status: "unavailable",
  windows: [],
  reason: "credential_unavailable",
};

/**
 * The Claude Keychain VALUE read was declined, denied, timed out, or
 * otherwise failed. A real failure: no windows, a named reason, and a
 * user-facing detail the meter can retry from. Never a fabricated reading.
 * A computer that runs work says it in its own words (`details`), since
 * nothing there can be retried by asking.
 */
export function keychainFailureOutcome(
  reason: KeychainValueFailure,
  details: Record<KeychainValueFailure, string> = KEYCHAIN_VALUE_FAILURE_DETAIL,
): ProviderOutcome {
  return {
    status: "unavailable",
    windows: [],
    reason,
    detail: details[reason],
  };
}

/**
 * Classify a non-2xx response. A 401 is the vendor's verdict on the
 * credential; a 429 is a back-off instruction; everything else - 403 included,
 * because that is also how a network policy refuses - is simply "we could not
 * find out this time".
 */
export function failureFromResponse(result: QuotaResponse): ProviderOutcome {
  if (isAuthFailure(result.status)) {
    return { status: "auth_required", windows: [], reason: "vendor_rejected" };
  }
  if (isRateLimited(result.status)) {
    return {
      status: "rate_limited",
      windows: [],
      reason: "rate_limited",
      ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
    };
  }
  return { status: "unavailable", windows: [], reason: `http_${result.status}` };
}

/** True when the response carried a usable body. */
export function succeeded(result: QuotaResponse): boolean {
  return isSuccess(result.status);
}
