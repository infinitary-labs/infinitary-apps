/**
 * Where a task runs, as the crew's placement reads and says it (docs/helper.md,
 * "Runs on" and "A task's own Runs on"; `TaskPlacement`). These cases pin the
 * behaviour no other test reaches: the wait for a computer on an older
 * version, the wait of a task with no project for a computer too old to take
 * one, a lost start's reconciliation, whether a placed task's turn is
 * running, and the refusals and Details words of a task's own Runs on. Each
 * drives a public door of the supervisor or its placement and reads the
 * record, the feed and the words.
 */

import { HERE } from "@shared/deviceNames";
import { deviceForgeGateRef, updateWaitLine } from "@shared/deviceSetup";
import {
  noNewWorkDayLine,
  noNewWorkStartRefusal,
  noNewWorkWaitLine,
} from "@shared/deviceUpdateNudge";
import type { FmEvent } from "@shared/events";
import { AUTOMATIC_COMPUTER, AUTOMATIC_WORD, UNCOMPARED_WAIT } from "@shared/placement";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { RUNS_ON_SOURCE_WORDS } from "@shared/taskPolicies";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { deferred } from "../../../tests/helpers/deferred";
import type { CrewMachines } from "../placed/crewMachines";
import { LOCAL_MACHINE_ID } from "../session/session";
import { seedTask } from "../tasks/seedTask";
import { UNCONFIRMED_START_RETURNED } from "../tasks/taskStarts";
import { QUIT_SETTLE_MS } from "./crewRuntime";
import { PLACED_WAIT_DAY_MS } from "./taskPlacement";

fakeCrewTimersEachTest();

const MINI = "mini";
const MINI_NAME = "Mac mini";

/** One computer that runs work, as the crew reads it; `reach.now` says whether it is in reach. */
function oneComputer(options: { takesRepoless?: boolean } = {}) {
  const reach = { now: false };
  const machines = {
    computers: () => [MINI],
    ready: () => reach.now,
    nameOf: () => MINI_NAME,
    placeOf: () => ({ label: MINI_NAME, where: `on ${MINI_NAME}`, who: MINI_NAME }),
    signInWait: () => undefined,
    signInsOf: async () => undefined,
    takesRepoless: () => options.takesRepoless ?? true,
    served: async () => undefined,
    accountOf: () => undefined,
    cutOffOf: () => undefined,
  } as unknown as CrewMachines;
  return { machines, reach };
}

function feed(events: FmEvent[]): string[] {
  return events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
}

