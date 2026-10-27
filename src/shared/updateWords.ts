export const UPDATE_WORDS = {
  channel: "Update channel",
  restart: "Update and restart",
  ready: "Restart",
  release: "View release",
  downloading: "Downloading…",
  installing: "Installing…",
  progress: "Download progress",
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
} as const;
