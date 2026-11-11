import fixture from "./architectureMap.json" with { type: "json" };

export { fillMapPart } from "../../src/shared/mapPart";

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
