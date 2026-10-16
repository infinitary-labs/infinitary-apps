import { describe, expect, it, vi } from "vitest";
import { statusFromHealth } from "./accountBackend";
import type { CredentialHealth } from "./credentialHealth";
import {
  CREDENTIAL_RENEW_LEAD_MS,
  classifyExpiry,
  isConnectedHealth,
  isNeedsReauthHealth,
  isNonTerminalFailureReason,
  servesModels,
} from "./credentialHealth";
import { CredentialHealthService } from "./credentialHealthService";

describe("credential-health contract", () => {
  it("projects status from health so unknown is never a sign-out", () => {
    expect(statusFromHealth({ state: "healthy", authType: "oauth" })).toEqual({
      connected: true,
      authType: "oauth",
    });
    expect(statusFromHealth({ state: "expiring", expiresAt: 1 })).toEqual({ connected: true });
    expect(
      statusFromHealth({ state: "degraded", reason: "keychain_no_interactive_session" }),
    ).toEqual({ connected: true, reason: "keychain_no_interactive_session" });
    expect(statusFromHealth({ state: "unsigned" })).toEqual({ connected: false });
    expect(statusFromHealth({ state: "needs_reauth", reason: "refresh_token_lapsed" })).toEqual({
      connected: false,
      reason: "unrenewable",
    });
  });

  it("treats no-interaction and unreadable failures as non-terminal", () => {
    expect(isNonTerminalFailureReason("keychain_no_interactive_session")).toBe(true);
    expect(isNonTerminalFailureReason("keychain_access_denied")).toBe(true);
    expect(isNonTerminalFailureReason("unknown")).toBe(true);
    expect(isNonTerminalFailureReason("unreadable")).toBe(true);
    expect(isNonTerminalFailureReason("refresh_token_lapsed")).toBe(false);
    expect(isNonTerminalFailureReason("rejected_after_renewal")).toBe(false);
  });

  it.each([
    [{ connected: true }, true],
    [{ connected: true, reason: "keychain_locked" }, true],
    [{ connected: true, reason: "unknown" }, true],
    [{ connected: false }, false],
    [{ connected: false, reason: "unrenewable" }, false],
    [{ connected: true, reason: "client_missing" }, false],
    [{ connected: true, reason: "client_outdated" }, false],
    [{ connected: true, reason: "refused" }, false],
    [{ connected: true, reason: "signed_out" }, false],
  ])("servesModels(%j) is %s: one predicate for every reader", (status, serves) => {
    expect(servesModels(status)).toBe(serves);
  });

  it("never lets a withheld account's reason become a re-auth on its own", () => {
    // A cut-off stands beside the credential: proof alone asks for a sign-in.
    expect(isNonTerminalFailureReason("refused")).toBe(true);
    expect(isNonTerminalFailureReason("signed_out")).toBe(true);
  });

  it("needs_reauth is proof-only: only that state is terminal", () => {
    expect(isNeedsReauthHealth({ state: "needs_reauth", reason: "refresh_token_lapsed" })).toBe(
      true,
    );
    expect(
      isNeedsReauthHealth({ state: "degraded", reason: "keychain_no_interactive_session" }),
    ).toBe(false);
    expect(isNeedsReauthHealth({ state: "unsigned" })).toBe(false);
    expect(isConnectedHealth({ state: "degraded", reason: "unknown" })).toBe(true);
    expect(isConnectedHealth({ state: "needs_reauth" })).toBe(false);
  });

  it("classifies expiry at expiresAt minus lead", () => {
    const now = 10_000;
    expect(classifyExpiry(now + CREDENTIAL_RENEW_LEAD_MS + 1, now)).toBe("healthy");
    expect(classifyExpiry(now + CREDENTIAL_RENEW_LEAD_MS, now)).toBe("expiring");
    expect(classifyExpiry(now - 1, now)).toBe("expiring");
    expect(classifyExpiry(undefined, now)).toBe("healthy");
  });
});

describe("CredentialHealthService", () => {
  it("renews proactively at expiresAt-lead and not while healthy", async () => {
    const renew = vi.fn(async () => ({ outcome: "renewed" as const }));
    const healthOf = new Map<string, CredentialHealth>([
      ["acct_ok", { state: "healthy" }],
      ["acct_soon", { state: "expiring", expiresAt: 1 }],
    ]);
    const service = new CredentialHealthService({
      host: {
        listEnabled: () => [{ accountId: "acct_ok" }, { accountId: "acct_soon" }],
        health: async (id) => healthOf.get(id) ?? { state: "unsigned" },
        renew,
      },
    });
    await service.tick(0);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith("acct_soon", "proactive");
  });

  it("bounds retries: a failed renew is not fabricated healthy and stops after the max", async () => {
    const renew = vi.fn(async () => ({ outcome: "failed" as const }));
    const service = new CredentialHealthService({
      maxAttempts: 3,
      host: {
        listEnabled: () => [{ accountId: "acct_e" }],
        health: async () => ({ state: "expiring", expiresAt: 1 }),
        renew,
      },
    });
    await service.tick(0);
    await service.tick(1);
    await service.tick(2);
    await service.tick(3);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("never renews a degraded no-interaction failure, and never treats it as terminal", async () => {
    const renew = vi.fn(async () => ({ outcome: "renewed" as const }));
    const service = new CredentialHealthService({
      host: {
        listEnabled: () => [{ accountId: "acct_k" }],
        health: async () => ({
          state: "degraded",
          reason: "keychain_no_interactive_session",
        }),
        renew,
      },
    });
    await service.tick(0);
    expect(renew).not.toHaveBeenCalled();
  });

  it("does not renew needs_reauth: there is no automatic remedy", async () => {
    const renew = vi.fn(async () => ({ outcome: "renewed" as const }));
    const service = new CredentialHealthService({
      host: {
        listEnabled: () => [{ accountId: "acct_d" }],
        health: async () => ({ state: "needs_reauth", reason: "refresh_token_lapsed" }),
        renew,
      },
    });
    await service.tick(0);
    expect(renew).not.toHaveBeenCalled();
  });

  it("a deferred renew does not consume the attempt budget", async () => {
    const renew = vi.fn(async () => ({ outcome: "deferred_session" as const }));
    const service = new CredentialHealthService({
      maxAttempts: 1,
      host: {
        listEnabled: () => [{ accountId: "acct_s" }],
        health: async () => ({ state: "expiring", expiresAt: 1 }),
        renew,
      },
    });
    await service.tick(0);
    await service.tick(1);
    expect(renew).toHaveBeenCalledTimes(2);
  });
});
