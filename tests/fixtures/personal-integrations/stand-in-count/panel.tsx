import type { PanelIntegrationAnswer, PanelProps } from "@infinitary/contracts";
import { useState } from "react";

/**
 * The panel integrations fixture (tests/e2e/panel-integrations.spec.ts,
 * INF-2334 piece 1): one button that calls the stand-in integration's
 * `count_items` through `props.integrations`, as its manifest names, and
 * shows the answer the app gave, refusal or words.
 */
export default function Panel({ id, integrations }: PanelProps) {
  const [answer, setAnswer] = useState<PanelIntegrationAnswer | null>(null);
  return (
    <div data-fixture={id}>
      <button
        type="button"
        data-fixture-count
        onClick={() => void integrations.call("stand-in", "count_items", {}).then(setAnswer)}
      >
        Count items
      </button>
      <p
        data-fixture-answer={answer === null ? "none" : answer.refused ? "refused" : "ran"}
        style={{ margin: "var(--space-2) 0 0" }}
      >
        {answer?.text ?? ""}
      </p>
    </div>
  );
}
