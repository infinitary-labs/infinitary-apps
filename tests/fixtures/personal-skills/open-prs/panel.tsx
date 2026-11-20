import type { PanelForgeChange, PanelForgeChanges, PanelProps } from "@firstmate/contracts";
import { Empty, Row } from "@firstmate/ui";
import { useEffect, useState } from "react";

/**
 * The `github-prs` skill's fixture: the captain's open proposed changes
 * through the app's own `forge.changes` read, one row each, the checks as
 * the row's one status dot, the host's own name for it (`#186`, `!4`) in
 * mono at the end. The app reads
 * them with the captain's own sign-in; the panel never reaches the network
 * and never holds a sign-in. No heading of its own - the host's title
 * already says what this is.
 */
const TONES: Record<PanelForgeChange["checks"], "ok" | "danger" | "warn" | "ring"> = {
  passed: "ok",
  failed: "danger",
  pending: "warn",
  none: "ring",
};

export default function Panel({ reads }: PanelProps) {
  const [value, setValue] = useState<PanelForgeChanges | null>(null);
  useEffect(() => reads.subscribe("forge.changes", setValue), [reads]);
  if (!value) return null;
  if (!value.signedIn) return <Empty>Sign in where your projects live, in Settings</Empty>;
  if (value.changes.length === 0) {
    return (
      <Empty>
        {value.reachable ? "No open proposed changes" : "Could not reach them just now"}
      </Empty>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      {value.changes.map((change) => (
        <Row
          key={change.url}
          title={change.title}
          tone={TONES[change.checks]}
          toneLabel={`checks ${change.checks}`}
          word={change.draft ? "draft" : undefined}
          trailing={change.label ?? `#${change.number}`}
        />
      ))}
    </div>
  );
}
