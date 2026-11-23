import type React from "react";
import { useState } from "react";
import { useInPlaceReveal } from "../reveals";
import { MicroLabel } from "./MicroLabel";

export type DisclosureProps = {
  label: React.ReactNode;
  /** The collapsed count, in dim mono: what the reader gets by opening it. */
  count?: number | string;
  /** Uncontrolled initial state; a collapsed group is the calm default. */
  defaultOpen?: boolean;
  /** Controlled state. Pass it with `onToggle` to own the open/closed bit. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
};

const caret = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

/**
 * A region that shows only its count until it is asked for (design skill
 * `components/now/NowPanel`: "everything richer hides behind a click"). The
 * header is a micro label, the count is mono, and the caret turns a quarter
 * on open. The body reveals in place; closing unmounts immediately.
 */
export function Disclosure({
  label,
  count,
  defaultOpen = false,
  open,
  onToggle,
  children,
  style,
}: DisclosureProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const [hover, setHover] = useState(false);
  const isOpen = open ?? uncontrolled;
  const reveal = useInPlaceReveal(isOpen);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, ...style }}>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          if (open === undefined) setUncontrolled(!isOpen);
          onToggle?.(!isOpen);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          margin: 0,
          // Even vertical padding keeps the caret on the row's center, like
          // the Tasks section chevron; 6px over 2px left it 2px low.
          padding: "4px 6px",
          border: "none",
          borderRadius: "var(--radius-s)",
          background: hover ? "var(--bg-2)" : "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "start",
          cursor: "pointer",
        }}
      >
        <MicroLabel count={count}>{label}</MicroLabel>
        <span
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            color: "var(--fg-3)",
            transform: isOpen ? "rotate(90deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out)",
          }}
        >
          {caret}
        </span>
      </button>
      {isOpen && (
        <div
          data-in-place-reveal={reveal ? "drift" : undefined}
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
