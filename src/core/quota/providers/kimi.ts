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
 * The Kimi Code plan's usage meter, read with the account's own credential:
 * the bearer Pi derives from its device-code sign-in, or the pasted Kimi
 * Code key. Moonshot does not document this endpoint. It answers in one of
 * two shapes: ratio pools under `usages` (`limit_5h`, `limit_7d`,
 * `limit_month_total`, each `{ used_ratio, reset_time }`) beside
 * `user.membership.level`, or the older counts - a weekly `usage` and a
 * `limits` list of `{ window: { duration, timeUnit }, detail }` rows, each
 * detail `{ limit, used, remaining, resetTime }`. When the answer is
 * neither, the reader refuses it (`schema_unrecognized`) and never invents
 * a window.
 *
 * The request carries the bearer and nothing else: no borrowed client
 * identity, since Kimi's terms ask a tool to keep its real one.
 */
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/**
 * What Infinitary says about a Kimi Code sign-in that answered with no
 * window: what happened on this read, never that the credential cannot
 * expose usage.
 */
export const KIMI_NO_WINDOW_DETAIL =
  "Kimi Code didn't return an allowance reading for this sign-in.";

/**
 * The ratio pools of the current answer, each `{ used_ratio, reset_time }`
 * with `used_ratio` from 0 to 1. A monthly pool has no fixed length, so it
 * carries no cycle and so no pace.
 */
const RATIO_POOLS = [
  { key: "limit_5h", id: "five_hour", label: "session", seconds: SESSION_WINDOW_SECONDS },
  { key: "limit_7d", id: "weekly", label: "weekly", seconds: WEEKLY_WINDOW_SECONDS },
  { key: "limit_month_total", id: "monthly", label: "monthly", seconds: undefined },
] as const;

/**
 * The plan names of Kimi's V1 membership catalog, by level. An unknown
 * level is shown as it came, so a new tier still names itself.
 */
const MEMBERSHIP_NAMES: Record<string, string> = {
  LEVEL_FREE: "Adagio",
  LEVEL_TRIAL: "Andante",
  LEVEL_BASIC: "Moderato",
  LEVEL_INTERMEDIATE: "Allegretto",
  LEVEL_ADVANCED: "Allegro",
};

export type KimiUsageParse =
  | { kind: "windows"; windows: QuotaWindowView[]; plan?: string }
  /** The answer's shape, with nothing Infinitary reads as a window. */
  | { kind: "empty"; plan?: string }
  /** Not an answer this reader knows. */
  | { kind: "unrecognized" };

/** Read the usages answer into Infinitary windows and the plan's name. */
export function parseKimiUsage(body: unknown, now: number): KimiUsageParse {
  const root = asRecord(body);
  if (!root || (!("usages" in root) && !("usage" in root) && !("limits" in root)))
    return { kind: "unrecognized" };
  const plan = planName(root);
  const windows = ratioWindows(asRecord(root.usages), now);
  // The older count shape: a weekly `usage` and per-window `limits`, read
  // only where the ratio pools did not name the same window.
  const named = new Set(windows.map((window) => window.id));
  for (const window of countWindows(root, now)) {
    if (!named.has(window.id)) windows.push(window);
  }
  const withPlan = plan ? { plan } : {};
  return windows.length > 0
    ? { kind: "windows", windows, ...withPlan }
    : { kind: "empty", ...withPlan };
}

function ratioWindows(pools: Record<string, unknown> | undefined, now: number): QuotaWindowView[] {
  if (!pools) return [];
  const windows: QuotaWindowView[] = [];
  for (const pool of RATIO_POOLS) {
    const slot = asRecord(pools[pool.key]);
    const used = asNumber(slot?.used_ratio);
    if (!slot || used === undefined || used < 0) continue;
    const resetsAtMs = parseTimestamp(slot.reset_time);
    windows.push(
      buildWindow({
        id: pool.id,
        label: pool.label,
        percentRemaining: roundPercent(100 - clampPercent(used * 100)),
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        ...(pool.seconds !== undefined ? { windowSeconds: pool.seconds } : {}),
        now,
      }),
    );
  }
  return windows;
}

function countWindows(root: Record<string, unknown>, now: number): QuotaWindowView[] {
  const windows: QuotaWindowView[] = [];
  const weekly = countWindow(asRecord(root.usage), "weekly", "weekly", WEEKLY_WINDOW_SECONDS, now);
  if (weekly) windows.push(weekly);
  for (const entry of Array.isArray(root.limits) ? root.limits : []) {
    const limit = asRecord(entry);
    const seconds = windowSeconds(asRecord(limit?.window));
    if (seconds === SESSION_WINDOW_SECONDS) {
      const session = countWindow(asRecord(limit?.detail), "five_hour", "session", seconds, now);
      if (session) windows.push(session);
    }
  }
  return windows;
}

/** A `{ limit, used, remaining, resetTime }` detail; its counts arrive as strings or numbers. */
function countWindow(
  detail: Record<string, unknown> | undefined,
  id: string,
  label: string,
  seconds: number,
  now: number,
): QuotaWindowView | undefined {
  if (!detail) return undefined;
  const limit = count(detail.limit);
  const used =
    count(detail.used) ?? (limit !== undefined ? remainingUsed(detail, limit) : undefined);
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
  const resetsAtMs = parseTimestamp(
    detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at,
  );
  return buildWindow({
    id,
    label,
    percentRemaining: roundPercent(100 - clampPercent((used / limit) * 100)),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    windowSeconds: seconds,
    now,
  });
}

function remainingUsed(detail: Record<string, unknown>, limit: number): number | undefined {
  const remaining = count(detail.remaining);
  return remaining !== undefined ? limit - remaining : undefined;
}

function count(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") return asNumber(Number(value));
  return asNumber(value);
}

const TIME_UNIT_SECONDS: Record<string, number> = {
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86_400,
};

function windowSeconds(window: Record<string, unknown> | undefined): number | undefined {
  const duration = asNumber(window?.duration);
  const unit = TIME_UNIT_SECONDS[asString(window?.timeUnit) ?? ""];
  return duration !== undefined && duration > 0 && unit !== undefined ? duration * unit : undefined;
}

function planName(root: Record<string, unknown>): string | undefined {
  const level = asString(asRecord(asRecord(root.user)?.membership)?.level)?.trim();
  if (!level || level === "LEVEL_UNSPECIFIED") return undefined;
  const version = root.version;
  const catalogued = version === undefined || version === "GOODS_VERSION_V1";
  return (catalogued ? MEMBERSHIP_NAMES[level] : undefined) ?? level;
}

/** A ratio off the wire, kept to the precision a meter can mean. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function fetchKimiQuota(
  http: QuotaHttp,
  auth: ManagedAuth,
  now: number,
  usageUrl: string = KIMI_USAGE_URL,
): Promise<ProviderOutcome> {
  if (!auth.apiKey && !auth.headers) return CREDENTIAL_UNAVAILABLE;
  const result = await http(usageUrl, {
    headers: requestHeaders(auth, { Accept: "application/json" }),
  });
  if (!succeeded(result)) return failureFromResponse(result);
  const parsed = parseKimiUsage(result.json, now);
  if (parsed.kind === "unrecognized") {
    return { status: "unavailable", windows: [], reason: "schema_unrecognized" };
  }
  const plan = parsed.plan ? { plan: parsed.plan } : {};
  if (parsed.kind === "empty") {
    return {
      status: "not_measured",
      windows: [],
      detail: KIMI_NO_WINDOW_DETAIL,
      reason: "no_window_read",
      ...plan,
    };
  }
  return { status: "ok", windows: parsed.windows, ...plan };
}
