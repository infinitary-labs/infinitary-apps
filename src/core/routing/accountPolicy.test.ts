import { describe, expect, it } from "vitest";
import { type AccountCandidate, selectAccount } from "./accountPolicy";

const candidate = (over: Partial<AccountCandidate> & { accountId: string }): AccountCandidate => ({
  label: over.accountId,
  enabled: true,
  connected: true,
  ...over,
});

describe("selectAccount (the per-account selection policy)", () => {
  it("picks the account with the most headroom and records why", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "Personal", effectivePercentRemaining: 31 }),
        candidate({ accountId: "b", label: "Work #2", effectivePercentRemaining: 72 }),
      ],
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons.join(" ")).toContain("picked Work #2: most headroom (72% left)");
  });

  it("lets the pinned account win while it is healthy", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", effectivePercentRemaining: 90 }),
        candidate({ accountId: "b", label: "Pinned one", effectivePercentRemaining: 20 }),
      ],
      pinnedAccountId: "b",
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons).toContain("picked Pinned one: pinned");
  });

  it("falls back from an exhausted pin instead of honoring it", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", effectivePercentRemaining: 40 }),
        candidate({ accountId: "b", effectivePercentRemaining: 0 }),
      ],
      pinnedAccountId: "b",
    });
    expect(decision.accountId).toBe("a");
    expect(decision.reasons.join(" ")).toContain("is exhausted");
  });

  it("drops disabled and known-disconnected accounts, with reasons", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "Off", enabled: false }),
        candidate({ accountId: "b", label: "Dead", connected: false }),
        candidate({ accountId: "c", label: "Live", effectivePercentRemaining: 10 }),
      ],
    });
    expect(decision.accountId).toBe("c");
    expect(decision.reasons).toContain("skipped Off: disabled");
    expect(decision.reasons).toContain("skipped Dead: needs sign in");
  });

  it("keeps an unchecked account eligible (uncertainty is not ineligibility)", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [candidate({ accountId: "a", label: "Unchecked", connected: undefined })],
    });
    expect(decision.accountId).toBe("a");
  });

  it("prefers measured headroom over unknown quota, but never drops the unknowns", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "Mystery" }),
        candidate({ accountId: "b", label: "Measured", effectivePercentRemaining: 12 }),
      ],
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons.join(" ")).toContain("Mystery: quota unknown, stays eligible");
  });

  it("rotates unknown-quota accounts least-recently-used when nothing is measured", () => {
    const first = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "A", lastSelectedAt: 200 }),
        candidate({ accountId: "b", label: "B", lastSelectedAt: 100 }),
        candidate({ accountId: "c", label: "C" }),
      ],
    });
    // Never selected sorts first; then the least recently used.
    expect(first.accountId).toBe("c");
    expect(first.reasons.join(" ")).toContain("rotating least recently used");
  });

  it("treats exhausted measured accounts as out and falls to unknowns", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "Empty", effectivePercentRemaining: 0 }),
        candidate({ accountId: "b", label: "Mystery" }),
      ],
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons).toContain("skipped Empty: exhausted");
  });

  it("returns no account when everything is exhausted, with the reason", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [candidate({ accountId: "a", effectivePercentRemaining: 0 })],
    });
    expect(decision.accountId).toBeUndefined();
    expect(decision.reasons.join(" ")).toContain("every openai-codex account is exhausted");
  });

  it("deprioritizes the protected flagship account and says so", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "flag", label: "Personal", effectivePercentRemaining: 95 }),
        candidate({ accountId: "b", label: "Work #2", effectivePercentRemaining: 30 }),
      ],
      protect: { accountId: "flag", floorPercent: 15 },
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons.join(" ")).toContain("skipped Personal: reserved for the first mate");
  });

  it("still uses the flagship when it is the only candidate (one-account users lose nothing)", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "flag", label: "Personal", effectivePercentRemaining: 12 }),
      ],
      protect: { accountId: "flag", floorPercent: 15 },
    });
    expect(decision.accountId).toBe("flag");
    expect(decision.reasons.join(" ")).toContain("only candidate");
  });

  it("prefers the higher spend priority over raw headroom (quota-axi ranking)", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({
          accountId: "a",
          label: "Slacker",
          effectivePercentRemaining: 51,
          spendPriority: 4.2,
        }),
        candidate({
          accountId: "b",
          label: "Burner",
          effectivePercentRemaining: 60,
          spendPriority: 1.1,
        }),
      ],
    });
    expect(decision.accountId).toBe("a");
    expect(decision.reasons.join(" ")).toContain("spend priority 4.20");
  });

  it("ranks a measurable spend priority above an unmeasurable one, never as zero", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        candidate({ accountId: "a", label: "Unmeasured", effectivePercentRemaining: 80 }),
        candidate({
          accountId: "b",
          label: "Overdrawn",
          effectivePercentRemaining: 49,
          // Negative is still a KNOWN signal; unknown ranks below it rather
          // than being read as zero.
          spendPriority: -0.4,
        }),
      ],
    });
    expect(decision.accountId).toBe("b");
    expect(decision.reasons.join(" ")).toContain("spend priority -0.40");
  });

  it("prefers an account projected to last through its resets over a higher-priority one that runs out (INF-898)", () => {
    // INF-898's Claude scores: 0.63 with the session running out, against a
    // second sign-in at 0.25 that lasts.
    const decision = selectAccount({
      providerId: "anthropic-claude",
      candidates: [
        candidate({
          accountId: "a",
          label: "Personal",
          effectivePercentRemaining: 25,
          spendPriority: 0.6257,
          lastsThroughReset: false,
        }),
        candidate({
          accountId: "b",
          label: "Work",
          effectivePercentRemaining: 99,
          spendPriority: 0.2498,
          lastsThroughReset: true,
        }),
      ],
    });
    expect(decision.accountId).toBe("b");
    expect(decision.candidates.find((fact) => fact.accountId === "a")).toMatchObject({
      lastsThroughReset: false,
      status: "eligible",
    });
  });
});
