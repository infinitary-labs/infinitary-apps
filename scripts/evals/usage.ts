/** Evaluation artifacts use null for an unreported counter, never an assumed zero. */
export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type TokenUsage = Record<(typeof TOKEN_FIELDS)[number], number | null>;

export function tokenUsage(value: unknown): TokenUsage {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    TOKEN_FIELDS.map((key) => {
      const count = raw[key];
      return [key, typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null];
    }),
  ) as TokenUsage;
}

/** One unknown contribution makes that total unknown; a reported zero stays zero. */
export function sumUsage(rows: TokenUsage[]): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows)
    for (const key of TOKEN_FIELDS) {
      const next = row[key];
      const held = total[key];
      total[key] = held === null || next === null ? null : held + next;
    }
  return total;
}

/** Claude's turn result includes client side calls absent from the conversation transcript. */
export function turnUsage(value: unknown): TokenUsage {
  const usage = value as { models?: unknown[] } | undefined;
  return Array.isArray(usage?.models) && usage.models.length
    ? sumUsage(usage.models.map(tokenUsage))
    : tokenUsage(value);
}
