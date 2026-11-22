import { join } from "node:path";
import { claimLink } from "@core/devices/dial";
import type { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import type { RestartOutcome } from "@core/helper/runAgent";
import { COMMAND_NOTICE_WORDS } from "@shared/commandNotice";
import * as m from "@shared/i18n/messages.generated";
import { presetKeymap, type SavedKeymap } from "@shared/keymap";
import { DEFAULT_SHELL_PREFERENCES } from "@shared/preferences";
import { describe, expect, it, vi } from "vitest";
import {
  besideShell,
  commandRun,
  JOINED,
  OWNED,
  type Records,
  silentRun,
  stopped,
} from "../../tests/helpers/besideShell";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { otherMac, shown, stopEachTest, stops } from "../../tests/helpers/shellStandIns";
import { BesideWindow } from "./besideWindow";
import { type OwnedRun, ownedRunOf } from "./runCommand";

/**
 * The window opened beside a command's first mate (docs/run.md), against
 * the stand-ins in `tests/helpers/besideShell.ts`.
 */

stopEachTest();

// INF-1352's plan, piece 6, the captain's answer window_joins=join (docs/run.md, "The window
// opened beside it"): the window opened while a command runs the first mate joins it over its
// local door, with no core of its own. INF-3660's plan, the captain's answers, gives it one
// rule: the first mate keeps the settings, the records and the crew, and only this window
// touches the desktop.
describe("the window beside a command's first mate", () => {
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
    const command = silentRun();
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
    // The run named ends, and its records say it let the folder go.
    at.starter.stop.mockImplementation(async () => {
      at.command.records = { running: false, run: null, lastStop: null };
      return "ended" as const;
    });
    expect(at.shell.startHere()).toBe(true);
    // Ended by force through its own agent's starter: the window starting here lets the job go.
    await expect
      .poll(() => at.relaunch.mock.calls)
      .toEqual([[{ startHere: true, letGoJob: true }]]);
    // By the run's process and start, so its starter ends that run alone.
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: false, force: JOINED }]]);
  });

  // The captain, on the fix's card: "can we not give an option that's force restart the
  // background process?" Restart it ends the command this window started by force and starts it
  // again; the window waits under its notice and joins the one that comes back.
  it("restarts a command that does not answer on Restart it, and joins the one started again", async () => {
    const command = silentRun();
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
      command.run.dispatch.mockImplementation(command.answer as never);
      await command.open().settled();
      return "restarted" as const;
    });
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "restart", byWindow: true },
    });
    await expect.poll(() => at.shell.thisMac(), { timeout: 5_000 }).not.toHaveProperty("command");
    // It ends the command by the process and start its door named.
    expect(at.starter.restart.mock.calls).toEqual([[JOINED]]);
    expect(at.restartWindows).toHaveBeenCalled();
    expect(at.relaunch).not.toHaveBeenCalled();
    expect(at.starter.stop).not.toHaveBeenCalled();
  });

  // INF-4624's review: a command started again by Restart it that welcomes the window and then
  // never answers would leave the window waiting for its answers with no end, the bug this fix is
  // for. Every welcome waits as the first does: the notice comes back and offers Restart it again.
  it("says a command started again by Restart it is not answering when it welcomes and never answers", async () => {
    const command = silentRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      // The run started again is its agent's own too, as its record says.
      ownedRun: (status) => (status.run?.pid === 42 ? { ...JOINED, pid: 42 } : JOINED),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    // The program started again welcomes the window at the same door and still never answers.
    at.starter.restart.mockImplementation(async () => {
      await command.stop();
      at.command.records = {
        running: true,
        run: { ...JOINED, pid: 42, recovers: true },
        lastStop: null,
      };
      await command.open({ ...JOINED, pid: 42 }).settled();
      return "restarted" as const;
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
    const command = silentRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 1_500 });
    const ending = () => {
      const mac = at.shell.thisMac();
      return "command" in mac ? mac.command?.ending : undefined;
    };
    await at.shell.start();
    await expect.poll(ending, { timeout: 3_000 }).toBe("not-answering");
    at.starter.restart.mockImplementation(async () => "failed" as const);
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
    const command = silentRun();
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
  // runs, joins a home by its pasted link as it did before INF-4930. The review of INF-4930: it
  // names no run to stop, so a command started by hand while the link is claimed keeps going -
  // its starter is let go with no stop asked or signalled - and with no first mate to ask, it
  // neither joins by an address nor follows along.
  it("joins by a pasted link while no command runs, stopping none started meanwhile", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = commandRun();
    const workDir = join(scratchDir("infinitary-shell-beside-work-"), "work");
    const at = besideShell(command.doorDir, {
      starts: true,
      records: stopped("signal", 0),
      ownedRun: () => null,
      workDir,
    });
    await at.start();
    expect(at.shell.followsAdded()).toEqual({
      follows: false,
      joins: false,
      pastes: true,
      outside: false,
    });
    await expect(at.shell.joinAt("kun@studio")).resolves.toEqual({ refused: "failed" });
    await grantFrom(pro, workDir);
    expect(await at.shell.followAdded()).toBe(false);
    expect(at.shell.thisMac().role).not.toBe("view");
    // The link is read as no run runs; a command started by hand takes the folder as it is claimed.
    const joining = at.shell.join(await pro.link("mac"));
    at.command.records = {
      running: true,
      run: { pid: 777, startedAt: JOINED.startedAt },
      lastStop: null,
    };
    await expect(joining).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: null }]]);
    expect(at.starter.stops).toBe(0);
    expect(at.startCore).not.toHaveBeenCalled();
  });

  // The review of INF-5409: a command the window has just started may not have written its
  // record yet, as on Windows, where Task Scheduler accepts the start before the run begins, and
  // may take longer than the window's wait to do so. That is not a stopped command: no join is
  // offered until the run it started welcomes the window, and the join then stops that run.
  it("offers no join while the command it started has not welcomed it, past the wait too, then stops that run", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = commandRun();
    let owned: OwnedRun | null = null;
    const at = besideShell(command.doorDir, {
      starts: true,
      records: { running: false, run: null, lastStop: null },
      ownedRun: () => owned,
      // Started well before the wait for it ended.
      startedAt: Date.now() - 60_000,
      readyMs: 1,
    });
    await at.shell.start();
    const starting = { follows: false, joins: false, pastes: false, outside: false };
    expect(at.shell.followsAdded()).toEqual(starting);
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({
      ok: false,
      refused: "other",
    });
    // Its run writes its record, and has not welcomed the window yet: still nothing is offered.
    owned = { pid: 4321, startedAt: "2026-11-20T18:00:00.000Z" };
    at.command.records = { running: true, run: owned, lastStop: null };
    expect(at.shell.followsAdded()).toEqual(starting);
    // It welcomes the window: the join is offered, and stops that run alone.
    await command.open(owned).settled();
    await expect
      .poll(() => at.shell.followsAdded())
      .toEqual({ follows: false, joins: true, pastes: true, outside: false });
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: owned }]]);
    expect(at.starter.stopped).toEqual([owned]);
  });

  // The review of INF-5409: Restart it ends the run the window owns and starts another; a join
  // asked meanwhile would name the run on its way out and leave its replacement running, so none
  // is offered until the restart settles, and a restart that did not happen offers it again.
  it("offers no join while Restart it is under way, and offers it again when the restart did not happen", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = silentRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
    const answers: ((done: RestartOutcome) => void)[] = [];
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          answers.push(resolve);
        }),
    );
    const starting = { follows: false, joins: false, pastes: false, outside: false };
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.shell.followsAdded()).toEqual(starting);
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({
      ok: false,
      refused: "other",
    });
    // The run being replaced reconnects and welcomes the window again before it ends: that is
    // not the run started again, so the join is still not offered.
    await command.stop();
    await command.open().settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(2);
    expect(at.shell.followsAdded()).toEqual(starting);
    expect(at.starter.stop).not.toHaveBeenCalled();
    // The service manager would not restart it while the records cannot be read: nothing is offered
    // until they name the run the window owns, by its process and start, still running.
    at.command.records = { running: null, run: null, lastStop: null };
    answers.shift()?.("failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(at.shell.followsAdded()).toEqual(starting);
    at.command.records = { running: true, run: { ...JOINED, recovers: true }, lastStop: null };
    await expect.poll(() => at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
    // A restart that ended that run and then could not start another leaves nothing to offer.
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { ending: "not-answering" } });
    expect(at.shell.restartCommand()).toBe(true);
    at.command.records = stopped("signal", 1);
    answers.shift()?.("failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(at.shell.followsAdded()).toEqual(starting);
  });

  // The review of INF-5409: a welcome from the run being replaced counts for nothing toward the run
  // started again, neither on a connection that has since dropped nor on one still open whose
  // drop the window has not heard yet; the join waits for the replacement's own welcome, reads
  // again records unreadable at it, and names that replacement.
  it("counts no welcome from the run Restart it replaces toward the run started again, and stops that run alone", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = silentRun();
    const first = {
      pid: 41,
      startedAt: "2026-11-20T08:00:00.000Z",
      agent: true as const,
      recovers: true as const,
    };
    // The run started again, whose record says when it started once it writes it.
    const again = { pid: 42, startedAt: "", agent: true as const, recovers: true as const };
    // Each run's door names it, as the run's own record does.
    const doorOf = (run: typeof first) => ({ pid: run.pid, startedAt: run.startedAt });
    await command.open(doorOf(first)).settled();
    const links: HomeLink[] = [];
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
      links,
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    let settle: (done: RestartOutcome) => void = () => {};
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    expect(at.shell.restartCommand()).toBe(true);
    // Its starter ends the run its notice names, by its process and start.
    expect(at.starter.restart.mock.calls).toEqual([[doorOf(first)]]);
    const starting = { follows: false, joins: false, pastes: false, outside: false };
    // The run being replaced reconnects while the records cannot be read, welcomes the window and
    // never answers it, past the wait for its answers: the notice still says the first mate is
    // starting again and offers neither a second Restart it nor Start it here.
    at.command.records = { running: null, run: null, lastStop: null };
    await command.stop();
    await command.open(doorOf(first)).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(at.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "restart", byWindow: true },
    });
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.startHere()).toBe(false);
    expect(at.shell.followsAdded()).toEqual(starting);
    // The run started again writes its record before the window has heard the run replaced drop,
    // and the starter answers. The welcome on the connection still open came through the door of
    // the run replaced, which named it, however late it was handled, so it counts for nothing.
    again.startedAt = new Date().toISOString();
    at.command.records = { running: true, run: again, lastStop: null };
    settle("restarted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(links.map((link) => link.connection())).not.toEqual([null]);
    expect(at.shell.followsAdded()).toEqual(starting);
    // It drops: still nothing until the run started again welcomes the window itself.
    await command.stop();
    await expect.poll(() => links.map((link) => link.connection())).toEqual([null]);
    expect(at.shell.followsAdded()).toEqual(starting);
    // The run started again welcomes the window while its records cannot be read: still nothing.
    at.command.records = { running: null, run: null, lastStop: null };
    await command.open(doorOf(again)).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(3);
    expect(at.shell.followsAdded()).toEqual(starting);
    // The records come back naming it, after one more reading that names no run: that reading
    // settles nothing and offers no join that stops none; the next offers it, with no new welcome.
    const reads: Records[] = [{ running: false, run: null, lastStop: null }];
    const after: Records = { running: true, run: again, lastStop: null };
    Object.defineProperty(at.command, "records", {
      configurable: true,
      get: () => reads.shift() ?? after,
    });
    expect(at.shell.followsAdded()).toEqual(starting);
    await expect.poll(() => at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
    expect(command.asked("inf:own-window:here")).toHaveLength(3);
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    const replacement = { pid: again.pid, startedAt: again.startedAt };
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: replacement }]]);
    expect(at.starter.stopped).toEqual([replacement]);
  });

  // The review of INF-5409: a run started again that welcomes the window before its starter
  // answers still offers no join until the starter does, and its notice follows it once the
  // starter answered: Restart it again for one that has not answered the window, none for one
  // that answered meanwhile.
  async function replacedBeforeAnswer(answers: boolean) {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    /** The window's first request at each welcome, answered once let go. */
    const heres: (() => void)[] = [];
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise((resolve) => heres.push(() => resolve({ ok: true })))
        : answer?.(channel as never, args as never)) as never);
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    let settle: (done: RestartOutcome) => void = () => {};
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    expect(at.shell.restartCommand()).toBe(true);
    const starting = { follows: false, joins: false, pastes: false, outside: false };
    // The run being replaced is gone, and the one started again writes its record and welcomes
    // the window before its starter answered.
    await command.stop();
    const again = {
      pid: 42,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    at.command.records = { running: true, run: again, lastStop: null };
    await command.open({ pid: again.pid, startedAt: again.startedAt }).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(2);
    // Past the wait for its answers, the notice still says the first mate is starting again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(at.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "restart", byWindow: true },
    });
    expect(at.shell.followsAdded()).toEqual(starting);
    // One that answers late, while the starter has still not answered, is back.
    if (answers) {
      // The window handled its answers once it started its pages over on them.
      const restarts = at.restartWindows.mock.calls.length;
      heres[1]?.();
      await expect.poll(() => at.restartWindows.mock.calls.length).toBe(restarts + 1);
    }
    settle("restarted");
    if (answers) await expect.poll(() => at.shell.thisMac()).not.toHaveProperty("command");
    else
      await expect
        .poll(() => at.shell.thisMac())
        .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    await expect.poll(() => at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    const replacement = { pid: again.pid, startedAt: again.startedAt };
    expect(at.starter.stop.mock.calls).toEqual([[{ forget: true, run: replacement }]]);
    expect(at.starter.stopped).toEqual([replacement]);
  }

  it("offers Restart it again once the starter answered for a run started again that welcomed and has not answered", async () => {
    await replacedBeforeAnswer(false);
  });

  it("takes the notice down once the starter answered for a run started again that answered meanwhile", async () => {
    await replacedBeforeAnswer(true);
  });

  // The review of INF-5409: a command this window started that never welcomed it before Restart it
  // was pressed, and that welcomes it while the restart is under way, is the only run there was:
  // a restart that did not happen joins it at once, never waiting for a second welcome.
  it("joins the run a refused Restart it left running at once where it welcomed the window meanwhile", async () => {
    const command = silentRun();
    // Started by this window, running, and not yet listening.
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      startedAt: Date.now(),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    let settle: (done: RestartOutcome) => void = () => {};
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    expect(at.shell.restartCommand()).toBe(true);
    await command.open().settled();
    await expect
      .poll(() => command.asked("inf:own-window:here").length, { timeout: 5_000 })
      .toBe(1);
    settle("failed");
    await expect.poll(() => at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
  });

  // The review of INF-5409: a refused Restart it over a run that reconnected and answered the
  // window meanwhile leaves that run as it is, with no notice offering to end it by force.
  async function answeredMeanwhile(outcome: RestartOutcome, answers: boolean): Promise<void> {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    /** The window's first request at each welcome, answered once let go. */
    const heres: (() => void)[] = [];
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise((resolve) => heres.push(() => resolve({ ok: true })))
        : answer?.(channel as never, args as never)) as never);
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    const door = { pid: first.pid, startedAt: first.startedAt };
    await command.open(door).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    let settle: (done: RestartOutcome) => void = () => {};
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    expect(at.shell.restartCommand()).toBe(true);
    // The same run reconnects and answers the window while the starter has not answered.
    await command.stop();
    await command.open(door).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(2);
    // The window had its answer once it went on to read the rest from that run, and the starter's
    // answer once the window's own handler of it ran, before this test's.
    const reads = command.asked("inf:settings:dictation:get").length;
    if (answers) {
      heres[1]?.();
      await expect.poll(() => command.asked("inf:settings:dictation:get").length).toBe(reads + 1);
    }
    // Until the starter answers, its force stop may still end that run: the waiting notice stays
    // over it, offering nothing, and what the run showed is kept for when the starter answers.
    expect(at.shell.thisMac()).toMatchObject({ command: { state: "waiting", ending: "restart" } });
    expect(at.shell.startHere()).toBe(false);
    settle(outcome);
    await at.starter.restart.mock.results.at(-1)?.value;
    expect(at.shell.thisMac()).not.toHaveProperty("command");
    if (answers) {
      expect(at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
      return;
    }
    // Its welcome that has not answered is counted on its own connection's wait.
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
  }

  it("puts up no notice when Restart it is refused over a run that answered the window meanwhile", async () => {
    await answeredMeanwhile("failed", true);
  });

  // The review of INF-5409: while Start it here's force stop may still end the run its notice names,
  // that run welcoming and answering the window takes nothing down: the waiting notice stays. Once
  // the stop was withdrawn and the run still holds the folder, its answer stands: no notice.
  it("keeps Start it here's waiting notice over a run that answers while its force stop is pending", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    const heres: (() => void)[] = [];
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise((resolve) => heres.push(() => resolve({ ok: true })))
        : answer?.(channel as never, args as never)) as never);
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    const door = { pid: first.pid, startedAt: first.startedAt };
    await command.open(door).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    let stopped: (ended: "withdrawn") => void = () => {};
    at.starter.stop.mockImplementation(() => new Promise((resolve) => (stopped = resolve)));
    expect(at.shell.startHere()).toBe(true);
    await command.stop();
    await command.open(door).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(2);
    const reads = command.asked("inf:settings:dictation:get").length;
    heres[1]?.();
    await expect.poll(() => command.asked("inf:settings:dictation:get").length).toBe(reads + 1);
    expect(at.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "not-answering", byWindow: true },
    });
    expect(at.shell.restartCommand()).toBe(false);
    stopped("withdrawn");
    await expect.poll(() => at.shell.thisMac()).not.toHaveProperty("command");
    expect(at.relaunch).not.toHaveBeenCalled();
  });

  // The review of INF-5409: Restart it is offered over the agent's own run only once that run says
  // a force stop can end it, its own reading of force stops running: a run frozen before then would
  // never act on one. Its notice then offers no Restart it, and offers it once the same run says so.
  it("offers Restart it only once the silent run says a force stop can end it", async () => {
    const command = silentRun();
    const run = { pid: 41, startedAt: new Date().toISOString(), agent: true as const };
    await command.open({ pid: run.pid, startedAt: run.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.thisMac()).not.toHaveProperty("command.byWindow");
    expect(at.shell.restartCommand()).toBe(false);
    at.command.records = { running: true, run: { ...run, recovers: true }, lastStop: null };
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 3_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    at.starter.restart.mockImplementation(async () => "untouched" as const);
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.starter.restart.mock.calls).toEqual([[{ pid: run.pid, startedAt: run.startedAt }]]);
  });

  // The review of INF-5409: Restart it that ended and started nothing keeps what the run's new
  // connection showed meanwhile, as a refused one does: its answer, or its own wait for one.
  it("keeps a reconnected run's answer, or its own wait, when Restart it ended and started nothing", async () => {
    await answeredMeanwhile("untouched", true);
    await answeredMeanwhile("untouched", false);
  });

  // The review of INF-5409: the wait for a first mate's answers is its connection's, so records
  // that could not be read at its welcome and come back meanwhile, naming the run its door named,
  // still end in the notice, for that run. Records that come back naming another run, which took
  // the folder meanwhile, are not that run's: nothing calls the other silent.
  it("says the first mate is not answering when its records come back during the wait for its answers", async () => {
    for (const comesBack of ["same", "another"] as const) {
      const command = silentRun();
      // The run behind the door, there before the window opened.
      const run = {
        pid: 42,
        startedAt: new Date().toISOString(),
        agent: true as const,
        recovers: true as const,
      };
      await command.open({ pid: run.pid, startedAt: run.startedAt }).settled();
      const at = besideShell(command.doorDir, {
        starts: true,
        readyMs: 2_000,
        answerWaitMs: 200,
        records: { running: null, run: null, lastStop: null },
        ownedRun: (status) => ownedRunOf(status),
      });
      await at.shell.start();
      await expect.poll(() => command.asked("inf:own-window:here").length).toBe(1);
      const other = { ...run, pid: 43, startedAt: new Date(Date.now() + 1).toISOString() };
      at.command.records = {
        running: true,
        run: comesBack === "same" ? run : other,
        lastStop: null,
      };
      if (comesBack === "same") {
        await expect
          .poll(() => at.shell.thisMac())
          .toMatchObject({
            command: { state: "stopped", ending: "not-answering", byWindow: true },
          });
        expect(at.shell.restartCommand()).toBe(true);
        expect(at.starter.restart.mock.calls).toEqual([
          [{ pid: run.pid, startedAt: run.startedAt }],
        ]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(at.shell.thisMac()).not.toHaveProperty("command");
        expect(at.shell.restartCommand()).toBe(false);
        expect(at.starter.restart).not.toHaveBeenCalled();
      }
      await at.shell.dispose();
    }
  });

  // The review of INF-5409: a door from before doors named their run says nobody's silence, so its
  // welcome that is never answered still gets its notice once the wait is over, and that notice
  // ends no run: it offers no Restart it, and its Start it here stops nothing, so the app starting
  // again finds the folder held and joins whichever run holds it.
  it("says a first mate behind a door that names no run is not answering, and ends no run for it", async () => {
    const command = silentRun();
    await command.open(null).settled();
    const holder = {
      pid: 44,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: holder, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.thisMac()).not.toHaveProperty("command.byWindow");
    // Its words say Start it here connects to it again, never that it stops it.
    const mac = at.shell.thisMac();
    const notice = mac.role === "home" ? mac.command : undefined;
    expect(notice).toMatchObject({ retries: true });
    expect(notice && COMMAND_NOTICE_WORDS.line(notice)).toBe(m.commandNoticeNotAnsweringRetry());
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.startHere()).toBe(true);
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.restart).not.toHaveBeenCalled();
    expect(at.starter.stop).not.toHaveBeenCalled();
    expect(at.starter.stops).toBe(0);
  });

  // The review of INF-5409: a first mate that welcomed the window and never answered is silent for
  // its own run alone. Where another run holds the folder once the wait is over, while the first
  // run's connection is still open, that other run is not called silent and nothing offers to end
  // it.
  it("calls no run silent that took the folder while another run's welcome waited for its answers", async () => {
    const command = silentRun();
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(1);
    const again = {
      pid: 42,
      startedAt: new Date(Date.now() + 1).toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    at.command.records = { running: true, run: again, lastStop: null };
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(at.shell.thisMac()).not.toHaveProperty("command");
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.startHere()).toBe(false);
    expect(at.starter.restart).not.toHaveBeenCalled();
    expect(at.starter.stop).not.toHaveBeenCalled();
  });

  // The review of INF-5409: the notice that a first mate does not answer is about the run that
  // timed out, so Start it here ends that run by force, never one that took the folder since.
  it("ends only the run its notice says does not answer on Start it here", async () => {
    const command = silentRun();
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    const again = {
      pid: 42,
      startedAt: new Date(Date.now() + 1).toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    at.command.records = { running: true, run: again, lastStop: null };
    expect(at.shell.startHere()).toBe(true);
    await expect
      .poll(() => at.starter.stop.mock.calls)
      .toEqual([[{ forget: false, force: { pid: first.pid, startedAt: first.startedAt } }]]);
  });

  // The review of INF-5409: a window that does not start the command stops one that does not
  // answer as Stop does, and Start it here then asks only the run its notice names to stop, by its
  // process and start, so a run started by hand in its place keeps going.
  it("asks only the run its notice names to stop on Start it here, with no starter", async () => {
    const command = silentRun();
    const first = { pid: 41, startedAt: new Date().toISOString() };
    await command.open(first).settled();
    const at = besideShell(command.doorDir, {
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    const byHand = { pid: 42, startedAt: new Date(Date.now() + 1).toISOString() };
    at.command.records = { running: true, run: byHand, lastStop: null };
    expect(at.shell.startHere()).toBe(true);
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.stopped).toEqual([first]);
  });

  // The review of INF-5409: the starter's service manager ends and starts again only the run its
  // own agent started, so over a silent run started by hand the notice is not the window's own: it
  // offers no Restart it, and Start it here asks that run alone to stop as Stop does.
  it("offers only a stop as Stop stops one over a silent run its agent did not start", async () => {
    const command = silentRun();
    const byHand = { pid: 41, startedAt: new Date().toISOString() };
    await command.open(byHand).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: byHand, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.thisMac()).not.toHaveProperty("command.byWindow");
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.startHere()).toBe(true);
    // The run asked to stop through the folder lets it go.
    at.command.records = { running: false, run: null, lastStop: null };
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.stopped).toEqual([byHand]);
    expect(at.starter.stop).not.toHaveBeenCalled();
    expect(at.starter.restart).not.toHaveBeenCalled();
  });

  // The review of INF-5409: a Restart it whose starter ended and started nothing, the run named no
  // longer being the one its agent holds, leaves the window as before the press at once: a run
  // started by hand there since is offered as before, never waited for as the run started again.
  // Its window is still connected to the run that did not answer, so nothing times the run there
  // from the records, and the notice names no run: past the next wait too, its Start it here
  // stops nothing and the app starting again connects to whichever run is there.
  it("stands as before the press when Restart it ended and started nothing", async () => {
    const command = silentRun();
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    const byHand = { pid: 50, startedAt: new Date(Date.now() + 1).toISOString() };
    // The run started by hand holds the folder by the press, while the window's connection is
    // still open to the run that did not answer, and the starter answers only past a reading of
    // the records and the answer wait: the run there, which nothing contacted, is never counted.
    let answer: () => void = () => {};
    at.starter.restart.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return "untouched" as const;
    });
    at.command.records = { running: true, run: byHand, lastStop: null };
    expect(at.shell.restartCommand()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(at.shell.thisMac()).toHaveProperty("command", {
      state: "waiting",
      ending: "restart",
      byWindow: true,
    });
    answer();
    await at.starter.restart.mock.results.at(-1)?.value;
    expect(at.shell.followsAdded()).toMatchObject({ joins: false, outside: true });
    const retry = { state: "stopped", ending: "not-answering", retries: true } as const;
    expect(at.shell.thisMac()).toHaveProperty("command", retry);
    // Past a reading of the records, a second apart, and the answer wait after it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(at.shell.thisMac()).toHaveProperty("command", retry);
    expect(COMMAND_NOTICE_WORDS.line(retry)).toBe(m.commandNoticeNotAnsweringRetry());
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.startHere()).toBe(true);
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.stop).not.toHaveBeenCalled();
    expect(at.starter.stopped).toEqual([]);
  });

  // The review of INF-5409: a Restart it that ended and started nothing while the records cannot
  // be read keeps naming the run that does not answer, since nothing says another holds the folder.
  // Its notice offers Restart it again only once the records read again and name that same run.
  it("keeps naming the silent run when Restart it started nothing and the records cannot be read", async () => {
    const command = silentRun();
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    at.starter.restart.mockImplementation(async () => {
      at.command.records = { running: null, run: null, lastStop: null };
      return "untouched" as const;
    });
    expect(at.shell.restartCommand()).toBe(true);
    await at.starter.restart.mock.results.at(-1)?.value;
    const named = { state: "stopped", ending: "not-answering" } as const;
    expect(at.shell.thisMac()).toHaveProperty("command", named);
    expect(at.shell.restartCommand()).toBe(false);
    // The records read again, naming that same run: Restart it is offered again.
    at.command.records = { running: true, run: first, lastStop: null };
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toHaveProperty("command", { ...named, byWindow: true });
    expect(at.shell.restartCommand()).toBe(true);
  });

  // The review of INF-5409: a notice that went up while the records could not be read could not
  // say whose run was silent, so it offered no Restart it. Once the records read again, past the
  // wait, its notice for that same run offers Restart it where the starter's own agent started it.
  it("offers Restart it once records that could not be read say the silent run is its agent's", async () => {
    const command = silentRun();
    const run = {
      pid: 42,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: run.pid, startedAt: run.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: null, run: null, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.thisMac()).not.toHaveProperty("command.byWindow");
    at.command.records = { running: true, run, lastStop: null };
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.starter.restart.mock.calls).toEqual([[{ pid: run.pid, startedAt: run.startedAt }]]);
  });

  // The review of INF-5409: a start this window asked ends only on a welcome from the run its own
  // agent started. A run started by hand that welcomes and leaves before that run writes its
  // record, as a delayed Windows start can, ends nothing: no join reads the folder as idle then.
  it("waits for the run it started past a welcome from a run started by hand", async () => {
    const pro = await otherMac({}, { joinsFromAnotherMac: true });
    const command = commandRun();
    const byHand = { pid: 40, startedAt: new Date().toISOString() };
    const at = besideShell(command.doorDir, {
      starts: true,
      records: { running: true, run: byHand, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
      startedAt: Date.now(),
      readyMs: 1,
    });
    await at.shell.start();
    await command.open(byHand).settled();
    await expect.poll(() => command.asked("inf:own-window:here").length).toBe(1);
    const starting = { follows: false, joins: false, pastes: false, outside: false };
    // It leaves, and the folder reads idle before the run this window started writes its record.
    await command.stop();
    at.command.records = { running: false, run: null, lastStop: null };
    expect(at.shell.followsAdded()).toEqual(starting);
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({
      ok: false,
      refused: "other",
    });
    // The run it started writes its record and welcomes the window: the join stops that run.
    const owned = {
      pid: 4321,
      startedAt: new Date(Date.now() + 1).toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    const door = { pid: owned.pid, startedAt: owned.startedAt };
    at.command.records = { running: true, run: owned, lastStop: null };
    await command.open(door).settled();
    await expect
      .poll(() => at.shell.followsAdded())
      .toEqual({ follows: false, joins: true, pastes: true, outside: false });
    await expect(at.shell.join(await pro.link("mac"))).resolves.toEqual({ ok: true });
    await expect.poll(() => at.shell.thisMac().role).toBe("view");
    expect(at.starter.stopped).toEqual([door]);
  });

  // The review of INF-5409: a first mate that answers its only welcome's first request late, while
  // Restart it is under way, is back on that same connection: a restart that did not happen leaves
  // it as it is, and the window stops counting it as silent.
  it("keeps a run that answered on its first connection while a refused Restart it was under way", async () => {
    const command = commandRun();
    const answer = command.run.dispatch.getMockImplementation();
    /** The window's first request at each welcome, answered once let go. */
    const heres: (() => void)[] = [];
    command.run.dispatch.mockImplementation(((channel: string, args: unknown[]) =>
      channel === "inf:own-window:here"
        ? new Promise((resolve) => heres.push(() => resolve({ ok: true })))
        : answer?.(channel as never, args as never)) as never);
    const first = {
      pid: 41,
      startedAt: new Date().toISOString(),
      agent: true as const,
      recovers: true as const,
    };
    await command.open({ pid: first.pid, startedAt: first.startedAt }).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      records: { running: true, run: first, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    let settle: (done: RestartOutcome) => void = () => {};
    at.starter.restart.mockImplementation(
      () =>
        new Promise<RestartOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    expect(at.shell.restartCommand()).toBe(true);
    expect(at.starter.restart.mock.calls).toEqual([
      [{ pid: first.pid, startedAt: first.startedAt }],
    ]);
    // The window handled its answers once it started its pages over on them.
    const restarts = at.restartWindows.mock.calls.length;
    heres[0]?.();
    await expect.poll(() => at.restartWindows.mock.calls.length).toBe(restarts + 1);
    settle("failed");
    // Past two readings of the records, a second apart, each longer than the wait for its answers,
    // nothing says it is silent again.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(at.shell.thisMac()).not.toHaveProperty("command");
    expect(command.asked("inf:own-window:here")).toHaveLength(1);
    expect(at.shell.followsAdded()).toMatchObject({ joins: true, pastes: true });
  });

  // The review of INF-5409: records that cannot be read say nothing of a command started outside
  // the window, so the window neither offers a join nor tells the person to stop one.
  it("offers no join and names no outside command while the command's records cannot be read", async () => {
    const command = commandRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      records: { running: null, run: null, lastStop: null },
    });
    await at.start();
    expect(at.shell.followsAdded()).toEqual({
      follows: false,
      joins: false,
      pastes: false,
      outside: false,
    });
    // Nor beside a command this window does not start, whose records cannot be read either.
    const alone = besideShell(command.doorDir, {
      records: { running: null, run: null, lastStop: null },
    });
    await alone.start();
    expect(alone.shell.followsAdded()).toMatchObject({ joins: false, outside: false });
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
      expect(at.shell.followsAdded()).toEqual({
        follows: owned !== null,
        joins: owned !== null,
        pastes: owned !== null,
        outside: owned === null,
      });
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
    expect(at.shell.followsAdded()).toEqual({
      follows: false,
      joins: false,
      pastes: false,
      outside: true,
    });
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
