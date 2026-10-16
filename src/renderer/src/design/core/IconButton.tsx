import type React from "react";
import { useCallback, useState } from "react";
import { useRestLabel } from "./restLabel";

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
  children,
  style,
  ref,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...rest
}: IconButtonProps) {
  const [hover, setHover] = useState(false);
  // The label on rest, the pointer's or the keyboard's focus (./restLabel).
  const restLabel = useRestLabel(label, { keys });
  const restRef = restLabel.ref;
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      restRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, restRef],
  );
  return (
    <button
      ref={setRef}
      type="button"
      aria-label={label}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerEnter={(event) => {
        restLabel.onPointerEnter(event);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        restLabel.onPointerLeave(event);
        onPointerLeave?.(event);
      }}
      onFocus={(event) => {
        restLabel.onFocus(event);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        restLabel.onBlur(event);
        onBlur?.(event);
      }}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-pill)",
        border: "1px solid transparent",
        background: hover && !disabled ? "var(--bg-3)" : "transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
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
