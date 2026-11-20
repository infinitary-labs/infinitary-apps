/**
 * Relative age of a feed timestamp, as the activity trail and the
 * collapsed Activity panel print it: now / 3m / 2h / 1d. Its own module,
 * so the panel library (`@infinitary/ui`) exports it without the feed's
 * authoring.
 */
export function feedRelativeAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
