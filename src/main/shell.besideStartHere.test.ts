import { COMMAND_NOTICE_WORDS } from "@shared/commandNotice";
import * as m from "@shared/i18n/messages.generated";
import { describe, expect, it } from "vitest";
import { besideShell, silentRun } from "../../tests/helpers/besideShell";
import { stopEachTest } from "../../tests/helpers/shellStandIns";
import { ownedRunOf } from "./runCommand";

/**
 * Start it here over a command that runs and does not answer (docs/run.md, "A command that runs
 * and does not answer"), against the stand-ins in `tests/helpers/besideShell.ts`: what the
 * window waits for before it starts here, and what it sends meanwhile.
 */

stopEachTest();

describe("Start it here over a silent command", () => {
  // The review of INF-5409: only a force stop that ended the run lets the window starting here
  // retire the job. A run gone before the press, or one that ended on its own after its stop was
  // written and before it claimed it, was ended by nothing, so the job stays as it is.
  it("leaves the job in place where the run went without its force stop ending it", async () => {
    for (const ended of ["untouched", "gone"] as const) {
      const command = silentRun();
      await command.open().settled();
      const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
      await at.shell.start();
      await expect
        .poll(() => at.shell.thisMac())
        .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
      at.starter.stop.mockImplementation(async () => {
        at.command.records = { running: false, run: null, lastStop: null };
        return ended;
      });
      expect(at.shell.startHere()).toBe(true);
      await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    }
  });

  // The review of INF-5409: a force stop the run claimed is waited for until it ended or was
  // declined, so the starter has not answered meanwhile. Through every reading of the records and
  // past the wait for an answer, Restart it keeps waiting under its notice, offering neither button
  // nor a join; Start it here keeps its wait, and starts here only once its stop ended the run.
  it("keeps Restart it pending while its force stop is still waited for", async () => {
    const command = silentRun();
    await command.open().settled();
    const at = besideShell(command.doorDir, { starts: true, readyMs: 2_000, answerWaitMs: 200 });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    let restarted: (outcome: "failed") => void = () => {};
    at.starter.restart.mockImplementation(() => new Promise((resolve) => (restarted = resolve)));
    expect(at.shell.restartCommand()).toBe(true);
    await expect.poll(() => at.starter.restart.mock.calls.length).toBe(1);
    // Past a reading of the records and the wait for an answer.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(at.shell.thisMac()).toMatchObject({ command: { state: "waiting", ending: "restart" } });
    expect(at.shell.followsAdded()).toMatchObject({ joins: false, pastes: false });
    expect(at.shell.startHere()).toBe(false);
    expect(at.shell.restartCommand()).toBe(false);
    // Declined, the run still runs and does not answer: its notice offers Restart it again.
    restarted("failed");
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
  });

  it("keeps Start it here pending while its force stop is still waited for", async () => {
    const second = silentRun();
    await second.open().settled();
    const here = besideShell(second.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      stopWaitMs: 300,
    });
    await here.shell.start();
    await expect
      .poll(() => here.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering", byWindow: true } });
    let stopped: (ended: "ended") => void = () => {};
    here.starter.stop.mockImplementation(() => new Promise((resolve) => (stopped = resolve)));
    expect(here.shell.startHere()).toBe(true);
    await expect.poll(() => here.starter.stop.mock.calls.length).toBe(1);
    // Past a reading of the records and the wait for a stopped run.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(here.shell.thisMac()).toMatchObject({
      command: { state: "waiting", ending: "not-answering" },
    });
    expect(here.relaunch).not.toHaveBeenCalled();
    expect(here.shell.restartCommand()).toBe(false);
    expect(here.shell.startHere()).toBe(false);
    here.command.records = { running: false, run: null, lastStop: null };
    stopped("ended");
    await expect
      .poll(() => here.relaunch.mock.calls)
      .toEqual([[{ startHere: true, letGoJob: true }]]);
  });

  // The review of INF-5409: Start it here starts this window again only once the run its notice
  // names let the folder go. Asked to stop through the folder, a run that still holds it when the
  // wait is over is never joined again in place of starting here: the notice offers Start it here
  // again, and nothing else is sent meanwhile.
  it("starts here only once the run asked to stop let the folder go, and offers Start it here again where it did not", async () => {
    const command = silentRun();
    const byHand = { pid: 41, startedAt: new Date().toISOString() };
    await command.open(byHand).settled();
    const at = besideShell(command.doorDir, {
      starts: true,
      readyMs: 2_000,
      answerWaitMs: 200,
      stopWaitMs: 600,
      records: { running: true, run: byHand, lastStop: null },
      ownedRun: (status) => ownedRunOf(status),
    });
    await at.shell.start();
    await expect
      .poll(() => at.shell.thisMac())
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.shell.startHere()).toBe(true);
    // While the window waits for the run to let the folder go, the notice says so and offers
    // nothing but Quit.
    const waiting = { state: "waiting", ending: "not-answering" } as const;
    expect(at.shell.thisMac()).toHaveProperty("command", waiting);
    expect(COMMAND_NOTICE_WORDS.line(waiting)).toBe(m.commandNoticeStopping());
    expect(at.shell.startHere()).toBe(false);
    expect(at.shell.restartCommand()).toBe(false);
    await expect
      .poll(() => at.shell.thisMac(), { timeout: 5_000 })
      .toMatchObject({ command: { state: "stopped", ending: "not-answering" } });
    expect(at.relaunch).not.toHaveBeenCalled();
    expect(at.starter.stopped).toEqual([byHand]);
    // Pressed again, the run lets the folder go while the window waits: it starts here then.
    expect(at.shell.startHere()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(at.relaunch).not.toHaveBeenCalled();
    at.command.records = { running: false, run: null, lastStop: null };
    await expect.poll(() => at.relaunch.mock.calls).toEqual([[{ startHere: true }]]);
    expect(at.starter.stopped).toEqual([byHand, byHand]);
  });

  // The review of INF-5409: Start it here over a silent run is one recovery. Until the app starts
  // again, a second press, Restart it and a join are refused, so its starter is asked to end that
  // run once and nothing else is sent meanwhile.
  it("sends nothing more while Start it here is stopping a silent run", async () => {
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
    // The run takes its time to end.
    at.starter.stop.mockImplementation(() => new Promise(() => {}));
    expect(at.shell.startHere()).toBe(true);
    expect(at.shell.startHere()).toBe(false);
    expect(at.shell.restartCommand()).toBe(false);
    expect(at.shell.followsAdded()).toMatchObject({ joins: false });
    const force = { forget: false, force: { pid: first.pid, startedAt: first.startedAt } };
    expect(at.starter.stop.mock.calls).toEqual([[force]]);
    expect(at.starter.restart).not.toHaveBeenCalled();
  });
});
