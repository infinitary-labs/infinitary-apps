export interface SlotBadgeProps {
  /** Intelligence slot the user assigned. `premium` is the opt-in slot. */
  slot?: "premium" | "high" | "medium" | "low";
  style?: React.CSSProperties;
}
export function SlotBadge(props: SlotBadgeProps): JSX.Element;
