import type { PushedWindow } from "../quota/pushedQuota";

/**
 * Reads the Antigravity program's print-mode usage report
 * (`agy -p /usage --output-format json`): one JSON document whose
 * `command.data.groups` each name a family of models and hold its limits
 * (`buckets`), each with a `window` ("weekly"), the `remaining_fraction`
 * of it and its `reset_time`. Only the Gemini group counts (INF-3776:
 * Google's forum reply scopes this way to Gemini models); its weekly limit
 * becomes the `seven_day` plan window the rest of the app already reads
 * (docs/quota.md). A limit of another length is left out, and a report
 * with no Gemini limit reads as nothing, never as an empty allowance.
 */
export function parseUsageReport(stdout: string, now: number): PushedWindow[] | undefined {
  const report = parse(stdout);
  if (!report || report.command?.name !== "usage") return undefined;
  const windows = new Map<string, PushedWindow>();
  for (const group of report.command.data?.groups ?? []) {
    if (typeof group?.name !== "string" || !/gemini/i.test(group.name)) continue;
    for (const bucket of group.buckets ?? []) {
      const window = readBucket(bucket, now);
      if (window && !windows.has(window.windowId)) windows.set(window.windowId, window);
    }
  }
  return windows.size > 0 ? [...windows.values()] : undefined;
}

type Bucket = { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };

type UsageReport = {
  command?: {
    name?: unknown;
    data?: { groups?: ({ name?: unknown; buckets?: Bucket[] } | null)[] };
  };
};

function parse(stdout: string): UsageReport | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null ? (value as UsageReport) : undefined;
  } catch {
    return undefined;
  }
}

/** The program's window names, as the plan windows the app reads. */
const WINDOWS: Readonly<Record<string, string>> = { weekly: "seven_day" };

function readBucket(bucket: Bucket | null, now: number): PushedWindow | undefined {
  if (!bucket || typeof bucket.window !== "string") return undefined;
  const windowId = WINDOWS[bucket.window];
  const remaining = bucket.remaining_fraction;
  if (!windowId || typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
  const utilization = Math.min(1, Math.max(0, 1 - remaining));
  const resetsAt =
    typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
  return {
    windowId,
    status: utilization >= 1 ? "rejected" : "allowed",
    utilization,
    ...(Number.isNaN(resetsAt) ? {} : { resetsAt }),
    at: now,
  };
}
