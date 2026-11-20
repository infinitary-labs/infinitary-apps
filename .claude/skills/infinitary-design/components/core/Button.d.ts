/**
 * @startingPoint section="Core" subtitle="Buttons: primary, secondary, ghost, danger" viewport="700x180"
 */
export interface ButtonProps {
  /** Visual style. Default "primary" (ice-cyan fill, dark text). */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  /** Immediate disabled, aria-busy feedback. Reserves both labels when supplied. */
  pending?: boolean;
  /** Static pending copy, default "Working...". No spinner or delayed paint. */
  pendingLabel?: string;
  /** Cannot be pressed for the reason `note` gives: dimmed, still a Tab stop (aria-disabled), a press does nothing. */
  off?: boolean;
  /** Why it is off, or a fact it only hints at: shown on rest, pointer or keyboard, and its accessible description. */
  note?: string;
  /** The reason alone, where another place already shows it: read by assistive technology, never drawn on rest. */
  "aria-description"?: string;
  /** Optional leading icon element (Lucide, 16px, currentColor). */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
  /** "submit" for a dialog's act, which Enter in the dialog's field presses (ConsentDialog). Default "button". */
  type?: "button" | "submit";
  /** A button that opens a popover says so, as an IconButton does (RowMenu's word). */
  "aria-haspopup"?: "menu" | "dialog" | boolean;
  "aria-expanded"?: boolean;
  /** The one button a question that asks once puts focus on: its Cancel. */
  autoFocus?: boolean;
  tabIndex?: number;
  style?: React.CSSProperties;
}
