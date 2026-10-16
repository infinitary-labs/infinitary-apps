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
 * Claude's plan windows, read from Anthropic's own OAuth usage endpoint with
 * the account's subscription credential - the same read-only request the
 * vendor's client makes. This is the sensor that closes the missing-quota
 * gap: before it, Claude quota existed only as mid-session pushes
 * (pushedQuota.ts), so an account that had not run a session yet rendered
 * nothing at all.
 *
 * A 401 is the vendor's verdict on the credential and the ONLY thing that can
 * lead to "sign in again" - and only after a delegated renewal through the
 * account's own client has failed to fix it (fetchQuota.ts). Local expiry
 * metadata never blocks the attempt: the client owns renewal, Infinitary owns the
 * store's location (claudeQuota.ts).
 */

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The OAuth beta header the vendor's own client sends on this API. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Window ids as the user reads them, matching the session-push vocabulary. */
export const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "weekly (Opus)",
  seven_day_sonnet: "weekly (Sonnet)",
  seven_day_overage_included: "weekly (with overage)",
  overage: "overage",
};

export function claudeWindowLabel(windowId: string): string {
  return CLAUDE_WINDOW_LABELS[windowId] ?? windowId.replace(/^model:/, "").replace(/_/g, " ");
}

/**
 * Window ids Infinitary understands at the top level of the usage response.
 *
 * The response also carries unreleased vendor codenames with the same shape
 * (`nimbus_quill`, `tangelo`, ...). Accepting every record turned those into
 * meters in the captain's Settings, so the top level is an allow list and the
 * vendor's own `limits` array is where new windows are meant to arrive from.
 */
const TOP_LEVEL_WINDOW_IDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
] as const;

/**
 * Read the usage response the way the vendor's own client does.
 *
 * `limits` is the authoritative list when it is present: it carries every
 * window the account currently has, including model-scoped ones
 * (`scope.model.display_name`), so a newly introduced limit appears without a
 * code change. The fixed top-level fields are the fallback for a response
 * that has no `limits`.
 */
export function parseClaudeUsage(body: unknown, now: number): { windows: QuotaWindowView[] } {
  const root = asRecord(body);
  if (!root) return { windows: [] };
  const windows: QuotaWindowView[] = [];
  const push = (window: QuotaWindowView | undefined) => {
    if (window && !windows.some((existing) => existing.id === window.id)) windows.push(window);
  };

  for (const entry of Array.isArray(root.limits) ? root.limits : []) {
    push(windowFromLimit(asRecord(entry), now));
  }

  if (windows.length === 0) {
    for (const key of TOP_LEVEL_WINDOW_IDS) {
      const slot = asRecord(root[key]);
      if (slot) push(windowFromSlot(slot, key, now));
    }
  }

  // Purchased extra usage is a real window, but only while it is switched on:
  // a disabled feature rendered as a full meter is an invented reading.
  const extra = asRecord(root.extra_usage);
  if (extra && extra.is_enabled === true) push(windowFromSlot(extra, "extra_usage", now));

  windows.sort((a, b) => a.id.localeCompare(b.id));
  return { windows };
}

/**
 * One entry of the vendor's `limits` array. Model-scoped entries name their
 * model in an object (`scope: { model: { display_name } }`), and the plain
 * session/weekly entries carry their period in `group`.
 */
function windowFromLimit(
  slot: Record<string, unknown> | undefined,
  now: number,
): QuotaWindowView | undefined {
  if (!slot) return undefined;
  const model = asRecord(asRecord(slot.scope)?.model);
  const displayName = model ? asString(model.display_name) : undefined;
  if (displayName) {
    const key = asString(model?.id) ?? slugify(displayName);
    return windowFromSlot(
      slot,
      `model:${key}`,
      now,
      WEEKLY_WINDOW_SECONDS,
      `${displayName} weekly`,
    );
  }
  const group = asString(slot.group);
  if (group === "session") return windowFromSlot(slot, "five_hour", now, SESSION_WINDOW_SECONDS);
  if (group === "weekly") return windowFromSlot(slot, "seven_day", now, WEEKLY_WINDOW_SECONDS);
  const kind = asString(slot.kind);
  return kind ? windowFromSlot(slot, kind, now) : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function windowFromSlot(
  slot: Record<string, unknown>,
  id: string,
  now: number,
  defaultWindowSeconds?: number,
  label?: string,
): QuotaWindowView | undefined {
  // Every used share in the usage response is a 0–100 percentage: the
  // top-level `utilization` carries the same number as `limits[].percent`
  // (4 and 4 in the live capture). Never read a value of 1 or less as a
  // fraction: that turns a session at 1% used into 0% remaining.
  const usedPercent =
    asNumber(slot.utilization) ??
    asNumber(slot.used_percent) ??
    asNumber(slot.percent_used) ??
    asNumber(slot.percent);
  const remaining =
    asNumber(slot.percent_remaining) ??
    (usedPercent !== undefined ? clampPercent(100 - usedPercent) : undefined);
  const resetsAtMs = parseTimestamp(slot.resets_at ?? slot.resetsAt ?? slot.reset_at);
  if (remaining === undefined && resetsAtMs === undefined) return undefined;
  const windowSeconds = asNumber(slot.window_seconds) ?? asNumber(slot.duration_seconds);
  return buildWindow({
    id,
    label: label ?? claudeWindowLabel(id),
    ...(remaining !== undefined ? { percentRemaining: remaining } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(windowSeconds !== undefined
      ? { windowSeconds }
      : defaultWindowSeconds !== undefined
        ? { windowSeconds: defaultWindowSeconds }
        : {}),
    now,
  });
}

export async function fetchClaudeQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
  usageUrl: string = CLAUDE_USAGE_URL,
): Promise<ProviderOutcome> {
  if (!auth.apiKey) return CREDENTIAL_UNAVAILABLE;
  const result = await http(usageUrl, {
    headers: requestHeaders(auth, {
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
    }),
  });
  if (!succeeded(result)) return failureFromResponse(result);
  return { status: "ok", ...parseClaudeUsage(result.json, now) };
}
