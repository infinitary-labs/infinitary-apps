import type React from "react";
import { useState } from "react";

export type InputProps = {
  placeholder?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Render in JetBrains Mono - for data-shaped values (hosts, ids). */
  mono?: boolean;
  size?: "md" | "lg";
  style?: React.CSSProperties;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "style">;

export function Input({
  placeholder,
  value,
  onChange,
  mono,
  size = "md",
  style,
  ...rest
}: InputProps) {
  const [focus, setFocus] = useState(false);
  const pad = size === "lg" ? "14px 20px" : "9px 14px";
  return (
    <input
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
        fontSize: size === "lg" ? "var(--text-md)" : "var(--text-base)",
        color: "var(--fg-1)",
        background: "var(--surface-input)",
        border: `1px solid ${focus ? "var(--line-2)" : "var(--line-1)"}`,
        borderRadius: "var(--radius-m)",
        padding: pad,
        outline: "none",
        boxShadow: focus ? "var(--focus-ring)" : "none",
        transition:
          "border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)",
        width: "100%",
        boxSizing: "border-box",
        ...style,
      }}
      {...rest}
    />
  );
}
