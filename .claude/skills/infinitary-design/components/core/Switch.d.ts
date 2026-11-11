export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** Accessible name when the visible label lives elsewhere, such as a list row. */
  "aria-label"?: string;
  /** -1 inside a row that is the Tab stop and answers Space for it (Settings → Panels). */
  tabIndex?: number;
  /** Cannot be switched for the reason `note` gives: dimmed, still a Tab stop (aria-disabled), a press does nothing. */
  off?: boolean;
  /** Why it is off: shown on rest, pointer or keyboard, and its accessible description. */
  note?: string;
}
