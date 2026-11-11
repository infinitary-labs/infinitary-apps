import fixture from "./architectureMap.json" with { type: "json" };

/**
 * A map part's data block, as the Advanced architecture skill has a crewmate
 * fill it: map files written the way the skill shows for this project's own
 * top, its core and its main process, the files and lines `git ls-files`
 * counts in each part, and two comparisons read from real changes in this
 * project's history - one that rebuilt how a crewmate's turn moves, one that
 * retired the main process's panel folder.
 */
export const MAP_DATA = fixture;

export type MapData = typeof MAP_DATA;

const OPEN = '<script type="application/json" data-map>';

/** The part with its JSON block replaced by `block`, marked packed when it is deflated and in base64. */
export function fillMapPart(part: string, block: string, packed = false): string {
  const at = part.indexOf(OPEN);
  const end = part.indexOf("</script>", at);
  if (at < 0 || end < 0) throw new Error("The map part has no data block to fill.");
  const opening = packed ? OPEN.replace("data-map>", "data-map data-packed>") : OPEN;
  return `${part.slice(0, at)}${opening}\n${block}\n${part.slice(end)}`;
}
