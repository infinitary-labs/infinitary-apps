import { readResetMark } from "@core/reset/mark";
import type { ResetAnswer } from "@shared/reset";

/**
 * Whether a reset waits for the next start to wipe the folder (docs/reset.md,
 * "A first mate with no window"), as a window beside a run reads it to start
 * again once the run ended. Only a mark at `asked` still has that wipe to do:
 * one left at `moved` for a few starts by a folder that could not be deleted
 * sits beside a fresh install already running, whose Stop must keep it stopped. A reset this program runs itself writes the mark
 * before its clearers, and one of them ends the run the window is beside, so
 * while that reset goes on the window reads no reset waiting: it would
 * otherwise quit before the reset's later steps and start the app twice.
 */
export function resetWatch(dataDir: string) {
  let resetting = false;
  return {
    waiting: (): boolean => !resetting && readResetMark(dataDir)?.stage === "asked",
    /**
     * This program's own reset, through the watch. One that starts the app
     * again stays marked as this program's own, as the app is quitting.
     */
    own:
      <Ask>(reset: (ask?: Ask) => Promise<ResetAnswer>) =>
      async (ask?: Ask): Promise<ResetAnswer> => {
        resetting = true;
        let answer: ResetAnswer | undefined;
        try {
          answer = await reset(ask);
          return answer;
        } finally {
          if (answer?.outcome !== "restarting") resetting = false;
        }
      },
  };
}
