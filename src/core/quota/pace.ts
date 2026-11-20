import { formatResetText, type QuotaWindowView } from "@shared/quota";
import { asNumber, asString } from "./json";

export const SESSION_WINDOW_SECONDS = 18_000;
export const WEEKLY_WINDOW_SECONDS = 604_800;
const PACE_DEADBAND = 1;

export type PaceStatus = NonNullable<QuotaWindowView["pace"]>;

export function windowSecondsForId(id: string): number | undefined {
  if (id === "five_hour" || id === "session" || id.endsWith(":5h")) return SESSION_WINDOW_SECONDS;
  if (id === "seven_day" || id === "weekly" || id.endsWith(":7d") || id.startsWith("seven_day_")) {
    return WEEKLY_WINDOW_SECONDS;
  }
  return undefined;
}

export function paceForWindow(input: {
  percentRemaining: number;
  resetsAtMs?: number;
  windowSeconds?: number;
  now: number;
}): PaceStatus | undefined {
  const cycle = input.windowSeconds;
  if (!cycle || cycle <= 0 || input.resetsAtMs === undefined) return undefined;
  const remainingSec = (input.resetsAtMs - input.now) / 1000;
  if (remainingSec < 0) return undefined;
  const timeRemainingPercent = (100 * remainingSec) / cycle;
  const reserve = input.percentRemaining - timeRemainingPercent;
  if (Math.abs(reserve) <= PACE_DEADBAND) return "on_pace";
  return reserve < 0 ? "ahead" : "behind";
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildWindow(input: {
  id: string;
  label: string;
  percentRemaining?: number;
  resetsAtMs?: number;
  startsAtMs?: number;
  windowSeconds?: number;
  now: number;
}): QuotaWindowView {
  const windowSeconds = input.windowSeconds ?? windowSecondsForId(input.id);
  const pace =
    input.percentRemaining !== undefined
      ? paceForWindow({
          percentRemaining: input.percentRemaining,
          ...(input.resetsAtMs !== undefined ? { resetsAtMs: input.resetsAtMs } : {}),
          ...(windowSeconds !== undefined ? { windowSeconds } : {}),
          now: input.now,
        })
      : undefined;
  const resetText =
    input.resetsAtMs !== undefined ? formatResetText(input.resetsAtMs, input.now) : undefined;
  return {
    id: input.id,
    label: input.label,
    ...(input.percentRemaining !== undefined ? { percentRemaining: input.percentRemaining } : {}),
    ...(pace ? { pace } : {}),
    ...(resetText ? { resetText } : {}),
    // The trusted cycle evidence rides the view so pace/runway/spend
    // priority can be recomputed honestly at read time (shared/quotaSignals).
    ...(input.resetsAtMs !== undefined ? { resetsAtMs: input.resetsAtMs } : {}),
    ...(input.startsAtMs !== undefined ? { startsAtMs: input.startsAtMs } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}

export function resetsAtFromRemainingSeconds(
  remainingSeconds: unknown,
  now: number,
): number | undefined {
  const seconds = asNumber(remainingSeconds);
  if (seconds === undefined || seconds < 0) return undefined;
  return now + seconds * 1000;
}
