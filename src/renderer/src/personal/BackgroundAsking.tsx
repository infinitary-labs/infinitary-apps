import * as m from "@shared/i18n/messages.generated";
import type { PersonalExtensionView } from "@shared/personal/manifest";
import { useState } from "react";
import { Button } from "../design";
import { integrationAskLine } from "./panelBoundaryWords";

type Ask = NonNullable<PersonalExtensionView["integrationAsks"]>[number];

/**
 * The host's own lines for a panel's integration calls that wait on the
 * captain's approval card or that the captain turned down (docs/integrations.md,
 * "Panels"), each with Ask again. Drawn by the window above the panel's
 * frame, never by the panel's code, where `BackgroundPaused` sits; each
 * button is reached with Tab like any other.
 */
export function BackgroundAsking({ id, asks }: { id: string; asks: readonly Ask[] }) {
  return (
    <div data-panel-integration-asks={id} style={{ marginBottom: "var(--space-2)" }}>
      {asks.map((ask) => (
        <AskLine key={`${ask.integration}/${ask.action}`} id={id} ask={ask} />
      ))}
    </div>
  );
}

function AskLine({ id, ask }: { id: string; ask: Ask }) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      data-panel-integration-ask={`${ask.integration}/${ask.action}`}
      data-state={ask.state}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
      }}
    >
      <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
        {integrationAskLine(ask.label, ask.place, ask.state)}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={asking}
        onClick={() => {
          setAsking(true);
          void window.infinitary.plugins.personal
            .askAgain(id, ask.integration, ask.action)
            .finally(() => setAsking(false));
        }}
      >
        {m.panelIntegrationAskAgain()}
      </Button>
    </div>
  );
}
