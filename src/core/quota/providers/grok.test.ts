import { describe, expect, it, vi } from "vitest";
import {
  consumerConfigMessage,
  grpcFrame,
  grpcTrailer,
  grpcWebOkBody,
  messageField,
  scalarField,
} from "../../../../tests/support/grpcWebEncoder";
import type { QuotaHttp, QuotaRequest } from "../http";
import { fetchGrokQuota, GROK_NO_WINDOW_DETAIL, GROK_USAGE_URL, parseGrokUsage } from "./grok";

const NOW = Date.parse("2026-09-05T08:00:00Z");
const PERIOD_START = Date.parse("2026-08-31T19:59:29Z");
const PERIOD_END = Date.parse("2026-09-07T19:59:29Z");
const WEEK_SECONDS = 7 * 24 * 3600;

/**
 * The data frame the live meter answered with on 2026-09-05 (a Grok session
 * on the captain's mini; usage numbers only, nothing a credential could be
 * recovered from): 25% of the weekly credits used, one Grok Build product at
 * the same 25%, the current weekly period, an empty prepaid balance.
 */
const LIVE_MESSAGE = Uint8Array.from([
  10, 84, 13, 0, 0, 200, 65, 18, 0, 26, 0, 34, 12, 8, 161, 186, 215, 212, 6, 16, 232, 175, 182, 166,
  3, 42, 12, 8, 161, 175, 252, 212, 6, 16, 232, 175, 182, 166, 3, 58, 7, 8, 2, 21, 0, 0, 200, 65,
  66, 30, 8, 2, 18, 12, 8, 161, 186, 215, 212, 6, 16, 232, 175, 182, 166, 3, 26, 12, 8, 161, 175,
  252, 212, 6, 16, 232, 175, 182, 166, 3, 88, 1, 98, 0, 104, 1,
]);

const OAUTH = { apiKey: "xai-oauth-access", usingOAuth: true };

type Call = { url: string; init: QuotaRequest };

/** An http seam that answers the meter and the sign-in probe separately. */
function stubHttp(answers: {
  meter: Parameters<QuotaHttp>[1] extends infer _ ? Awaited<ReturnType<QuotaHttp>> : never;
  models?: Awaited<ReturnType<QuotaHttp>>;
}): { http: QuotaHttp; calls: Call[] } {
  const calls: Call[] = [];
  const http: QuotaHttp = async (url, init) => {
    calls.push({ url, init });
    if (url === GROK_USAGE_URL) return answers.meter;
    if (url === "https://api.x.ai/v1/models") return answers.models ?? { status: 200, json: {} };
    throw new Error(`unexpected ${url}`);
  };
  return { http, calls };
}

