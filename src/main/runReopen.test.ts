import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { holderIsWindow, lockHolderKind } from "./runCommand";
import {
  bundleOf,
  copiesListed,
  endRefusedLaunch,
  openWindowOnReopen,
  reopenOlderWindow,
} from "./runReopen";

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

  // The review of INF-5409: macOS taking the ask confirms no window, so only a window's answer does.
  it("asks the window once to reopen as the Dock does, confirmed only by a window's answer", async () => {
    const macos = asker(true);
    const outcome = await reopenOlderWindow({
      bundle,
      holderAlive: () => true,
      answered: () => false,
      soleRecipient: async () => true,
      ask: macos.ask,
    });
    expect(outcome).toBe("unconfirmed");
    expect(macos.asked).toEqual(["/Applications/Infinitary.app"]);
    const answering = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        answered: () => answering.asked.length > 0,
        soleRecipient: async () => true,
        ask: answering.ask,
      }),
    ).toBe("confirmed");
    expect(answering.asked).toHaveLength(1);
  });

  it("is unconfirmed where macOS refuses with no window's answer, or there is no app to ask", async () => {
    const refused = asker(false);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        answered: () => false,
        soleRecipient: async () => true,
        ask: refused.ask,
      }),
    ).toBe("unconfirmed");
    expect(refused.asked).toHaveLength(1);
    // A window's answer confirms it whatever macOS said of the ask.
    const answeredAnyway = asker(false);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        answered: () => answeredAnyway.asked.length > 0,
        soleRecipient: async () => true,
        ask: answeredAnyway.ask,
      }),
    ).toBe("confirmed");
    const none = asker(true);
    expect(
      await reopenOlderWindow({
        bundle: bundleOf("/repo/node_modules/electron/dist/electron"),
        holderAlive: () => true,
        answered: () => false,
        soleRecipient: async () => true,
        ask: none.ask,
      }),
    ).toBe("unconfirmed");
    expect(none.asked).toEqual([]);
    // A window's answer that came meanwhile wins at every end, with nothing asked of macOS.
    for (const holderAlive of [true, false]) {
      const late = asker(true);
      expect(
        await reopenOlderWindow({
          bundle: bundleOf("/repo/node_modules/electron/dist/electron"),
          holderAlive: () => holderAlive,
          answered: () => true,
          soleRecipient: async () => true,
          ask: late.ask,
        }),
      ).toBe("confirmed");
      expect(late.asked).toEqual([]);
    }
  });

  it("asks nothing of a window that ended meanwhile", async () => {
    const macos = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => false,
        answered: () => false,
        soleRecipient: async () => true,
        ask: macos.ask,
      }),
    ).toBe("gone");
    expect(macos.asked).toEqual([]);
    // One that lets the lock go at the ask, as a window the person quit, leaves the folder to be
    // read afresh rather than a word to click it in the Dock.
    const quitting = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => quitting.asked.length === 0,
        answered: () => false,
        soleRecipient: async () => true,
        ask: quitting.ask,
      }),
    ).toBe("gone");
    expect(quitting.asked).toHaveLength(1);
  });
  // The review of INF-5409: the whole handoff to an older window that answers nothing, whose last
  // window was closed, so the launch's ask opened nothing. The launch tells it by what it runs as,
  // asks it once to reopen through macOS's open, which reaches that window's own reopen handler,
  // and ends without starting again; with no window's answer to confirm it, the person is told to
  // click it in the Dock.
  it("hands a launch to an older window with no window open, which reopens it, and ends", async () => {
    const olderWindow = (opensOnReopen: boolean) => {
      const events = new EventEmitter();
      const windows: string[] = [];
      // Every version opens its window on macOS's reopen; an older one answers no launch's ask.
      events.on("activate", () => windows.push("window"));
      return {
        windows,
        ask: async (to: string) => {
          if (!opensOnReopen) return false;
          expect(to).toBe(bundle);
          events.emit("activate");
          return true;
        },
      };
    };
    const refusedLaunch = async (
      older: ReturnType<typeof olderWindow>,
      alive = true,
      replaced = false,
    ) => {
      const ended: string[] = [];
      // The holder told to be a window is the one asked to reopen.
      let classified: number | undefined;
      const found = await lockHolderKind({
        running: () => false,
        answered: () => false,
        holder: () => 4242,
        asked: 4242,
        windowHolder: (holder) =>
          holderIsWindow(holder, {
            words: async () => ({
              words: ["/Applications/Infinitary.app/Contents/MacOS/Infinitary"],
              exact: false,
            }),
          }),
        lockFree: () => false,
        readEveryMs: 50,
        everyMs: 10,
        onWindow: (holder) => {
          classified = holder;
        },
      });
      expect(classified).toBe(4242);
      const kind = await endRefusedLaunch({
        found,
        answered: () => false,
        occupied: () => replaced,
        platform: "darwin",
        reopen: () =>
          reopenOlderWindow({
            bundle,
            holderAlive: () => alive && classified === 4242,
            answered: () => false,
            soleRecipient: async () => true,
            ask: older.ask,
          }),
        tellDock: async () => {
          ended.push("told to click it in the Dock");
        },
        relaunch: () => ended.push("started again"),
        quit: () => ended.push("quit"),
      });
      return { kind, ended };
    };

    const reopening = olderWindow(true);
    expect(await refusedLaunch(reopening)).toEqual({
      kind: "window",
      ended: ["told to click it in the Dock", "quit"],
    });
    expect(reopening.windows).toEqual(["window"]);

    const refusing = olderWindow(false);
    expect(await refusedLaunch(refusing)).toEqual({
      kind: "window",
      ended: ["told to click it in the Dock", "quit"],
    });
    expect(refusing.windows).toEqual([]);

    // The window ended meanwhile, as one the person quit: nothing asked, nothing started, so a
    // window quit stays quit; only a run that took the folder meanwhile has the launch start again.
    const ended = olderWindow(true);
    expect(await refusedLaunch(ended, false)).toEqual({ kind: "window", ended: ["quit"] });
    expect(ended.windows).toEqual([]);
    // Another program took the folder meanwhile, a run or one not yet told apart: the launch ends
    // nothing and starts nothing, but watches that holder as any other.
    const replacedBy = olderWindow(true);
    expect(await refusedLaunch(replacedBy, false, true)).toEqual({ kind: "follow", ended: [] });
    expect(replacedBy.windows).toEqual([]);
  });

  // The review of INF-5409: macOS's open reaches a running copy of the bundle, not one process of
  // several, so with another copy running besides the holder and this launch it is not asked at
  // all, and the person is told to click it in the Dock.
  it("asks macOS only while the holder is the one copy besides the launch", async () => {
    const macos = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => true,
        answered: () => false,
        soleRecipient: async () => false,
        ask: macos.ask,
      }),
    ).toBe("unconfirmed");
    expect(macos.asked).toEqual([]);
    // The holder quits while the copies are read: nothing asked, the folder read afresh.
    let alive = true;
    const quitting = asker(true);
    expect(
      await reopenOlderWindow({
        bundle,
        holderAlive: () => alive,
        answered: () => false,
        soleRecipient: async () => {
          alive = false;
          return true;
        },
        ask: quitting.ask,
      }),
    ).toBe("gone");
    expect(quitting.asked).toEqual([]);
  });

  it("lists this program's own copies by what a Mac's process list shows", () => {
    const exe = "/Applications/Infinitary.app/Contents/MacOS/Infinitary";
    const listed = [
      `  412 ${exe}`,
      `30117 ${exe} --user-data-dir=/Users/a/Library/Application Support/infinitary`,
      `30118 /Applications/Infinitary.app/Contents/Frameworks/Infinitary Helper (GPU).app/Contents/MacOS/Infinitary Helper (GPU) --type=gpu-process`,
      `30200 ${exe}Other`,
      ` 9001 /bin/zsh -c ${exe}`,
      "",
    ].join("\n");
    expect(copiesListed(listed, exe)).toEqual([412, 30117]);
  });

  it("ends as a window answered or the person chose, whatever was read before", async () => {
    const end = async (
      found: "run" | "free" | "window" | "left",
      answered: boolean,
      answersLater = false,
    ) => {
      const ended: string[] = [];
      let looks = 0;
      const kind = await endRefusedLaunch({
        found,
        // An answer that comes after the first look, as one written while the launch decides.
        answered: () => answered || (answersLater && looks++ > 0),
        occupied: () => false,
        platform: "darwin",
        reopen: async () => {
          ended.push("asked to reopen");
          return "confirmed";
        },
        tellDock: async () => {
          ended.push("told to click it in the Dock");
        },
        relaunch: () => ended.push("started again"),
        quit: () => ended.push("quit"),
      });
      return { kind, ended };
    };
    // A window that answered after a run was read, and quit: the launch does not start it again.
    expect(await end("run", true)).toEqual({ kind: "window", ended: ["quit"] });
    expect(await end("free", true)).toEqual({ kind: "window", ended: ["quit"] });
    // The person left a holder that showed nothing open: nothing asked, nothing started.
    expect(await end("left", false)).toEqual({ kind: "window", ended: ["quit"] });
    expect(await end("run", false)).toEqual({ kind: "run", ended: ["started again", "quit"] });
    // A window that answers while the launch decides, before it starts again or tells the person
    // to click it in the Dock, wins as one that answered first.
    expect(await end("run", false, true)).toEqual({ kind: "run", ended: ["quit"] });
    expect(await end("free", false, true)).toEqual({ kind: "free", ended: ["quit"] });
    expect(await end("free", false)).toEqual({ kind: "free", ended: ["started again", "quit"] });
    // An answer once the reopen came back unconfirmed: the person is told nothing of the Dock.
    const ended: string[] = [];
    let reopened = false;
    await endRefusedLaunch({
      found: "window",
      answered: () => reopened,
      occupied: () => false,
      platform: "darwin",
      reopen: async () => {
        reopened = true;
        return "unconfirmed";
      },
      tellDock: async () => {
        ended.push("told to click it in the Dock");
      },
      relaunch: () => ended.push("started again"),
      quit: () => ended.push("quit"),
    });
    expect(ended).toEqual(["quit"]);
  });
});
