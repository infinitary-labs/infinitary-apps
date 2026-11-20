import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { hostEnv } from "@core/hostEnv";

/**
 * Clicking Infinitary while only its command runs (docs/run.md, "Opened
 * while it runs"; INF-4113 reproduced it). A packaged Mac app's command runs
 * from its own file inside the app (scripts/mac-app-launcher.m), where macOS
 * never hands it a click. One that runs from the app's main executable - a
 * development run, or one whose move to that file failed - is listed under
 * the app itself, so a click in the Dock, Spotlight or Finder, and `open -a`,
 * reach the command instead of starting the app: macOS sends it the reopen
 * Electron calls `activate` and brings it to the front with a bare app menu.
 * The command has no window to show, so it puts itself back in the
 * background and opens the app beside itself as a new copy, through macOS's
 * own open, which starts it as any launch does; that copy joins the command
 * as the window does at any launch.
 */

/** What the command needs of Electron's app. */
export type ReopenedApp = {
  on: (event: "activate", listener: () => void) => unknown;
  setActivationPolicy: (policy: "prohibited") => void;
};

/** The `.app` folder an executable inside `Contents/MacOS` belongs to, or null outside one. */
export function bundleOf(execPath: string): string | null {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (!macos.endsWith("/MacOS") || !contents.endsWith("/Contents") || !bundle.endsWith(".app"))
    return null;
  return bundle;
}

/** macOS's own open, starting `bundle` as a new copy with `args` after it. */
export function openNewCopy(bundle: string, args: readonly string[]): void {
  execFile(
    "/usr/bin/open",
    ["-n", bundle, ...(args.length ? ["--args", ...args] : [])],
    { env: hostEnv() },
    (error) => {
      if (error) console.warn(`[run] could not open the window: ${error.message}`);
    },
  );
}

/**
 * Each reopen of the command opens the app's window beside it. `args` are
 * what the window's copy needs to start this app: none for an installed
 * app, the app's folder for a development run of Electron.
 */
export function openWindowOnReopen(options: {
  app: ReopenedApp;
  execPath: string;
  args: readonly string[];
  open?: (bundle: string, args: readonly string[]) => void;
}): void {
  const bundle = bundleOf(options.execPath);
  if (!bundle) return;
  const open = options.open ?? openNewCopy;
  options.app.on("activate", () => {
    // macOS made the command a front app on the reopen: background-only again, with no menu.
    options.app.setActivationPolicy("prohibited");
    open(bundle, options.args);
  });
}
