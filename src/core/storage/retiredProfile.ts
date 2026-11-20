import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A data folder that has moved to Infinitary. The one-time move (a later step)
 * writes this marker into the old folder once the new folder holds everything,
 * and Firstmate 3000 never opens a folder that carries it, so two apps never
 * write the same saved work. The marker's presence is the whole rule: a marker
 * that does not parse still retires the folder, because a folder that says it
 * moved is never guessed open.
 */
export const RETIRED_PROFILE_MARKER = "retired-profile.json";

export const RETIRED_PROFILE_TITLE = "Your saved work has moved to Infinitary";
export const RETIRED_PROFILE_MESSAGE =
  "This saved work now lives in Infinitary. Open Infinitary to continue. Nothing here has been changed.";

export function isProfileRetired(dataRoot: string): boolean {
  return existsSync(join(dataRoot, RETIRED_PROFILE_MARKER));
}
