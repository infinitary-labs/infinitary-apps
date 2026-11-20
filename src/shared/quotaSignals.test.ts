import { describe, expect, it } from "vitest";
import type { QuotaProviderView, QuotaWindowView } from "./quota";
import {
  bandOf,
  CREW_NEAR_FLOOR_PERCENT,
  classifyProviderWindows,
  compareBandRank,
  formatDurationShort,
  providerScopes,
  scopeSignals,
  spendBand,
  windowSignals,
} from "./quotaSignals";

/**
 * Constructed readings with round numbers, so every expected value below
 * can be worked out by hand from the formulas in quotaSignals.ts.
 * At NOW the five-hour window has 3h of 5h left (60% of its clock) and the
 * weekly windows have 1.75 of 7 days left (25% of their clock).
 */
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

const claudeFiveHour: QuotaWindowView = {
  id: "five_hour",
  label: "session",
  percentRemaining: 90,
  resetsAtMs: Date.parse("2026-10-14T15:00:00.000Z"),
  windowSeconds: 18_000,
};
const claudeSevenDay: QuotaWindowView = {
  id: "seven_day",
  label: "weekly",
  percentRemaining: 40,
  resetsAtMs: Date.parse("2026-10-16T06:00:00.000Z"),
  windowSeconds: 604_800,
};
const claudeFable: QuotaWindowView = {
  id: "model:fable",
  label: "Fable week",
  percentRemaining: 42,
  resetsAtMs: Date.parse("2026-10-16T06:00:00.000Z"),
  windowSeconds: 604_800,
};

