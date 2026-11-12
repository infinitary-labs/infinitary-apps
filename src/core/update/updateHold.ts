import type { UpdateHold, UpdateHoldStep } from "@shared/channels/ownWindow";
import type { BrowserViewer } from "../browser/browserViews";
import { type CrewWorkForUpdate, createUpdateSaving } from "./updateWork";

/** What `replaced` answers when no work was saved for the window's update. */
export const HOLD_NOT_SAVED =
  "The crew's work was not saved for this update, so nothing was replaced. Try the update again.";

/**
 * The hold this computer's window keeps on the crew's saved work while it
 * installs an update for a first mate a command started (docs/alpha.md,
 * "Saving work before an update"): the window replaces the copy, since
 * only a program in the person's own session can, and the first mate
 * holds its crew's work saved meanwhile. The hold belongs to the
 * connection that asked: a window that closes or drops lets the save go
 * and carries the work on, so a closed window never leaves the crew
 * waiting. Once the copy is replaced the work stays saved, for the new
 * copy to resume, and `replaced` ends this first mate.
 */
export function createUpdateHold(
  work: CrewWorkForUpdate,
  /** Ends this first mate with its work saved, for its starter to start the new copy. */
  replaced: () => void,
): (step: UpdateHoldStep, window: BrowserViewer) => Promise<UpdateHold> {
  const saving = createUpdateSaving(work);
  let holder: BrowserViewer | null = null;
  let saved = false;
  const letGo = () => {
    saving.later();
    if (saved) saving.release();
    saved = false;
  };
  const now = (): UpdateHold => {
    const status = saving.status();
    return { saved, ...(status ? { work: status } : {}) };
  };
  return async (step, window) => {
    switch (step) {
      case "save": {
        if (holder !== window) {
          holder = window;
          window.onGone(() => {
            if (holder !== window) return;
            holder = null;
            letGo();
          });
        }
        const done = await saving.save();
        // The window left, or let it go, while the work was being saved: nothing holds it.
        if (done && holder !== window) saving.release();
        else saved = done;
        return now();
      }
      case "later":
        saving.later();
        return now();
      case "release":
        letGo();
        return now();
      case "replaced": {
        if (!saved) throw new Error(HOLD_NOT_SAVED);
        // The copy is replaced: the work stays saved, whatever the window does next.
        holder = null;
        // After this answer is on its way, so the window hears it before the first mate ends.
        setImmediate(replaced);
        return now();
      }
      case "status":
        return now();
    }
  };
}

/** How often the window reads which tasks its first mate still waits for while it saves. */
const HOLD_READ_MS = 1_000;

/**
 * The same hold from the window's side: the crew's work for the window's
 * own update checker, kept by the first mate it asks. Update later lets
 * the save go there too, and a save that finished as Update later was
 * chosen is released, so the first mate never holds work nobody waits on.
 */
export function crewWorkHeldThere(
  ask: (step: UpdateHoldStep) => Promise<UpdateHold>,
  every = HOLD_READ_MS,
): CrewWorkForUpdate {
  const quietly = (step: UpdateHoldStep) => void ask(step).catch(() => {});
  return {
    save: async ({ signal, waiting }) => {
      const later = () => quietly("later");
      signal.addEventListener("abort", later, { once: true });
      const reading = setInterval(() => {
        void ask("status")
          .then((hold) => {
            if (hold.work?.state === "saving") waiting(hold.work.tasks);
          })
          .catch(() => {});
      }, every);
      try {
        const hold = await ask("save");
        if (!hold.saved) return "withdrawn";
        if (!signal.aborted) return "saved";
        await ask("release");
        return "withdrawn";
      } finally {
        clearInterval(reading);
        signal.removeEventListener("abort", later);
      }
    },
    release: () => quietly("release"),
    // What resumes is read from the first mate with each status (`BesideWindow.dispatch`).
    resuming: () => [],
  };
}
