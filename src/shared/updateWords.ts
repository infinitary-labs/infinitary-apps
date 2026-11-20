export const UPDATE_WORDS = {
  channel: "Update channel",
  restart: "Update and restart",
  ready: "Restart",
  release: "View release",
  downloading: "Downloading…",
  installing: "Installing…",
  progress: "Download progress",
  check: "Check for updates",
  /** The next step after a failed check or a failed install that can pass on a retry. */
  retry: "Try again",
  /** The main step once the app cannot update this copy itself. */
  releasesPage: "Open the releases page",
  copy: "Copy command",
  copied: "Copied",
  checkingButton: "Checking…",
  checking: "Checking for updates…",
  later: "Update later",
  saving: "Saving work…",
  updating: "Updating…",
} as const;

/**
 * What Update later answers when it let an update go (docs/alpha.md,
 * "Saving work before an update"): nothing went wrong.
 */
export const UPDATE_LATER = "The update waits until you choose it again. Your work carries on.";

/**
 * How a crewmate's turn an update stopped opens again, naming the computer
 * that was updated when it is not this one (docs/alpha.md, "Saving work
 * before an update"); a scripted stand-in recognizes it by it.
 */
export function updateResumedWords(computer?: string): string {
  return `Your last turn stopped part way while Infinitary${computer ? ` on ${computer}` : ""} was updated; it is back now.`;
}

/** The crew's work around this computer's own update, in the update notice and on the Version row. */
export const UPDATE_WORK_WORDS = {
  saving: "Saving work before the update. Running work finishes first, so nothing is lost.",
  waitingFor: (task: string) => `Waiting for “${task}” to finish what it is running.`,
  updating: "Updating. Infinitary checks the new copy and restarts.",
  resuming: (count: number) =>
    count === 1
      ? "Resuming work the update paused."
      : `Resuming work the update paused, for ${count} tasks.`,
} as const;

/** Each channel's name, as the Update channel row and the up-to-date line say it. */
export const UPDATE_CHANNEL_NAMES = { stable: "Stable", alpha: "Alpha" } as const;

/** What the last check found, in the update row and notice (docs/alpha.md "Update channels"). */
export const UPDATE_NOTICES = {
  none: "No release is available on this channel yet.",
  ahead:
    "This copy is ahead of this channel. It will wait for a newer release, without downgrading.",
  latest: (channel: keyof typeof UPDATE_CHANNEL_NAMES) =>
    `Up to date on ${UPDATE_CHANNEL_NAMES[channel]}.`,
  available: (version: string) => `Version ${version} is available.`,
  /** After a failed check or install: the version the last read found still installs. */
  stillAvailable: (version: string) => `Version ${version} is still available.`,
} as const;

/**
 * The update row's and notice's words for each state of the ladder
 * (src/renderer/src/app/updateStep.ts), beside the step's button.
 */
export const UPDATE_STEP_WORDS = {
  /** When the release source last answered: "Checked just now.", "Checked 5m ago." */
  checked: (age: string) => (age === "now" ? "Checked just now." : `Checked ${age} ago.`),
  restarts: "Update and restart saves running work first.",
  asksPassword: "Install asks for your password, then Infinitary starts again.",
  replaces: "Install replaces this copy, then Infinitary starts again.",
  command: "Run this command to update:",
  downloading: (version: string) => `Downloading ${version}`,
  ready: "The update is ready. Restart to finish installing it.",
  /** A failed channel change, the one problem the Update channel row shows. */
  channelFailed:
    "The update channel could not be changed. Try again after any update has finished.",
  unconfirmed: "The update could not be confirmed. Check Version in Settings before trying again.",
} as const;

export const UPDATE_PROBLEMS = {
  installation:
    "In-app updates are only for copies installed from the disk image. Keep Homebrew copies updated through Homebrew.",
  unknownInstallation:
    "Infinitary could not confirm how this copy was installed. Reinstall it from the releases page, keeping your saved work.",
  unwritable:
    "Infinitary cannot replace this copy. Ask an administrator to install the new disk image, keeping your saved work.",
  staged:
    "The update is ready, but Infinitary could not finish restarting. Try restarting again after your running work stops.",
  checkFailed: "Updates could not be checked.",
} as const;
