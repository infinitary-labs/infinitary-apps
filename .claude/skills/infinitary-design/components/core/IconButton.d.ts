export interface IconButtonProps {
  /** Accessible label (also the tooltip). Required. */
  label: string;
  /**
   * The key that runs the same command anywhere in the window (`⇧⌘F`),
   * drawn in mono after the words in the label. Pass the same keys as
   * `aria-keyshortcuts`.
   */
  keys?: string;
  "aria-keyshortcuts"?: string;
  /** Outer hit target in px. Default 32; never below 28 on desktop. */
  size?: number;
  tone?: "neutral" | "accent" | "danger" | "ok";
  disabled?: boolean;
  /** The icon element (Lucide, currentColor). */
  children?: React.ReactNode;
  onClick?: () => void;
  /** When the button opens a menu (RowMenu's kebab). */
  "aria-haspopup"?: "menu";
  "aria-expanded"?: boolean;
  /** -1 where its row opens it by a key of its own (a task board tile's Space opens its ⋯). */
  tabIndex?: number;
  style?: React.CSSProperties;
}
