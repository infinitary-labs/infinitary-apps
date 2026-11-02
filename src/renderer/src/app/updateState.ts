import type { UpdateChannel, UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_PROBLEMS } from "@shared/updateWords";
import { create } from "zustand";

type State = {
  status: UpdateStatus | null;
  busy: boolean;
  /** A pressed Check for updates is reading. */
  checking: boolean;
  problem: string | null;
  /** Update later let the last update go: it waits, and the work carries on. */
  later: string | null;
  noticeOpen: boolean;
};
export const useUpdateState = create<State>(() => ({
  status: null,
  busy: false,
  checking: false,
  problem: null,
  later: null,
  noticeOpen: false,
}));
export function setUpdateNoticeOpen(next: boolean | ((open: boolean) => boolean)): void {
  useUpdateState.setState((state) => ({
    noticeOpen: typeof next === "function" ? next(state.noticeOpen) : next,
  }));
}
/** An update is saving the crew's work before it replaces the copy, so it can still wait. */
export const savingForUpdate = (status: UpdateStatus | null): boolean =>
  status?.work?.state === "saving";

/** A copy whose installation the app could not confirm keeps its explanation, with no check. */
export const checksUpdates = (status: UpdateStatus | null): boolean =>
  status?.problem !== UPDATE_PROBLEMS.unknownInstallation;

let reading = 0;
let subscription = 0;

export async function refreshUpdateStatus(): Promise<void> {
  const own = ++reading;
  try {
    const status = await window.infinitary.update.status();
    if (own === reading) useUpdateState.setState({ status });
  } catch {
    /* An unanswered check never invents an offer. */
  }
}

let pressed: Promise<void> | null = null;

/** Check for updates: a second press joins the check already reading. */
export function checkForUpdates(): Promise<void> {
  if (pressed) return pressed;
  useUpdateState.setState({ checking: true });
  pressed = (async () => {
    const own = ++reading;
    try {
      const status = await window.infinitary.update.check();
      if (own === reading) useUpdateState.setState({ status });
    } catch {
      // An unanswered check never invents an offer, nor says the copy is up to date.
      const previous = useUpdateState.getState().status;
      if (own === reading && previous) {
        const { notice, ...known } = previous;
        useUpdateState.setState({
          status: { ...known, phase: "error", problem: UPDATE_PROBLEMS.checkFailed },
        });
      }
    } finally {
      pressed = null;
      useUpdateState.setState({ checking: false });
    }
  })();
  return pressed;
}

export async function chooseUpdateChannel(channel: UpdateChannel): Promise<void> {
  const own = ++subscription;
  reading++;
  const previous = useUpdateState.getState().status;
  useUpdateState.setState({
    busy: true,
    problem: null,
    status: previous
      ? {
          ...previous,
          channel,
          latestVersion: null,
          updateAvailable: false,
          install: undefined,
          phase: "checking",
          percent: undefined,
          problem: undefined,
          notice: undefined,
        }
      : null,
  });
  try {
    const status = await window.infinitary.update.setChannel(channel);
    if (own === subscription) useUpdateState.setState({ status, busy: false });
  } catch {
    if (own === subscription) {
      useUpdateState.setState({
        status: previous,
        busy: false,
        problem:
          "The update channel could not be changed. Try again after any update has finished.",
      });
      await refreshUpdateStatus();
    }
  }
}

export async function installOfferedUpdate(): Promise<void> {
  const own = subscription;
  useUpdateState.setState({ busy: true, problem: null, later: null });
  const timer = setInterval(() => {
    void refreshUpdateStatus();
  }, 250);
  try {
    const result = await window.infinitary.update.install();
    if (own === subscription && !result.ok)
      useUpdateState.setState(result.later ? { later: UPDATE_LATER } : { problem: result.problem });
  } catch {
    if (own === subscription)
      useUpdateState.setState({
        problem:
          "The update could not be confirmed. Check Version in Settings before trying again.",
      });
  } finally {
    clearInterval(timer);
    if (own === subscription) useUpdateState.setState({ busy: false });
    await refreshUpdateStatus();
  }
}

/**
 * Update later (docs/alpha.md, "Saving work before an update"): lets an
 * update go while it saves the crew's work. The pressed install answers
 * that it waits, and the work carries on.
 */
export async function updateLater(): Promise<void> {
  try {
    const status = await window.infinitary.update.later();
    useUpdateState.setState({ status });
  } catch {
    // The update goes on; the next reading says where it stands.
  }
  await refreshUpdateStatus();
}
