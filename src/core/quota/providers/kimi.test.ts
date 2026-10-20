import { describe, expect, it } from "vitest";
import type { QuotaHttp, QuotaRequest } from "../http";
import { fetchKimiQuota, KIMI_NO_WINDOW_DETAIL, KIMI_USAGE_URL, parseKimiUsage } from "./kimi";

/**
 * The Kimi Code meter (INF-560: "It has an allowance meter"). No live
 * capture exists yet - nobody here holds a Kimi Code plan - so the answers
 * are the ones CodexBar 0.78.1 records for the same endpoint
 * (Tests/CodexBarTests/KimiRatioPoolTests.swift and
 * KimiMembershipNativeProofTests.swift), with the membership beside them.
 */
const NOW = Date.parse("2026-09-16T18:00:00Z");

const RATIO_ANSWER = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "25", remaining: "75" },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.625, reset_time: "2026-09-16T20:15:44Z" },
    limit_7d: { used_ratio: 0.125, reset_time: "2026-09-20T00:00:00Z" },
    limit_month_total: { used_ratio: 0.0056, reset_time: "2026-10-17T00:00:00Z" },
    limit_month_code: { used_ratio: 0, reset_time: "2026-10-17T00:00:00Z" },
  },
  user: { membership: { level: "LEVEL_ADVANCED" } },
  version: "GOODS_VERSION_V1",
};

/** The older count shape: a weekly `usage` and a five-hour `limits` row. */
const COUNT_ANSWER = {
  usage: { limit: "100", used: "19", remaining: "81", resetTime: "2026-09-19T16:45:59.449979Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "25", remaining: "75" },
    },
  ],
};

function stubHttp(answer: Awaited<ReturnType<QuotaHttp>>): {
  http: QuotaHttp;
  calls: { url: string; init: QuotaRequest }[];
} {
  const calls: { url: string; init: QuotaRequest }[] = [];
  return {
    calls,
    http: async (url, init) => {
      calls.push({ url, init });
      return answer;
    },
  };
}

describe("parseKimiUsage", () => {
  it("reads the session, weekly and monthly pools and names the plan", () => {
    const parsed = parseKimiUsage(RATIO_ANSWER, NOW);
    expect(parsed.kind).toBe("windows");
    if (parsed.kind !== "windows") return;
    expect(parsed.plan).toBe("Allegro");
    expect(parsed.windows.map((window) => [window.id, window.label])).toEqual([
      ["five_hour", "session"],
      ["weekly", "weekly"],
      ["monthly", "monthly"],
    ]);
    expect(parsed.windows[0]).toMatchObject({
      percentRemaining: 37.5,
      resetsAtMs: Date.parse("2026-09-16T20:15:44Z"),
      windowSeconds: 18_000,
    });
    expect(parsed.windows[1]).toMatchObject({ percentRemaining: 87.5, windowSeconds: 604_800 });
    expect(parsed.windows[2]?.percentRemaining).toBeCloseTo(99.44, 2);
    // A month has no fixed length, so its window claims no pace.
    expect(parsed.windows[2]?.pace).toBeUndefined();
  });

  it("reads the older count shape when no ratio pool is reported", () => {
    const parsed = parseKimiUsage(COUNT_ANSWER, NOW);
    expect(parsed.kind).toBe("windows");
    if (parsed.kind !== "windows") return;
    expect(parsed.windows).toEqual([
      expect.objectContaining({ id: "weekly", percentRemaining: 81 }),
      expect.objectContaining({ id: "five_hour", percentRemaining: 75 }),
    ]);
  });

  it("shows a level outside the V1 catalog as it came", () => {
    const parsed = parseKimiUsage(
      { ...RATIO_ANSWER, user: { membership: { level: "LEVEL_ULTRA" } } },
      NOW,
    );
    expect(parsed.kind === "windows" && parsed.plan).toBe("LEVEL_ULTRA");
  });

  it("refuses an answer that is not the meter's and invents nothing from an empty one", () => {
    expect(parseKimiUsage({ error: "not found" }, NOW)).toEqual({ kind: "unrecognized" });
    expect(parseKimiUsage({ usages: { limit_5h: {} } }, NOW)).toEqual({ kind: "empty" });
  });
});

describe("fetchKimiQuota", () => {
  it("asks the usages endpoint with the account's own bearer and nothing borrowed", async () => {
    const { http, calls } = stubHttp({ status: 200, json: RATIO_ANSWER });
    const outcome = await fetchKimiQuota(
      http,
      { headers: { Authorization: "Bearer kimi-device-token" }, usingOAuth: true },
      NOW,
    );
    expect(outcome).toMatchObject({ status: "ok", plan: "Allegro" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(KIMI_USAGE_URL);
    expect(calls[0]?.init.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer kimi-device-token",
    });
  });

  it("sends a pasted Kimi Code key as the bearer", async () => {
    const { http, calls } = stubHttp({ status: 200, json: RATIO_ANSWER });
    await fetchKimiQuota(http, { apiKey: "sk-kimi-key", usingOAuth: false }, NOW);
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer sk-kimi-key");
  });

  it("keeps the quota rules: a 401 asks for renewal, a 403 and a new shape are not knowing", async () => {
    const auth = { apiKey: "sk-kimi-key", usingOAuth: false };
    expect(await fetchKimiQuota(stubHttp({ status: 401 }).http, auth, NOW)).toMatchObject({
      status: "auth_required",
      reason: "vendor_rejected",
    });
    expect((await fetchKimiQuota(stubHttp({ status: 403 }).http, auth, NOW)).status).toBe(
      "unavailable",
    );
    expect(
      await fetchKimiQuota(stubHttp({ status: 200, json: { data: [] } }).http, auth, NOW),
    ).toMatchObject({ status: "unavailable", reason: "schema_unrecognized", windows: [] });
    expect(
      await fetchKimiQuota(stubHttp({ status: 200, json: { usages: {} } }).http, auth, NOW),
    ).toMatchObject({ status: "not_measured", detail: KIMI_NO_WINDOW_DETAIL, windows: [] });
  });
});
