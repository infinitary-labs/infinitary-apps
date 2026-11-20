import { KEYCHAIN_VALUE_FAILURE_DETAIL } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { managedFromClaudeStore } from "./claudeAuthResolve";

describe("managedFromClaudeStore", () => {
  // INF-2318: the allowance names the identity from its credential read.
  it("hands a live credential and its current identity to the sensor", () => {
    expect(
      managedFromClaudeStore({
        state: "present",
        identity: { label: "alex.two@example.com" },
        auth: { accessToken: "tok", expiresAt: 9e15 },
      }),
    ).toEqual({ managed: { apiKey: "tok", usingOAuth: true, account: "alex.two@example.com" } });
  });

  it("INF-2317: hands an expired access credential to the sensor, not a local sign-out", () => {
    expect(
      managedFromClaudeStore({
        state: "present",
        identity: {},
        auth: { accessToken: "tok", expiresAt: 1 },
      }),
    ).toEqual({ managed: { apiKey: "tok", usingOAuth: true } });
  });

  it("a Keychain decline stays retryable", () => {
    const mapped = managedFromClaudeStore({
      state: "unreadable",
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
      managedFromClaudeStore({
        state: "unreadable",
        reason: "keychain_no_interactive_session",
      }).unresolved,
    ).toMatchObject({
      status: "unavailable",
      reason: "keychain_no_interactive_session",
    });
  });

  it("a locked store stays retryable and says so, never sign-in and never Always Allow", () => {
    const unresolved = managedFromClaudeStore({
      state: "unreadable",
      reason: "keychain_locked",
    }).unresolved;
    expect(unresolved).toMatchObject({ status: "unavailable", reason: "keychain_locked" });
    // What the meter tells the person: it is locked, and Retry asks to unlock it.
    expect(unresolved?.detail).toMatch(/locked/);
    expect(unresolved?.detail).toMatch(/Retry, then enter your password to unlock/);
    expect(unresolved?.detail).not.toMatch(/Always Allow/);
  });

  it("an empty store is not knowing, never sign-in", () => {
    expect(managedFromClaudeStore({ state: "absent" })).toEqual({});
  });
});
