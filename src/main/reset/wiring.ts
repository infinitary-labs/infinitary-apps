import { hostPlatform } from "@core/platform";
import type { FreshAuthentication } from "@core/secrets/approvals";
import type { ResetAnswer } from "@shared/reset";
import type { CommandStarter } from "../commandStarter";
import type { Shell } from "../shell";
import type { UserDataChoice } from "../userDataDir";
import type { WorkContext } from "../workContext";
import { couldNotStartYet } from "./couldNotStart";
import { freshAuthenticationFor } from "./freshAuthentication";
import { type ResetAsk, type ResetPlace, resetInApp, restartForReset } from "./inApp";
import { clearStartAttempts } from "./startAttempts";
import { resetWithoutFirstMate } from "./withoutFirstMate";

/**
 * Every place a window start reaches Reset Infinitary (docs/reset.md, "Where
 * a reset can start"), sharing one folder and one restart: Infinitary could
 * not start, the screens shown when the folder cannot open, the window's own
 * row, and a computer that controls this one.
 */
export function resetsFor(input: {
  dataDir: string;
  choice: UserDataChoice;
  starter: CommandStarter | null;
  work: WorkContext;
  /** A run on a test's or another chosen isolated folder. */
  isolated: boolean;
  /** A window start on this app's own folder, which counts toward Infinitary could not start. */
  countsStarts: boolean;
  /** Starts the app again with these arguments once it quits. */
  relaunch: (args: string[]) => void;
  quit: () => void;
}) {
  const restart = restartForReset(input);
  const { work } = input;
  const spot: Omit<ResetPlace, "authentication"> = {
    dataDir: input.dataDir,
    choice: input.choice,
    starter: input.starter,
    work: {
      dataDir: work.place.dataDir,
      flavor: work.place.flavor,
      spelling: work.place.folderSpelling,
      serviceManager: work.serviceManager,
    },
  };
  // Made once the shell's window side is wired; a computer that controls this one asks it too.
  let here: ((ask?: ResetAsk) => Promise<ResetAnswer>) | undefined;
  return {
    /** Shows Infinitary could not start instead of this start, answering true (./couldNotStart.ts). */
    couldNotStart: (hidden: boolean, window: () => Buffer | undefined): boolean =>
      input.countsStarts &&
      couldNotStartYet({
        hidden,
        restart,
        place: {
          ...spot,
          authentication: freshAuthenticationFor(input.choice, hostPlatform(), window),
        },
      }),
    /** This start got through: the count of starts that did not goes. */
    started: () => {
      if (input.countsStarts) clearStartAttempts(input.dataDir);
    },
    /** The reset a screen shown when this folder cannot open offers, with no first mate running. */
    withoutFirstMate: (authentication: FreshAuthentication | undefined) =>
      resetWithoutFirstMate({ ...spot, authentication, questionConfirms: true, restart }),
    /** The window's own row's reset, also asked by a computer that controls this one. */
    inApp: (shell: Shell, authentication: FreshAuthentication | undefined) => {
      here = resetInApp({ ...spot, authentication, shell, restart });
      return here;
    },
    /**
     * A computer that controls this one asked: the answer goes back to it
     * first, as the reset stops the first mate that answers it.
     */
    forController: async (): Promise<void> => {
      const reset = here;
      if (!reset) throw new Error("Infinitary is still starting.");
      setImmediate(() => {
        reset({ kind: "for-controller" }).catch((error: unknown) =>
          console.warn(`[reset] the reset another computer asked failed: ${String(error)}`),
        );
      });
    },
  };
}
