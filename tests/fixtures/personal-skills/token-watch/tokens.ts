import type { SqlAnswer, SqlValue } from "@firstmate/contracts";

/**
 * The `usage` skill's query: the tokens each task spent since `?`, busiest
 * first. `SUM` over counts nobody recorded is null, and stays null - the
 * row renders "–", never 0.
 */
export const TOKENS_QUERY = `
  SELECT task_id, key, title, activity, SUM(input) AS input, SUM(output) AS output, MAX(at) AS last_at
  FROM v_usage_v1
  WHERE at > ?
  GROUP BY task_id
  ORDER BY COALESCE(SUM(input), 0) + COALESCE(SUM(output), 0) DESC
  LIMIT 8`;

export type TokenRow = {
  taskId: string;
  key: string;
  title: string;
  activity: string | null;
  /** Null when no request in the window recorded a count. */
  tokens: number | null;
  lastAt: number;
};

function count(value: SqlValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

/** The answer's rows, or none for a refusal (a refusal is the panel's bug, not news). */
export function rowsOf(answer: SqlAnswer | null): TokenRow[] {
  if (!answer || "refused" in answer) return [];
  return answer.rows.map((row) => {
    const input = count(row.input);
    const output = count(row.output);
    return {
      taskId: String(row.task_id),
      key: String(row.key ?? ""),
      title: String(row.title ?? row.task_id),
      activity: typeof row.activity === "string" ? row.activity : null,
      tokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
      lastAt: count(row.last_at) ?? 0,
    };
  });
}

/** 940, 12.4k, 1.2M - the way people say a count. */
export function formatTokens(value: number | null): string {
  if (value === null) return "–";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${trim(value / 1_000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** What the dot says: what the task's crewmate is doing right now. */
export function toneOf(activity: string | null): "busy" | "ok" | "danger" | "idle" {
  if (activity === "running") return "busy";
  if (activity === "idle") return "ok";
  if (activity === "interrupted") return "danger";
  return "idle";
}
