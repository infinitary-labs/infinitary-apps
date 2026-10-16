export interface CardStackProps {
  /** 0-based index of the visible card. */
  index?: number;
  /** Total cards in the stack; ghost edges peek above when > 1. */
  count?: number;
  /** Unseen cards before the visible one: an accent dot on "Previous card". */
  unreadBefore?: number;
  /** Unseen cards after the visible one: an accent dot on "Next card". */
  unreadAfter?: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** The arrows' key hints (IconButton `keys` and `aria-keyshortcuts`): the window's keys that page the same way. */
  prevKeys?: { keys?: string; "aria-keyshortcuts"?: string };
  nextKeys?: { keys?: string; "aria-keyshortcuts"?: string };
  width?: number | string;
  /** The currently visible card (a ResponseCard). One at a time, always. */
  children?: React.ReactNode;
  /** Optional style override for the peeking card edges (e.g. acrylic treatments). */
  peekStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}