describe("windowSignals", () => {
  it("computes pace numbers for the Claude windows", () => {
    // 3h of 5h left: timeRemaining 60, elapsed 40, used 10.
    // reserve = 90 - 60 = 30; burn = 10 / 40 = 0.25.
    const fiveHour = windowSignals(claudeFiveHour, NOW);
    expect(fiveHour.kind).toBe("measured");
    if (fiveHour.kind !== "measured") return;
    expect(fiveHour.timeRemainingPercent).toBeCloseTo(60, 3);
    expect(fiveHour.reservePercentPoints).toBeCloseTo(30, 3);
    expect(fiveHour.burnMultiple).toBeCloseTo(0.25, 3);
    expect(fiveHour.status).toBe("behind");
    expect(fiveHour.confidence).toBe("established");

    // 1.75 of 7 days left: timeRemaining 25, elapsed 75, used 60.
    // reserve = 40 - 25 = 15; burn = 60 / 75 = 0.8.
    const sevenDay = windowSignals(claudeSevenDay, NOW);
    if (sevenDay.kind !== "measured") throw new Error("expected measured");
    expect(sevenDay.reservePercentPoints).toBeCloseTo(15, 3);
    expect(sevenDay.burnMultiple).toBeCloseTo(0.8, 3);
  });

  it("projects cycle-average exhaustion (codex weekly)", () => {
    // 5.25 of 7 days left: timeRemaining 75, elapsed 25 (151,200 s), used 12.
    // burn = 12 / 25 = 0.48; the remaining 88 lasts 88 / (12 / 151,200) =
    // 1,108,800 s = 12d 20h past NOW.
    const signals = windowSignals(
      {
        id: "weekly",
        label: "weekly",
        percentRemaining: 88,
        resetsAtMs: Date.parse("2026-10-19T18:00:00.000Z"),
        windowSeconds: 604_800,
      },
      NOW,
    );
    if (signals.kind !== "measured") throw new Error("expected measured");
    expect(signals.burnMultiple).toBeCloseTo(0.48, 3);
    expect(signals.projectedExhaustedAtMs).toBeDefined();
    expect(
      Math.abs((signals.projectedExhaustedAtMs as number) - Date.parse("2026-10-27T08:00:00Z")),
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

describe("scopeSignals - spendPriority", () => {
  it("computes claude all_models = 0.8130 (cycle-weighted mean over 5h + 7d)", () => {
    // gap(5h) = (90 - 0.25 * 60) / 60 = 1.25; gap(7d) = (40 - 0.8 * 25) / 25 = 0.8.
    // (1.25 * 18,000 + 0.8 * 604,800) / 622,800 = 506,340 / 622,800 = 0.81301.
    const scope = scopeSignals({
      scope: "all_models",
      windows: [claudeFiveHour, claudeSevenDay],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(0.813, 3);
    expect(scope.effectivePercentRemaining).toBe(40);
    expect(scope.limitingWindowId).toBe("seven_day");
    expect(scope.runway.status).toBe("through_reset");
  });

  it("computes claude model:fable = 0.8591 (the model window joins the bound)", () => {
    // gap(fable) = (42 - (58 / 75) * 25) / 25 = 0.90667, weighted 604,800 beside
    // the two account-wide gaps: 1,054,692 / 1,227,600 = 0.85915.
    const scope = scopeSignals({
      scope: "model:fable",
      windows: [claudeFiveHour, claudeSevenDay, claudeFable],
      nowMs: NOW,
    });
    expect(scope.spendPriority).toBeCloseTo(0.8591, 3);
  });

  it("computes cursor all_models = 1.4167 (equal cycles reduce to a plain mean)", () => {
    // 12 of 30 days left: timeRemaining 40, elapsed 60.
    // gap(70) = (70 - 0.5 * 40) / 40 = 1.25; gap(52) = (52 - 0.8 * 40) / 40 = 0.5;
    // gap(100) = 100 / 40 = 2.5; mean = 4.25 / 3 = 1.41667.
    const resetsAtMs = Date.parse("2026-10-26T12:00:00.000Z");
    const cycle = 30 * 24 * 3600;
    const scope = scopeSignals({
      scope: "all_models",
      windows: [
        {
          id: "included_usage",
          label: "included usage",
          percentRemaining: 70,
          resetsAtMs,
          windowSeconds: cycle,
        },
        {
          id: "auto_usage",
          label: "auto usage",
          percentRemaining: 52,
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
    expect(scope.spendPriority).toBeCloseTo(1.4167, 3);
    expect(scope.effectivePercentRemaining).toBe(52);
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
    expect(scope.effectivePercentRemaining).toBe(40);
  });

  it("lets an untriggered window contribute headroom without blocking the scalar", () => {
    const scope = scopeSignals({
      scope: "all_models",
      windows: [claudeSevenDay, { id: "five_hour", label: "session", percentRemaining: 100 }],
      nowMs: NOW,
    });
    // Only the weekly gap counts: (40 - 0.8 * 25) / 25 = 0.8.
    expect(scope.spendPriority).toBeCloseTo(0.8, 3);
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
    expect(view.allModels?.effectivePercentRemaining).toBe(40);
    const fable = view.scopes.find((scope) => scope.scope === "model:fable");
    expect(fable?.boundedBy).toEqual(["five_hour", "seven_day", "model:fable"]);
  });

  it("scopes Claude's per-model weeklies and excludes overage windows from every bound", () => {
    const { bounding, scoped, excluded } = classifyProviderWindows("claude", [
      { id: "five_hour", label: "session", percentRemaining: 90 },
      { id: "seven_day", label: "weekly", percentRemaining: 40 },
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

// INF-1714 (the captain approved floor 10% and "A · Balance inside the band"):
// the band decides first, then spend priority inside it.
describe("spendBand / compareBandRank (crew allowance bands)", () => {
  it("reads the near-floor from the headroom at or below the floor, before the score", () => {
    const at = { effectivePercentRemaining: CREW_NEAR_FLOOR_PERCENT, spendPriority: 2 };
    expect(spendBand({ ...at, lastsThroughReset: true })).toBe("near_floor");
    expect(spendBand({ ...at, effectivePercentRemaining: CREW_NEAR_FLOOR_PERCENT + 0.5 })).toBe(
      "conserve",
    );
    expect(
      spendBand({
        ...at,
        effectivePercentRemaining: CREW_NEAR_FLOOR_PERCENT + 0.5,
        lastsThroughReset: true,
      }),
    ).toBe("room");
    // A reading with headroom but no usable pace is unknown, never healthy.
    expect(spendBand({ effectivePercentRemaining: 60 })).toBe("unknown");
    expect(spendBand({})).toBe("unknown");
    // A near-floor reading with no score is still near-floor: known allowance.
    expect(spendBand({ effectivePercentRemaining: 4 })).toBe("near_floor");
  });

  it("never lets a higher score cross a band, and orders by score inside one", () => {
    const room = { effectivePercentRemaining: 60, spendPriority: -2, lastsThroughReset: true };
    const conserve = { effectivePercentRemaining: 20, spendPriority: 5, lastsThroughReset: false };
    const nearFloor = { effectivePercentRemaining: 4, spendPriority: 9, lastsThroughReset: true };
    const unknown = { effectivePercentRemaining: 90 };
    const sorted = [unknown, nearFloor, conserve, room].sort(compareBandRank);
    expect(sorted).toEqual([room, conserve, nearFloor, unknown]);
    expect(compareBandRank({ ...room, spendPriority: 1 }, room)).toBeLessThan(0);
  });

  it("keeps a carried band over the adjusted facts beside it", () => {
    // Placed work charged this room reading into a projected run-out; the band stays.
    const charged = {
      effectivePercentRemaining: 22,
      spendPriority: -0.4,
      lastsThroughReset: false,
      band: "room" as const,
    };
    const other = { effectivePercentRemaining: 70, spendPriority: 0.2, lastsThroughReset: false };
    expect(bandOf(charged)).toBe("room");
    expect(compareBandRank(charged, other)).toBeLessThan(0);
  });
});
