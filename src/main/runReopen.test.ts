import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { holderIsWindow, lockHolderKind } from "./runCommand";
import { endRefusedLaunch, openWindowOnReopen, tellThePerson } from "./runReopen";

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
// which may have closed its last window: tell the person to click it in the Dock where no window's
// answer confirms it. macOS cannot be asked to reopen that one process without the person's consent
// to control the app, so the launch sends it nothing.
describe("a launch beside an older Mac window", () => {
  // The review of INF-5409: the whole handoff to an older window that answers nothing, whose last
  // window was closed, so the launch's ask opened nothing. The launch tells it by what it runs as,
  // sends it nothing, and ends without starting again, with the person told to click it in the
  // Dock; a holder that let the folder go before or while the word is up is read afresh.
  it("tells the person to click an older window in the Dock and reads how the word ended", async () => {
    const refusedLaunch = async (state: {
      alive: boolean;
      occupied?: boolean;
      // What happens while the word is up: the holder quits, another takes the folder, a window answers.
      meanwhile?: { alive?: boolean; occupied?: boolean; answered?: boolean };
    }) => {
      const ended: string[] = [];
      let classified: number | undefined;
      let answered = false;
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
      if (found === "stopped") throw new Error("the watch was not ended");
      const kind = await endRefusedLaunch({
        found,
        answered: () => answered,
        holderAlive: () => state.alive && classified === 4242,
        occupied: () => state.occupied === true,
        platform: "darwin",
        tellDock: async () => {
          ended.push("told to click it in the Dock");
          const then = state.meanwhile ?? {};
          if (then.alive !== undefined) state.alive = then.alive;
          if (then.occupied !== undefined) state.occupied = then.occupied;
          if (then.answered) answered = true;
        },
        relaunch: () => ended.push("started again"),
        quit: () => ended.push("quit"),
      });
      return { kind, ended };
    };

    expect(await refusedLaunch({ alive: true, occupied: true })).toEqual({
      kind: "window",
      ended: ["told to click it in the Dock", "quit"],
    });
    // The window ended first, as one the person quit: nothing told, nothing started, so a window
    // quit stays quit.
    expect(await refusedLaunch({ alive: false })).toEqual({ kind: "window", ended: ["quit"] });
    // Another program took the folder first, a run or one not yet told apart: the launch ends
    // nothing and starts nothing, but watches that holder as any other.
    expect(await refusedLaunch({ alive: false, occupied: true })).toEqual({
      kind: "follow",
      ended: [],
    });
    // While the word is up: the holder quit and left the folder free, which stays free.
    expect(
      await refusedLaunch({
        alive: true,
        occupied: true,
        meanwhile: { alive: false, occupied: false },
      }),
    ).toEqual({ kind: "window", ended: ["told to click it in the Dock", "quit"] });
    // The holder was replaced while the word was up: the replacement is watched, not left.
    expect(
      await refusedLaunch({ alive: true, occupied: true, meanwhile: { alive: false } }),
    ).toEqual({ kind: "follow", ended: ["told to click it in the Dock"] });
    // A window answered while the word was up, then quit and another took the folder: it answered.
    expect(
      await refusedLaunch({
        alive: true,
        occupied: true,
        meanwhile: { alive: false, answered: true },
      }),
    ).toEqual({ kind: "window", ended: ["told to click it in the Dock", "quit"] });
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
        holderAlive: () => true,
        occupied: () => true,
        platform: "darwin",
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
    expect(await end("window", true)).toEqual({ kind: "window", ended: ["quit"] });
    // The person left a holder that showed nothing open: nothing told, nothing started.
    expect(await end("left", false)).toEqual({ kind: "window", ended: ["quit"] });
    expect(await end("run", false)).toEqual({ kind: "run", ended: ["started again", "quit"] });
    // A window that answers while the launch decides, before it starts again, wins as one that
    // answered first.
    expect(await end("run", false, true)).toEqual({ kind: "run", ended: ["quit"] });
    expect(await end("free", false, true)).toEqual({ kind: "free", ended: ["quit"] });
    expect(await end("free", false)).toEqual({ kind: "free", ended: ["started again", "quit"] });
  });
});

// The review of INF-5409: a word the launch takes away before it is shown, as the question once
// the holder was told apart, takes no window, no focus and shows nothing.
describe("a word to the person", () => {
  type Box = { message: string; signal?: AbortSignal; cancelId?: number };
  const person = (options: { hidden?: boolean; fails?: boolean; whileMade?: () => void } = {}) => {
    const done: string[] = [];
    return {
      done,
      words: {
        ready: async () => {
          done.push("ready");
        },
        hidden: options.hidden ?? false,
        say: (box: Box) => done.push(`said ${box.message}`),
        parent: (box: Box) => {
          if (!box.signal) return null;
          done.push("window made");
          options.whileMade?.();
          return { destroy: () => done.push("window gone") };
        },
        focus: () => done.push("focused"),
        show: async (box: Box) => {
          if (options.fails) throw new Error("no box");
          done.push(`shown ${box.message}`);
          return 1;
        },
      },
    };
  };

  it("makes nothing for a word taken away before it is shown, and shows one still wanted", async () => {
    const taken = new AbortController();
    const before = person();
    // Taken away while Electron was getting ready.
    const late = tellThePerson(() => ({ message: "Leave it?", signal: taken.signal }), {
      ...before.words,
      ready: async () => {
        taken.abort();
      },
    });
    expect(await late).toBeNull();
    expect(before.done).toEqual([]);
    expect(await tellThePerson(() => null, before.words)).toBeNull();
    expect(before.done).toEqual(["ready"]);

    // Taken away while its window was made: that window goes, and nothing is focused or shown.
    const meanwhile = new AbortController();
    const making = person({ whileMade: () => meanwhile.abort() });
    expect(
      await tellThePerson(() => ({ message: "Leave it?", signal: meanwhile.signal }), making.words),
    ).toBeNull();
    expect(making.done).toEqual(["ready", "window made", "window gone"]);

    const wanted = person();
    const open = new AbortController();
    expect(
      await tellThePerson(() => ({ message: "Leave it?", signal: open.signal }), wanted.words),
    ).toBe(1);
    expect(wanted.done).toEqual([
      "ready",
      "window made",
      "focused",
      "shown Leave it?",
      "window gone",
    ]);
  });

  it("says a hidden launch's word in its output and answers a failed one as dismissed", async () => {
    const hidden = person({ hidden: true });
    expect(await tellThePerson(() => ({ message: "In the Dock" }), hidden.words)).toBeNull();
    expect(hidden.done).toEqual(["ready", "said In the Dock"]);
    const failing = person({ fails: true });
    expect(await tellThePerson(() => ({ message: "Leave it?", cancelId: 0 }), failing.words)).toBe(
      0,
    );
    expect(failing.done).toEqual(["ready", "focused"]);
  });
});
