export interface BadgeProps {
  tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "outline";
  /** JetBrains Mono — for statuses derived from data (ON PACE, 62%). */
  mono?: boolean;
  /** Leading status dot in currentColor. */
  dot?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
