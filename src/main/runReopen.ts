import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";

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

/** macOS's own open, asking the running app at `bundle` to reopen as a click in the Dock does; whether macOS took it. */
export function askReopen(bundle: string): Promise<boolean> {
  return new Promise((done) =>
    execFile(
      "/usr/bin/open",
      ["-a", bundle],
      { env: hostEnv(), timeout: RESOURCE_READ_TIMEOUT_MS },
      (error) => done(!error),
    ),
  );
}

/**
 * A launch refused the folder's lock by a window from before the launch's
 * ask had an answer, told only by what it runs as (`holderIsWindow`), on a
 * Mac (docs/run.md, "Opened while it runs"): that older window brings itself
 * forward on the ask while it has a window, but one whose last window was
 * closed keeps running in the Dock and opens nothing. The launch asks it
 * once to reopen, as a click in the Dock does, through macOS's own open
 * (`askReopen`), which every version opens its window on. `asked` once macOS
 * took the ask; `gone` where the window ended meanwhile, so nothing is
 * asked and the folder may be free; `unconfirmed` where it cannot be asked,
 * macOS refused it, or it reached this launch instead (`reachedSelf`), for
 * the launch to tell the person to click Infinitary in the Dock.
 */
export async function reopenOlderWindow(options: {
  bundle: string | null;
  holderAlive: () => boolean;
  reachedSelf: () => boolean;
  ask?: (bundle: string) => Promise<boolean>;
}): Promise<"asked" | "gone" | "unconfirmed"> {
  if (!options.holderAlive()) return "gone";
  if (options.bundle === null) return "unconfirmed";
  const taken = await (options.ask ?? askReopen)(options.bundle);
  return taken && !options.reachedSelf() ? "asked" : "unconfirmed";
}

/**
 * How a window launch refused the folder's lock ends, once it read who holds
 * it (`lockHolderKind`): a window's answer wins, even one that came after the
 * holder was read, and so does the person's word to leave a holder that
 * showed nothing open (`left`). A window told only by what it runs as, on a
 * Mac, is asked once to reopen (`reopenOlderWindow`), and the person is told
 * to click it in the Dock where that is not confirmed. The launch starts
 * again beside a run, on a free folder, or where that window ended
 * meanwhile, and quits either way. The holder's kind, for the launch's log.
 */
export async function endRefusedLaunch(options: {
  found: "run" | "free" | "window" | "left";
  answered: boolean;
  platform: string;
  reopen: () => Promise<"asked" | "gone" | "unconfirmed">;
  tellDock: () => Promise<void>;
  relaunch: () => void;
  quit: () => void;
}): Promise<"run" | "free" | "window"> {
  const kind = options.answered || options.found === "left" ? "window" : options.found;
  const reopened =
    kind === "window" &&
    options.found !== "left" &&
    !options.answered &&
    options.platform === "darwin"
      ? await options.reopen()
      : null;
  if (reopened === "unconfirmed") await options.tellDock();
  if (kind !== "window" || reopened === "gone") options.relaunch();
  options.quit();
  return kind;
}
