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

export function bundleOf(execPath: string): string | null {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (!macos.endsWith("/MacOS") || !contents.endsWith("/Contents") || !bundle.endsWith(".app"))
    return null;
  return bundle;
}

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

/**
 * What a check's hidden launch says in its output before a word it would show the person, the
 * word's own message and detail after it: a launch refused the folder's lock shows its words to no
 * one there (docs/run.md, "Opened while it runs").
 */
export const TOLD_THE_PERSON = "[app] told the person:";

/**
 * How a window launch refused the folder's lock ends, once it read who holds
 * it (`lockHolderKind`): a window's answer wins, even one that came after the
 * holder was read, read again before each step, and so does the person's word
 * to leave a holder that showed nothing open (`left`). A window told only by
 * what it runs as, on a Mac, is a window from before that answer which may
 * have closed its last window and opened none at the ask; macOS cannot be
 * asked to reopen that one process without the person's consent to control
 * the app, and its open of the bundle may reach another copy or start one, so
 * the launch sends nothing and tells the person to click Infinitary in the
 * Dock (`tellDock`) while that holder still holds the folder (`holderAlive`).
 * The word is taken away once a window answers or that holder lets the folder
 * go, and how it ended is read afterwards, as before it: an answer ends the
 * launch; that holder gone with the folder left free starts nothing, so a
 * window quit stays quit; gone with another program on the folder
 * (`occupied`) ends nothing either: `follow`, for the launch to watch that
 * holder as any other. The launch starts again beside a run and on a free
 * folder, and quits otherwise. The holder's kind, for the launch's log.
 */
export async function endRefusedLaunch(options: {
  found: "run" | "free" | "window" | "left";
  answered: () => boolean;
  /** Whether the window told by what it runs as still holds the folder. */
  holderAlive: () => boolean;
  /** Whether a program holds the folder now, or a run notes it does. */
  occupied: () => boolean;
  platform: string;
  tellDock: () => Promise<void>;
  relaunch: () => void;
  quit: () => void;
}): Promise<"run" | "free" | "window" | "follow"> {
  const answeredFirst = options.answered();
  const kind = answeredFirst || options.found === "left" ? "window" : options.found;
  if (
    kind === "window" &&
    options.found !== "left" &&
    !answeredFirst &&
    options.platform === "darwin"
  ) {
    if (options.holderAlive()) await options.tellDock();
    if (!options.answered() && !options.holderAlive() && options.occupied()) return "follow";
  }
  if (kind !== "window" && !options.answered()) options.relaunch();
  options.quit();
  return kind;
}
