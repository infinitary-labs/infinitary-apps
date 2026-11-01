export const UPDATE_WORDS = {
  channel: "Update channel",
  restart: "Update and restart",
  ready: "Restart",
  release: "View release",
  downloading: "Downloading…",
  installing: "Installing…",
  progress: "Download progress",
  check: "Check for updates",
  checkingButton: "Checking…",
  checking: "Checking for updates…",
  show: "Show update",
} as const;

/** What the last check found, on the Version row in Settings (docs/alpha.md "Update channels"). */
export const UPDATE_NOTICES = {
  none: "No release is available on this channel yet.",
  ahead:
    "This copy is ahead of this channel. It will wait for a newer release, without downgrading.",
  latest: "You have the latest release on this channel.",
  available: (version: string) => `Version ${version} is available.`,
} as const;

export const UPDATE_PROBLEMS = {
  installation:
    "In-app updates are only for copies installed from the disk image. Keep Homebrew copies updated through Homebrew.",
  unknownInstallation:
    "Infinitary could not confirm how this copy was installed. Reinstall it using Homebrew or the disk image, keeping your saved work.",
  unwritable:
    "Infinitary cannot replace this copy. Ask an administrator to install the new disk image, keeping your saved work.",
  staged:
    "The update is ready, but Infinitary could not finish restarting. Try restarting again after your running work stops.",
  checkFailed: "Updates could not be checked. Try again, or open the releases page.",
} as const;
