export interface StatusDotProps {
  /** ok = signed in with a reading · ring = signed in, nothing read · warn = stale · danger = sign in again · idle = paused · busy = work in flight on this row · captain = the captain's own hold on this row. */
  tone?: "ok" | "ring" | "warn" | "danger" | "idle" | "busy" | "captain";
  /** Accessible name and tooltip, e.g. "signed in". Always pass it - the dot carries no text. */
  label: string;
  /** False only where the same words are already shown. The accessible name stays. */
  nativeTitle?: boolean;
  /** A Tab stop of its own whose words show in the app's label on rest, for a row whose state the dot alone says. Never inside a control. */
  focusable?: boolean;
  style?: React.CSSProperties;
}
