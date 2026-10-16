import { MOVE_LOCK_MESSAGE, MOVE_LOCK_TITLE, moveLockHeld, moveLockPathFor } from "./moveLock";
import { isProfileRetired, RETIRED_PROFILE_MESSAGE, RETIRED_PROFILE_TITLE } from "./retiredProfile";

/** What a refusal window says: a title, the reason, and what the captain can do next. */
export type DataRefusal = { title: string; message: string; next: string };

/**
 * Why this data folder is not opened, or null when it is. A folder that moved
 * to Infinitary is refused for good; one a move is working on right now is
 * refused until that move finishes. Nothing here writes the folder.
 */
export function dataFolderRefusal(dataRoot: string): DataRefusal | null {
  if (isProfileRetired(dataRoot)) {
    return {
      title: RETIRED_PROFILE_TITLE,
      message: RETIRED_PROFILE_MESSAGE,
      next: "You can close this window.",
    };
  }
  if (moveLockHeld(moveLockPathFor(dataRoot))) {
    return {
      title: MOVE_LOCK_TITLE,
      message: MOVE_LOCK_MESSAGE,
      next: "You can close this window.",
    };
  }
  return null;
}
