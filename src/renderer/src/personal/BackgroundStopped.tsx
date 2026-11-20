import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { Button } from "../design";

/**
 * The host's own status for a panel whose background work it stopped, and
 * the Retry that starts it again (INF-2205 piece B). Drawn by the window
 * above the panel's frame, never by the panel's code, so it answers
 * whatever the panel does; the Retry is a button, reached with Tab like any
 * other.
 */
export function BackgroundStopped({
  id,
  draft,
  reason,
}: {
  id: string;
  draft: boolean;
  reason: "unresponsive" | "exited";
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      data-panel-background-stopped={id}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
        {reason === "exited" ? m.panelBackgroundExited() : m.panelBackgroundStopped()}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={asking}
        onClick={() => {
          setAsking(true);
          void window.infinitary.plugins.personal
            .retry(id, draft ? { draft: true } : undefined)
            .finally(() => setAsking(false));
        }}
      >
        {m.panelRetry()}
      </Button>
    </div>
  );
}
