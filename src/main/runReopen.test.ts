import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { bundleOf, openWindowOnReopen, reopenOlderWindow } from "./runReopen";

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

// The captain's choice for a launch refused the lock by a Mac window from before windows answered,
// which may have closed its last window: ask it once to reopen, and tell the person to click it in
// the Dock where that is not confirmed.
describe("a launch beside an older Mac window", () => {
  const bundle = bundleOf("/Applications/Infinitary.app/Contents/MacOS/Infinitary");
  const asker = (taken: boolean) => {
    const asked: string[] = [];
    return {
      asked,
      ask: async (to: string) => {
        asked.push(to);
        return taken;
      },
    };
  };

  it("asks the window once to reopen as the Dock does", async () => {
    const macos = asker(true);
    const outcome = await reopenOlderWindow({
      bundle,
      holderAlive: () => true,
      reachedSelf: () => false,
      ask: macos.ask,
    });
    expect(outcome).toBe("asked");
    expect(macos.asked).toEqual(["/Applications/Infinitary.app"]);
  });

  it("is unconfirmed where macOS refuses, the reopen reaches the launch itself, or there is no app to ask", async () => {
    const refused = asker(false);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        reachedSelf: () => false,
        ask: refused.ask,
      }),
    ).toBe("unconfirmed");
    expect(refused.asked).toHaveLength(1);
    const self = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        reachedSelf: () => true,
        ask: self.ask,
      }),
    ).toBe("unconfirmed");
    const none = asker(true);
    expect(
      await reopenOlderWindow({
        bundle: bundleOf("/repo/node_modules/electron/dist/electron"),
        holderAlive: () => true,
        reachedSelf: () => false,
        ask: none.ask,
      }),
    ).toBe("unconfirmed");
    expect(none.asked).toEqual([]);
  });

  it("asks nothing of a window that ended meanwhile", async () => {
    const macos = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => false,
        reachedSelf: () => false,
        ask: macos.ask,
      }),
    ).toBe("gone");
    expect(macos.asked).toEqual([]);
  });
});
