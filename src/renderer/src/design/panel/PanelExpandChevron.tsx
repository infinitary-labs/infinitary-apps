import type { CSSProperties } from "react";

/**
 * The rail panel's expand mark (SidePanelChrome's collapse control): a 14px
 * down chevron in the header's secondary tone. A collapsed region turns it
 * 180° so it points up. Sections that expand the same way - a panel's own
 * groups among them, so it is in the panel library - reuse this rather
 * than drawing another glyph.
 */
function panelExpandChevronStyle(collapsed: boolean): CSSProperties {
  return {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    color: "var(--fg-2)",
    transform: collapsed ? "rotate(180deg)" : "none",
    transition: "transform var(--dur-fast) var(--ease-out)",
  };
}

export function PanelExpandChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      data-panel-expand-chevron=""
      aria-hidden="true"
      style={panelExpandChevronStyle(collapsed)}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
