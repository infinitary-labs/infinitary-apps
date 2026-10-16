import { describe, expect, it } from "vitest";
import { sumUsage, tokenUsage, turnUsage } from "../scripts/evals/usage";

describe("evaluation usage accounting", () => {
  it("preserves reported zeros and marks absent or invalid counters unknown", () => {
    expect(tokenUsage({ input: 0, output: 7, cacheRead: -1, cacheWrite: "3" })).toEqual({
      input: 0,
      output: 7,
      cacheRead: null,
      cacheWrite: null,
    });
    for (const value of [undefined, null, {}, { input: Number.NaN, output: Infinity }])
      expect(tokenUsage(value)).toEqual({
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
      });
  });

  it("does not turn missing contributions into zero or publish a partial sum as a total", () => {
    const known = tokenUsage({ input: 3, output: 5, cacheRead: 20, cacheWrite: 0 });
    expect(sumUsage([known, known])).toEqual({
      input: 6,
      output: 10,
      cacheRead: 40,
      cacheWrite: 0,
    });
    expect(sumUsage([known, tokenUsage({ input: 2, output: 4 })])).toEqual({
      input: 5,
      output: 9,
      cacheRead: null,
      cacheWrite: null,
    });
    expect(sumUsage([known, tokenUsage(undefined)])).toEqual(tokenUsage(undefined));
  });

  it("includes Claude side models once and keeps an omitted model counter unknown", () => {
    expect(
      turnUsage({
        input: 12,
        output: 16,
        cacheRead: 30,
        models: [
          { model: "main", input: 2, output: 9, cacheRead: 30, cacheWrite: 10 },
          { model: "side", input: 10, output: 7, cacheRead: 0 },
        ],
      }),
    ).toEqual({ input: 12, output: 16, cacheRead: 30, cacheWrite: null });
    expect(turnUsage({ input: 4, output: 6 })).toEqual({
      input: 4,
      output: 6,
      cacheRead: null,
      cacheWrite: null,
    });
    expect(turnUsage(undefined)).toEqual(tokenUsage(undefined));
  });
});
