import { describe, expect, it } from "vitest";
import type { QuotaProviderView, QuotaWindowView } from "./quota";
import {
  classifyProviderWindows,
  formatDurationShort,
  providerScopes,
  scopeSignals,
  windowSignals,
} from "./quotaSignals";

/**
 * The parity fixtures below are REAL readings: quota-axi --full on the
 * captain's machine, 2026-09-01T07:16:17.160Z. Reproducing its published
 * numbers to ~4 decimals is the proof the reimplementation carries the same
 * semantics (its README documents the formulas; no code was taken).
 */
const NOW = Date.parse("2026-09-01T07:16:17.160Z");

const claudeFiveHour: QuotaWindowView = {
  id: "five_hour",
  label: "session",
  percentRemaining: 96,
  resetsAtMs: Date.parse("2026-09-01T10:20:00.490Z"),
  windowSeconds: 18_000,
};
const claudeSevenDay: QuotaWindowView = {
  id: "seven_day",
  label: "weekly",
  percentRemaining: 34,
  resetsAtMs: Date.parse("2026-09-01T21:00:00.490Z"),
  windowSeconds: 604_800,
};
const claudeFable: QuotaWindowView = {
  id: "model:fable",
  label: "Fable week",
  percentRemaining: 36,
  resetsAtMs: Date.parse("2026-09-01T21:00:00.490Z"),
  windowSeconds: 604_800,
};

describe("windowSignals", () => {
  it("reproduces quota-axi's pace numbers for the captain's real Claude windows", () => {
    const fiveHour = windowSignals(claudeFiveHour, NOW);
    expect(fiveHour.kind).toBe("measured");
    if (fiveHour.kind !== "measured") return;
    expect(fiveHour.timeRemainingPercent).toBeCloseTo(61.2407, 3);
    expect(fiveHour.reservePercentPoints).toBeCloseTo(34.7593, 3);
    expect(fiveHour.burnMultiple).toBeCloseTo(0.1032, 3);
    expect(fiveHour.status).toBe("behind");
    expect(fiveHour.confidence).toBe("established");

    const sevenDay = windowSignals(claudeSevenDay, NOW);
    if (sevenDay.kind !== "measured") throw new Error("expected measured");
    expect(sevenDay.reservePercentPoints).toBeCloseTo(25.8282, 3);
    expect(sevenDay.burnMultiple).toBeCloseTo(0.7187, 3);
  });

  it("projects cycle-average exhaustion (codex weekly, real reading)", () => {
    const signals = windowSignals(
      {
        id: "weekly",
        label: "weekly",
        percentRemaining: 96,
        resetsAtMs: Date.parse("2026-09-07T02:55:10.000Z"),
        windowSeconds: 604_800,
      },
      NOW,
    );
    if (signals.kind !== "measured") throw new Error("expected measured");
    expect(signals.burnMultiple).toBeCloseTo(0.237, 3);
    // quota-axi published 2026-09-29T15:43:09 for this reading.
    expect(signals.projectedExhaustedAtMs).toBeDefined();
    expect(
      Math.abs((signals.projectedExhaustedAtMs as number) - Date.parse("2026-09-29T15:43:09Z")),
    ).toBeLessThan(60_000);
  });

  it("treats an untriggered window (no reset, nothing used) as fully available", () => {
    expect(windowSignals({ id: "s", label: "s", percentRemaining: 100 }, NOW)).toEqual({
      kind: "untriggered",
    });
  });

  it("is unmeasurable without trusted cycle evidence - usage but no clock, or expired reset", () => {
    expect(windowSignals({ id: "w", label: "w", percentRemaining: 55 }, NOW).kind).toBe(
      "unmeasurable",
    );
    expect(
      windowSignals(
        {
          id: "w",
          label: "w",
          percentRemaining: 55,
          resetsAtMs: NOW - 1000,
          windowSeconds: 18_000,
        },
        NOW,
      ).kind,
    ).toBe("unmeasurable");
    expect(
      windowSignals({ id: "w", label: "w", percentRemaining: 55, resetsAtMs: NOW + 1000 }, NOW)
        .kind,
    ).toBe("unmeasurable");
  });

  it("derives the cycle from a startsAt/resetsAt pair when both are trusted", () => {
    const signals = windowSignals(
      {
        id: "included_usage",
        label: "included usage",
        percentRemaining: 50,
        startsAtMs: NOW - 500_000 * 1000,
        resetsAtMs: NOW + 500_000 * 1000,
      },
      NOW,
    );
    if (signals.kind !== "measured") throw new Error("expected measured");
    expect(signals.cycleSeconds).toBe(1_000_000);
    expect(signals.timeRemainingPercent).toBeCloseTo(50, 5);
    expect(signals.status).toBe("on_pace");
  });

  it("marks a cycle under 10% elapsed as early confidence", () => {
    const signals = windowSignals(
      {
        id: "credits",
        label: "credits",
        percentRemaining: 100,
        resetsAtMs: NOW + 0.95 * 604_800 * 1000,
        windowSeconds: 604_800,
      },
      NOW,
    );
    if (signals.kind !== "measured") throw new Error("expected measured");
    expect(signals.confidence).toBe("early");
  });
});

