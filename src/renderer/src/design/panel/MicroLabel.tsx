import type React from "react";

export type MicroLabelProps = {
  children?: React.ReactNode;
  /** A count beside the label, rendered in dim mono (data is always mono). */
  count?: number | string;
  style?: React.CSSProperties;
};

/**
 * The uppercase tracked micro label (design skill, CONTENT FUNDAMENTALS:
 * `CREW`, `QUOTA`, `ON PACE`), as the now panel's group headers paint it:
 * 11px, weight 500, +0.09em, tertiary. It is how a panel names a region
 * without giving it a heading.
 */
export function MicroLabel({ children, count, style }: MicroLabelProps) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", ...style }}>
      <span
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--fg-3)",
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
          }}
        >
          {count}
        </span>
      )}
    </span>
  );
}
