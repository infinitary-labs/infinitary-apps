import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { Button } from "../design";

/**
 * The host's own status for a panel whose background work the app refused
 * because it is written for an earlier panel API, and the Update panel that
 * asks the first mate to update it (INF-2470). Drawn by the window above the
 * panel's frame, never by the panel's code, where `BackgroundStopped` sits;
 * the button is reached with Tab like any other, and stays off once the
 * update was asked.
 */
export function BackgroundPaused({ id, asked }: { id: string; asked: boolean }) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      data-panel-background-paused={id}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
        {m.panelBackgroundPaused()}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={asked || asking}
        onClick={() => {
          setAsking(true);
          void window.infinitary.plugins.personal.update(id).finally(() => setAsking(false));
        }}
      >
        {m.panelBackgroundUpdate()}
      </Button>
    </div>
  );
}
