export interface QuotaMicroMeterProps {
  /** Window label, e.g. "session", "weekly (Opus)". Never truncated. */
  label: string;
  /** 0–100. Omit for an unread window ("–"). */
  percentRemaining?: number;
  /** Pace: ahead (warn) / on_pace (accent) / behind (ok) / unknown (idle). ≤10% forces danger. */
  pace?: "ahead" | "on_pace" | "behind" | "unknown";
  /** Rides the title only ("weekly · resets Fri"); the row has no room for it. */
  resetText?: string;
  /** The linear-pace clock marker position (the window's timeRemainingPercent). Omit when pace is unknown. */
  clockPercent?: number;
  /** A last-known-good reading: dims the bar and the number, drops the tint. */
  stale?: boolean;
  style?: React.CSSProperties;
}
