import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import type { QuotaHttp, QuotaRequest } from "../http";
import { fetchOpenCodeGoQuota, OPENCODE_GO_USAGE_URL } from "./opencodeGo";

/**
 * The OpenCode Go meter (INF-6873 part 1). The answers are OpenCode's own
 * documented examples (opencode.ai/docs/go, "Usage"), copied as written:
 * no live capture with a Go key exists here yet.
 */
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

const DOCUMENTED_ANSWER = {
  usage: {
    rolling: { status: "ok", percent: 30, resetsAt: "2026-11-21T15:00:00.000Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-23T00:00:00.000Z" },
    monthly: { status: "ok", percent: 50, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
};

const DOCUMENTED_ENTITLEMENT_REFUSAL = {
  type: "error",
  error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
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

describe("fetchOpenCodeGoQuota", () => {
  it("reads OpenCode's documented answer as the 5-hour, weekly and monthly windows, percent left", async () => {
    const { http, calls } = stubHttp({ status: 200, json: DOCUMENTED_ANSWER });
    const outcome = await fetchOpenCodeGoQuota(http, { apiKey: "sk-go", usingOAuth: false }, NOW);
    expect(calls).toEqual([
      {
        url: OPENCODE_GO_USAGE_URL,
        init: { headers: { Accept: "application/json", Authorization: "Bearer sk-go" } },
      },
    ]);
    expect(outcome.status).toBe("ok");
    expect(
      outcome.windows.map((window) => ({
        id: window.id,
        label: window.label,
        left: window.percentRemaining,
        resetsAt: window.resetsAtMs,
      })),
    ).toEqual([
      {
        id: "five_hour",
        label: "session",
        left: 70,
        resetsAt: Date.parse("2026-11-21T15:00:00.000Z"),
      },
      { id: "weekly", label: "weekly", left: 0, resetsAt: Date.parse("2026-11-23T00:00:00.000Z") },
      {
        id: "monthly",
        label: "monthly",
        left: 50,
        resetsAt: Date.parse("2026-12-01T00:00:00.000Z"),
      },
    ]);
  });

  it("reads a rate-limited meter as spent whatever its percent says", async () => {
    const { http } = stubHttp({
      status: 200,
      json: {
        usage: {
          rolling: { status: "rate-limited", percent: 97, resetsAt: "2026-11-21T15:00:00.000Z" },
        },
      },
    });
    const outcome = await fetchOpenCodeGoQuota(http, { apiKey: "sk-go", usingOAuth: false }, NOW);
    expect(outcome.windows.map((window) => [window.id, window.percentRemaining])).toEqual([
      ["five_hour", 0],
    ]);
  });

  it("asks to sign in again only on a 401", async () => {
    const { http } = stubHttp({ status: 401 });
    expect(
      await fetchOpenCodeGoQuota(http, { apiKey: "sk-wrong", usingOAuth: false }, NOW),
    ).toMatchObject({
      status: "auth_required",
      reason: "vendor_rejected",
    });
  });

  it("says no Go plan covers the key on OpenCode's 403 EntitlementError, never a sign-in", async () => {
    const { http } = stubHttp({ status: 403, json: DOCUMENTED_ENTITLEMENT_REFUSAL });
    expect(
      await fetchOpenCodeGoQuota(http, { apiKey: "sk-no-plan", usingOAuth: false }, NOW),
    ).toEqual({
      status: "unavailable",
      windows: [],
      reason: "no_entitlement",
      detail: m.accountsQuotaOpenCodeGoNoPlan(),
    });
  });

  it("treats any other 403 as a failed read, not a missing plan", async () => {
    const { http } = stubHttp({ status: 403, json: { message: "blocked" } });
    expect(await fetchOpenCodeGoQuota(http, { apiKey: "sk-go", usingOAuth: false }, NOW)).toEqual({
      status: "unavailable",
      windows: [],
      reason: "http_403",
    });
  });

  it("refuses an answer with no meter it knows instead of inventing a window", async () => {
    const { http } = stubHttp({ status: 200, json: { usage: { daily: { percent: 10 } } } });
    expect(await fetchOpenCodeGoQuota(http, { apiKey: "sk-go", usingOAuth: false }, NOW)).toEqual({
      status: "unavailable",
      windows: [],
      reason: "schema_unrecognized",
    });
  });

  it("asks nothing without the account's key", async () => {
    const { http, calls } = stubHttp({ status: 200, json: DOCUMENTED_ANSWER });
    expect((await fetchOpenCodeGoQuota(http, { usingOAuth: false }, NOW)).reason).toBe(
      "credential_unavailable",
    );
    expect(calls).toEqual([]);
  });
});
