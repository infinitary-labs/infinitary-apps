import type { PanelProps } from "@firstmate/contracts";

/** Fluid content in an actual installed, content-sized frame, not a mocked height report. */
export default function Panel(_props: PanelProps) {
  return (
    <div data-resize-probe="">
      <svg
        data-resize-drawing=""
        role="img"
        aria-label="Width-dependent drawing"
        viewBox="0 0 240 1200"
        preserveAspectRatio="none"
        // Whole-pixel content keeps the panel document from acquiring its own
        // scrollbar through fractional viewport rounding: probe the OUTER surface.
        style={{
          display: "block",
          width: "100%",
          height: "round(up, calc(100vw * var(--drawing-ratio, 5)), 1px)",
        }}
      >
        <rect width="240" height="2400" fill="var(--accent-dim)" />
        <path d="M20 0V2400 M120 0V2400 M220 0V2400" stroke="var(--accent)" />
      </svg>
      <p data-resize-end="" style={{ margin: 0, height: 24, lineHeight: "24px" }}>
        End of drawing
      </p>
    </div>
  );
}
