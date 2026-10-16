import type React from "react";

export type EmptyProps = {
  /** One calm sentence saying what would be here. Sentence case, no period needed. */
  children?: React.ReactNode;
  style?: React.CSSProperties;
};

/**
 * A list's empty state: one quiet line, never a box, an illustration or an
 * exclamation (design skill: calm, low-ceremony, emptiness is a feature). A
 * panel whose whole content would be empty says nothing at all - visibility
 * is data, and the host renders no chrome for a panel with nothing to show.
 * This line is for a SECTION that is empty inside a panel that is not.
 */
export function Empty({ children, style }: EmptyProps) {
  return (
    <p
      style={{
        margin: 0,
        padding: "var(--space-2) 6px",
        fontSize: "var(--text-sm)",
        lineHeight: "var(--leading-body)",
        color: "var(--fg-3)",
        ...style,
      }}
    >
      {children}
    </p>
  );
}
