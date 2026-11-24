import { hostPlatform } from "@core/platform";
import { app } from "electron";
import { commandStarter } from "../commandStarter";
import type { UserDataChoice } from "../userDataDir";
import { workContext } from "../workContext";
import { finishResetAtStart } from "./atStart";
import { answerResetCommand, type CommandAnswer } from "./command";
import { freshAuthenticationFor } from "./freshAuthentication";
import { canConfirm, resetWithoutFirstMate } from "./withoutFirstMate";

/**
 * `<app> reset` as the app runs it (./command.ts): on the folder `run` would
 * open, holding that folder's own lock, taken before Electron is ready, so
 * no start opens it meanwhile. Nothing restarts: the command wipes the folder itself
 * once its lock is let go, and the next start opens on the welcome screen.
 */
export async function runResetCommand(input: {
  words: readonly string[];
  choice: UserDataChoice;
  dataDir: string;
}): Promise<CommandAnswer> {
  const { choice, dataDir } = input;
  const platform = hostPlatform();
  const authentication = freshAuthenticationFor(choice, platform);
  const own = choice.kind === "flavor" ? choice : null;
  const work = workContext();
  const reset = resetWithoutFirstMate({
    authentication,
    dataDir,
    choice,
    starter: own
      ? commandStarter({
          work,
          flavor: own.flavor,
          dataDir,
          isolated: false,
          switched: false,
          packaged: app.isPackaged,
        })
      : null,
    work: {
      dataDir: work.place.dataDir,
      flavor: work.place.flavor,
      spelling: work.place.folderSpelling,
      serviceManager: work.serviceManager,
    },
    questionConfirms: false,
    restart: () => {},
  });
  return answerResetCommand(input.words, {
    // Electron starts only once the folder's lock is held, as a window's start
    // asks it first, so no second Chromium opens on a folder Infinitary runs on.
    canConfirm: async () => {
      await app.whenReady();
      return canConfirm(authentication);
    },
    holdFolder: () => {
      app.setPath("userData", dataDir);
      return app.requestSingleInstanceLock();
    },
    releaseFolder: () => app.releaseSingleInstanceLock(),
    reset,
    finish: async () =>
      (await finishResetAtStart({ choice, dataDir })).kind === "done" ? "done" : "held",
  });
}
