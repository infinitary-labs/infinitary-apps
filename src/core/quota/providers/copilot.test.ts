import { describe, expect, it } from "vitest";
import type { QuotaHttp, QuotaRequest } from "../http";
import {
  COPILOT_CHAT_LABEL,
  COPILOT_NO_WINDOW_DETAIL,
  COPILOT_PLAN,
  COPILOT_PREMIUM_LABEL,
  COPILOT_USAGE_URL,
  fetchCopilotQuota,
  parseCopilotUsage,
} from "./copilot";

/**
 * The Copilot meter of INF-560's plan, read from GitHub's
 * `copilot_internal/user`. No live capture exists yet: the answers below
 * carry the field set CodexBar's reader and the copilot-api project decode
 * from a paid seat (premium requests metered, chat and completions
 * unlimited) and from a free seat (everything metered), with numbers a
 * month of use produces.
 */
const NOW = Date.parse("2026-10-19T17:00:00Z");
const RESET = Date.parse("2026-11-01T00:00:00Z");
const CYCLE_START = Date.parse("2026-10-01T00:00:00Z");

const PAID_SEAT = {
  access_type_sku: "monthly_subscriber_quota",
  analytics_tracking_id: "0f3c2a9e5b7d4c1a8e6f2b3d4c5a6e7f",
  assigned_date: "2026-03-14T18:22:09+00:00",
  can_signup_for_limited: false,
  chat_enabled: true,
  copilot_plan: "individual",
  organization_login_list: [],
  organization_list: [],
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    chat: {
      entitlement: 0,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "chat",
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
    },
    completions: {
      entitlement: 0,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "completions",
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
    },
    premium_interactions: {
      entitlement: 300,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 22.3,
      quota_id: "premium_interactions",
      quota_remaining: 66.9,
      remaining: 66,
      unlimited: false,
    },
  },
};

const FREE_SEAT = {
  ...PAID_SEAT,
  access_type_sku: "free_limited_copilot",
  copilot_plan: "free",
  quota_snapshots: {
    ...PAID_SEAT.quota_snapshots,
    chat: {
      ...PAID_SEAT.quota_snapshots.chat,
      entitlement: 50,
      percent_remaining: 64,
      quota_remaining: 32,
      remaining: 32,
      unlimited: false,
    },
    premium_interactions: {
      ...PAID_SEAT.quota_snapshots.premium_interactions,
      entitlement: 50,
      percent_remaining: 90,
      quota_remaining: 45,
      remaining: 45,
    },
  },
};

const GITHUB_SIGN_IN = {
  apiKey: "gho_account-sign-in",
  baseUrl: "https://api.github.com",
  usingOAuth: true,
};

function stubHttp(answer: Awaited<ReturnType<QuotaHttp>>) {
  const calls: { url: string; init: QuotaRequest }[] = [];
  const http: QuotaHttp = async (url, init) => {
    calls.push({ url, init });
    return answer;
  };
  return { http, calls };
}

