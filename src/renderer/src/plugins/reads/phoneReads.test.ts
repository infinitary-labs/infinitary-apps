import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { phoneReads } from "../../../../../ios/Infinitary/CardRuntime/phoneReads";

/**
 * A panel or a card on the phone reads through this folder's executor, under
 * the phone's own read api (docs/ios.md, "Panels"). Its `quota.snapshot` is
 * handed the panel contract's fields as a desktop window hands them, never
 * the account's id or the identity the provider reported.
 */
describe("the phone's quota read for a panel", () => {
  it("hands the page the panel contract's fields only", async () => {
    const reading: QuotaSnapshotView = {
      generatedAt: "2026-11-26T00:00:00.000Z",
      fetchedAt: 1_795_000_000_000,
      providers: [
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
    const asked: string[] = [];
    const reads = phoneReads(async (channel) => {
      asked.push(channel);
      return reading;
    });
    const seen: unknown[] = [];
    const stop = reads.executor.subscribe(
      "quota.snapshot",
      {},
      { onValue: (value) => seen.push(value), onError: () => {} },
    );
    await expect.poll(() => seen.length).toBe(1);
    expect(asked).toEqual(["inf:quota:snapshot"]);
    expect(seen[0]).toStrictEqual({
      fetchedAt: 1_795_000_000_000,
      providers: [
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
    stop();
  });
});
