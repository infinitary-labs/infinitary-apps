import { describe, expect, it } from "vitest";
import { googleWaits, namesDailyLimit, nextPacificMidnight } from "./waits";

/**
 * INF-7264's spec for the fix to Gmail's daily allowance running out each
 * morning: "On a 429 with no usable Retry-After, wait before the next Gmail
 * request, doubling from 1 minute to at most 1 hour, and clear the wait on
 * the next answer", and "when Google names the daily limit, wait until the
 * next midnight Pacific". The service-wide behavior, per service and
 * through Google's MCP answers, is googleIntegration.test.ts's.
 */

describe("nextPacificMidnight", () => {
  it("names the next midnight in Pacific standard time", () => {
    // 9:41 AM PST on November 28, 2026.
    expect(nextPacificMidnight(Date.UTC(2026, 10, 28, 17, 41))).toBe(Date.UTC(2026, 10, 29, 8));
  });

  it("names the next midnight in Pacific daylight time", () => {
    // 7:28 AM PDT on July 15, 2026.
    expect(nextPacificMidnight(Date.UTC(2026, 6, 15, 14, 28))).toBe(Date.UTC(2026, 6, 16, 7));
  });
});

describe("namesDailyLimit", () => {
  it("reads Gmail's own daily-limit reason", () => {
    // Google's Gmail error guide's reason for a daily limit, under words that
    // name no day, so only the reason can tell it.
    expect(
      namesDailyLimit({
        error: {
          errors: [
            { domain: "usageLimits", reason: "dailyLimitExceeded", message: "Quota exceeded" },
          ],
          code: 429,
          message: "Quota exceeded",
        },
      }),
    ).toBe(true);
  });

  it("reads a Google Cloud quota error whose limit is per day", () => {
    expect(
      namesDailyLimit({
        error: {
          code: 429,
          message: "Quota exceeded.",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "RATE_LIMIT_EXCEEDED",
              metadata: { quota_limit: "RequestsPerDayPerProject", quota_limit_value: "5000" },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("does not take a per-minute limit for a daily one", () => {
    // Google's Gmail error guide's body for a per-minute user limit.
    expect(
      namesDailyLimit({
        error: {
          errors: [
            {
              domain: "usageLimits",
              reason: "userRateLimitExceeded",
              message: "User Rate Limit Exceeded",
            },
          ],
          code: 403,
          message: "User Rate Limit Exceeded",
        },
      }),
    ).toBe(false);
    expect(namesDailyLimit(undefined)).toBe(false);
  });
});

describe("googleWaits", () => {
  it("doubles the wait from a minute to an hour while Google gives no Retry-After, and starts over after an answer", () => {
    const clock = { now: Date.UTC(2026, 10, 28, 17) };
    const waits = googleWaits(() => clock.now);
    const seconds: string[] = [];
    for (let refusal = 0; refusal < 8; refusal += 1) {
      seconds.push(waits.slowed("gmail", "Gmail", null, undefined));
      clock.now += 3_600_000;
    }
    expect(seconds.map((words) => /waits (\d+) seconds/.exec(words)?.[1])).toEqual([
      "60",
      "120",
      "240",
      "480",
      "960",
      "1920",
      "3600",
      "3600",
    ]);

    waits.answered("gmail");
    expect(waits.slowed("gmail", "Gmail", null, undefined)).toBe(
      "Gmail asked the app to slow down without saying for how long, so the app waits 60 seconds.",
    );
  });

  it("holds a request until the wait ends", () => {
    const clock = { now: Date.UTC(2026, 10, 28, 17) };
    const waits = googleWaits(() => clock.now);
    waits.slowed("gmail", "Gmail", null, undefined);
    clock.now += 59_000;
    expect(waits.holds("gmail", "Gmail")).toBe("Gmail asked the app to wait 1 more seconds.");
    clock.now += 1_000;
    expect(waits.holds("gmail", "Gmail")).toBeUndefined();
  });
});
