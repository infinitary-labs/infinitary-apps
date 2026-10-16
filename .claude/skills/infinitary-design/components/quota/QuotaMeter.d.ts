export interface QuotaMeterProps {
  /** Window label, e.g. "session", "weekly", "opus weekly". */
  label?: string;
  /** 0–100. Omit for "no data". */
  percentRemaining?: number;
  /** Pace: ahead (green) / on_pace (accent) / behind (amber) / unknown. ≤10% remaining always shows danger. */
  pace?: "ahead" | "on_pace" | "behind" | "unknown";
  /** e.g. "resets Fri 9am". */
  resetText?: string;
  style?: React.CSSProperties;
}
