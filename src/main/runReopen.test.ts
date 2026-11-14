import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openWindowOnReopen } from "./runReopen";

/**
 * The captain's words on INF-4113: "The real fix: the background program
 * should open a window when you click the app." A click while only the run
 * runs reaches the run as macOS's reopen, which Electron calls `activate`.
 * Data: the installed app's own executable path and a development run's.
 */

const INSTALLED = "/Applications/Infinitary.app/Contents/MacOS/Infinitary";

function runApp() {
  const events = new EventEmitter();
  const policies: string[] = [];
  const opened: { bundle: string; args: readonly string[] }[] = [];
  const app = {
    on: (event: "activate", listener: () => void) => events.on(event, listener),
    setActivationPolicy: (policy: "prohibited") => {
      policies.push(policy);
    },
  };
  return {
    app,
    events,
    policies,
    opened,
    open: (bundle: string, args: readonly string[]) => opened.push({ bundle, args }),
  };
}

describe("the run opened from the Dock", () => {
  it("opens the app's window as a new copy and stays in the background on each click", () => {
    const run = runApp();
    openWindowOnReopen({ app: run.app, execPath: INSTALLED, args: [], open: run.open });
    expect(run.opened).toEqual([]);
    run.events.emit("activate");
    expect(run.opened).toEqual([{ bundle: "/Applications/Infinitary.app", args: [] }]);
    expect(run.policies).toEqual(["prohibited"]);
    // A later click, after that window was quit, opens one again.
    run.events.emit("activate");
    expect(run.opened).toHaveLength(2);
  });

  it("starts a development run's app folder in Electron's own bundle", () => {
    const run = runApp();
    const electron =
      "/src/infinitary/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
    openWindowOnReopen({
      app: run.app,
      execPath: electron,
      args: ["/src/infinitary"],
      open: run.open,
    });
    run.events.emit("activate");
    expect(run.opened).toEqual([
      {
        bundle: "/src/infinitary/node_modules/electron/dist/Electron.app",
        args: ["/src/infinitary"],
      },
    ]);
  });
});
