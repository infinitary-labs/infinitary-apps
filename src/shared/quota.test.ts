import { describe, expect, it } from "vitest";
import { panelQuotaSnapshot, type QuotaSnapshotView } from "./quota";

/**
 * A panel granted `quota.snapshot` is handed `PanelQuotaSnapshot` and
 * nothing more. The reading below sets every field the sensor writes,
 * the account's id and the identity the provider reported among them.
 */
const reading: QuotaSnapshotView = {
  generatedAt: "2026-11-26T00:00:00.000Z",
  fetchedAt: 1_795_000_000_000,
  providers: [
    {
      provider: "claude",
      label: "Claude",
      accountId: "acct-claude-7f3e",
      accountLabel: "Personal",
      account: "someone@example.com",
      plan: "Max",
      status: "ok",
      stale: false,
      measuredAt: 1_794_999_000_000,
      keepGoingOnCredits: true,
      credits: { state: "available", usedPercent: 12, balance: "15.00", inUse: false },
      windows: [
        {
          id: "session",
          label: "session",
          percentRemaining: 62,
          pace: "behind",
          resetText: "resets 6pm",
          resetsAtMs: 1_795_010_000_000,
          startsAtMs: 1_794_992_000_000,
          windowSeconds: 18_000,
        },
      ],
    },
    {
      provider: "codex",
      label: "Codex",
      accountId: "acct-codex-21aa",
      accountLabel: "Work",
      account: "Example Org",
      status: "rate_limited",
      reason: "vendor_429",
      retryAfter: "120",
      stale: true,
      measuredAt: 1_794_990_000_000,
      savedResets: { available: 2, applicable: 1 },
      detail: "Couldn't read this allowance just now.",
      windows: [],
    },
  ],
};

describe("panelQuotaSnapshot", () => {
  it("keeps the fields the panel contract names and leaves the account's identity out", () => {
    expect(panelQuotaSnapshot(reading)).toStrictEqual({
      fetchedAt: 1_795_000_000_000,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          accountLabel: "Personal",
          plan: "Max",
          status: "ok",
          stale: false,
          measuredAt: 1_794_999_000_000,
          windows: [
            {
              id: "session",
              label: "session",
              percentRemaining: 62,
              pace: "behind",
              resetText: "resets 6pm",
              resetsAtMs: 1_795_010_000_000,
              windowSeconds: 18_000,
            },
          ],
        },
        {
          provider: "codex",
          label: "Codex",
          accountLabel: "Work",
          status: "rate_limited",
          stale: true,
          measuredAt: 1_794_990_000_000,
          detail: "Couldn't read this allowance just now.",
          windows: [],
        },
      ],
    });
  });

  it("leaves a field the reading does not set absent rather than undefined", () => {
    const projected = panelQuotaSnapshot({
      generatedAt: "2026-11-26T00:00:00.000Z",
      fetchedAt: 1,
      providers: [
        {
          provider: "grok",
          label: "Grok",
          status: "unavailable",
          stale: false,
          windows: [{ id: "premium", label: "premium" }],
        },
      ],
    });
    expect(projected?.providers[0]).toStrictEqual({
      provider: "grok",
      label: "Grok",
      status: "unavailable",
      stale: false,
      windows: [{ id: "premium", label: "premium" }],
    });
  });

  it("answers null before the first reading", () => {
    expect(panelQuotaSnapshot(null)).toBeNull();
  });
});
