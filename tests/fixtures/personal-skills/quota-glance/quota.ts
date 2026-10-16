import type { PanelQuotaProvider, PanelQuotaSnapshot } from "@firstmate/contracts";

/** The rows worth a line: a real reading, a carried-forward one, or a sensor that said why not. */
export function rowsOf(snapshot: PanelQuotaSnapshot): PanelQuotaProvider[] {
  if (!snapshot) return [];
  return snapshot.providers.filter((provider) => provider.status !== "skipped");
}

/** "as of 3h ago": a carried-forward reading says its age, never a fresh time. */
export function age(measuredAt: number | undefined, now: number): string {
  if (measuredAt === undefined) return "as of an earlier read";
  const minutes = Math.max(1, Math.round((now - measuredAt) / 60_000));
  return minutes < 60 ? `as of ${minutes}m ago` : `as of ${Math.round(minutes / 60)}h ago`;
}
