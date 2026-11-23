import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { defaultClaudeConfigDir } from "@core/claude/claudeQuota";
import type { FolderMove } from "@core/folderMove/due";
import type { MoveDeps } from "@core/folderMove/move";
import { olderRunAgent, type TakeOverDeps } from "@core/folderMove/takeOver";
import { pauseInBackground, resumeInBackground } from "@core/helper/background";
import { handBackgroundOver } from "@core/helper/moveWork";
import { userUnitsDir } from "@core/helper/runAgent";
import { APP_IDENTITIES } from "@shared/codeNames";
import { spellingOfUserDataFolder } from "@shared/userDataFolders";
import { hostPlatform } from "../core/platform";
import type { HandOverNames } from "./handOverPage";
import type { WorkContext } from "./workContext";

/** The app a data folder belongs to, by the name a person knows it (`@shared/codeNames`). */
function appNameOfFolder(dir: string): string {
  return APP_IDENTITIES[spellingOfUserDataFolder(basename(dir)) ?? "fm"].app.release;
}

export function handOverNames(move: FolderMove): HandOverNames {
  return { from: appNameOfFolder(move.from), to: appNameOfFolder(move.to) };
}

/**
 * What the one-time move's hand-over reaches, the window's and a run's
 * alike: the move itself, the take-over from an older copy with no window
 * still holding the older folder, its background agent let go first
 * (src/core/folderMove/takeOver.ts), and once the work is in, the older
 * agent's hand-over to this app's label, as the work run's move hands it
 * over, so its file starts nothing on the frozen older folder.
 */
export function handOverReach(
  move: FolderMove,
  work: WorkContext,
): {
  deps: Pick<MoveDeps, "platform" | "claudeConfigDir" | "hostname">;
  takeOver: TakeOverDeps;
  handBackground?: () => Promise<unknown>;
} {
  const serviceManager = work.serviceManager;
  // The older copy's names follow the folder it moves from, never where
  // this computer's work happens to be (`folderSpelling` names this app's
  // own folder whenever its work is not still in the older one).
  const olderSpelling = spellingOfUserDataFolder(basename(move.from)) ?? "fm";
  // The start entry a run of the older copy may have, let go before a forced end.
  const olderRun = olderRunAgent({
    spelling: olderSpelling,
    flavor: work.place.flavor,
    platform: hostPlatform(),
    homeDir: homedir(),
    unitsDir: userUnitsDir(process.env, homedir()),
    dataDir: move.from,
  });
  const olderBackground = serviceManager && {
    flavor: work.place.flavor,
    dataDir: join(move.from, "work"),
    spelling: olderSpelling,
    homeDir: homedir(),
    uid: process.getuid?.() ?? userInfo().uid,
    ...serviceManager,
  };
  return {
    deps: {
      platform: hostPlatform(),
      claudeConfigDir: defaultClaudeConfigDir(),
      hostname: hostname(),
    },
    takeOver: {
      platform: hostPlatform(),
      hostname: hostname(),
      ...(olderBackground
        ? {
            unloadAgent: (service) => pauseInBackground(olderBackground, service),
            resumeAgent: (service) => resumeInBackground(olderBackground, service),
          }
        : {}),
      ...(olderRun ? { runAgent: olderRun } : {}),
    },
    ...(serviceManager
      ? {
          handBackground: async () => {
            const dataDir = join(move.to, "work");
            const { workLog } = await import("@core/helper/run");
            return handBackgroundOver(dataDir, {
              spelling: work.place.spelling,
              flavor: work.place.flavor,
              background: (dir, spelling) => ({
                flavor: work.place.flavor,
                dataDir: dir,
                spelling,
                homeDir: homedir(),
                uid: process.getuid?.() ?? userInfo().uid,
                ...serviceManager,
              }),
              launcher: work.launcher,
              env: work.backgroundEnv,
              log: workLog(dataDir),
            });
          },
        }
      : {}),
  };
}
