import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stagedFolders } from "@core/folderMove/due";
import { hostPlatform } from "@core/platform";
import { finishReset, RESET_FINISH_SEAMS, type ResetFinish } from "@core/reset/finish";
import type { ResetOutsideKind } from "@core/reset/mark";
import { MOVE_LOCK_SUFFIX } from "@core/storage/moveLock";
import { OWN_IDENTITY } from "@shared/codeNames";
import { type BuildFlavor, olderUserDataFolders } from "@shared/userDataFolders";
import { handOverProfileDir } from "../handOver";
import { answerBootCommand } from "../startAtBootContext";
import type { UserDataChoice } from "../userDataDir";
import { clearAppFiles, clearPasswordStore, passwordStoreCustodies } from "./outside";

/**
 * Finishes a reset asked before the app quit (docs/reset.md, "At the next
 * start"), before anything of this start reads or writes the data folder -
 * the compile cache included. An isolated or chosen folder is wiped alone;
 * the person's own folder of a flavor also takes its older copies beside it
 * and what the mark lists outside it.
 */
export async function finishResetAtStart(input: {
  choice: UserDataChoice;
  dataDir: string;
}): Promise<ResetFinish> {
  const { choice, dataDir } = input;
  if (choice.kind !== "flavor")
    return finishReset(dataDir, { ...RESET_FINISH_SEAMS, olderCopies: () => [] });
  const platform = hostPlatform();
  const flavor = choice.flavor;
  return finishReset(dataDir, {
    ...RESET_FINISH_SEAMS,
    olderCopies: () => olderCopies(dataDir, flavor),
    clearOutside: (kind) => clearAtStart(kind, { platform, flavor, dataDir }),
  });
}

/**
 * What else of this flavor's saved work sits beside the folder: an older
 * name's folder (Firstmate 3000's), a folder a move set aside or was still
 * building, the hand-over's throwaway profile and the move's lock files.
 */
export function olderCopies(dataDir: string, flavor: BuildFlavor): string[] {
  const parent = dirname(dataDir);
  const older = olderUserDataFolders(OWN_IDENTITY, flavor).map((name) => join(parent, name));
  const setAside = `${basename(dataDir)}-set-aside-`;
  let beside: string[] = [];
  try {
    beside = readdirSync(parent)
      .filter((name) => name.startsWith(setAside))
      .map((name) => join(parent, name));
  } catch {
    beside = [];
  }
  return [
    ...older,
    ...older.map((folder) => `${folder}${MOVE_LOCK_SUFFIX}`),
    ...beside,
    ...stagedFolders(dataDir),
    handOverProfileDir(dataDir),
    `${dataDir}${MOVE_LOCK_SUFFIX}`,
  ];
}

/**
 * One outside kind, cleared at a start: the password store's items, the
 * start-at-boot entry, and the app's own files a Mac keeps outside the
 * folder, which only now, with the old app gone, stay deleted.
 */
async function clearAtStart(
  kind: ResetOutsideKind,
  place: { platform: NodeJS.Platform; flavor: BuildFlavor; dataDir: string },
): Promise<boolean> {
  if (kind === "password-store")
    return clearPasswordStore(
      passwordStoreCustodies({ platform: place.platform, flavor: place.flavor }),
    );
  if (kind === "start-entries")
    return (await answerBootCommand({ boot: ["--off"], help: null }, place.dataDir)).code === 0;
  return clearAppFiles({ platform: place.platform, flavor: place.flavor, homeDir: homedir() });
}
