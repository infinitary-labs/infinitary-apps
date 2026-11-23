import * as m from "@shared/i18n/messages.generated";
import type { ResetAnswer } from "@shared/reset";
import { app } from "electron";
import { standaloneWindow } from "../savedDataRefusal";
import { markRefusalWindow } from "../windows";
import type { ResetPlace } from "./inApp";
import { followResetScreen } from "./screen";
import {
  clearStartAttempts,
  earlierStartAttempts,
  noteStartAttempt,
  START_ATTEMPTS_SHOWN,
} from "./startAttempts";
import { resetWithoutFirstMate } from "./withoutFirstMate";

/**
 * Counts this window start on its own folder, or, when earlier starts that
 * never got through reached `START_ATTEMPTS_SHOWN`, shows Infinitary could
 * not start instead and answers true: this start goes no further. The count
 * goes once a window is ready to show, and once the first mate or the view
 * started (./app.ts).
 */
export function couldNotStartYet(input: {
  place: ResetPlace;
  hidden: boolean;
  /** Starts the app again and quits this one. */
  restart: () => Promise<void>;
}): boolean {
  const { dataDir } = input.place;
  const earlier = earlierStartAttempts(dataDir);
  if (earlier >= START_ATTEMPTS_SHOWN) {
    void showCouldNotStart({
      dataDir,
      hidden: input.hidden,
      restart: input.restart,
      reset: resetWithoutFirstMate({
        ...input.place,
        questionConfirms: true,
        restart: input.restart,
      }),
    });
    return true;
  }
  noteStartAttempt(dataDir, earlier);
  app.on("browser-window-created", (_event, win) =>
    win.once("ready-to-show", () => clearStartAttempts(dataDir)),
  );
  return false;
}

/**
 * Infinitary could not start (docs/reset.md, "Infinitary could not start"):
 * the last starts never got as far as starting it, so this one shows a
 * standalone screen instead of trying again by itself. Try again starts the
 * app once more with the count gone; Reset Infinitary asks in place first,
 * then resets with no first mate running; Quit leaves the count, so the next
 * start shows this screen again.
 */
export async function showCouldNotStart(input: {
  dataDir: string;
  hidden: boolean;
  reset: () => Promise<ResetAnswer>;
  /** Starts the app again and quits this one. */
  restart: () => Promise<void>;
}): Promise<void> {
  await app.whenReady();
  const win = standaloneWindow({ title: "Infinitary", width: 640, height: 420 });
  if (!input.hidden) markRefusalWindow(win);
  win.on("closed", () => app.quit());
  await followResetScreen({
    win,
    words: {
      title: m.resetCouldNotStartTitle(),
      message: m.resetCouldNotStartMessage(),
      next: m.resetCouldNotStartNext(),
    },
    again: true,
    reset: input.reset,
    onAgain: () => {
      clearStartAttempts(input.dataDir);
      void input.restart();
    },
    onQuit: () => app.quit(),
  });
  if (!input.hidden) win.show();
}
