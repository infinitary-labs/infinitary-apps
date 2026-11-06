import { feedRelativeAge } from "@shared/relativeAge";
import { checksUpdates, type UpdateStatus } from "@shared/update";
import {
  UPDATE_NOTICES,
  UPDATE_PROBLEMS,
  UPDATE_STEP_WORDS,
  UPDATE_WORDS,
  UPDATE_WORK_WORDS,
} from "@shared/updateWords";

/**
 * The update ladder (docs/alpha.md "Update channels"): for every state of
 * this copy's update, the line that says where it stands and the button
 * that takes the next step, with at most one more control beside it. The
 * Version row in Settings → General and the top-right update notice both
 * draw it (UpdateStepView.tsx), so the words and the button sit together and
 * agree wherever a person looks. It reads only the typed status the core
 * sends and what this window pressed.
 */

/** What a step's button does: each runs one existing update request. */
export type UpdateStepAction = "check" | "install" | "release" | "copy" | "later";

export type UpdateStepButton = {
  action: UpdateStepAction;
  label: string;
  /** The button reads this, unavailable, while its request runs. */
  pending?: string;
  disabled?: boolean;
};

export type UpdateStep = {
  /** A stable name for the state, for tests and the row's hook. */
  state:
    | "current"
    | "checking"
    | "check-failed"
    | "available"
    | "command"
    | "downloading"
    | "saving"
    | "updating"
    | "ready"
    | "retry"
    | "blocked"
    | "unknown"
    | "resuming";
  /** Where the update stands, or null when nothing has been read yet. */
  line: string | null;
  /** A problem reads as an alert, everything else as a status. */
  problem: boolean;
  primary: UpdateStepButton;
  secondary?: UpdateStepButton;
  /** Saving work: each task whose running work the update waits for. */
  waiting?: string[];
  /** Downloading: how far, out of 100. */
  percent?: number;
  /** The command that installs the offered version by hand, selectable. */
  command?: string;
};

/** What this window pressed, beside the status the core sends. */
export type UpdateStepPresses = {
  /** A pressed Check for updates is reading. */
  checking: boolean;
  /** An install or a channel change is running. */
  busy: boolean;
  /** What the last pressed install answered, when it did not finish. */
  problem: string | null;
  /** Update later let the last update go. */
  later: string | null;
  now: number;
};

const releasesPage: UpdateStepButton = { action: "release", label: UPDATE_WORDS.releasesPage };
const viewRelease: UpdateStepButton = { action: "release", label: UPDATE_WORDS.release };

/** The step for this status, or null before the first status arrives. */
export function updateStep(
  status: UpdateStatus | null,
  pressed: UpdateStepPresses,
): UpdateStep | null {
  if (!status) return null;
  if (!checksUpdates(status))
    return { state: "unknown", line: status.problem ?? null, problem: true, primary: releasesPage };
  const install = status.install;
  const installLabel = install?.restarts ? UPDATE_WORDS.restart : "Install";
  if (status.work?.state === "saving")
    return {
      state: "saving",
      line: UPDATE_WORK_WORDS.saving,
      problem: false,
      waiting: status.work.tasks,
      primary: { action: "install", label: installLabel, pending: UPDATE_WORDS.saving },
      secondary: { action: "later", label: UPDATE_WORDS.later },
    };
  if (status.work?.state === "resuming")
    return {
      state: "resuming",
      line: UPDATE_WORK_WORDS.resuming(status.work.tasks.length),
      problem: false,
      primary: { action: "check", label: UPDATE_WORDS.check, disabled: true },
    };
  if (status.phase === "installing")
    return {
      state: "updating",
      line: UPDATE_WORK_WORDS.updating,
      problem: false,
      primary: { action: "install", label: installLabel, pending: UPDATE_WORDS.updating },
    };
  if (status.phase === "downloading")
    return {
      state: "downloading",
      line: UPDATE_STEP_WORDS.downloading(status.latestVersion ?? ""),
      problem: false,
      percent: status.percent ?? 0,
      primary: { action: "install", label: installLabel, pending: UPDATE_WORDS.downloading },
    };
  const problem = pressed.problem ?? status.problem ?? null;
  if (status.phase === "ready")
    return {
      state: "ready",
      line: problem ?? UPDATE_STEP_WORDS.ready,
      problem: problem !== null,
      primary: {
        action: "install",
        label: UPDATE_WORDS.ready,
        ...(pressed.busy ? { pending: UPDATE_WORDS.installing } : {}),
      },
    };
  if (pressed.checking || status.phase === "checking")
    return {
      state: "checking",
      line: UPDATE_WORDS.checking,
      problem: false,
      // A press while one reads joins it; the button keeps its place and focus.
      primary: { action: "check", label: UPDATE_WORDS.checkingButton, disabled: pressed.busy },
    };
  if (status.problem === UPDATE_PROBLEMS.checkFailed)
    return {
      state: "check-failed",
      line: UPDATE_PROBLEMS.checkFailed,
      problem: true,
      primary: { action: "check", label: UPDATE_WORDS.retry, disabled: pressed.busy },
      secondary: releasesPage,
    };
  if (status.updateAvailable && status.latestVersion) {
    const available = UPDATE_NOTICES.available(status.latestVersion);
    if (problem !== null)
      // The app installs it here and the failure can pass on a retry; with no
      // way to install it here, the releases page is the way on.
      return install
        ? {
            state: "retry",
            line: problem,
            problem: true,
            ...(status.upgradeCommand ? { command: status.upgradeCommand } : {}),
            primary: {
              action: "install",
              label: UPDATE_WORDS.retry,
              ...(pressed.busy ? { pending: UPDATE_WORDS.installing } : {}),
            },
            secondary: viewRelease,
          }
        : { state: "blocked", line: problem, problem: true, primary: releasesPage };
    if (install)
      return {
        state: "available",
        line:
          pressed.later ??
          `${available} ${
            install.restarts
              ? UPDATE_STEP_WORDS.restarts
              : install.asksPassword
                ? UPDATE_STEP_WORDS.asksPassword
                : UPDATE_STEP_WORDS.replaces
          }`,
        problem: false,
        primary: {
          action: "install",
          label: installLabel,
          ...(pressed.busy ? { pending: UPDATE_WORDS.installing } : {}),
        },
        secondary: viewRelease,
      };
    if (status.upgradeCommand)
      return {
        state: "command",
        line: `${available} ${UPDATE_STEP_WORDS.command}`,
        problem: false,
        command: status.upgradeCommand,
        primary: { action: "copy", label: UPDATE_WORDS.copy },
        secondary: viewRelease,
      };
    return { state: "available", line: available, problem: false, primary: viewRelease };
  }
  const checked =
    status.checkedAt === undefined
      ? null
      : UPDATE_STEP_WORDS.checked(feedRelativeAge(status.checkedAt, pressed.now));
  const found = status.notice ?? null;
  return {
    state: "current",
    line: status.problem ?? (found && checked ? `${found} ${checked}` : found),
    problem: status.problem !== undefined,
    primary: { action: "check", label: UPDATE_WORDS.check, disabled: pressed.busy },
  };
}
