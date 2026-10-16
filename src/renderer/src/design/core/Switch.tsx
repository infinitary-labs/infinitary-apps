export type SwitchProps = {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  /** Put a changing state label before the switch to keep the switch at the row's right edge. */
  labelPosition?: "before" | "after";
  /** Accessible name when the visible label lives elsewhere (e.g. a SettingRow). */
  "aria-label"?: string;
  disabled?: boolean;
};

export function Switch({
  checked,
  onChange,
  label,
  labelPosition = "after",
  "aria-label": ariaLabel,
  disabled,
}: SwitchProps) {
  const labelNode = label && (
    <span
      data-switch-state-label={labelPosition === "before" ? "" : undefined}
      style={{ fontSize: "var(--text-base)", color: "var(--fg-1)" }}
    >
      {label}
    </span>
  );
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        marginLeft: labelPosition === "before" ? "auto" : undefined,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {labelPosition === "before" && labelNode}
      <button
        type="button"
        role="switch"
        aria-checked={checked ?? false}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!checked)}
        style={{
          width: 36,
          height: 20,
          borderRadius: "var(--radius-pill)",
          background: checked ? "var(--accent)" : "var(--bg-3)",
          border: `1px solid ${checked ? "transparent" : "var(--line-1)"}`,
          position: "relative",
          transition: "background var(--dur-med) var(--ease-out)",
          flexShrink: 0,
          padding: 0,
          cursor: "inherit",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 17 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: checked ? "#05070d" : "var(--fg-2)",
            transition:
              "left var(--dur-med) var(--ease-out),background var(--dur-med) var(--ease-out)",
          }}
        />
      </button>
      {labelPosition === "after" && labelNode}
    </label>
  );
}
