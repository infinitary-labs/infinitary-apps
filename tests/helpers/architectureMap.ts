import { fillMapPart } from "../../src/shared/mapPart";
import fixture from "./architectureMap.json" with { type: "json" };

export { fillMapPart };

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

/**
 * The map part whose data block names its data file by `src` and holds
 * nothing, as the skill has a crewmate write it on a card: a path before the
 * host keeps the file, the kept copy's address after.
 */
export function mapPartNaming(part: string, src: string): string {
  return fillMapPart(part, "").replace(
    '<script type="application/json" data-map>',
    `<script type="application/json" data-map src="${src}">`,
  );
}
