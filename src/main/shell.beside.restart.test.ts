import { join } from "node:path";
import type { HomeLink } from "@core/devices/homeLink";
import type { RestartOutcome } from "@core/helper/runAgent";
import { COMMAND_NOTICE_WORDS } from "@shared/commandNotice";
import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import {
  besideShell,
  commandRun,
  grantFrom,
  JOINED,
  OWNED,
  type Records,
  silentRun,
  stopped,
} from "../../tests/helpers/besideShell";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { otherMac, stopEachTest } from "../../tests/helpers/shellStandIns";
import { type OwnedRun, ownedRunOf } from "./runCommand";

/**
 * The window beside a command's first mate when the command does not answer, restarts, or
 * is left for another computer (docs/run.md), against the stand-ins in
 * `tests/helpers/besideShell.ts`. The rest of that window's tests are in `shell.beside.test.ts`.
 */

stopEachTest();

describe("the window beside a command's first mate, restarts and joins", () => {
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
    // That first mate lists `join-by-address-reach`, so it is asked where a refusal stopped too.
    expect(command.asked("inf:devices:link-at")).toEqual([
      ["kun@studio", { confirm: "ED25519 SHA256:abc", reach: true }],
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
});
