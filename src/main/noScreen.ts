import { COMPUTER, HERE } from "@shared/deviceNames";

/**
 * The window on Linux with no screen (INF-1181): Chromium would stop with
 * "Missing X server or $DISPLAY" and a crash, so the app says in two plain
 * lines that its window needs a screen, and how a computer with none runs
 * work instead - the command from Run a command there (docs/devices.md,
 * "Joining by a command") - then exits 1. The work mode draws on a display
 * of its own and never asks this (docs/helper.md, "No screen needed").
 */
export const NO_SCREEN_WORDS = [
  `Infinitary's window needs a screen, and ${HERE.this} has none.`,
  `To run your first mate's work here, use Run a command there in Devices on your other ${COMPUTER.one}, then run that command here.`,
] as const;

/**
 * Whether the window would start with no screen to draw on: Linux with
 * neither an X nor a Wayland display, and no windowless platform asked for.
 */
export function hasNoScreen(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): boolean {
  if (platform !== "linux") return false;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return false;
  return !argv.includes("--ozone-platform=headless");
}