describe("scopeSignals - spendPriority (quota-axi published scalars)", () => {
  it("reproduces claude all_models = 3.3848 (cycle-weighted mean over 5h + 7d)", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [claudeFiveHour, claudeSevenDay],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(3.3848, 3);
    expect(scope.effectivePercentRemaining).toBe(34);
    expect(scope.limitingWindowId).toBe("seven_day");
    expect(scope.runway.status).toBe("through_reset");
  });

  it("reproduces claude model:fable = 3.5442 (the model window joins the bound)", () => {
    const scope = scopeSignals({
      scope: "model:fable",
      windows: [claudeFiveHour, claudeSevenDay, claudeFable],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(3.5442, 3);
  });

  it("reproduces cursor all_models = 1.6783 (equal cycles reduce to a plain mean)", () => {
    const resetsAtMs = Date.parse("2026-09-11T23:30:07.000Z");
    const cycle = 31 * 24 * 3600;
    const scope = scopeSignals({
      scope: "all_models",
      windows: [
        {
          id: "included_usage",
          label: "included usage",
          percentRemaining: 62,
          resetsAtMs,
          windowSeconds: cycle,
        },
        {
          id: "auto_usage",
          label: "auto usage",
          percentRemaining: 55,
          resetsAtMs,
          windowSeconds: cycle,
        },
        {
          id: "api_usage",
          label: "API usage",
          percentRemaining: 100,
          resetsAtMs,
          windowSeconds: cycle,
        },
      ],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(1.6783, 3);
    expect(scope.effectivePercentRemaining).toBe(55);
    expect(scope.limitingWindowId).toBe("auto_usage");
  });

  it("makes the whole scope unmeasurable when any bound lacks usable pace - never zero", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [
        claudeSevenDay,
        { id: "five_hour", label: "session", percentRemaining: 55 }, // no clock
      ],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeUndefined();
    expect(scope.runway.status).toBe("unknown");
    expect(scope.unmeasurableWindowIds).toEqual(["five_hour"]);
    // Headroom is still known - a different claim from pace.
    expect(scope.effectivePercentRemaining).toBe(34);
  });

  it("lets an untriggered window contribute headroom without blocking the scalar", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [claudeSevenDay, { id: "five_hour", label: "session", percentRemaining: 100 }],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(3.4419, 3);
    expect(scope.unmeasurableWindowIds).toBeUndefined();
  });

  it("reports exhausted_now when a bound is at zero", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [{ ...claudeSevenDay, percentRemaining: 0 }],
      nowMs: NOW,
    });
    expect(scope.runway.status).toBe("exhausted_now");
    expect(scope.effectivePercentRemaining).toBe(0);
  });

  it("clamps the scalar to ±100 so one near-reset window cannot dwarf the scale", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [
        {
          id: "weekly",
          label: "weekly",
          percentRemaining: 100,
          // 0.01% of the cycle left: an enormous raw gap.
          resetsAtMs: NOW + 60_000,
          windowSeconds: 604_800,
        },
      ],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBe(100);
  });

  it("projects the scope's earliest finite exhaustion with its limiting window", () => {
    const hot: QuotaWindowView = {
      id: "weekly",
      label: "weekly",
      percentRemaining: 9,
      // 5 of 7 days left, 91% burned in 2 days: exhausts well before reset.
      resetsAtMs: NOW + 5 * 24 * 3600 * 1000,
      windowSeconds: 604_800,
    };
    const scope = scopeSignals({ scope: "all_models", windows: [hot], nowMs: NOW });
    expect(scope.runway.status).toBe("projected_exhaustion");
    expect(scope.runway.limitingWindowId).toBe("weekly");
    expect(scope.runway.projectedExhaustedAtMs).toBeGreaterThan(NOW);
    expect(scope.spendPriority).toBeLessThan(0);
  });
});

describe("classifyProviderWindows / providerScopes", () => {
  it("keeps a model window out of the account-wide bound (it scopes only itself)", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      status: "ok",
      stale: false,
      windows: [claudeFiveHour, claudeSevenDay, claudeFable],
    };
    const view = providerScopes(row, NOW);
    expect(view.allModels?.boundedBy).toEqual(["five_hour", "seven_day"]);
    expect(view.allModels?.effectivePercentRemaining).toBe(34);
    const fable = view.scopes.find((scope) => scope.scope === "model:fable");
    expect(fable?.boundedBy).toEqual(["five_hour", "seven_day", "model:fable"]);
  });

  it("scopes Claude's per-model weeklies and excludes overage windows from every bound", () => {
    const { bounding, scoped, excluded } = classifyProviderWindows("claude", [
      { id: "five_hour", label: "session", percentRemaining: 96 },
      { id: "seven_day", label: "weekly", percentRemaining: 34 },
      { id: "seven_day_opus", label: "weekly (Opus)", percentRemaining: 12 },
      { id: "seven_day_overage_included", label: "weekly (with overage)", percentRemaining: 80 },
      { id: "overage", label: "overage", percentRemaining: 100 },
    ]);
    expect(bounding.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect([...scoped.keys()]).toEqual(["model:opus"]);
    expect(excluded.map((window) => window.id)).toEqual(["seven_day_overage_included", "overage"]);
  });

  it("reports nothing derived for a stale row - a stale percentage is not current headroom", () => {
    const row: QuotaProviderView = {
      provider: "claude",
      label: "Claude",
      status: "ok",
      stale: true,
      windows: [claudeFiveHour, claudeSevenDay],
    };
    expect(providerScopes(row, NOW)).toEqual({ combined: false, scopes: [] });
  });
});

describe("formatDurationShort", () => {
  it("renders days/hours/minutes at the right grain", () => {
    expect(formatDurationShort(5 * 24 * 3600 * 1000 + 19 * 3600 * 1000)).toBe("5d 19h");
    expect(formatDurationShort(7 * 3600 * 1000 + 21 * 60 * 1000)).toBe("7h 21m");
    expect(formatDurationShort(40 * 60 * 1000)).toBe("40m");
    expect(formatDurationShort(-5)).toBe("0m");
  });
});
