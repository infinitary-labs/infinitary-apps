import { REFRESH_TOKEN_LAPSED } from "@shared/credentialHealth";
import type { QuotaCreditsView, QuotaWindowView } from "@shared/quota";
import type { ManagedAuth } from "../auth";
import { isAuthFailure, type QuotaHttp, requestHeaders } from "../http";
import { asNumber, asRecord, clampPercent } from "../json";
import {
  CREDENTIAL_UNAVAILABLE,
  failureFromResponse,
  type ProviderOutcome,
  succeeded,
} from "../outcome";
import { buildWindow, parseTimestamp } from "../pace";

/**
 * GitHub Copilot's allowance, read from the user endpoint VS Code's Copilot
 * reads (`copilot_internal/user`), with the GitHub sign-in Pi stores for
 * the account (`copilotMeterAuth`, src/core/pi/copilotMeter.ts). The
 * endpoint is undocumented and can change without notice: an answer this
 * reader no longer recognizes is `schema_unrecognized`, never an invented
 * window. The answer carries a `quota_snapshots` map (premium requests,
 * chat, completions) and a `quota_reset_date` (INF-560's plan).
 *
 * The request carries only the bearer and an Accept header: no borrowed
 * editor identity, so Infinitary does not claim to be something it is not
 * where it has the choice.
 */
export const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

/** The window that bounds the account: the month's premium requests. */
export const COPILOT_PREMIUM_LABEL = "premium requests";
/** Chat, shown when the plan meters it; it bounds only its own scope. */
export const COPILOT_CHAT_LABEL = "chat";
/** The plan a Copilot row names (the captain's word for it, INF-560). */
export const COPILOT_PLAN = "GitHub Copilot";

/**
 * What Infinitary says about a Copilot sign-in whose answer carried no
 * metered window - every allowance unlimited, or a seat billed another way.
 * It states what happened on this read, never what the plan allows.
 */
export const COPILOT_NO_WINDOW_DETAIL =
  "GitHub Copilot didn't return an allowance reading for this sign-in.";

/** The user endpoint on the host the account signed in to. */
export function copilotUsageUrl(apiBase: string | undefined): string {
  return apiBase ? `${apiBase.replace(/\/$/, "")}/copilot_internal/user` : COPILOT_USAGE_URL;
}

export type CopilotUsageParse =
  | { kind: "windows"; windows: QuotaWindowView[]; credits?: QuotaCreditsView }
  /** A known answer with nothing metered in it. */
  | { kind: "empty" }
  /** Not the answer this reader knows. */
  | { kind: "unrecognized" };

/**
 * Read the user endpoint's answer. `quota_snapshots.premium_interactions`
 * is the account's bound and `quota_snapshots.chat` its own scope; a
 * snapshot marked unlimited, or a zero-entitlement placeholder, is no
 * window. `quota_reset_date` is the first day of the next month, in UTC,
 * so the cycle runs from the same day a month before.
 */
export function parseCopilotUsage(body: unknown, now: number): CopilotUsageParse {
  const snapshots = asRecord(asRecord(body)?.quota_snapshots);
  if (!snapshots) return { kind: "unrecognized" };
  const resetsAtMs = parseTimestamp(asRecord(body)?.quota_reset_date);
  const startsAtMs = resetsAtMs !== undefined ? monthBefore(resetsAtMs) : undefined;
  const cycle =
    resetsAtMs !== undefined && startsAtMs !== undefined
      ? { resetsAtMs, startsAtMs, windowSeconds: (resetsAtMs - startsAtMs) / 1000 }
      : {};
  const windows: QuotaWindowView[] = [];
  for (const [key, id, label] of [
    ["premium_interactions", "premium_interactions", COPILOT_PREMIUM_LABEL],
    ["chat", "product:chat", COPILOT_CHAT_LABEL],
  ] as const) {
    const percentRemaining = meteredPercent(snapshots[key]);
    if (percentRemaining === undefined) continue;
    windows.push(buildWindow({ id, label, percentRemaining, ...cycle, now }));
  }
  if (windows.length === 0) return { kind: "empty" };
  const credits = copilotCredits(snapshots.premium_interactions);
  return { kind: "windows", windows, ...(credits ? { credits } : {}) };
}

/**
 * Paid premium requests past the allowance, as a credits fact shown only
 * (docs/quota.md, "Credits past the allowance"): `overage_permitted` on the
 * premium-requests snapshot. GitHub does not yet say when a budget stops a
 * request, so nothing here is ever `spent`.
 */
function copilotCredits(value: unknown): QuotaCreditsView | undefined {
  const permitted = asRecord(value)?.overage_permitted;
  if (permitted === true) return { state: "available" };
  if (permitted === false) return { state: "off" };
  return undefined;
}

/** A snapshot's percent left, or undefined when it meters nothing. */
function meteredPercent(value: unknown): number | undefined {
  const snapshot = asRecord(value);
  if (!snapshot || snapshot.unlimited === true) return undefined;
  const entitlement = asNumber(snapshot.entitlement);
  const remaining = asNumber(snapshot.remaining);
  // GitHub sends a zero-entitlement, zero-remaining snapshot for a seat
  // billed another way; read as a window it would be a fake reading.
  if (entitlement === 0 && remaining === 0) return undefined;
  const percent = asNumber(snapshot.percent_remaining);
  if (percent !== undefined) return clampPercent(percent);
  if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    return clampPercent((remaining / entitlement) * 100);
  }
  return undefined;
}

function monthBefore(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  );
}

export async function fetchCopilotQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
  usageUrl?: string,
): Promise<ProviderOutcome> {
  if (!auth.apiKey) return CREDENTIAL_UNAVAILABLE;
  const result = await http(usageUrl ?? copilotUsageUrl(auth.baseUrl), {
    headers: requestHeaders(auth, { Accept: "application/json" }),
  });
  if (!succeeded(result)) {
    // The token sent is the GitHub sign-in itself, which no renewal can
    // replace: GitHub refusing it is the proof that it lapsed.
    if (isAuthFailure(result.status)) {
      return { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED };
    }
    return failureFromResponse(result);
  }
  const parsed = parseCopilotUsage(result.json, now);
  if (parsed.kind === "unrecognized") {
    return { status: "unavailable", windows: [], reason: "schema_unrecognized" };
  }
  if (parsed.kind === "empty") {
    return {
      status: "not_measured",
      windows: [],
      plan: COPILOT_PLAN,
      detail: COPILOT_NO_WINDOW_DETAIL,
      reason: "no_window_read",
    };
  }
  return {
    status: "ok",
    windows: parsed.windows,
    ...(parsed.credits ? { credits: parsed.credits } : {}),
    plan: COPILOT_PLAN,
  };
}
