// The ambient music's shipped styles by name (docs/ambient-music.md), apart
// from the look so a person's own styles (./ambientOwn.ts) can name them too.

/** The ambient music's styles, in the order Settings lists them (docs/ambient-music.md). */
export const AMBIENT_STYLES = [
  "deep-drift",
  "star-cruise",
  "cold-sleep",
  "quiet-cove",
  "tavern-embers",
  "moonlit-deck",
  "harbor-dawn",
  "fair-winds",
  "wayfinder-night",
  "island-morning",
] as const;
export type AmbientStyle = (typeof AMBIENT_STYLES)[number];
/** The style that plays until someone picks another. */
export const DEFAULT_AMBIENT_STYLE: AmbientStyle = "cold-sleep";
