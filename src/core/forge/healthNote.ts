import type { ForgeHealthChange } from "./signIns";

/**
 * The feed line a sign-in's health change writes, or none (docs/forge.md,
 * "The one host card"): a host going out of reach says so once, and only
 * when a project of the captain's lives there. A sign-in no project uses
 * writes nothing the captain could act on (INF-2299 finding 5).
 */
export function forgeHealthNote(change: ForgeHealthChange, projectsOnHost: number): string | null {
  if (change.to !== "unavailable" || change.from === "unavailable") return null;
  if (projectsOnHost === 0) return null;
  return `Could not reach ${change.name} - trying again.`;
}
