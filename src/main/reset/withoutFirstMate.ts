import { hostPlatform } from "@core/platform";
import { withinMs } from "@core/reset/prepare";
import type { ResetAnswer } from "@shared/reset";
import { confirmPerson, outsideAtStart, outsideNow, type ResetPlace } from "./inApp";
import { endLeftoverPrograms } from "./leftovers";
import { runReset } from "./running";

/**
 * Reset Infinitary where no first mate runs: from the screens shown when
 * Infinitary cannot open and from the reset command (docs/reset.md, "Where
 * a reset can start"). The person confirms with the system's own
 * confirmation; this program clears what it reaches outside the folder,
 * writes the mark, ends every program still holding a file in the folder and
 * restarts, so the next start wipes the folder as after the Settings row.
 *
 * What only a running first mate undoes stays as a plain wipe leaves it:
 * paired devices are not told, open tasks' stops do not run, accounts are
 * not signed out with their providers and projects keep the settings
 * Infinitary wrote into them.
 */
export function resetWithoutFirstMate(
  input: ResetPlace & {
    /**
     * Where the system has no confirmation to ask, as on an isolated or
     * chosen folder: true when the window's own question confirms, false
     * when nothing may (the command, which a shell an agent drives can run).
     */
    questionConfirms: boolean;
    /** Starts the app again and quits this one; the command passes none. */
    restart: () => Promise<void> | void;
  },
): () => Promise<ResetAnswer> {
  return () =>
    runReset({
      confirm: async () => {
        if (!input.questionConfirms && !(await canConfirm(input.authentication))) return false;
        return confirmPerson(input.authentication, hostPlatform(), null);
      },
      prepare: () => Promise.resolve(),
      clear: outsideNow(input),
      atStart: outsideAtStart(input.choice),
      dataDir: input.dataDir,
      stopFirstMate: () => Promise.resolve(),
      endLeftovers: () => endLeftoverPrograms(input.dataDir),
      restart: input.restart,
      within: withinMs,
    });
}

/** Whether the system can ask the person at this computer to confirm. */
export async function canConfirm(authentication: ResetPlace["authentication"]): Promise<boolean> {
  return authentication ? authentication.available().catch(() => false) : false;
}