describe("parseGrokUsage", () => {
  it("reads the live capture into the shared credits window and its product window", () => {
    const parsed = parseGrokUsage(LIVE_MESSAGE, NOW);
    expect(parsed.kind).toBe("windows");
    if (parsed.kind !== "windows") return;
    expect(parsed.windows).toHaveLength(2);
    expect(parsed.windows[0]).toMatchObject({
      id: "credits",
      label: "credits",
      percentRemaining: 75,
      startsAtMs: PERIOD_START,
      resetsAtMs: PERIOD_END,
      windowSeconds: WEEK_SECONDS,
    });
    expect(parsed.windows[1]).toMatchObject({
      id: "product:grok_build",
      label: "Grok Build",
      percentRemaining: 75,
      resetsAtMs: PERIOD_END,
    });
    // Two days into a week at 25% used is under the reset clock: calm.
    expect(parsed.windows[0]?.pace).toBe("behind");
    expect(parsed.windows[0]?.resetText).toMatch(/^resets /);
  });

  it("treats an omitted usage float as proto3 zero only when a valid period proves the config", () => {
    const zeroUsed = parseGrokUsage(
      consumerConfigMessage({
        periodType: 2,
        periodStartSeconds: PERIOD_START / 1000,
        periodEndSeconds: PERIOD_END / 1000,
        products: [{ product: 2 }],
      }),
      NOW,
    );
    expect(zeroUsed.kind).toBe("windows");
    if (zeroUsed.kind !== "windows") return;
    expect(zeroUsed.windows.map((window) => [window.id, window.percentRemaining])).toEqual([
      ["credits", 100],
      ["product:grok_build", 100],
    ]);

    // No percent and no valid period: nothing was read, nothing is invented.
    expect(parseGrokUsage(consumerConfigMessage({ periodType: 0 }), NOW)).toEqual({
      kind: "empty",
    });
    expect(
      parseGrokUsage(
        consumerConfigMessage({ periodType: 2, periodEndSeconds: PERIOD_END / 1000 }),
        NOW,
      ),
    ).toEqual({ kind: "empty" });
  });

  it("names every product the vendor has, and discloses an unknown one without dropping it", () => {
    const parsed = parseGrokUsage(
      consumerConfigMessage({
        percentUsed: 12.5,
        products: [
          { product: 1, percentUsed: 10 },
          { product: 4, percentUsed: 20.25 },
          { product: 9, percentUsed: 30 },
          { percentUsed: 40 },
        ],
      }),
      NOW,
    );
    expect(
      parsed.kind === "windows" && parsed.windows.map((w) => [w.id, w.label, w.percentRemaining]),
    ).toEqual([
      ["credits", "credits", 87.5],
      ["product:api", "API", 90],
      ["product:chat", "Chat", 79.75],
      ["product:unknown_9", "Product 9", 70],
      ["product:unspecified", "Other", 60],
    ]);
  });

  it("clamps an out-of-range percent and rounds float32 noise away", () => {
    const parsed = parseGrokUsage(consumerConfigMessage({ percentUsed: 130 }), NOW);
    expect(parsed.kind === "windows" && parsed.windows[0]?.percentRemaining).toBe(0);
    const noisy = parseGrokUsage(consumerConfigMessage({ percentUsed: 22.4 }), NOW);
    expect(noisy.kind === "windows" && noisy.windows[0]?.percentRemaining).toBe(77.6);
  });

  it("refuses a message that is not the config it knows", () => {
    // A top-level message with no config submessage.
    expect(parseGrokUsage(scalarField(1, 5), NOW)).toEqual({ kind: "unrecognized" });
    // A config whose bytes are malformed.
    expect(parseGrokUsage(messageField(1, Uint8Array.from([0x08])), NOW)).toEqual({
      kind: "unrecognized",
    });
  });
});

