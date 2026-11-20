import { existsSync } from "node:fs";
import { join } from "node:path";
import { OWN_IDENTITY, type Spelling } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import {
  type BuildFlavor,
  olderUserDataFolders,
  spellingOfUserDataFolder,
  userDataFolderOf,
} from "@shared/userDataFolders";
import { dueMove, type FolderMove } from "../folderMove/due";
import { readMoveRecord } from "../folderMove/record";
import { isProfileRetired } from "../storage/retiredProfile";

/**
 * Where the app keeps its data when it runs work for another Mac's Firstmate
 * (docs/helper.md): `work/` in its own folder for its flavor, in the home
 * folder of the macOS user it runs as. Nothing else in that folder is opened:
 * not the record, not the single-instance lock, not a sign-in.
 *
 * Across the Infinitary rename the work may still be in an older spelling's
 * folder, until the one-time move brings that folder into this app's own
 * (docs/helper.md, "Under the other name"): the work is read where it is now.
 */

export type HelperPlace = {
  /** Whether it runs from a packaged app. */
  readonly packaged: boolean;
  readonly flavor: BuildFlavor;
  /** Whose app this is (`@shared/codeNames`): its own folder is this spelling's. */
  readonly spelling: Spelling;
  /** Its own data: the grant, the lock. 0700, every file in it 0600. */
  readonly dataDir: string;
  /**
   * The spelling whose folder `dataDir` is in, which the background's label
   * follows: this app's own, or an older one's while the work is still there.
   */
  readonly folderSpelling: Spelling;
  /**
   * The one-time move that brings the work into this app's own folder, due
   * now (src/core/folderMove/move.ts); null when none is. Until it is made,
   * `dataDir` is the older folder's work.
   */
  readonly move: FolderMove | null;
  /**
   * This app's own folder moved to another app's (its retired marker): the
   * work there is that app's now, and nothing here opens it.
   */
  readonly retired: boolean;
};

export type HelperPlaceInput = {
  packaged: boolean;
  /** The app's flavor, as the main process reads it (src/main/userDataDir.ts). */
  flavor: BuildFlavor;
  /** The platform's application-data folder: Electron's `appData`. */
  appData: string;
  env: NodeJS.ProcessEnv;
  /** Whose folders it reads (src/main/userDataDir.ts `folderSpellingFor`); this build's own unless given. */
  spelling?: Spelling;
};

export function helperPlace(input: HelperPlaceInput): HelperPlace {
  const spelling = input.spelling ?? OWN_IDENTITY;
  const base = { packaged: input.packaged, flavor: input.flavor, spelling };
  // A packaged app never takes its folder from the environment.
  const isolated = input.packaged ? undefined : settingFrom(input.env, "HELPER_DATA_DIR")?.trim();
  if (isolated)
    return { ...base, dataDir: isolated, folderSpelling: spelling, move: null, retired: false };
  return { ...base, ...workFolderNow({ appData: input.appData, spelling, flavor: input.flavor }) };
}

/** Whether a work folder holds this computer's work: the grant it joined with, or a removal still to finish. */
export function holdsWork(dir: string): boolean {
  return existsSync(join(dir, "home.json")) || existsSync(join(dir, "left.json"));
}

/**
 * Where the work is now, for an app of `spelling`: in its own folder once it
 * is there or nothing is anywhere else; otherwise in the newest older
 * spelling's folder that holds work and has not moved, with the move that
 * brings it over when one is due. A move already made and still finishing
 * has the work in this app's folder. An older folder holding no work - only
 * a window's saved work - is the window's to move, never the work's.
 */
export function workFolderNow(input: {
  appData: string;
  spelling: Spelling;
  flavor: BuildFlavor;
}): Pick<HelperPlace, "dataDir" | "folderSpelling" | "move" | "retired"> {
  const own = join(input.appData, userDataFolderOf(input.spelling, input.flavor));
  const ownWork = join(own, "work");
  const here = { dataDir: ownWork, folderSpelling: input.spelling, move: null };
  const move = dueMove(input);
  // Committed already: the work is here, and the move has steps left.
  if (move && readMoveRecord(own)) return { ...here, move, retired: false };
  if (holdsWork(ownWork) || isProfileRetired(own))
    return { ...here, retired: isProfileRetired(own) };
  for (const name of olderUserDataFolders(input.spelling, input.flavor)) {
    const older = join(input.appData, name);
    const olderWork = join(older, "work");
    if (isProfileRetired(older) || !holdsWork(olderWork)) continue;
    return {
      dataDir: olderWork,
      folderSpelling: spellingOfUserDataFolder(name) ?? input.spelling,
      // None when this app's person kept its own window's work apart from it.
      move: move?.from === older ? move : null,
      retired: false,
    };
  }
  return { ...here, retired: false };
}
