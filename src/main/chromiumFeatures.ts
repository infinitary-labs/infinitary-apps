/** The part of Electron's `app.commandLine` this module needs. */
export type ChromiumCommandLine = {
  getSwitchValue: (name: string) => string;
  appendSwitch: (name: string, value?: string) => void;
};

/**
 * Chromium features the app never uses and turns off before it is ready.
 *
 * `DIPS` is Chromium's bounce-tracking mitigation (renamed BTM in its code,
 * still DIPS on the command line). It keeps a SQLite store in every profile
 * and opens it on a lowest-priority worker thread, and a task that has
 * started there must finish before the process may exit. When the Mac is
 * loaded that thread is the last to run, so a quit that had already done
 * all of its own work stayed alive for seconds - twenty and more in the
 * e2e suite, where the launch helper then killed it. The app is not a web
 * browser that tracks bounces, and a task browser's site data already goes
 * when it closes, so the store buys nothing.
 */
export const DISABLED_CHROMIUM_FEATURES: readonly string[] = ["DIPS"];

/**
 * Adds features to `--disable-features` and keeps the ones already there.
 * Chromium holds one value per switch, the last one written, so a plain
 * append would drop a list set before the app's code ran: a person's own
 * launch flag, or the one Playwright's loader sets in e2e.
 */
export function disableChromiumFeatures(
  commandLine: ChromiumCommandLine,
  features: readonly string[] = DISABLED_CHROMIUM_FEATURES,
): void {
  const current = commandLine
    .getSwitchValue("disable-features")
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
  const added = features.filter((feature) => !current.includes(feature));
  if (added.length === 0) return;
  commandLine.appendSwitch("disable-features", [...current, ...added].join(","));
}
