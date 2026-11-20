import { needsReauthCardId, needsReauthCopy } from "@shared/credentialHealth";
import { describe, expect, it } from "vitest";
import { needsReauthTargets } from "./needsReauth";

describe("needsReauthTargets", () => {
  it("raises one target per auth_required account and ignores retryable misses", () => {
    const targets = needsReauthTargets({
      generatedAt: "2026-09-10T00:00:00.000Z",
      fetchedAt: 1,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_cl1",
          accountLabel: "Personal",
          status: "auth_required",
          reason: "rejected_after_renewal",
          stale: false,
          windows: [],
        },
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_cl2",
          accountLabel: "Work",
          status: "unavailable",
          reason: "keychain_no_interactive_session",
          stale: false,
          windows: [],
        },
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_cl3",
          status: "unavailable",
          reason: "keychain_unreadable",
          stale: false,
          windows: [],
        },
        {
          provider: "codex",
          label: "Codex",
          accountId: "acct_ok",
          status: "ok",
          stale: false,
          windows: [{ id: "weekly", label: "weekly", percentRemaining: 50 }],
        },
      ],
    });
    expect(targets).toEqual([
      {
        accountId: "acct_cl1",
        providerName: "Claude",
        accountLabel: "Personal",
        cardId: needsReauthCardId("acct_cl1"),
        copy: needsReauthCopy("Claude", "Personal"),
      },
    ]);
  });

  it("a lapsed-refresh proof is the same terminal state", () => {
    const [target] = needsReauthTargets({
      generatedAt: "2026-09-10T00:00:00.000Z",
      fetchedAt: 1,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountId: "acct_cl1",
          accountLabel: "Personal",
          status: "auth_required",
          reason: "refresh_token_lapsed",
          stale: false,
          windows: [],
        },
      ],
    });
    expect(target?.copy).toBe("Claude (Personal) needs you to sign in again.");
  });
});
