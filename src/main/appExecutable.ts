import { basename, dirname, join } from "node:path";

/**
 * The background file's name beside a Mac app's main executable
 * (scripts/mac-app-launcher.m, BACKGROUND_SUFFIX; docs/run.md, "Opened while
 * it runs"). Every start of a packaged Mac app that shows no window runs from
 * `Contents/MacOS/<name> Background`, so macOS never hands it a click on the
 * app.
 */
export const MAC_BACKGROUND_SUFFIX = " Background";

/**
 * The app's own program for a process that runs `execPath`: a Mac app's
 * background file reads as the main executable beside it, which is what a
 * start of the app names - at login, for another user, after an update - and
 * which starts each copy from its own file. Anything else is its own program.
 */
export function appExecutable(execPath: string, platform: NodeJS.Platform): string {
  if (platform !== "darwin" || !execPath.endsWith(MAC_BACKGROUND_SUFFIX)) return execPath;
  const folder = dirname(execPath);
  const main = basename(execPath).slice(0, -MAC_BACKGROUND_SUFFIX.length);
  return basename(folder) === "MacOS" && main ? join(folder, main) : execPath;
}
