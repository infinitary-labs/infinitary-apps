import { checksUpdates, type UpdateChannel, type UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_PROBLEMS, UPDATE_STEP_WORDS } from "@shared/updateWords";
import { create } from "zustand";

type State = {
  status: UpdateStatus | null;
  busy: boolean;
  /** A pressed Check for updates is reading. */
  checking: boolean;
  /** What the last pressed install answered, when it did not finish. */
  problem: string | null;
  /** A failed channel change: the one problem the Update channel row shows. */
  channelProblem: string | null;
  /** Update later let the last update go: it waits, and the work carries on. */
  later: string | null;
  noticeOpen: boolean;
};
export const useUpdateState = create<State>(() => ({
  status: null,
  busy: false,
  checking: false,
  problem: null,
  channelProblem: null,
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

export { checksUpdates };

let reading = 0;
let subscription = 0;
let pressed: Promise<void> | null = null;

export async function refreshUpdateStatus(): Promise<void> {
  // A pressed check is reading now, so its answer is newer than this one: Check for
  // updates from command search opens the Version row, whose own read starts after it.
  if (pressed) return;
  const own = ++reading;
  try {
    const status = await window.infinitary.update.status();
    if (own !== reading) return;
    const before = useUpdateState.getState().status;
    useUpdateState.setState({ status });
    // A view's update can start before this window listens for its push, as when a
    // command-started first mate opens it to install: the first reading naming who asked opens the notice.
    if (status.askedFrom && !before?.askedFrom) followAskedUpdate();
  } catch {
    /* An unanswered check never invents an offer. */
  }
}

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
    channelProblem: null,
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
        channelProblem: UPDATE_STEP_WORDS.channelFailed,
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
        problem: UPDATE_STEP_WORDS.unconfirmed,
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

let following: ReturnType<typeof setInterval> | null = null;

/**
 * A paired phone or Mac started this computer's update (`inf:update:asked`,
 * docs/view.md, "Updating the first mate's computer"): the notice opens and
 * follows it, saying who asked, so someone here can still choose Update
 * later. It reads until the update under way no longer names that view.
 */
export function followAskedUpdate(): void {
  setUpdateNoticeOpen(true);
  if (following) return;
  let readings = 0;
  following = setInterval(() => {
    void refreshUpdateStatus().then(() => {
      readings++;
      const status = useUpdateState.getState().status;
      // The first readings may come before the update says who asked.
      if (readings > 4 && !status?.askedFrom && following) {
        clearInterval(following);
        following = null;
      }
    });
  }, 500);
}
