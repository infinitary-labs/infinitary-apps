import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerScopes } from "@shared/quotaSignals";
import { describe, expect, it } from "vitest";
import { parseClaudeUsage } from "./providers/claude";
import { parseCodexUsage } from "./providers/codex";

/**
 * The credits fact each provider's usage reading carries (INF-4104 piece 1,
 * docs/quota.md "Credits past the allowance"), and Codex's saved resets
 * (INF-5369 piece 6, "Saved resets"): what each says, and that neither
 * raises a plan window. The answers are whole provider readings
 * (`tests/fixtures/quota-credits`).
 */

const NOW = Date.parse("2026-11-13T21:00:00Z");

function reading(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, "../../../tests/fixtures/quota-credits", name), "utf8"),
  ) as unknown;
}

describe("Claude's extra usage", () => {
  // A live Max reading with extra usage switched off.
  const body = reading("claude-usage.json") as Record<string, unknown>;
  const extra = body.extra_usage as Record<string, unknown>;
  const switchedOn = (fields: Record<string, unknown>) => ({
    ...body,
    extra_usage: { ...extra, is_enabled: true, monthly_limit: 5000, currency: "USD", ...fields },
  });

  it("is off when switched off", () => {
    expect(parseClaudeUsage(body, NOW).credits).toEqual({ state: "off" });
  });

  it("is available with its share of the monthly limit while it is switched on", () => {
    const parsed = parseClaudeUsage(switchedOn({ used_credits: 600, utilization: 12 }), NOW);
    expect(parsed.credits).toEqual({ state: "available", usedPercent: 12 });
  });

  it("never bounds or raises a plan window", () => {
    const off = parseClaudeUsage(body, NOW);
    const on = parseClaudeUsage(switchedOn({ used_credits: 600, utilization: 12 }), NOW);
    const bounds = (windows: typeof on.windows) =>
      providerScopes(
        { provider: "claude", label: "Claude", status: "ok", stale: false, windows },
        NOW,
      ).allModels?.effectivePercentRemaining;
    expect(bounds(on.windows)).toBe(bounds(off.windows));
  });

  it("is spent once its spend limit is reached or its monthly limit used up", () => {
    expect(parseClaudeUsage(switchedOn({ spend_limit_reached: true }), NOW).credits).toEqual({
      state: "spent",
      usedPercent: 100,
    });
    expect(parseClaudeUsage(switchedOn({ utilization: 100 }), NOW).credits).toEqual({
      state: "spent",
      usedPercent: 100,
    });
  });

  it("says nothing when the reading has no field for it", () => {
    const { extra_usage: _gone, ...without } = body;
    expect(parseClaudeUsage(without, NOW).credits).toBeUndefined();
  });
});

describe("ChatGPT's Codex credits", () => {
  // A live Pro reading, trimmed of the account's identity.
  const body = reading("codex-usage-credits.json") as Record<string, unknown>;
  const credits = body.credits as Record<string, unknown>;

  it("are available with their balance, beside unchanged plan windows", () => {
    const parsed = parseCodexUsage(body, NOW);
    expect(parsed.credits).toEqual({ state: "available", balance: credits.balance });
    expect(parsed.windows.map(({ id, percentRemaining }) => ({ id, percentRemaining }))).toEqual([
      { id: "weekly", percentRemaining: 16 },
    ]);
  });

  it("are off on an account that has none", () => {
    const none = { ...body, credits: { ...credits, has_credits: false, balance: "0" } };
    expect(parseCodexUsage(none, NOW).credits).toEqual({ state: "off" });
  });

  it("are spent once a spend or overage limit is reached", () => {
    expect(parseCodexUsage({ ...body, spend_control: { reached: true } }, NOW).credits).toEqual({
      state: "spent",
    });
    const overage = { ...body, credits: { ...credits, overage_limit_reached: true } };
    expect(parseCodexUsage(overage, NOW).credits).toEqual({ state: "spent" });
  });

  it("are unlimited when the reading says so, and unknown when it says nothing", () => {
    const unlimited = { ...body, credits: { ...credits, unlimited: true, balance: null } };
    expect(parseCodexUsage(unlimited, NOW).credits).toEqual({
      state: "available",
      unlimited: true,
    });
    const { credits: _gone, spend_control: _none, ...without } = body;
    expect(parseCodexUsage(without, NOW).credits).toBeUndefined();
  });
});

// INF-5369 piece 6 (docs/quota.md, "Saved resets"): the count is shown, never used.
describe("ChatGPT's saved resets for Codex", () => {
  // The same live Pro reading: it holds one saved reset that does not apply yet.
  const body = reading("codex-usage-credits.json") as Record<string, unknown>;
  const resets = body.rate_limit_reset_credits as Record<string, number>;

  it("are the held and applicable counts as sent, beside unchanged plan windows", () => {
    const parsed = parseCodexUsage(body, NOW);
    expect(parsed.savedResets).toEqual({
      available: resets.available_count,
      applicable: resets.applicable_available_count,
    });
    const { rate_limit_reset_credits: _gone, ...without } = body;
    expect(parsed.windows).toEqual(parseCodexUsage(without, NOW).windows);
  });

  it("are unknown, never zero, when the reading carries no count", () => {
    const { rate_limit_reset_credits: _gone, ...without } = body;
    expect(parseCodexUsage(without, NOW).savedResets).toBeUndefined();
    const noCount = { ...body, rate_limit_reset_credits: { applicable_available_count: 0 } };
    expect(parseCodexUsage(noCount, NOW).savedResets).toBeUndefined();
  });
});