describe("parseCopilotUsage", () => {
  it("reads a paid seat's premium requests as its one window, over the month to the reset", () => {
    const parsed = parseCopilotUsage(PAID_SEAT, NOW);
    expect(parsed.kind).toBe("windows");
    if (parsed.kind !== "windows") return;
    // Unlimited chat and completions are no meter.
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({
      id: "premium_interactions",
      label: COPILOT_PREMIUM_LABEL,
      percentRemaining: 22.3,
      resetsAtMs: RESET,
      startsAtMs: CYCLE_START,
      windowSeconds: (RESET - CYCLE_START) / 1000,
    });
    // 78% of the requests gone with 40% of the month left is ahead of the clock.
    expect(parsed.windows[0]?.pace).toBe("ahead");
    expect(parsed.windows[0]?.resetText).toMatch(/^resets /);
  });

  it("reads paid premium requests past the allowance as a credits fact, shown only", () => {
    // INF-4104 piece 1: `overage_permitted` on the premium-requests snapshot.
    expect(parseCopilotUsage(PAID_SEAT, NOW)).toMatchObject({ credits: { state: "off" } });
    const permitted = {
      ...PAID_SEAT,
      quota_snapshots: {
        ...PAID_SEAT.quota_snapshots,
        premium_interactions: {
          ...PAID_SEAT.quota_snapshots.premium_interactions,
          overage_permitted: true,
        },
      },
    };
    expect(parseCopilotUsage(permitted, NOW)).toMatchObject({ credits: { state: "available" } });
  });

  it("shows chat beside premium requests when the plan meters it", () => {
    const parsed = parseCopilotUsage(FREE_SEAT, NOW);
    expect(parsed.kind).toBe("windows");
    if (parsed.kind !== "windows") return;
    expect(
      parsed.windows.map((window) => [window.id, window.label, window.percentRemaining]),
    ).toEqual([
      ["premium_interactions", COPILOT_PREMIUM_LABEL, 90],
      ["product:chat", COPILOT_CHAT_LABEL, 64],
    ]);
  });

  it("reads a seat billed another way, with zero-entitlement placeholders, as no window", () => {
    const placeholder = {
      ...PAID_SEAT.quota_snapshots.premium_interactions,
      entitlement: 0,
      remaining: 0,
      quota_remaining: 0,
      percent_remaining: 100,
    };
    const parsed = parseCopilotUsage(
      {
        ...PAID_SEAT,
        quota_snapshots: { ...PAID_SEAT.quota_snapshots, premium_interactions: placeholder },
      },
      NOW,
    );
    expect(parsed).toEqual({ kind: "empty" });
  });

  it("refuses an answer with no quota snapshots rather than inventing a window", () => {
    const { quota_snapshots: _gone, ...rest } = PAID_SEAT;
    expect(parseCopilotUsage(rest, NOW)).toEqual({ kind: "unrecognized" });
  });
});

describe("fetchCopilotQuota", () => {
  it("asks GitHub's API with the account's GitHub sign-in and names the plan", async () => {
    const { http, calls } = stubHttp({ status: 200, json: PAID_SEAT });
    const outcome = await fetchCopilotQuota(http, GITHUB_SIGN_IN, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(COPILOT_USAGE_URL);
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer gho_account-sign-in");
    expect(outcome).toMatchObject({ status: "ok", plan: COPILOT_PLAN });
    expect(outcome.windows.map((window) => window.label)).toEqual([COPILOT_PREMIUM_LABEL]);
  });

  it("asks a GitHub Enterprise account's own API", async () => {
    const { http, calls } = stubHttp({ status: 200, json: PAID_SEAT });
    await fetchCopilotQuota(
      http,
      { ...GITHUB_SIGN_IN, baseUrl: "https://api.octocorp.ghe.com" },
      NOW,
    );
    expect(calls[0]?.url).toBe("https://api.octocorp.ghe.com/copilot_internal/user");
  });

  it("calls a refused GitHub sign-in lapsed, which only signing in again replaces", async () => {
    const { http } = stubHttp({ status: 401, json: { message: "Bad credentials" } });
    expect(await fetchCopilotQuota(http, GITHUB_SIGN_IN, NOW)).toEqual({
      status: "auth_required",
      windows: [],
      reason: "refresh_token_lapsed",
    });
  });

  it("keeps a 403 as not knowing, never a sign-out", async () => {
    const { http } = stubHttp({ status: 403, json: {} });
    expect(await fetchCopilotQuota(http, GITHUB_SIGN_IN, NOW)).toMatchObject({
      status: "unavailable",
      reason: "http_403",
    });
  });

  it("says a reading with nothing metered was read, never that the plan has none", async () => {
    const unlimited = {
      ...PAID_SEAT,
      quota_snapshots: {
        ...PAID_SEAT.quota_snapshots,
        premium_interactions: {
          ...PAID_SEAT.quota_snapshots.premium_interactions,
          unlimited: true,
        },
      },
    };
    const { http } = stubHttp({ status: 200, json: unlimited });
    expect(await fetchCopilotQuota(http, GITHUB_SIGN_IN, NOW)).toMatchObject({
      status: "not_measured",
      windows: [],
      detail: COPILOT_NO_WINDOW_DETAIL,
    });
  });

  it("asks nothing without a stored sign-in", async () => {
    const { http, calls } = stubHttp({ status: 200, json: PAID_SEAT });
    expect(await fetchCopilotQuota(http, { usingOAuth: true }, NOW)).toMatchObject({
      status: "unavailable",
      reason: "credential_unavailable",
    });
    expect(calls).toHaveLength(0);
  });
});
