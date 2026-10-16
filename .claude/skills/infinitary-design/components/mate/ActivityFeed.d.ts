export interface ActivityFeedEvent {
  /** Event time — Date or epoch ms; rendered hh:mm 24h local. */
  time: Date | number;
  /** spawn = accent dot · report = neutral · done = dim. */
  kind?: "spawn" | "report" | "done";
  text: string;
}
export interface ActivityFeedProps {
  /** Oldest→newest; the LAST entry is the most recent (bottom line, full opacity). */
  events?: ActivityFeedEvent[];
  /** Optional row cap (most recent kept). Omit to show the full history. */
  max?: number;
  style?: React.CSSProperties;
}
