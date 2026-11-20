import type { CSSProperties, ReactNode } from "react";

export type GroupedPillsOption<T extends string = string> = {
  value: T;
  label: ReactNode;
};

export type GroupedPillsProps<T extends string = string> = {
  name: string;
  htmlName: string;
  value: T;
  options: readonly GroupedPillsOption<T>[];
  onChange?: (value: T) => void;
  disabled?: boolean;
  /**
   * The key of the window command that switches the same choice, drawn
   * after the pills; pass `aria-keyshortcuts` with it (docs/keyboard.md,
   * "Key hints").
   */
  keys?: string | undefined;
  "aria-keyshortcuts"?: string | undefined;
};

export type GroupedChecksOption<T extends string = string> = GroupedPillsOption<T> & {
  /** What a screen reader says for the pill when its label is short ("Mon" says "Monday"). */
  ariaLabel?: string;
};

export type GroupedChecksProps<T extends string = string> = {
  name: string;
  values: readonly T[];
  options: readonly GroupedChecksOption<T>[];
  onChange?: (values: T[]) => void;
  disabled?: boolean;
};

function trackStyle(disabled: boolean | undefined): CSSProperties {
  return {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "var(--space-1)",
    background: "var(--bg-0)",
    border: "1px solid var(--line-1)",
    borderRadius: "var(--radius-pill)",
    opacity: disabled ? 0.4 : 1,
    pointerEvents: disabled ? "none" : "auto",
  };
}

function pillStyle(checked: boolean, disabled: boolean | undefined): CSSProperties {
  return {
    boxSizing: "border-box",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-xs)",
    fontWeight: 500,
    lineHeight: 1,
    height: "var(--space-5)",
    padding: "0 var(--space-3)",
    color: checked ? "var(--accent)" : "var(--fg-3)",
    background: checked ? "var(--accent-dim)" : "transparent",
    border: `1px solid ${checked ? "var(--accent)" : "var(--line-1)"}`,
    borderRadius: "var(--radius-pill)",
    cursor: disabled ? "default" : "pointer",
    whiteSpace: "nowrap",
  };
}

/** The unseen control a pill holds; the pill draws its focus (design/styles.css). */
const UNSEEN: CSSProperties = {
  position: "absolute",
  inset: 0,
  opacity: 0,
  margin: 0,
  cursor: "inherit",
  appearance: "none",
};

/** A group's name for a screen reader, drawn nowhere. */
const UNSEEN_LEGEND: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

/**
 * Equal pills in a grouped track: selected and unselected share height,
 * padding, radius, and a 1px border; only fill and color change.
 */
export function GroupedPills<T extends string>({
  name,
  htmlName,
  value,
  options,
  onChange,
  disabled,
  keys,
  "aria-keyshortcuts": ariaKeys,
}: GroupedPillsProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      aria-keyshortcuts={ariaKeys}
      style={trackStyle(disabled)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label key={option.value} data-grouped-pill="" style={pillStyle(checked, disabled)}>
            <input
              type="radio"
              name={htmlName}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => {
                if (!checked) onChange?.(option.value);
              }}
              style={UNSEEN}
            />
            {option.label}
          </label>
        );
      })}
      {keys && (
        // Decoration: the group names its key in aria-keyshortcuts.
        <span data-grouped-pills-key="" aria-hidden="true" style={KEY_STYLE}>
          {keys}
        </span>
      )}
    </div>
  );
}

/** A command's key after the pills, as a button draws its own (./Button). */
const KEY_STYLE: CSSProperties = {
  alignSelf: "center",
  padding: "0 var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
};

/**
 * The same track where any number may be chosen: each pill a checkbox,
 * chosen ones filled, in the options' order (the design skill's
 * GroupedPills, "Several at once").
 */
export function GroupedChecks<T extends string>({
  name,
  values,
  options,
  onChange,
  disabled,
}: GroupedChecksProps<T>) {
  return (
    <fieldset style={{ ...trackStyle(disabled), margin: 0, minWidth: 0 }}>
      <legend style={UNSEEN_LEGEND}>{name}</legend>
      {options.map((option) => {
        const checked = values.includes(option.value);
        return (
          <label key={option.value} data-grouped-pill="" style={pillStyle(checked, disabled)}>
            <input
              type="checkbox"
              value={option.value}
              checked={checked}
              disabled={disabled}
              aria-label={option.ariaLabel}
              onChange={() =>
                onChange?.(
                  options
                    .map((one) => one.value)
                    .filter((one) => (one === option.value ? !checked : values.includes(one))),
                )
              }
              style={UNSEEN}
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}
