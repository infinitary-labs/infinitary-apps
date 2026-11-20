import type { PanelFeedLine, PanelProps } from "@firstmate/contracts";
import { Empty, FeedLine } from "@firstmate/ui";
import { useEffect, useState } from "react";
import { relativeAge, reportsOf } from "./lines";

/**
 * The `tasks-and-feed` skill's fixture: a slice of the app's own log through
 * the `feed.recent` read - the reports and the failures, newest at the
 * bottom - as the app's own feed line, with the task key in dim mono and the
 * age already formatted the app's way.
 */
const TAIL = 8;

export default function Panel({ reads }: PanelProps) {
  const [lines, setLines] = useState<PanelFeedLine[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(
    () =>
      reads.subscribe("feed.recent", (value) => {
        setLines(value);
        setNow(Date.now());
      }),
    [reads],
  );
  const reports = reportsOf(lines, TAIL);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {reports.length === 0 ? (
        <Empty>No reports yet</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {reports.map((line) => (
            <FeedLine
              key={`${line.at}-${line.text}`}
              kind={line.kind === "ok" ? "report" : "failed"}
              tone={line.kind}
              time={relativeAge(line.at, now)}
              taskKey={line.taskKey}
            >
              {line.text}
            </FeedLine>
          ))}
        </div>
      )}
    </div>
  );
}