describe("fetchGrokQuota over OAuth", () => {
  it("POSTs the empty request to the meter with the account's own bearer and reads real windows", async () => {
    const { http, calls } = stubHttp({
      meter: { status: 200, bytes: grpcWebOkBody(LIVE_MESSAGE) },
    });
    const result = await fetchGrokQuota(http, OAUTH, NOW);
    expect(result.status).toBe("ok");
    expect(result.windows.map((window) => window.id)).toEqual(["credits", "product:grok_build"]);
    expect(result.detail).toBeUndefined();
    // Exactly one request, and nothing that pretends to be a browser.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GROK_USAGE_URL);
    expect(calls[0]?.init).toMatchObject({ method: "POST", responseType: "bytes" });
    expect(Array.from(calls[0]?.init.body ?? [])).toEqual([0, 0, 0, 0, 0]);
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer xai-oauth-access",
      Accept: "*/*",
      "Content-Type": "application/grpc-web+proto",
      "x-grpc-web": "1",
    });
  });

  it("honours a dev/e2e endpoint override", async () => {
    const { http, calls } = stubHttp({ meter: { status: 500 } });
    const override: QuotaHttp = async (url, init) => {
      if (url === "http://127.0.0.1:9/meter")
        return { status: 200, bytes: grpcFrame(LIVE_MESSAGE) };
      return http(url, init);
    };
    const result = await fetchGrokQuota(override, OAUTH, NOW, "http://127.0.0.1:9/meter");
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an HTTP 401", { status: 401 }, "meter_http_401"],
    ["an HTTP 403", { status: 403 }, "meter_http_403"],
    [
      "gRPC UNAUTHENTICATED",
      { status: 200, bytes: grpcTrailer({ "grpc-status": "16", "grpc-message": "expired" }) },
      "meter_grpc_16",
    ],
    [
      "gRPC PERMISSION_DENIED",
      { status: 200, headers: { "grpc-status": "7" }, bytes: new Uint8Array() },
      "meter_grpc_7",
    ],
  ])(
    "keeps a live sign-in whose meter answered %s on the honest disclosed line",
    async (_label, meter, reason) => {
      // The meter refused, but the sign-in itself is alive: that is "no
      // reading", never "sign in again" - the same bearer may be serving
      // inference right now.
      const { http, calls } = stubHttp({ meter, models: { status: 200, json: { data: [] } } });
      const result = await fetchGrokQuota(http, OAUTH, NOW);
      expect(result).toEqual({
        status: "not_measured",
        windows: [],
        detail: GROK_NO_WINDOW_DETAIL,
        reason,
      });
      expect(calls.map((call) => call.url)).toEqual([GROK_USAGE_URL, "https://api.x.ai/v1/models"]);
    },
  );

  it("maps a meter refusal that the vendor's own API confirms to auth_required", async () => {
    const { http } = stubHttp({ meter: { status: 401 }, models: { status: 401, json: {} } });
    const result = await fetchGrokQuota(http, OAUTH, NOW);
    expect(result).toMatchObject({ status: "auth_required", reason: "vendor_rejected" });
  });

  it("reports a sign-in probe that could not answer as not knowing, not as a refusal", async () => {
    const { http } = stubHttp({ meter: { status: 403 }, models: { status: 503, json: {} } });
    const result = await fetchGrokQuota(http, OAUTH, NOW);
    expect(result).toMatchObject({ status: "unavailable", reason: "http_503" });
  });

  it("classifies a rate limit from either layer, keeping Retry-After", async () => {
    const http429 = stubHttp({ meter: { status: 429, retryAfter: "30" } });
    expect(await fetchGrokQuota(http429.http, OAUTH, NOW)).toMatchObject({
      status: "rate_limited",
      retryAfter: "30",
    });
    const grpc8 = stubHttp({
      meter: { status: 200, bytes: grpcTrailer({ "grpc-status": "8" }), retryAfter: "5" },
    });
    expect(await fetchGrokQuota(grpc8.http, OAUTH, NOW)).toMatchObject({
      status: "rate_limited",
      retryAfter: "5",
    });
    expect(grpc8.calls).toHaveLength(1);
  });

  it("reports any other server verdict as not knowing, with a sanitized reason", async () => {
    const { http } = stubHttp({
      meter: { status: 200, bytes: grpcTrailer({ "grpc-status": "13", "grpc-message": "boom" }) },
    });
    expect(await fetchGrokQuota(http, OAUTH, NOW)).toEqual({
      status: "unavailable",
      windows: [],
      reason: "grpc_13",
    });
    const down = stubHttp({ meter: { status: 502 } });
    expect(await fetchGrokQuota(down.http, OAUTH, NOW)).toMatchObject({
      status: "unavailable",
      reason: "http_502",
    });
  });

  it("never invents a window from a body it does not recognize", async () => {
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.from([0, 0, 0, 0, 8, 10]),
      grpcFrame(scalarField(3, 1)),
    ]) {
      const { http, calls } = stubHttp({ meter: { status: 200, bytes } });
      expect(await fetchGrokQuota(http, OAUTH, NOW)).toEqual({
        status: "unavailable",
        windows: [],
        reason: "schema_unrecognized",
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("discloses a well-formed answer that carries no window", async () => {
    const { http } = stubHttp({
      meter: { status: 200, bytes: grpcWebOkBody(consumerConfigMessage({ periodType: 0 })) },
    });
    expect(await fetchGrokQuota(http, OAUTH, NOW)).toEqual({
      status: "not_measured",
      windows: [],
      detail: GROK_NO_WINDOW_DETAIL,
      reason: "no_window_read",
    });
  });

  it("asks nothing without a credential", async () => {
    const http = vi.fn<QuotaHttp>();
    expect(await fetchGrokQuota(http, { usingOAuth: true }, NOW)).toMatchObject({
      status: "unavailable",
      reason: "credential_unavailable",
    });
    expect(http).not.toHaveBeenCalled();
  });
});
