import type { PanelProps } from "@firstmate/contracts";
import { Button } from "@firstmate/ui";
import { useState } from "react";

/** Unrounded fluid content; the host, not panel authors, must fit its document. */
export default function Panel(_props: PanelProps) {
  const [ratio, setRatio] = useState(1.001);
  return (
    <div data-fractional-probe="">
      <div style={{ display: "flex", gap: "var(--space-1)", marginBottom: "var(--space-2)" }}>
        <Button variant="secondary" size="sm" onClick={() => setRatio(1.001)}>
          Short
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setRatio(1.013)}>
          Change
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setRatio(5.001)}>
          Tall
        </Button>
      </div>
      <svg
        data-fractional-drawing=""
        role="img"
        aria-label="Fractional-height drawing"
        viewBox={`0 0 240 ${ratio * 240}`}
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        <rect width="240" height={ratio * 240} fill="var(--accent-dim)" />
        <path
          d={`M20 0V${ratio * 240} M120 0V${ratio * 240} M220 0V${ratio * 240}`}
          stroke="var(--accent)"
        />
      </svg>
      <p data-fractional-end="" style={{ margin: 0 }}>
        End of drawing
      </p>
    </div>
  );
}
