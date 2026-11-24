import { MOVE_LOCK_MESSAGE, MOVE_LOCK_TITLE, moveLockHeld, moveLockPathFor } from "./moveLock";
import type { DataFolderPrivacy } from "./ownerOnly";
import { isProfileRetired, RETIRED_PROFILE_MESSAGE, RETIRED_PROFILE_TITLE } from "./retiredProfile";

/**
 * What a refusal window says: a title, the reason, and what the captain can do
 * next. `offersReset` marks a refusal whose window also offers Reset
 * Infinitary (docs/reset.md, "Where a reset can start"); a folder a move
 * retired or holds never does, since its work lives on elsewhere.
 */
export type DataRefusal = { title: string; message: string; next: string; offersReset?: true };

export const UNSAFE_FOLDER_TITLE = "Infinitary could not keep this folder private";
export const UNSAFE_FOLDER_MESSAGE =
  "Other accounts on this PC could read your saved work here, and Infinitary could not change that. Nothing here has been changed.";
export const UNSAFE_FOLDER_NEXT =
  "Move the folder to a drive formatted for Windows (NTFS) that your account owns, then open Infinitary again.";
export const UNCHECKED_FOLDER_TITLE = "Infinitary could not check this folder";
export const UNCHECKED_FOLDER_MESSAGE =
  "Windows did not let Infinitary check who can read your saved work here, so Infinitary did not open it. Nothing here has been changed.";
export const UNCHECKED_FOLDER_NEXT =
  "Open Infinitary again. If this keeps happening, ask whoever manages this PC whether Windows PowerShell is blocked: Infinitary uses it for this check.";
export const UNFINISHED_FOLDER_TITLE = "Infinitary could not finish keeping this folder private";
export const UNFINISHED_FOLDER_MESSAGE =
  "Infinitary started making your saved work here readable by your account alone, but Windows stopped before every file was done. Infinitary tries again each time it opens.";
export const UNFINISHED_FOLDER_NEXT =
  "Close any other program using files in this folder, then open Infinitary again.";

/**
 * Why this data folder is not opened, or null when it is. A folder that moved
 * to Infinitary is refused for good; one a move is working on right now is
 * refused until that move finishes; on Windows, a folder the app could not
 * make owner-only (`privacy`, ./ownerOnly.ts) is refused with words that say
 * whether Windows could not check it, could not finish, or the place is
 * unsafe. Nothing here writes the folder.
 */
export function dataFolderRefusal(
  dataRoot: string,
  privacy?: DataFolderPrivacy | null,
): DataRefusal | null {
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
  const why = privacy?.refused?.why;
  if (why === "unread") {
    return {
      title: UNCHECKED_FOLDER_TITLE,
      message: UNCHECKED_FOLDER_MESSAGE,
      next: UNCHECKED_FOLDER_NEXT,
      offersReset: true,
    };
  }
  if (why === "unfinished") {
    return {
      title: UNFINISHED_FOLDER_TITLE,
      message: UNFINISHED_FOLDER_MESSAGE,
      next: UNFINISHED_FOLDER_NEXT,
      offersReset: true,
    };
  }
  if (why) {
    return {
      title: UNSAFE_FOLDER_TITLE,
      message: UNSAFE_FOLDER_MESSAGE,
      next: UNSAFE_FOLDER_NEXT,
      offersReset: true,
    };
  }
  return null;
}
