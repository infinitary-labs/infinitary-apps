import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { useState } from "react";
import { useRestLabelWith } from "./restLabel";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * What a pending-capable button reads while its click is in flight, in
 * English for the tests; the button calls the message when it draws.
 */
export const PENDING_LABEL = m.uiButtonPending();

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /**
   * The key that presses this button, drawn inside it (design skill Button,
   * "A key inside a button"): quiet mono after the label, mostly in the room
   * the padding already has; the label moves left, and the button widens by
   * six pixels for the air the key needs, or by what a longer key needs.
   */
  keys?: string;
  /**
   * Marked off: the button cannot be pressed right now, for the reason its
   * `note` gives. It stays a Tab stop, `aria-disabled` rather than disabled,
   * dimmed as a disabled one is, and a press does nothing, so the keyboard
   * reaches the reason as the pointer does (docs/keyboard.md, "Facts shown on
   * rest").
   */
  off?: boolean;
  /**
   * A fact the button only hints at - why it is off, or where its press is
   * done: shown in the app's label on rest, the pointer's or the keyboard's
   * focus (./restLabel), and its accessible description.
   */
  note?: string | undefined;
  /** The button itself, for a popover that hangs from it. */
  ref?: React.Ref<HTMLButtonElement>;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style">;

const base: React.CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-base)",
  fontWeight: 500,
  borderRadius: "var(--radius-m)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid transparent",
  transition:
    "background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out),opacity var(--dur-fast) var(--ease-out)",
  lineHeight: 1,
  // A button label never wraps or gets crushed by a cramped flex row - the
  // row's flexible content gives way instead (design skill Button rule).
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const variants: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: "var(--accent)", color: "#05070d", borderColor: "transparent" },
  secondary: { background: "transparent", color: "var(--fg-1)", borderColor: "var(--line-2)" },
  ghost: { background: "transparent", color: "var(--fg-2)", borderColor: "transparent" },
  danger: { background: "transparent", color: "var(--danger)", borderColor: "var(--danger)" },
};

const sizes: Record<ButtonSize, { padY: number; padX: number; fontSize?: string }> = {
  sm: { padY: 6, padX: 12, fontSize: "var(--text-sm)" },
  md: { padY: 9, padX: 16 },
  lg: { padY: 12, padX: 22, fontSize: "var(--text-md)" },
};

/**
 * Where a key sits inside the button: one mono glyph at `--text-sm` is 0.6em
 * of 12.5px wide (JetBrains Mono), the key ends `KEY_INSET` inside the border,
 * and at least `KEY_GAP` separates it from the label. It sits on the label's
 * baseline (`keyLine`), not above it. The label moves left to make room, down
 * to `KEY_MIN_LEAD` before it, so a Mac key widens a button by six pixels: the
 * air the captain chose over a tighter fit inside the padding alone. A longer
 * key (Ctrl+1 on Linux) widens the button by what it needs.
 */
const KEY_GLYPH = 7.5;
const KEY_GAP = 6;
const KEY_INSET = 7;
const KEY_MIN_LEAD = 10;

function keyPadding(size: ButtonSize, keys: string): React.CSSProperties {
  const { padY, padX } = sizes[size];
  const room = KEY_INSET + keys.length * KEY_GLYPH + KEY_GAP;
  const lead = Math.max(KEY_MIN_LEAD, 2 * padX - room);
  return { padding: `${padY}px ${room}px ${padY}px ${lead}px` };
}

// The key's line: the button's own font at the label's line height, between the
// same paddings as the label, so its baseline is the label's; the key itself
// is the mono inline on that baseline.
const keyLine: React.CSSProperties = {
  position: "absolute",
  right: KEY_INSET,
  display: "block",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

const keyStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  color: "color-mix(in srgb, currentColor 60%, transparent)",
};

export function Button({
  variant = "primary",
  size = "md",
  disabled,
  pending,
  pendingLabel = m.uiButtonPending(),
  icon,
  children,
  style,
  keys,
  off = false,
  note,
  ref,
  onClick,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onKeyDown,
  "aria-disabled": ariaDisabled,
  "aria-description": ariaDescription,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const unavailable = disabled || pending;
  // The note on rest, the pointer's or the keyboard's focus (./restLabel).
  const restLabel = useRestLabelWith(
    note,
    { fact: true },
    { ref, onPointerEnter, onPointerLeave, onFocus, onBlur, onKeyDown },
  );
  const { padY, padX, fontSize } = sizes[size];
  const sized: React.CSSProperties = {
    ...(fontSize ? { fontSize } : {}),
    ...(keys
      ? { position: "relative", ...keyPadding(size, keys) }
      : { padding: `${padY}px ${padX}px` }),
  };
  const hoverStyle: React.CSSProperties =
    hover && !unavailable && !off
      ? variant === "primary"
        ? { background: "var(--accent-strong)" }
        : variant === "danger"
          ? { background: "var(--danger-dim)" }
          : { background: "var(--bg-3)", color: "var(--fg-1)" }
      : {};
  return (
    <button
      {...restLabel}
      type="button"
      disabled={unavailable}
      aria-busy={pending || undefined}
      aria-disabled={off || ariaDisabled || undefined}
      aria-description={note ?? ariaDescription}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => {
        // An off button's press does nothing, a form's submit included.
        if (off) event.preventDefault();
        else onClick?.(event);
      }}
      style={{
        ...base,
        ...variants[variant],
        ...sized,
        ...(unavailable || off ? { opacity: 0.4, cursor: "default" } : {}),
        ...hoverStyle,
        ...style,
        ...(pending ? { transition: "none" } : {}),
      }}
      {...rest}
    >
      {icon}
      {pending === undefined ? (
        children
      ) : (
        <span style={{ display: "grid" }}>
          <span
            aria-hidden={pending || undefined}
            style={{ gridArea: "1 / 1", visibility: pending ? "hidden" : "visible" }}
          >
            {children}
          </span>
          <span
            aria-hidden={!pending || undefined}
            style={{ gridArea: "1 / 1", visibility: pending ? "visible" : "hidden" }}
          >
            {pendingLabel}
          </span>
        </span>
      )}
      {keys && (
        // Decoration: the button names its key in aria-keyshortcuts. A
        // pending button shows its pending label alone.
        <span
          data-button-key=""
          aria-hidden="true"
          style={{
            ...keyLine,
            top: padY,
            bottom: padY,
            visibility: pending ? "hidden" : undefined,
          }}
        >
          <span style={keyStyle}>{keys}</span>
        </span>
      )}
    </button>
  );
}
