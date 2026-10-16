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
  /** Optional leading icon element (Lucide, 16px, currentColor). */
  icon?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
  /** A button that opens a popover says so, as an IconButton does (RowMenu's word). */
  "aria-haspopup"?: "menu" | "dialog" | boolean;
  "aria-expanded"?: boolean;
  /** The one button a question that asks once puts focus on: its Cancel. */
  autoFocus?: boolean;
  tabIndex?: number;
  style?: React.CSSProperties;
}
