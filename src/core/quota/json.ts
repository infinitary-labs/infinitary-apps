export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Codex reports whole percents, so 1 means 1% used, never a fraction. */
export function remainingFromUsedPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}
