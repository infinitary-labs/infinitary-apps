import type React from "react";

export type KeyCapProps = {
  children?: React.ReactNode;
  size?: "sm" | "md";
};

/** Both sizes use the kbd style. A 10px literal sat under the type scale. */
const kbd: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  padding: "2px 7px",
  minWidth: 18,
};

export function KeyCap({ children }: KeyCapProps) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontWeight: 500,
        color: "var(--fg-2)",
        background: "var(--bg-3)",
        border: "1px solid var(--line-1)",
        borderBottomWidth: 2,
        borderRadius: "var(--radius-s)",
        lineHeight: 1.5,
        ...kbd,
      }}
    >
      {children}
    </kbd>
  );
}
