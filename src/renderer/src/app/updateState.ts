import type { UpdateChannel, UpdateStatus } from "@shared/update";
import { create } from "zustand";

type State = {
  status: UpdateStatus | null;
  busy: boolean;
  problem: string | null;
  noticeOpen: boolean;
};
export const useUpdateState = create<State>(() => ({
  status: null,
  busy: false,
  problem: null,
  noticeOpen: false,
}));
export function setUpdateNoticeOpen(next: boolean | ((open: boolean) => boolean)): void {
  useUpdateState.setState((state) => ({
    noticeOpen: typeof next === "function" ? next(state.noticeOpen) : next,
  }));
}
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
  useUpdateState.setState({ busy: true, problem: null });
  const timer = setInterval(() => {
    void refreshUpdateStatus();
  }, 250);
  try {
    const result = await window.infinitary.update.install();
    if (own === subscription && !result.ok) useUpdateState.setState({ problem: result.problem });
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
