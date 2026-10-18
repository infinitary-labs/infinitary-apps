import { join } from "node:path";
import { userDataFolderOf } from "@shared/userDataFolders";
import { runMove } from "../../src/core/folderMove/move";
import { scratchDir } from "./scratchDirs";

/**
 * A computer that runs work, before and after its first update to
 * Infinitary (docs/helper.md, "Under the other name"): its work starts in
 * Firstmate 3000's folder under `appData`, and its work run moves that whole
 * folder into Infinitary's with the real move engine before it starts.
 */

/** Where the work is before the move: Firstmate 3000's folder's `work/`. */
export function olderWorkFolder(appData: string): string {
  return join(appData, userDataFolderOf("fm", "release"), "work");
}

/**
 * The one-time move of Firstmate 3000's folder into Infinitary's, with the
 * computer's work stopped; answers where the work is now. `platform` picks
 * the copier: a Mac's spawns `cp -c`, so a unit test moves with Node's own
 * copy, as a Linux computer does.
 */
export async function moveWorkFolder(
  appData: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const to = join(appData, userDataFolderOf("inf", "release"));
  const moved = await runMove(
    { from: join(appData, userDataFolderOf("fm", "release")), to },
    {
      platform,
      claudeConfigDir: scratchDir("infinitary-moved-claude-"),
      hostname: "builder-mac",
    },
  );
  if (moved.kind !== "moved") throw new Error(`The move did not happen: ${JSON.stringify(moved)}`);
  return join(to, "work");
}
