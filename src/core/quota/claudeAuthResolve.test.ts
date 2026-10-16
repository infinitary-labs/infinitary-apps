import { REFRESH_TOKEN_LAPSED } from "@shared/credentialHealth";
import { KEYCHAIN_VALUE_FAILURE_DETAIL } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { managedFromClaudeAuthResult } from "./claudeAuthResolve";

describe("managedFromClaudeAuthResult", () => {
  it("hands a live credential to the sensor", () => {
    expect(
      managedFromClaudeAuthResult({
        status: "resolved",
        auth: { accessToken: "tok", expiresAt: 9e15 },
      }),
    ).toEqual({ managed: { apiKey: "tok", usingOAuth: true } });
  });

  it("a lapsed refresh token is needs_reauth proof, never a retryable miss", () => {
    expect(managedFromClaudeAuthResult({ status: "unrenewable" })).toEqual({
      unresolved: { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED },
    });
  });

  it("a Keychain decline stays retryable", () => {
    const mapped = managedFromClaudeAuthResult({
      status: "locked",
      reason: "keychain_access_denied",
    });
    expect(mapped.managed).toBeUndefined();
    expect(mapped.unresolved).toMatchObject({
      status: "unavailable",
      reason: "keychain_access_denied",
      detail: KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_access_denied,
    });
  });

  it("a no-interactive-session block stays retryable", () => {
    expect(
      managedFromClaudeAuthResult({
        status: "unavailable",
        reason: "keychain_no_interactive_session",
      }).unresolved,
    ).toMatchObject({
      status: "unavailable",
      reason: "keychain_no_interactive_session",
    });
  });

  it("a locked store stays retryable and says so, never sign-in and never Always Allow", () => {
    const unresolved = managedFromClaudeAuthResult({
      status: "unavailable",
      reason: "keychain_locked",
    }).unresolved;
    expect(unresolved).toMatchObject({ status: "unavailable", reason: "keychain_locked" });
    // What the meter tells the person: it is locked, and Retry asks to unlock it.
    expect(unresolved?.detail).toMatch(/locked/);
    expect(unresolved?.detail).toMatch(/Retry, then enter your password to unlock/);
    expect(unresolved?.detail).not.toMatch(/Always Allow/);
  });

  it("an empty store is not knowing, never sign-in", () => {
    expect(managedFromClaudeAuthResult({ status: "unavailable" })).toEqual({});
  });
});