describe("where a task runs", () => {
  it("says once that a task waits for a computer on an older version, brings back its Update card, and says so again after a day", async () => {
    let at = 1_000_000;
    const recallUpdateCard = vi.fn();
    const { machines } = oneComputer();
    const { supervisor, tasks, events } = setup(fakeCrewmate(), {
      machines,
      now: () => at,
      takesNoWorkUntilUpdated: (device) => device === MINI,
      recallUpdateCard,
    });
    seedTask(tasks, {
      id: "t-older",
      title: "Footer",
      status: "queued",
      repoId: null,
      shape: { kind: "unclear", runs_on_ask: MINI },
    });

    await supervisor.starts.dispatchQueuedTask("t-older");
    await supervisor.starts.dispatchQueuedTask("t-older");
    expect(tasks.get("t-older")).toMatchObject({ status: "open", deviceId: MINI });
    expect(feed(events)).toEqual([noNewWorkWaitLine('"Footer"', MINI_NAME)]);
    expect(recallUpdateCard.mock.calls).toEqual([[MINI]]);
    const record = tasks.get("t-older");
    expect(record && supervisor.placement.taskPlace(record)).toEqual({
      name: MINI_NAME,
      where: `on ${MINI_NAME}`,
      reach: "out-of-reach",
      noNewWork: true,
    });

    at += PLACED_WAIT_DAY_MS;
    await supervisor.starts.dispatchQueuedTask("t-older");
    await supervisor.starts.dispatchQueuedTask("t-older");
    expect(feed(events).slice(1)).toEqual([
      noNewWorkDayLine(MINI_NAME, '"Footer"'),
      `To run it here instead, ask your first mate to run "Footer" on ${HERE.this}.`,
    ]);
    expect(recallUpdateCard).toHaveBeenCalledTimes(1);
  });

  // INF-5442 behavior 3: this Mac already knew its work computer had to be
  // updated before it could take a turn, and a new task still started there,
  // made its working copy and then waited. A computer in reach that takes no
  // new work until it is updated holds the task before it starts.
  it("holds a task for a computer in reach that takes no new work until it is updated, before it starts there", async () => {
    const recallUpdateCard = vi.fn();
    const { machines, reach } = oneComputer();
    reach.now = true;
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate, {
      machines,
      takesNoWorkUntilUpdated: (device) => device === MINI,
      recallUpdateCard,
    });
    seedTask(tasks, {
      id: "t-behind",
      title: "Header",
      status: "queued",
      repoId: null,
      shape: { kind: "unclear", runs_on_ask: MINI },
    });

    const claimed = vi.spyOn(tasks.starts, "claimForDispatch");
    await supervisor.starts.dispatchQueuedTask("t-behind");
    await supervisor.starts.dispatchQueuedTask("t-behind");
    await tick();
    // It never claims its start there, so no working copy is made there.
    expect(claimed).not.toHaveBeenCalled();
    expect(tasks.get("t-behind")).toMatchObject({ status: "open", deviceId: MINI });
    expect(crewmate.promptCalls).toHaveLength(0);
    expect(feed(events)).toEqual([noNewWorkWaitLine('"Header"', MINI_NAME)]);
    expect(recallUpdateCard.mock.calls).toEqual([[MINI]]);
    const record = tasks.get("t-behind");
    expect(record && supervisor.placement.taskPlace(record)).toMatchObject({ noNewWork: true });
  });

  // The captain's Start of a backlog task held there is a wait, never a failed start.
  it("keeps the captain's Start of a backlog task for a computer in reach that takes no new work as a wait, never a failed start", async () => {
    const { machines, reach } = oneComputer();
    reach.now = true;
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, {
      machines,
      takesNoWorkUntilUpdated: (device) => device === MINI,
    });
    seedTask(tasks, {
      id: "t-asked",
      title: "Header",
      status: "queued",
      repoId: null,
      shape: { kind: "unclear", runs_on_ask: MINI },
      startPolicy: "on-request",
    });

    const said = await supervisor.starts.startQueuedNow("t-asked", {
      audience: "captain",
      direct: true,
    });
    const key = tasks.get("t-asked")?.key;
    expect(said).toBe(noNewWorkStartRefusal(`${key} "Header"`, MINI_NAME, HERE.this));
    expect(crewmate.promptCalls).toHaveLength(0);
    // Not returned to Backlog with Could not start: it waits there for the update.
    expect(tasks.get("t-asked")?.startNotice).toBeFalsy();
    expect(tasks.starts.startAttemptOf("t-asked")).toBeUndefined();
    expect(tasks.get("t-asked")).toMatchObject({ status: "open", deviceId: MINI });
  });

  it("holds a task with no project for a computer too old to take one, and says so once", async () => {
    const { machines, reach } = oneComputer({ takesRepoless: false });
    reach.now = true;
    const crewmate = fakeCrewmate();
    const { supervisor, tasks, events } = setup(crewmate, { machines });
    seedTask(tasks, {
      id: "t-repoless",
      title: "Notes",
      status: "queued",
      repoId: null,
      shape: { kind: "unclear", runs_on_ask: MINI },
    });

    await supervisor.starts.dispatchQueuedTask("t-repoless");
    await supervisor.starts.dispatchQueuedTask("t-repoless");
    expect(tasks.get("t-repoless")).toMatchObject({ status: "open", deviceId: MINI });
    expect(feed(events)).toEqual([updateWaitLine(MINI_NAME, '"Notes"')]);
    expect(crewmate.promptCalls).toHaveLength(0);
  });

  it("settles each lost start once contact is back: a recorded session started, none returns it to the queue, and one on a computer still out of reach keeps waiting", async () => {
    const { machines, reach } = oneComputer();
    const { supervisor, tasks } = setup(fakeCrewmate(), { machines });
    /** A start accepted, claimed, then cut off before its session was confirmed. */
    const lost = (id: string, device?: string) => {
      seedTask(tasks, {
        id,
        title: id,
        status: "queued",
        repoId: null,
        ...(device ? { deviceId: device } : {}),
      });
      expect(tasks.starts.beginStartAttempt(id)).toBe(true);
      expect(tasks.starts.claimForDispatch(id)).toBe(true);
      tasks.starts.markStartChecking(id);
    };
    lost("t-here");
    lost("t-recorded");
    tasks.turns.setSessionFile("t-recorded", "session-1");
    lost("t-away", MINI);

    supervisor.reconcileCutOffs();
    // None recorded here: back to open work, with no failure, and Start is offered again.
    expect(tasks.get("t-here")).toMatchObject({ status: "open", startNotice: null });
    expect(tasks.starts.startAttemptOf("t-here")).toBeUndefined();
    expect(tasks.timeline("t-here").map((event) => event.text)).toContain(
      UNCONFIRMED_START_RETURNED,
    );
    expect(tasks.starts.startAttemptOf("t-recorded")).toBeUndefined();
    expect(tasks.get("t-recorded")?.status).toBe("active");
    expect(tasks.starts.startAttemptOf("t-away")?.phase).toBe("checking");
    expect(tasks.get("t-away")?.status).toBe("active");

    // That computer is back with no session recorded: it did not start.
    reach.now = true;
    supervisor.reconcileCutOffs();
    expect(tasks.starts.startAttemptOf("t-away")).toBeUndefined();
    expect(tasks.get("t-away")?.status).toBe("open");
  });

  it("calls a placed task's turn running only while it streams and its computer is in reach", async () => {
    const { machines, reach } = oneComputer();
    reach.now = true;
    const crewmate = fakeCrewmate();
    const { supervisor, tasks } = setup(crewmate, { machines });
    const { taskId } = await supervisor.intake.commission({
      title: "Fix the meter",
      intent: intentOf("Fix the meter's unit."),
    });
    await tick();
    const running = () => {
      const record = tasks.get(taskId);
      return record ? supervisor.placement.placementRunning(record) : undefined;
    };
    expect(running()).toBe(true);
    tasks.placement.setDevice(taskId, MINI);
    expect(running()).toBe(true);
    reach.now = false;
    expect(running()).toBe(false);
    reach.now = true;
    crewmate.finishPrompt();
    await tick();
    expect(running()).toBe(false);
  });

  it("refuses a task's own Runs on for closed work, a project the record lacks, and Automatic without a project", () => {
    const { machines } = oneComputer();
    const { supervisor, tasks } = setup(fakeCrewmate(), { machines });
    seedTask(tasks, { id: "t-closed", title: "Old", status: "cancelled", repoId: null });
    seedTask(tasks, { id: "t-lost", title: "Lost", status: "queued", repoId: "gone" });
    seedTask(tasks, { id: "t-free", title: "Free", status: "queued", repoId: null });
    const handle = (id: string) => `${tasks.get(id)?.key} "${tasks.get(id)?.title}"`;

    expect(supervisor.placement.runsOnRefusal("t-closed", MINI)).toBe(
      `${handle("t-closed")} is not open work, so where it runs cannot change.`,
    );
    expect(supervisor.placement.runsOnRefusal("t-lost", MINI)).toBe(
      `${handle("t-lost")} has no project, so it runs on ${HERE.this}.`,
    );
    expect(supervisor.placement.runsOnRefusal("t-free", AUTOMATIC_COMPUTER)).toBe(
      "Automatic needs a project that can run on another computer.",
    );
    expect(supervisor.placement.runsOnRefusal("t-free", MINI)).toBeUndefined();
    expect(supervisor.placement.runsOnRefusal("t-free", RUNS_ON_THIS_MAC)).toBeUndefined();
  });

  it("names where a task runs in Details only once a computer is listed and the task can follow one", () => {
    const listed = { now: false };
    const machines = {
      ...oneComputer().machines,
      computers: () => (listed.now ? [MINI] : []),
    } as unknown as CrewMachines;
    const { supervisor, tasks } = setup(fakeCrewmate(), { machines });
    seedTask(tasks, {
      id: "t-asked",
      title: "Asked",
      status: "queued",
      repoId: null,
      shape: { kind: "unclear", runs_on_ask: MINI },
    });
    seedTask(tasks, {
      id: "t-part",
      title: "Part",
      status: "queued",
      repoId: null,
      parentId: "t-asked",
    });
    seedTask(tasks, { id: "t-free", title: "Free", status: "queued", repoId: null });
    seedTask(tasks, { id: "t-lost", title: "Lost", status: "queued", repoId: "gone" });
    const fact = (id: string) => {
      const record = tasks.get(id);
      return record && supervisor.placement.runsOnFact(record);
    };

    // No computer that runs work is listed: nothing to say.
    expect(fact("t-asked")).toBeUndefined();
    listed.now = true;
    expect(fact("t-asked")).toEqual({ label: MINI_NAME, source: "task" });
    expect(fact("t-part")).toEqual({ label: MINI_NAME, source: "parent" });
    // A task with no project nobody asked about, and one whose project runs only here.
    expect(fact("t-free")).toBeUndefined();
    expect(fact("t-lost")).toBeUndefined();
    expect(supervisor.placement.runsOnWords("t-free", MINI)).toBe(
      `${MINI_NAME} (${RUNS_ON_SOURCE_WORDS.task})`,
    );
    expect(supervisor.placement.runsOnWords("t-free", null)).toBe(HERE.This);
  });

  it("says why a task on Automatic has no computer yet, by how it starts", () => {
    const { machines } = oneComputer();
    const { supervisor, tasks } = setup(fakeCrewmate(), {
      automatic: { choose: async () => undefined },
      machines,
    });
    const shape = { kind: "unclear" as const, runs_on_ask: AUTOMATIC_COMPUTER };
    seedTask(tasks, { id: "t-ready", title: "Ready", status: "queued", repoId: null, shape });
    seedTask(tasks, {
      id: "t-asked",
      title: "Asked",
      status: "queued",
      repoId: null,
      shape,
      startPolicy: "on-request",
    });
    const fact = (id: string) => {
      const record = tasks.get(id);
      return record && supervisor.placement.runsOnFact(record);
    };

    expect(fact("t-ready")).toEqual({
      label: AUTOMATIC_WORD,
      source: "task",
      reason: UNCOMPARED_WAIT.words,
    });
    expect(fact("t-asked")).toEqual({
      label: AUTOMATIC_WORD,
      source: "task",
      reason: "Your first mate chooses a computer when this task starts. It stays there.",
    });
  });

  it("tells a crewmate and the first mate to hand the captain files on a card only where that computer takes them (INF-3757)", () => {
    // An older computer's emit_card has no files: its crewmate keeps the old way.
    const takes = { now: false };
    const machines = {
      ...oneComputer().machines,
      takesCardFiles: () => takes.now,
    } as unknown as CrewMachines;
    const { supervisor } = setup(fakeCrewmate(), { machines });
    expect(supervisor.placement.computersFor(MINI).computers?.cardFiles).toBe(false);
    expect(supervisor.placement.everyComputerTakesCardFiles()).toBe(false);
    // A crewmate on the home always has them.
    expect(supervisor.placement.computersFor(LOCAL_MACHINE_ID).computers).not.toHaveProperty(
      "cardFiles",
    );
    takes.now = true;
    expect(supervisor.placement.computersFor(MINI).computers).not.toHaveProperty("cardFiles");
    expect(supervisor.placement.everyComputerTakesCardFiles()).toBe(true);
  });

  // Intent: INF-4461, main's failing check - docs/helper.md, "A quit lifts no
  // more of these gates". A computer's new sign-in starts the tasks held for
  // it one after another; a quit during one of those starts, after which the
  // host closes its database, leaves the rest held for that computer's next
  // report instead of lifting a hold in the closed database, which reached
  // nobody and made an unheard rejection.
  it("lifts no more holds for a computer's own sign-in once a quit came during one held task's start", async () => {
    const reached = deferred<void>();
    const held = deferred<void>();
    const { supervisor, tasks, sessions, db } = setup(fakeCrewmate());
    vi.mocked(sessions.open).mockImplementationOnce(async () => {
      reached.resolve();
      await held.promise;
      throw new Error("This computer is stopping.");
    });
    const ref = deviceForgeGateRef("gitlab.com", MINI);
    for (const id of ["t-first", "t-second"])
      seedTask(tasks, {
        id,
        title: "website",
        prompt: "Fix the footer.",
        status: "queued",
        gate: { kind: "captain", ref },
      });
    const resuming = supervisor.placement.resumeDeviceForgeSignInTasks(MINI, "gitlab.com");
    await reached.promise;
    const quitting = supervisor.disposeAll();
    await vi.advanceTimersByTimeAsync(QUIT_SETTLE_MS);
    await quitting;
    expect(tasks.listOpen().filter((record) => record.gate?.ref === ref)).toHaveLength(1);
    db.close();
    held.resolve();
    await expect(resuming).resolves.toBeUndefined();
  });
});
