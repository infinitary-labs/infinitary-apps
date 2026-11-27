import * as m from "@shared/i18n/messages.generated";
import type { QuotaWindowView } from "@shared/quota";
import type { ManagedAuth } from "../auth";
import { type QuotaHttp, requestHeaders } from "../http";
import { asNumber, asRecord, asString, clampPercent } from "../json";
import {
  CREDENTIAL_UNAVAILABLE,
  failureFromResponse,
  type ProviderOutcome,
  succeeded,
} from "../outcome";
import {
  buildWindow,
  parseTimestamp,
  SESSION_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "../pace";

/**
 * The OpenCode Go plan's usage reading, documented by OpenCode
 * (opencode.ai/docs/go, "Usage"), read with the account's own pasted key as
 * a bearer. The answer is `{ usage: { rolling, weekly, monthly } }`, each
 * meter `{ status, percent, resetsAt }`: `percent` is how much of the limit
 * is USED, a whole number from 0 to 100; `resetsAt` is ISO 8601; `status` is
 * `ok`, or `rate-limited` once that limit is used up. `rolling` is the
 * 5-hour limit. Anything else is refused (`schema_unrecognized`), never
 * guessed into a window.
 */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";

/**
 * The 5-hour and weekly limits have fixed lengths and so a pace; the monthly
 * allowance follows the paid period, which has none.
 */
const METERS = [
  { key: "rolling", id: "five_hour", label: "session", seconds: SESSION_WINDOW_SECONDS },
  { key: "weekly", id: "weekly", label: "weekly", seconds: WEEKLY_WINDOW_SECONDS },
  { key: "monthly", id: "monthly", label: "monthly", seconds: undefined },
] as const;

export function parseOpenCodeGoUsage(body: unknown, now: number): QuotaWindowView[] | undefined {
  const usage = asRecord(asRecord(body)?.usage);
  if (!usage) return undefined;
  const windows: QuotaWindowView[] = [];
  for (const meter of METERS) {
    const slot = asRecord(usage[meter.key]);
    const used = asNumber(slot?.percent);
    if (!slot || used === undefined) continue;
    const spent = asString(slot.status) === "rate-limited";
    const resetsAtMs = parseTimestamp(slot.resetsAt);
    windows.push(
      buildWindow({
        id: meter.id,
        label: meter.label,
        percentRemaining: spent ? 0 : 100 - clampPercent(used),
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        ...(meter.seconds !== undefined ? { windowSeconds: meter.seconds } : {}),
        now,
      }),
    );
  }
  return windows.length > 0 ? windows : undefined;
}

/**
 * A 403 whose body names OpenCode's EntitlementError: the key is valid but
 * no active Go plan covers it. Signing in again with the same key changes
 * nothing, so it is never `auth_required`.
 */
function isEntitlementRefusal(json: unknown): boolean {
  return asString(asRecord(asRecord(json)?.error)?.type) === "EntitlementError";
}

export async function fetchOpenCodeGoQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
  usageUrl: string = OPENCODE_GO_USAGE_URL,
): Promise<ProviderOutcome> {
  if (!auth.apiKey && !auth.headers) return CREDENTIAL_UNAVAILABLE;
  const result = await http(usageUrl, {
    headers: requestHeaders(auth, { Accept: "application/json" }),
  });
  if (result.status === 403 && isEntitlementRefusal(result.json)) {
    return {
      status: "unavailable",
      windows: [],
      reason: "no_entitlement",
      detail: m.accountsQuotaOpenCodeGoNoPlan(),
    };
  }
  if (!succeeded(result)) return failureFromResponse(result);
  const windows = parseOpenCodeGoUsage(result.json, now);
  if (!windows) return { status: "unavailable", windows: [], reason: "schema_unrecognized" };
  return { status: "ok", windows };
}
