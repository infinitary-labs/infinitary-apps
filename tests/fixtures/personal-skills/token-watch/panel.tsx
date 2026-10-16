import type { PanelProps, SqlAnswer } from "@firstmate/contracts";
import { Empty, MicroLabel, Row } from "@firstmate/ui";
import { useEffect, useState } from "react";
import { formatTokens, rowsOf, TOKENS_QUERY, toneOf } from "./tokens";

/**
 * The `usage` skill's fixture, and the captain's token dashboard: the tokens
 * the crew and the Firstmate spent in the last hour, live, from one query
 * over the app's own record (`v_usage_v1`). The Firstmate's own row stands
 * apart from the crew's; a count nobody recorded is "–".
 */
const WINDOW_MS = 60 * 60 * 1000;
const SLIDE_MS = 60 * 1000;

export default function Panel({ reads }: PanelProps) {
  const [since, setSince] = useState(() => Date.now() - WINDOW_MS);
  const [answer, setAnswer] = useState<SqlAnswer | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setSince(Date.now() - WINDOW_MS), SLIDE_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => reads.subscribe("sql", { sql: TOKENS_QUERY, params: [since] }, setAnswer),
    [reads, since],
  );

  const rows = rowsOf(answer);
  const firstmate = rows.find((row) => row.key === "FIRSTMATE");
  const crew = rows.filter((row) => row !== firstmate);
  const counted = rows.filter((row) => row.tokens !== null);
  const total =
    counted.length > 0 ? counted.reduce((sum, row) => sum + (row.tokens ?? 0), 0) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <MicroLabel count={formatTokens(total)}>Tokens · last hour</MicroLabel>
      {rows.length === 0 ? (
        <Empty>No tokens in the last hour</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {firstmate && (
            <Row
              title="Firstmate"
              tone="ring"
              trailing={`${formatTokens(firstmate.tokens)} tokens`}
            />
          )}
          {crew.map((row) => (
            <Row
              key={row.taskId}
              title={row.title}
              tone={toneOf(row.activity)}
              toneLabel={row.activity ?? "not running"}
              trailing={`${formatTokens(row.tokens)} tokens`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
