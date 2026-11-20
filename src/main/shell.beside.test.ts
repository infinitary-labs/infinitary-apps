import { join } from "node:path";
import { type HomeConnection, startConnection } from "@core/connection/connection";
import { claimLink } from "@core/devices/dial";
import { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import { DevicePairing } from "@core/devices/pairing";
import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { DEFAULT_SAVED_KEYMAP, presetKeymap, type SavedKeymap } from "@shared/keymap";
import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  otherMac,
  ownCore,
  ownUpdates,
  shown,
  stopEachTest,
  stops,
} from "../../tests/helpers/shellStandIns";
import type { StartEntry } from "./besideRun";
import { BesideWindow } from "./besideWindow";
import type { OwnedRun } from "./runCommand";
import type { RunStatus } from "./runStatus";
import { Shell } from "./shell";

/**
 * The window opened beside a command's first mate (docs/run.md): the shell
 * against a stand-in core served on the command's local door, a stand-in for
 * the command's records and starter, and this program's own presence.
 */

stopEachTest();

// INF-1352's plan, piece 6, the captain's answer window_joins=join (docs/run.md, "The window
// opened beside it"): the window opened while a command runs the first mate joins it over its
// local door, with no core of its own. INF-3660's plan, the captain's answers, gives it one
// rule: the first mate keeps the settings, the records and the crew, and only this window
// touches the desktop.
describe("the window beside a command's first mate", () => {
  const JOINED = { pid: 41, startedAt: "2026-11-01T08:00:00.000Z" };
  /** The run this app's own agent started, which its window's starter owns. */
  const OWNED: OwnedRun = JOINED;
  /** The command's own records in its data folder, as the window reads them. */
  type Records = Pick<RunStatus, "running" | "run" | "lastStop">;
  const stopped = (
    reason: "quit" | "signal" | "updated" | "start-failed",
    exitCode: number,
    of = JOINED,
  ): Records => ({
    running: false,
    run: null,
    // Stopped just now: the wait for a start entry counts from the record's own time.
    lastStop: { ...of, stoppedAt: new Date().toISOString(), reason, exitCode, lines: [] },
  });

  /** The command's first mate in another program: a stand-in core served on its local door. */
  function commandRun() {
    const run = ownCore();
    /** What that first mate keeps, and what this computer's window told it. */
    const there = {
      look: {
        ...DEFAULT_SHELL_PREFERENCES,
        appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, theme: "light", size: 125 },
      } as ShellPreferences,
      keys: DEFAULT_SAVED_KEYMAP as SavedKeymap,
      showInDock: true,
      dictation: true,
      cards: [] as Card[],
      here: 0,
      focused: 0,
      answers: [] as unknown[][],
      holds: [] as unknown[],
    };
    run.dispatch.mockImplementation((async (channel: string, args: unknown[]) => {
      switch (channel) {
        case "inf:shell:preferences":
          return there.look;
        case "inf:settings:appearance:set":
          there.look = { ...there.look, appearance: args[0] as ShellPreferences["appearance"] };
          run.core.events.emit("inf:shell:preferences", there.look);
          return there.look.appearance;
        case "inf:settings:keys:get":
          return { saved: there.keys, unreadable: false };
        case "inf:settings:keys:set":
          there.keys = args[0] as SavedKeymap;
          return { ok: true };
        case "inf:presence:get":
          return { startAtLogin: false, showInDock: there.showInDock };
        case "inf:settings:dictation:get":
          return { enabled: there.dictation, key: "AltRight" };
        case "inf:settings:dictation:set":
          there.dictation = (args[0] as { enabled: boolean }).enabled;
          return { enabled: there.dictation, key: "AltRight" };
        case "inf:own-window:here":
          there.here += 1;
          return { ok: true };
        case "inf:own-window:focused":
          there.focused += 1;
          return { ok: true };
        case "inf:own-window:answer":
          there.answers.push(args);
          return { ok: true };
        case "inf:cards:list":
          return there.cards;
        case "inf:settings:notifications:get":
          return true;
        case "inf:update:hold":
          there.holds.push(args[0]);
          return { saved: true, work: { state: "resuming", tasks: ["Fix the flaky test"] } };
        default:
          return { run: channel };
      }
    }) as never);
    const doorDir = join(scratchDir("infinitary-shell-beside-"), "local-door");
    const pairing = new DevicePairing({
      dir: join(scratchDir("infinitary-shell-beside-"), "devices"),
      onProblem: () => {},
    });
    let connection: HomeConnection | null = null;
    const open = () => {
      connection = startConnection({
        dispatch: run.core.dispatch,
        events: run.core.events,
        devices: pairing,
        localDoor: doorDir,
        port: 0,
        onProblem: () => {},
      });
      return connection;
    };
    stops.push(async () => {
      await connection?.close();
      pairing.dispose();
    });
    return {
      run,
      there,
      doorDir,
      open,
      stop: () => connection?.close(),
      asked: (channel: string) =>
        run.dispatch.mock.calls.filter(([asked]) => asked === channel).map(([, args]) => args),
    };
  }

  function besideShell(
    doorDir: string,
    options: {
      records?: Records;
      entry?: StartEntry;
      readyMs?: number;
      installsUpdates?: boolean;
      programReplaced?: boolean;
      /** When this window started the command, and the starter it started it with. */
      startedAt?: number;
      starts?: boolean;
      /** How long the window waits for a running command to answer before it says it does not. */
      answerWaitMs?: number;
      /** Each dial of the command's door after this turns true never connects, as at a stuck command. */
      dialHangs?: () => boolean;
      /** This user's work folder, where a home that added this computer leaves its grant. */
      workDir?: string;
      /**
       * The command running when it is the starter's own - this app's agent started it - or null
       * for one started by hand; asked each time. With a starter, the agent's run by default.
       */
      ownedRun?: () => OwnedRun | null;
    } = {},
  ) {
    const startCore = vi.fn(async () => ownCore().core);
    const relaunch = vi.fn();
    const restartWindows = vi.fn();
    const openPage = vi.fn(async (_url: string) => {});
    const pushes: { channel: string; payload: unknown }[] = [];
    /** What the command's records say now, and which start entry is in place. */
    const command = {
      records: options.records ?? ({ running: true, run: JOINED, lastStop: null } as Records),
      entry: options.entry ?? (null as StartEntry),
      programReplaced: options.programReplaced ?? false,
    };
    /** This program's own Dock icon, login item, file picker and Notification Center. */
    const program = {
      dock: [] as boolean[],
      startAtLogin: false,
      picked: ["/home/kai/report.pdf"],
      notified: [] as { title: string; body: string }[],
    };
    /** The command's starter (docs/run.md, "The window starts it"), and Stop's signals. */
    const starter = {
      start: vi.fn(async () => true),
      atLogin: {
        get: () => starter.login,
        set: (on: boolean) => {
          starter.login = on;
        },
      },
      inPlace: () => true,
      stop: vi.fn(async (_how: { forget: boolean }) => {}),
      restart: vi.fn(async (_run?: { pid?: number }) => true),
      login: false,
      stops: 0,
      /** Which run each stop asked to stop, when it named one. */
      stopped: [] as (OwnedRun | undefined)[],
    };
    const made = new Shell({
      joined: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "joined"), () => {}),
      openPage,
      beside: {
        door: doorDir,
        crewmatesDir: "/run/crewmates",
        look: new JoinedHome(join(scratchDir("infinitary-shell-beside-"), "look"), () => {}),
        status: () => command.records,
        startEntry: () => command.entry,
        // The entry's own wait is the rule's (besideRun.test.ts); here the window only waits to join.
        restartWaitMs: 0,
        presence: {
          getStartAtLogin: () => program.startAtLogin,
          setStartAtLogin: (enabled) => {
            program.startAtLogin = enabled;
          },
          setShowInDock: (visible) => program.dock.push(visible),
        },
        chooseFiles: async () => program.picked,
        installsUpdates: options.installsUpdates ?? false,
        programReplaced: () => command.programReplaced,
        ...(options.starts ? { starter } : {}),
        ownedRun: options.ownedRun ?? (() => OWNED),
        ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
        ...(options.answerWaitMs === undefined ? {} : { answerWaitMs: options.answerWaitMs }),
        stopCommand: (only?: OwnedRun) => {
          starter.stops += 1;
          starter.stopped.push(only);
          return command.records.running === true;
        },
      },
      startCore,
      startConnection: () => {
        throw new Error("A window beside a command serves no connection.");
      },
      ...(options.readyMs !== undefined || options.dialHangs
        ? {
            localWindow: {
              ...(options.readyMs !== undefined ? { readyMs: options.readyMs } : {}),
              ...(options.dialHangs
                ? {
                    link: (linkOptions: ConstructorParameters<typeof HomeLink>[0]) =>
                      new HomeLink({
                        ...linkOptions,
                        dial: (grant, reached) =>
                          options.dialHangs?.()
                            ? new Promise<never>(() => {})
                            : (linkOptions.dial?.(grant, reached) ??
                              Promise.reject(new Error("no dial"))),
                      }),
                  }
                : {}),
            },
          }
        : {}),
      ...(options.workDir ? { work: { dataDir: options.workDir } } : {}),
      broadcast: (channel, payload) => pushes.push({ channel, payload }),
      notifications: {
        supported: () => true,
        focused: () => false,
        show: (notification) => program.notified.push(notification),
      },
      deviceName: async () => "MacBook Pro",
      restartWindows,
      relaunch,
      updates: ownUpdates().updates,
    });
    stops.push(() => made.dispose());
    return {
      shell: made,
      /**
       * Starts the window, then waits as the window's first request does: for the
       * command's first welcome, or for the window to stop waiting for one.
       */
      start: async () => {
        await made.start();
        await made.dispatch("inf:conversation:state", []).catch(() => {});
      },
      startCore,
      relaunch,
      restartWindows,
      openPage,
      pushes,
      command,
      program,
      starter,
    };
  }

  it("asks the command's first mate over its door, with no core here", async () => {
    const command = commandRun();
    const opened = command.open();
    await opened.settled();
    const at = besideShell(command.doorDir);
    await at.start();
    expect(at.startCore).not.toHaveBeenCalled();
    expect(at.shell.core()).toBeNull();
    // This computer's own window: nothing to leave, no device of the first mate's.
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    expect(command.run.dispatch.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "inf:repos:list",
      [],
      { kind: "captain" },
    ]);
    command.run.core.events.emit("inf:models:changed", { ok: true });
    await expect
      .poll(() => at.pushes.filter((push) => push.channel === "inf:models:changed").length)
      .toBe(1);
    // The captain's answer direction=a, the window joins the command's first mate: a reply
    // piece that first mate streams, sent outside the numbering, reaches this window too.
    const piece = {
      type: "assistant_delta",
      taskId: "t1",
      text: "The harbour opens at six.",
    } as const;
    command.run.core.events.emit("inf:event", piece);
    await expect
      .poll(() => at.pushes.filter((push) => push.channel === "inf:event").map((p) => p.payload))
      .toEqual([piece]);
    // Card pictures are read from the command's folder; dictation follows its switch.
    expect(at.shell.pictures()).toEqual({ root: "/run/crewmates" });
    expect(at.shell.dictationEnabled()).toBe(true);
    await at.shell.dispatch("inf:settings:dictation:set", [{ enabled: false, key: "AltRight" }]);
    expect(at.shell.dictationEnabled()).toBe(false);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // The captain's answer look_here=follow: "Follow the first mate's look and keys, on this
  // computer only", with a copy kept so the window draws right before the first mate answers.
  it("follows the first mate's look and keys, and keeps a copy for the next start", async () => {
    const command = commandRun();
    command.there.keys = {
      ...presetKeymap("emacs"),
      keys: { "settings.open": [{ key: "KeyD", meta: true }] },
    };
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    expect(at.shell.preferences.get().appearance).toMatchObject({ theme: "light", size: 125 });
    expect(at.shell.preferences.keymap()).toEqual({ saved: command.there.keys, unreadable: false });
    // A change made in this window is the first mate's to keep; the window follows its answer.
    const dark = { ...command.there.look.appearance, theme: "dark" as const };
    expect(await at.shell.dispatch("inf:settings:appearance:set", [dark])).toEqual(dark);
    expect(command.there.look.appearance.theme).toBe("dark");
    expect(at.shell.preferences.get().appearance.theme).toBe("dark");
    // A change the first mate makes itself reaches the window, and its windows hear the look.
    command.there.look = {
      ...command.there.look,
      appearance: { ...command.there.look.appearance, size: 150 },
    };
    command.run.core.events.emit("inf:shell:preferences", command.there.look);
    await expect.poll(() => at.shell.preferences.get().appearance.size).toBe(150);
    expect(at.pushes.findLast((push) => push.channel === "inf:shell:preferences")?.payload).toEqual(
      at.shell.preferences.get(),
    );
    // Keys changed here are installed here and kept by the first mate.
    const keys: SavedKeymap = {
      ...presetKeymap("emacs"),
      keys: { "settings.open": [{ key: "KeyE", meta: true }] },
    };
    at.shell.preferences.setKeymap(keys);
    expect(at.shell.preferences.keymap().saved).toEqual(keys);
    await expect.poll(() => command.there.keys).toEqual(keys);
  });

  it("reads everything once the command's door opens after the window", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 20 });
    await at.start();
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    await command.open().settled();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        caughtUp: 1,
      });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    // The late welcome still gives it the first mate's look and its dictation switch.
    await expect.poll(() => at.shell.preferences.get().appearance.theme).toBe("light");
    await expect.poll(() => at.shell.dictationEnabled()).toBe(true);
  });

  // INF-4680's window-first cut, the captain's words "without losing any functionality": the
  // window draws before the command it started welcomes it, and a message typed meanwhile still
  // reaches the first mate, once the window said it is here.
  it("draws before the command it started welcomes it, and sends a message typed meanwhile then", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, {
      records: { running: false, run: null, lastStop: null },
      startedAt: Date.now(),
      readyMs: 60_000,
    });
    // The start returns with no door open yet, so the window is made now, drawn with the look
    // kept here.
    await at.shell.start();
    expect((await at.shell.dispatch("inf:shell:preferences", [])).appearance.theme).toBe(
      DEFAULT_SHELL_PREFERENCES.appearance.theme,
    );
    const sent = at.shell.dispatch("inf:converse", ["Fix the login page"]);
    expect(command.asked("inf:converse")).toEqual([]);
    at.command.records = { running: true, run: JOINED, lastStop: null };
    await command.open().settled();
    expect(await sent).toEqual({ run: "inf:converse" });
    expect(command.asked("inf:converse")).toEqual([["Fix the login page"]]);
    const asked = command.run.dispatch.mock.calls.map(([channel]) => channel);
    expect(asked.indexOf("inf:own-window:here")).toBeLessThan(asked.indexOf("inf:converse"));
    // It read nothing before the welcome, so it reads nothing twice; the welcome brings the look.
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    expect(at.shell.preferences.get().appearance.theme).toBe("light");
  });

  // INF-3645's review: a command's first mate opens no page itself, so a sign-in started
  // from this window opened no browser page here.
  it("opens each page the command's first mate sends, a sign-in's too", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    const page = "https://example.com/sign-in?state=1";
    command.run.core.events.emit("inf:app:open-page", { url: page });
    const google = "https://accounts.google.com/o/oauth2/auth?state=2";
    command.run.core.events.emit("inf:app:sign-in-page", {
      url: google,
      id: "return-1",
      port: 4242,
    });
    await expect.poll(() => at.openPage.mock.calls.map(([url]) => url)).toEqual([page, google]);
  });

  // INF-3645's review: the window's dictation switch followed only its own reads and sets.
  it("follows the first mate's dictation switch, wherever it is turned", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    expect(at.shell.dictationEnabled()).toBe(true);
    command.run.core.events.emit("inf:settings:dictation", { enabled: false, key: "AltRight" });
    await expect.poll(() => at.shell.dictationEnabled()).toBe(false);
  });

  // The captain's answer dock=split: "The first mate keeps Show in Dock and this window
  // applies it; this window changes Start at login itself".
  it("applies the first mate's Dock choice to this program, and answers Start at login from it", async () => {
    const command = commandRun();
    command.there.showInDock = false;
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    // It says it is open, then applies what the first mate keeps.
    expect(command.there.here).toBe(1);
    expect(at.program.dock).toEqual([false]);
    command.run.core.events.emit("inf:presence:dock", { showInDock: true });
    await expect.poll(() => at.program.dock).toEqual([false, true]);
    // The first mate asks this window for what only its program can read or change.
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-1",
      ask: { kind: "start-at-login", set: true },
    });
    await expect
      .poll(() => command.there.answers)
      .toEqual([["ask-1", { kind: "start-at-login", enabled: true }]]);
    expect(at.program.startAtLogin).toBe(true);
    // The extras: a task browser page's file dialog is this window's too.
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-2",
      ask: { kind: "choose-files", multiple: true },
    });
    await expect
      .poll(() => command.there.answers.at(-1))
      .toEqual(["ask-2", { kind: "choose-files", paths: ["/home/kai/report.pdf"] }]);
    // None of it is the window's own pages' to hear.
    expect(
      at.pushes.filter(
        (push) => push.channel === "inf:own-window:ask" || push.channel === "inf:presence:dock",
      ),
    ).toEqual([]);
  });

  // The captain's answer notifications=window: "This computer's window, while Infinitary is
  // running; the run never posts".
  it("posts the first mate's new card on this computer", async () => {
    const command = commandRun();
    const old = shown("old", { title: "Already there" });
    command.there.cards = [old];
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    const report = shown("report", { title: "Tests fixed", body: "<p>All green.</p>" });
    command.run.core.events.emit("inf:cards", [old, report]);
    await expect
      .poll(() => at.program.notified)
      .toEqual([
        {
          kind: "card",
          title: m.uiCardKindNote(),
          body: "Tests fixed\nAll green.",
          cardId: "report",
        },
      ]);
  });

  // The extras, same piece: coming back to the window refreshes the plan's allowance.
  it("tells the first mate when the window comes to the front", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    at.shell.windowFocused();
    await expect.poll(() => command.there.focused).toBe(1);
  });

  // The captain's words: "when i'm literally working actively on my desktop app, my phone
  // still gets push notification". The first mate here runs in another program, so the window
  // says when it is in front and when it leaves, and says it again to a first mate that
  // forgot it as the connection dropped.
  it("tells the first mate when the window is in front and when it leaves, and again after a drop", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    at.shell.windowFront(true);
    await expect.poll(() => command.asked("inf:window:front")).toEqual([[true]]);
    at.shell.windowFront(false);
    await expect.poll(() => command.asked("inf:window:front")).toEqual([[true], [false]]);
    at.shell.windowFront(true);
    await expect.poll(() => command.asked("inf:window:front")).toEqual([[true], [false], [true]]);
    await command.stop();
    await command.open().settled();
    await expect
      .poll(() => command.asked("inf:window:front"), { timeout: 5_000 })
      .toEqual([[true], [false], [true], [true]]);
  });

  // INF-4786: a window that came to the front before its first welcome, then quit, went on
  // rescheduling its front-of-screen reaction forever and held one processor core until killed.
  it("ends at once when it quits after coming to the front before its first welcome", async () => {
    // The command never opens its door, so it never welcomes the window.
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 60_000 });
    // A window that never stops reacting would starve the event loop and hang the test,
    // so this cuts it off far past any reaction a closed window may still make.
    const reaction = BesideWindow.prototype.focused;
    let reactions = 0;
    let cutOff = false;
    const spy = vi.spyOn(BesideWindow.prototype, "focused").mockImplementation(function (
      this: BesideWindow,
    ) {
      reactions += 1;
      if (reactions > 1_000) cutOff = true;
      else reaction.call(this);
    });
    stops.push(() => spy.mockRestore());
    await at.shell.start();
    at.shell.windowFocused();
    await at.shell.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(cutOff).toBe(false);
  });

  // INF-4680's window-first cut, the captain's words "without losing any functionality": coming
  // to the front before the first welcome still refreshes the allowance once welcomed.
  it("tells the first mate it came to the front before the first welcome, once welcomed", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 60_000 });
    await at.shell.start();
    at.shell.windowFocused();
    await command.open().settled();
    await expect.poll(() => command.there.focused, { timeout: 5_000 }).toBe(1);
  });

  // The captain's answer restart=wait-for-entry: "offer it at once when none will restart the
  // run". A kill leaves the earlier command's stop record, which names another command.
  it("says the command stopped and offers Start it here at once when no entry restarts it", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    at.command.records = stopped("quit", 0, { pid: 7, startedAt: "2026-10-30T08:00:00.000Z" });
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "crashed" },
      });
    expect(at.pushes.at(-1)).toEqual({
      channel: "inf:devices:this-mac",
      payload: at.shell.thisMac(),
    });
    // It never starts a first mate by itself: only the person's Start it here does.
    expect(at.relaunch).not.toHaveBeenCalled();
    expect(at.shell.startHere()).toBe(true);
    expect(at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  it("never offers Start it here while the command it joined is alive", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    // Out of reach, with the command still running: no notice, nothing to start.
    await command.stop();
    await expect
      .poll(() => at.shell.dispatch("inf:repos:list", []).catch(() => "lost"))
      .toBe("lost");
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    expect(at.shell.startHere()).toBe(false);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // "Wait for the start entry when one is in place, then offer it": exit 75 under a
  // restarting entry waits, and an entry that never comes back ends in the offer.
  it("waits for the start entry after an update, then offers Start it here when it never comes back", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { entry: "linux-unit", readyMs: 400 });
    await at.start();
    at.command.records = stopped("updated", 75);
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "waiting", ending: "updated" },
      });
    expect(at.shell.startHere()).toBe(false);
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "updated" },
      });
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // The third launch state: the window opened while the command is between two stops.
  it("opened between two commands, waits under the notice and joins the one the entry starts", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, {
      records: stopped("updated", 75),
      entry: "linux-unit",
      readyMs: 60_000,
    });
    // It draws at once, under its notice, and starts no first mate.
    await at.start();
    expect(at.startCore).not.toHaveBeenCalled();
    expect(at.shell.thisMac()).toEqual({
      role: "home",
      left: null,
      byCommand: true,
      command: { state: "waiting", ending: "updated" },
    });
    at.command.records = { running: true, run: JOINED, lastStop: at.command.records.lastStop };
    await command.open().settled();
    // The command the entry started welcomes it: the notice goes and the window reads everything.
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({ role: "home", left: null, byCommand: true, caughtUp: 1 });
    await expect.poll(() => at.shell.preferences.get().appearance.theme).toBe("light");
  });

  // The captain's answer update=window-installs. Where the first mate can replace the program
  // itself, its updater is the only one, and this window follows the new program.
  it("asks the first mate's own updater, and starts again on the program it replaced", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir);
    await at.start();
    expect(await at.shell.dispatch("inf:update:status", [])).toEqual({ run: "inf:update:status" });
    expect(await at.shell.dispatch("inf:update:install", [])).toEqual({
      run: "inf:update:install",
    });
    // The command ended for its update and came back on the new program.
    at.command.programReplaced = true;
    await command.stop();
    await command.open().settled();
    await expect.poll(() => at.relaunch.mock.calls, { timeout: 5_000 }).toEqual([[undefined]]);
  });

  // "This window installs it for the run, while the run holds the crew's saved work."
  it("installs an update itself where only a window can, with the first mate ending first", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { installsUpdates: true, starts: true });
    await at.start();
    // This program's own notice, with the work the first mate still resumes.
    const status = await at.shell.dispatch("inf:update:status", []);
    expect(status).toMatchObject({
      currentVersion: "0.1.28-alpha.3",
      work: { state: "resuming", tasks: ["Fix the flaky test"] },
    });
    expect(command.asked("inf:update:status")).toEqual([]);
    // Before this window's update replaces the copy, the first mate ends with its work saved.
    const heldAtStop: unknown[] = [];
    at.starter.stop.mockImplementation(
      async () => void heldAtStop.push(command.there.holds.at(-1)),
    );
    await at.shell.updateReplacing();
    expect(command.there.holds.at(-1)).toBe("replaced");
    // Then its starter lets it go, not forgotten: its agent would start the old copy again, and
    // macOS's installer refuses to replace a copy that runs (INF-4113). The new window starts it.
    expect(heldAtStop).toEqual(["replaced"]);
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: false }]]);
  });

  // INF-1352's plan, piece 7, starter=login-agent: an earlier command's stop is not this one's.
  it("waits with no notice for the command it started, then joins it", async () => {
    const command = commandRun();
    const records = stopped("quit", 0, { pid: 7, startedAt: "2026-10-30T08:00:00.000Z" });
    const at = besideShell(command.doorDir, {
      records,
      startedAt: Date.now() + 1,
      readyMs: 60_000,
    });
    const starting = at.shell.start();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    at.command.records = { running: true, run: JOINED, lastStop: records.lastStop };
    await command.open().settled();
    await starting;
    await expect
      .poll(() => at.shell.thisMac())
      .toEqual({ role: "home", left: null, byCommand: true });
    expect(await at.shell.dispatch("inf:repos:list", [])).toEqual({ run: "inf:repos:list" });
    expect(at.startCore).not.toHaveBeenCalled();
    // With no starter (a boot entry), joining would leave a command that entry starts again.
    expect(await at.shell.join("not a link")).toEqual({ ok: false, refused: "other" });
  });

  it("stops the command on Stop, and starts it again through its starter on Start it here", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 50 });
    await at.start();
    expect(await at.shell.join("not a link")).toEqual({ ok: false, refused: "not-a-link" });
    expect(at.shell.stopCommand()).toBe(true);
    expect(at.starter.stops).toBe(1);
    at.command.records = stopped("quit", 0);
    await command.stop();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        // The captain's answer on the review: the notice speaks of the program this window started.
        command: { state: "stopped", ending: "quit", byWindow: true },
      });
    // Under the notice there is nothing to stop.
    expect(at.shell.stopCommand()).toBe(false);
    at.starter.start.mockResolvedValueOnce(false);
    expect(at.shell.startHere()).toBe(true);
    expect(at.starter.start).toHaveBeenCalledTimes(1);
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  it("keeps the notice down while the command Start it here started comes up, then starts the window over", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 5_000 });
    await at.start();
    at.shell.stopCommand();
    const records = stopped("quit", 0);
    if (records.lastStop) records.lastStop.stoppedAt = new Date(Date.now() - 1_000).toISOString();
    at.command.records = records;
    await command.stop();
    await expect
      .poll(
        () => {
          const here = at.shell.thisMac();
          return here.role === "home" ? here.command?.state : null;
        },
        { timeout: 5_000 },
      )
      .toBe("stopped");
    expect(at.shell.startHere()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(at.shell.thisMac()).toEqual({ role: "home", left: null, byCommand: true });
    at.command.records = {
      running: true,
      run: { pid: 43, startedAt: new Date().toISOString() },
      lastStop: null,
    };
    await command.open().settled();
    await expect.poll(() => at.restartWindows.mock.calls.length, { timeout: 5_000 }).toBe(1);
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // INF-4622: after an update from 0.6.3, a person's window never opened. A command that
  // welcomes the window and then never answers left the window waiting for its first answers
  // with no end, so it never drew; one whose door never opened left a window with nothing on it.
  // The window draws, says its first mate is not answering, and Start it here stops that
  // command and runs the first mate here.
  it("draws under a notice when the command welcomes it and never answers, and Start it here stops it", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
    // The window draws at once, and says so once the command's wait is over.
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "not-answering", byWindow: true },
      });
    // The window reads its own copy of the look rather than waiting on the command.
    expect(await at.shell.dispatch("inf:shell:preferences", [])).toBeDefined();
    expect(at.shell.startHere()).toBe(true);
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: false, force: { pid: JOINED.pid } }]]);
  });

  // The captain, on the fix's card: "can we not give an option that's force restart the
  // background process?" Restart it ends the command this window started by force and starts it
  // again; the window waits under its notice and joins the one that comes back.
  it("restarts a command that does not answer on Restart it, and joins the one started again", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({
        command: { state: "stopped", ending: "not-answering", byWindow: true },
      });
    // The program the service manager starts again answers, at the same door.
    at.starter.restart.mockImplementation(async () => {
      await command.stop();
      command.run.dispatch.mockImplementation(answer as never);
      await command.open().settled();
      return true;
    });
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "restart", byWindow: true },
    });
    await expect.poll(() => at.shell.thisMac(), { timeout: 5_000 }).not.toHaveProperty("command");
    // It ends the command by the process its record names.
    expect(at.starter.restart.mock.calls).toEqual([[{ pid: JOINED.pid }]]);
    expect(at.restartWindows).toHaveBeenCalled();
    expect(at.relaunch).not.toHaveBeenCalled();
    expect(at.starter.stop).not.toHaveBeenCalled();
  });

  // INF-4624's review: a command started again by Restart it that welcomes the window and then
  // never answers would leave the window waiting for its answers with no end, the bug this fix is
  // for. Every welcome waits as the first does: the notice comes back and offers Restart it again.
  it("says a command started again by Restart it is not answering when it welcomes and never answers", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    // The program started again welcomes the window at the same door and still never answers.
    at.starter.restart.mockImplementation(async () => {
      await command.stop();
      at.command.records = { running: true, run: { ...JOINED, pid: 42 }, lastStop: null };
      await command.open().settled();
      return true;
    });
    expect(at.shell.restartCommand()).toBe(true);
    await expect.poll(() => at.restartWindows.mock.calls.length, { timeout: 3_000 }).toBe(1);
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 3_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    // The window started over draws from its own copy rather than waiting on the command.
    expect(await at.shell.dispatch("inf:shell:preferences", [])).toBeDefined();
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.starter.restart).toHaveBeenCalledTimes(2);
  });

  // INF-4624's review: a restart that fails leaves the notice up, with its way out, rather than
  // taking it down until a new wait has passed.
  it("keeps the notice that the command is not answering when Restart it could not restart it", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 1_500 });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    await at.shell.start();
    await expect.poll(ending, { timeout: 3_000 }).toBe("not-answering");
    at.starter.restart.mockImplementation(async () => false);
    expect(at.shell.restartCommand()).toBe(true);
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    // The window's next readings of the command's records, a second apart, keep it up.
    const seen = new Set<string | undefined>();
    const until = Date.now() + 1_300;
    while (Date.now() < until) {
      seen.add(ending());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect([...seen]).toEqual(["not-answering"]);
  });

  // INF-4624's review: the count of a command that does not answer ends with that command. One
  // started again after it stopped, as after an update, gets a wait of its own before the window
  // offers to end it by force.
  it("counts a command started after another stopped anew before saying it is not answering", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 20, answerWaitMs: 600 });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    await at.shell.start();
    await expect.poll(ending, { timeout: 2_000 }).toBe("not-answering");
    at.command.records = stopped("updated", 75);
    await expect.poll(ending, { timeout: 2_000 }).not.toBe("not-answering");
    at.command.records = { running: true, run: { ...JOINED, pid: 42 }, lastStop: null };
    await expect.poll(() => at.shell.thisMac(), { timeout: 2_000 }).not.toHaveProperty("command");
  });

  // INF-4624's review: a command that answers after its notice went up has answered. Should its
  // link then drop, as on a missed ping or waking from sleep, the window waits anew before calling
  // it silent, rather than at once offering to end a healthy command by force.
  it("waits anew after a late answer before calling a command that drops away silent", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    let answerHere: () => void = () => {};
    const here = new Promise<void>((resolve) => {
      answerHere = resolve;
    });
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? here.then(() => answer?.(channel as never, args as never))
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { readyMs: 2_000, answerWaitMs: 1_500 });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    await at.shell.start();
    await expect.poll(ending, { timeout: 3_000 }).toBe("not-answering");
    answerHere();
    await expect.poll(ending).toBeUndefined();
    // The same command's link drops while it still runs.
    await command.stop();
    const seen = new Set<string | undefined>();
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      seen.add(ending());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(seen.has("not-answering")).toBe(false);
  });

  // INF-4624's review: a command stuck after its welcome cannot answer the link's pings, so its
  // link drops and the asks it never answered are refused. That refusal is no answer: the notice
  // and its way out stay up, and the window does not start over as though the command were back.
  it("keeps the notice when the link to a command that never answered drops mid-reading", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    await command.open().settled();
    let stuck = false;
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 300,
      dialHangs: () => stuck,
    });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    await at.shell.start();
    expect(ending()).toBeUndefined();
    // The command comes back after a drop, welcomes the window again and never answers it.
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.stop();
    await command.open().settled();
    await expect.poll(ending, { timeout: 3_000 }).toBe("not-answering");
    // Its link drops with that welcome's asks unanswered, and dialing it again hangs.
    stuck = true;
    await command.stop();
    const seen = new Set<string | undefined>();
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      seen.add(ending());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect([...seen]).toEqual(["not-answering"]);
    expect(at.restartWindows).not.toHaveBeenCalled();
  });

  // INF-4624's review: a command that ends while the window's first asks are still unanswered,
  // as in a crash during a slow start after an update, is started again by its service manager.
  // The one started again gets a wait of its own: the first welcome's wait running out does not
  // call it silent seconds after it started and offer to end it by force.
  it("gives a command started again while the first welcome waited a wait of its own", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise(() => {})
        : answer?.(channel as never, args as never)) as never);
    await command.open().settled();
    let stuck = false;
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 1_500,
      dialHangs: () => stuck,
    });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    const starting = at.shell.start();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(ending()).toBeUndefined();
    // The command ends with the welcome's asks unanswered, and another one runs in its place.
    stuck = true;
    at.command.records = { running: true, run: { ...JOINED, pid: 42 }, lastStop: null };
    await command.stop();
    const seen = new Set<string | undefined>();
    const until = Date.now() + 1_200;
    while (Date.now() < until) {
      seen.add(ending());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(seen.has("not-answering")).toBe(false);
    await starting;
  });

  it("says the command is not answering when its door never opens while it runs", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { readyMs: 20, answerWaitMs: 200 });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toEqual({
        role: "home",
        left: null,
        byCommand: true,
        command: { state: "stopped", ending: "not-answering" },
      });
    // A command that answers after all takes the notice down.
    await command.open().settled();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toMatchObject({ role: "home", left: null, byCommand: true, caughtUp: 1 });
    expect(at.shell.thisMac()).not.toHaveProperty("command");
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  it("runs the first mate here on Start it here once the command could not start", async () => {
    const command = commandRun();
    const at = besideShell(command.doorDir, { starts: true, records: stopped("start-failed", 1) });
    await at.start();
    expect(at.shell.startHere()).toBe(true);
    expect(at.starter.start).not.toHaveBeenCalled();
    expect(at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
  });

  // "Start at login starts the command, not the window."
  it("answers Start at login from the command's starter, never this program's login item", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true });
    await at.start();
    command.run.core.events.emit("inf:own-window:ask", {
      id: "ask-1",
      ask: { kind: "start-at-login", set: true },
    });
    await expect
      .poll(() => command.there.answers)
      .toEqual([["ask-1", { kind: "start-at-login", enabled: true }]]);
    expect(at.starter.login).toBe(true);
    expect(at.program.startAtLogin).toBe(false);
  });

  // Joining another computer from beside a command: that command's first mate is this
  // computer's own, so it stops, and nothing set to start it again remains.
  it("joins another computer with a pasted link, stopping the command and letting its starter go", async () => {
    const pro = await otherMac();
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true });
    await at.start();
    await expect(at.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    // The review of INF-5409: it stops the run its agent started, by that run's process.
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: OWNED }]]);
    expect(at.starter.stopped).toEqual([OWNED]);
    expect(at.startCore).not.toHaveBeenCalled();
  });

  // The review of INF-5409: joining reads the owned run once, so a command that ends between the
  // check and the stop leaves a stop for that run alone, never one for whatever runs there next.
  it("stops only the run it read as its own, even when that run ends as it joins", async () => {
    const pro = await otherMac();
    const command = commandRun();
    await command.open().settled();
    const reads = [OWNED];
    const at = besideShell(command.doorDir, {
      starts: true,
      ownedRun: () => reads.shift() ?? null,
    });
    await at.start();
    await expect(at.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: OWNED }]]);
    expect(at.starter.stopped).toEqual([OWNED]);
  });

  // The fourth window journey on Windows: a window that starts the command, opened while none
  // runs, joins a home by its pasted link as it did before INF-4930 - there is no run to stop -
  // and lets its starter go so nothing starts the command again.
  it("joins another computer while no command runs, letting its starter go", async () => {
    const pro = await otherMac();
    const command = commandRun();
    const at = besideShell(command.doorDir, {
      starts: true,
      records: stopped("signal", 0),
      ownedRun: () => null,
    });
    await at.start();
    expect(at.shell.followsAdded().joins).toBe(true);
    await expect(at.shell.join(await pro.link())).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true }]]);
    expect(at.startCore).not.toHaveBeenCalled();
  });

  // INF-1827 offers Join by its address at first launch, and an installed app's first launch
  // stands beside the command its window started: the command's first mate, which keeps this
  // computer's SSH trust and Infinitary's own key, asks the other computer for the link.
  it("joins another computer by its address, asking the command's first mate for the link", async () => {
    const pro = await otherMac();
    const command = commandRun();
    const link = await pro.link("mac");
    const fallback = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation((async (channel: string, args: unknown[]) =>
      channel === "inf:devices:link-at"
        ? { link, host: "127.0.0.1" }
        : fallback?.(channel as never, args as never)) as never);
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true });
    await at.start();
    await expect(at.shell.joinAt("kun@studio", { confirm: "ED25519 SHA256:abc" })).resolves.toEqual(
      expect.objectContaining({ asks: "join" }),
    );
    expect(command.asked("inf:devices:link-at")).toEqual([
      ["kun@studio", { confirm: "ED25519 SHA256:abc" }],
    ]);
    await expect(at.shell.joinHeld("join")).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: OWNED }]]);
    expect(at.starter.stopped).toEqual([OWNED]);
    expect(at.startCore).not.toHaveBeenCalled();
  });

  // The review of INF-4930: following along stops the command beside the window by itself, so
  // only a command this window's starter owns - this window or this app's own agent started it -
  // and never one the person started by hand, though a grant waits in the work folder. It stops
  // that run alone, by its process number.
  it("follows along beside the command its own agent started, never beside one started by hand", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    for (const owned of [null, { pid: 4321, startedAt: "2026-11-20T18:00:00.000Z" }]) {
      const command = untouchedCommand();
      await command.open().settled();
      const workDir = join(scratchDir("infinitary-shell-beside-work-"), "work");
      const at = besideShell(command.doorDir, { starts: true, ownedRun: () => owned, workDir });
      await at.start();
      // Beside one started by hand it neither follows nor offers a join that would stop it.
      expect(at.shell.followsAdded()).toEqual({ follows: owned !== null, joins: owned !== null });
      await grantFrom(pro, workDir);
      expect(await at.shell.followAdded()).toBe(owned !== null);
      if (owned !== null) {
        await expect.poll(() => at.shell.thisMac().role).toBe("view");
        expect(at.starter.stopped).toEqual([owned]);
        // Its agent's stop names that run too, so a stop asked through the folder (Windows) is
        // ignored by a run started by hand that took its place at the last moment.
        expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: owned }]]);
      } else {
        expect(at.shell.thisMac().role).not.toBe("view");
        expect(at.starter.stops).toBe(0);
        expect(at.starter.stop).not.toHaveBeenCalled();
      }
    }
  });

  // The review of INF-5409: a command started by hand that replaces the owned one while the window
  // asks its first mate whether anything was done here is never stopped.
  it("stays beside a command started by hand that replaced the owned one during the wait", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    let running: OwnedRun | null = { pid: 4321, startedAt: "2026-11-20T18:00:00.000Z" };
    const command = untouchedCommand(() => {
      // The owned run ended and one the person started by hand took its place.
      running = null;
    });
    await command.open().settled();
    const workDir = join(scratchDir("infinitary-shell-beside-work-"), "work");
    const at = besideShell(command.doorDir, { starts: true, ownedRun: () => running, workDir });
    await at.start();
    await grantFrom(pro, workDir);
    expect(await at.shell.followAdded()).toBe(false);
    expect(at.shell.thisMac().role).not.toBe("view");
    expect(at.starter.stops).toBe(0);
    expect(at.starter.stop).not.toHaveBeenCalled();
    // Nor does it offer to join, which would stop the run started by hand.
    expect(at.shell.followsAdded()).toEqual({ follows: false, joins: false });
    expect(await at.shell.join(await pro.link("mac"))).toEqual({ ok: false, refused: "other" });
    expect(at.starter.stop).not.toHaveBeenCalled();
  });

  /** A command whose first mate says nothing was done here, calling `meanwhile` as it answers. */
  function untouchedCommand(meanwhile?: () => void) {
    const command = commandRun();
    const fallback = command.run.dispatch.getMockImplementation();
    command.run.dispatch.mockImplementation((async (channel: string, args: unknown[]) => {
      if (channel !== "inf:app:first-run") return fallback?.(channel as never, args as never);
      meanwhile?.();
      return { gateOpen: true, firstTurnAt: null, untouched: true };
    }) as never);
    return command;
  }

  /** The grant a home that added this computer leaves in its work folder. */
  async function grantFrom(pro: Awaited<ReturnType<typeof otherMac>>, workDir: string) {
    const grant = await claimLink(await pro.link("mac"), {
      kind: "mac",
      name: "Mac mini",
      user: { name: "sam", uid: 501 },
    });
    new JoinedHome(workDir).join(grant, Date.now());
  }
});
