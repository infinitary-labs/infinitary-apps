import type React from "react";
import { useState } from "react";
import { useRestLabelWith } from "./restLabel";

export type IconButtonTone = "neutral" | "accent" | "danger" | "ok";

export type IconButtonProps = {
  /**
   * Accessible name; rendered as aria-label and as the label the app draws
   * on rest, the pointer's or the keyboard's focus (./iconLabel).
   */
  label: string;
  /**
   * The key that runs the same command anywhere in the window (`⌘,`), drawn
   * after the words in the label; pass `aria-keyshortcuts` with it.
   */
  keys?: string | undefined;
  size?: number;
  tone?: IconButtonTone;
  disabled?: boolean;
  /**
   * Marked off: it cannot be pressed right now, and its label says why. It
   * stays a Tab stop, `aria-disabled` rather than disabled, dimmed as a
   * disabled one is, and a press does nothing, so the keyboard reaches the
   * reason as the pointer does (docs/keyboard.md, "Facts shown on rest").
   */
  off?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLButtonElement>;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style">;

const tones: Record<IconButtonTone, React.CSSProperties> = {
  neutral: { color: "var(--fg-2)" },
  accent: { color: "var(--accent)" },
  danger: { color: "var(--danger)" },
  ok: { color: "var(--ok)" },
};

export function IconButton({
  label,
  keys,
  size = 32,
  tone = "neutral",
  disabled,
  off = false,
  children,
  style,
  ref,
  onClick,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: IconButtonProps) {
  const [hover, setHover] = useState(false);
  // The label on rest, the pointer's or the keyboard's focus (./restLabel).
  const restLabel = useRestLabelWith(
    label,
    { keys },
    { ref, onPointerEnter, onPointerLeave, onFocus, onBlur, onKeyDown },
  );
  return (
    <button
      {...restLabel}
      type="button"
      aria-label={label}
      disabled={disabled}
      aria-disabled={off || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(event) => {
        // An off button's press does nothing, a form's submit included.
        if (off) event.preventDefault();
        else onClick?.(event);
      }}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-pill)",
        border: "1px solid transparent",
        background: hover && !disabled && !off ? "var(--bg-3)" : "transparent",
        cursor: disabled || off ? "default" : "pointer",
        opacity: disabled || off ? 0.4 : 1,
        transition: "background var(--dur-fast) var(--ease-out)",
        ...tones[tone],
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
