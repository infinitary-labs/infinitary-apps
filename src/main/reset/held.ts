import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAll } from "@core/removeWhole";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";

/** Try again, the box's first and default answer. */
export const RESET_HELD_TRY_AGAIN = 0;

/**
 * Another program still holds the data folder a reset is finishing, so it
 * could not be renamed aside (docs/reset.md, "A folder another program
 * holds"). The start opens nothing of the folder: Chromium runs on a
 * throwaway profile outside it, and one box offers to try again, which
 * starts the app once more, or to quit.
 */
export async function showResetHeld(): Promise<void> {
  const { app, dialog } = await import("electron");
  const profile = mkdtempSync(join(tmpdir(), "infinitary-reset-"));
  app.setPath("userData", profile);
  await app.whenReady();
  startLanguage(app.getPreferredSystemLanguages(), languageOverride(process.env, app.isPackaged));
  let answer = 1;
  try {
    app.focus({ steal: true });
    answer = (
      await dialog.showMessageBox({
        type: "warning",
        title: "Infinitary",
        message: m.resetHeldMessage(),
        detail: m.resetHeldDetail(),
        buttons: [m.resetHeldTryAgain(), m.resetHeldQuit()],
        defaultId: RESET_HELD_TRY_AGAIN,
        cancelId: 1,
      })
    ).response;
  } catch (error) {
    console.warn(`[reset] could not show that the folder is held: ${(error as Error).message}`);
  }
  if (answer === RESET_HELD_TRY_AGAIN) app.relaunch();
  removeAll(profile);
  app.exit(0);
}
