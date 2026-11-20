import type { PanelFeedLine } from "@firstmate/contracts";

/** The slice: reports and failures only, newest last, the tail the rail can hold. */
export function reportsOf(lines: PanelFeedLine[], tail: number): PanelFeedLine[] {
  return lines
    .filter((line) => line.kind === "ok" || line.kind === "danger")
    .sort((left, right) => left.at - right.at)
    .slice(-tail);
}

/** now / 3m / 2h / 1d, as the app prints a feed age. */
export function relativeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
