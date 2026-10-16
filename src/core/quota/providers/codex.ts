import type { QuotaWindowView } from "@shared/quota";
import type { ManagedAuth } from "../auth";
import { type QuotaHttp, requestHeaders } from "../http";
import { asNumber, asRecord, asString, remainingFromUsedPercent } from "../json";
import {
  CREDENTIAL_UNAVAILABLE,
  failureFromResponse,
  type ProviderOutcome,
  succeeded,
} from "../outcome";
import {
  buildWindow,
  resetsAtFromRemainingSeconds,
  SESSION_WINDOW_SECONDS,
  WEEKLY_WINDOW_SECONDS,
} from "../pace";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_CLAIM = "https://api.openai.com/auth";

export function chatgptAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const claim = asRecord(asRecord(payload)?.[JWT_CLAIM]);
    return asString(claim?.chatgpt_account_id);
  } catch {
    return undefined;
  }
}

export function parseCodexUsage(
  body: unknown,
  now: number,
): {
  windows: QuotaWindowView[];
  plan?: string;
} {
  const root = asRecord(body);
  if (!root) return { windows: [] };
  const rate = asRecord(root.rate_limit) ?? asRecord(root.rateLimit) ?? root;
  const windows: QuotaWindowView[] = [];
  // A slot's own length names it: a Pro plan sends its 7-day window as
  // primary. The slot's position names it only when no length is given.
  const slots = [
    { slot: asRecord(rate.primary_window) ?? asRecord(rate.primaryWindow), fallback: "five_hour" },
    {
      slot: asRecord(rate.secondary_window) ?? asRecord(rate.secondaryWindow),
      fallback: "weekly",
    },
  ];
  for (const { slot, fallback } of slots) {
    if (!slot) continue;
    const id = durationId(slot) ?? fallback;
    const parsed = windowFromSlot(slot, id, labelFor(id), now);
    if (parsed) windows.push(parsed);
  }

  for (const [key, node] of Object.entries(rate)) {
    if (key === "primary_window" || key === "primaryWindow") continue;
    if (key === "secondary_window" || key === "secondaryWindow") continue;
    const slot = asRecord(node);
    if (!slot) continue;
    const id = slotId(key, slot);
    const parsed = windowFromSlot(slot, id, labelFor(id), now);
    if (parsed) windows.push(parsed);
  }

  const plan = asString(root.plan_type) ?? asString(root.plan);
  return { windows, ...(plan ? { plan } : {}) };
}

function windowSecondsOf(slot: Record<string, unknown>): number | undefined {
  return (
    asNumber(slot.limit_window_seconds) ?? asNumber(slot.window_seconds) ?? asNumber(slot.limit)
  );
}

function durationId(slot: Record<string, unknown>): "five_hour" | "weekly" | undefined {
  const seconds = windowSecondsOf(slot);
  if (seconds === SESSION_WINDOW_SECONDS) return "five_hour";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  return undefined;
}

function slotId(key: string, slot: Record<string, unknown>): string {
  const duration = durationId(slot);
  return duration ? `${key}_${duration}` : key;
}

function labelFor(id: string): string {
  if (id.includes("five_hour") || id === "five_hour") return "session";
  if (id.includes("weekly") || id === "weekly") return "weekly";
  return id.replaceAll("_", " ");
}

function windowFromSlot(
  slot: Record<string, unknown> | undefined,
  id: string,
  label: string,
  now: number,
): QuotaWindowView | undefined {
  if (!slot) return undefined;
  const used =
    asNumber(slot.used_percent) ?? asNumber(slot.usedPercent) ?? asNumber(slot.percent_used);
  const remaining =
    asNumber(slot.percent_remaining) ??
    (used !== undefined ? remainingFromUsedPercent(used) : undefined);
  const windowSeconds = windowSecondsOf(slot);
  const resetsAtMs = resetsAtFromRemainingSeconds(
    slot.reset_after_seconds ?? slot.resetAfterSeconds ?? slot.resets_in_seconds,
    now,
  );
  if (remaining === undefined && resetsAtMs === undefined) return undefined;
  return buildWindow({
    id,
    label,
    ...(remaining !== undefined ? { percentRemaining: remaining } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    now,
  });
}

export async function fetchCodexQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
): Promise<ProviderOutcome> {
  const token = auth.apiKey;
  if (!token) return CREDENTIAL_UNAVAILABLE;
  const accountId = chatgptAccountId(token);
  const result = await http(USAGE_URL, {
    headers: requestHeaders(auth, {
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    }),
  });
  if (!succeeded(result)) return failureFromResponse(result);
  return { status: "ok", ...parseCodexUsage(result.json, now) };
}
