import { existsSync, readFileSync } from "node:fs";
import { type FreezeIncident, freezeIncidentSchema } from "../../src/core/freeze/freezeRecorder";
import { type PassLine, passLineSchema } from "../../src/core/freeze/passSteps";

/** INF-2205: all record readers retain unfinished incidents as unknown, not zero work. */
export function readFreezes(path: string): FreezeIncident[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => freezeIncidentSchema.parse(JSON.parse(text)));
}

/** The minute pass record: one line per pass, each step's timing (docs/freeze-recorder.md). */
export function readPasses(path: string): PassLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => passLineSchema.parse(JSON.parse(text)));
}
