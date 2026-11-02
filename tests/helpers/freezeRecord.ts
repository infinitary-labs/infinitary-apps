import { existsSync, readFileSync } from "node:fs";
import { type FreezeIncident, freezeIncidentSchema } from "../../src/core/freeze/freezeRecorder";

/** INF-2205: all record readers retain unfinished incidents as unknown, not zero work. */
export function readFreezes(path: string): FreezeIncident[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => freezeIncidentSchema.parse(JSON.parse(text)));
}
