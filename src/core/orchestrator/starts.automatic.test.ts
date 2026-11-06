/**
 * Starting a task on Automatic (`CrewStarts`; docs/helper.md, "Runs
 * on"): a task started on the model the captain named while its computer is
 * chosen, and the wait Activity shows while Automatic finds a computer.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The cases drive real git.
 */
import { execFileSync } from "node:child_process";
import type { FmEvent } from "@shared/events";
import {
  AUTOMATIC_COMPUTER,
  type PlacementWait,
  type PlacementWaitRow,
  placementWait,
} from "@shared/placement";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  reboot,
  setup,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { AutomaticPlacement } from "../placed/automaticPlacement";
import type { CrewMachines } from "../placed/crewMachines";
import { FIRSTMATE_RECIPIENT, INBOX_DEDUPE_WINDOW_MS } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the task graph (R1)", () => {
  it("starts an Automatic task on a model the captain named while its computers were compared (INF-83)", async () => {
    const dir = scratchDir("infinitary-automatic-named-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    let compared!: () => void;
    const comparing = new Promise<void>((resolve) => {
      compared = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: WorkShape[] = [];
    const { supervisor, repos, tasks, sessionSpecs, events } = setup(fakeCrewmate(), {
      automatic: {
        choose: async (record, _repo, _prompt, shape) => {
          asked.push(shape);
          if (asked.length === 1) {
            compared();
            await held;
          }
          // As AutomaticPlacement's own check: late facts never overrule a changed task.
          if (JSON.stringify(tasks.get(record.id)?.shape) !== JSON.stringify(record.shape))
            return undefined;
          const model = shape.override_model_id ?? "mock-1";
          return {
            computerId: null,
            routed: { choice: { provider: "fm-mock", id: model }, bucket: "high", rule: "R8" },
          };
        },
      },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "footer",
      title: "Fix the ledger footer",
      repoId: repo.id,
      status: "queued",
      startPolicy: "on-request",
    });
    const starting = supervisor.starts.startQueuedNow(task.id);
    await comparing;
    tasks.updateFields(task.id, { model: "mock-2" }, "firstmate");
    release();
    await starting;
    // Compared again on the model named, and started on it: the captain's
    // Start is not turned into a wait for room.
    expect(asked.map((shape) => shape.override_model_id)).toEqual([undefined, "mock-2"]);
    expect(sessionSpecs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-2" });
    expect(tasks.get(task.id)?.status).toBe("active");
    expect(
      events.some((event) => event.type === "firstmate_note" && event.taskId === task.id),
    ).toBe(false);
  });

  // Intent: INF-409's goal - a task whose Runs on changes while its start
  // waits on a computer starts where it now runs, routed there.
  it("starts an Automatic task here, routed here, when the captain runs it on this computer while its computers were compared (INF-409)", async () => {
    const dir = scratchDir("infinitary-automatic-moved-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    let compared!: () => void;
    const comparing = new Promise<void>((resolve) => {
      compared = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const { supervisor, repos, tasks, sessionSpecs, events } = setup(fakeCrewmate(), {
      // This Mac's own routing, which a start here asks.
      routedModel: { provider: "fm-mock", id: "mock-here" },
      automatic: {
        choose: async (record) => {
          asked += 1;
          compared();
          await held;
          // As AutomaticPlacement's own check: late facts never overrule a changed task.
          if (JSON.stringify(tasks.get(record.id)?.shape) !== JSON.stringify(record.shape))
            return undefined;
          return {
            computerId: null,
            routed: { choice: { provider: "fm-mock", id: "mock-1" }, bucket: "high", rule: "R8" },
          };
        },
      },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "footer",
      title: "Fix the ledger footer",
      repoId: repo.id,
      status: "queued",
      startPolicy: "on-request",
    });
    const starting = supervisor.starts.startQueuedNow(task.id);
    await comparing;
    // As update_task does with runs_on this-mac, which a task not yet claimed accepts.
    expect(supervisor.placement.runsOnRefusal(task.id, RUNS_ON_THIS_MAC)).toBeUndefined();
    tasks.updateFields(
      task.id,
      { runsOn: { ask: RUNS_ON_THIS_MAC, words: "This computer (This task)" } },
      "firstmate",
    );
    supervisor.placement.runsOnChanged(task.id);
    release();
    expect(await starting).toBe(`Started ${tasks.get(task.id)?.key} "Fix the ledger footer".`);
    // It no longer runs on Automatic: never compared again, never told to
    // wait for room, and routed among this Mac's own subscriptions.
    expect(asked).toBe(1);
    expect(sessionSpecs[0]?.model).toEqual({ provider: "fm-mock", id: "mock-here" });
    expect(tasks.get(task.id)).toMatchObject({ status: "active", deviceId: null });
    expect(tasks.get(task.id)?.shape?.placement_wait).toBeUndefined();
    expect(
      events.some((event) => event.type === "firstmate_note" && event.taskId === task.id),
    ).toBe(false);
  });
});

/**
 * INF-67's F1 (decided: no spam in Activity): an Automatic wait's words come
 * from each comparison's live readings, so they change from one sweep to the
 * next, and every line about a task is a row in its Activity. A wait says so
 * once, and again only when its kind changes; Details keep the latest words.
 */
describe("an Automatic wait in Activity", () => {
  const STANDARD = { cpu: 0.5, memoryBytes: 2 * 1024 ** 3 };
  /** This computer's comparison, through the words' own owner. */
  const compared = (row: Partial<PlacementWaitRow>): PlacementWait =>
    placementWait([{ name: "This Mac", rejections: [], capacity: null, ...row }], STANDARD);

  it("says a wait again only when its kind changes, while Details read its latest words", async () => {
    const dir = scratchDir("infinitary-automatic-wait-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    const waits = [
      compared({ rejections: ["resources-stale"] }),
      compared({ rejections: ["project-unknown"] }),
      compared({ rejections: ["cpu-busy"], capacity: { cpu: 0.2, memoryBytes: 5 * 1024 ** 3 } }),
      compared({
        rejections: ["cpu-busy", "memory-busy"],
        capacity: { cpu: 0.2, memoryBytes: 5 * 1024 ** 3 },
      }),
    ];
    let next = 0;
    const { supervisor, repos, tasks, events } = setup(fakeCrewmate(), {
      // A later comparison reads as the last one did.
      automatic: {
        choose: async () => ({ wait: waits[Math.min(next++, waits.length - 1)] as PlacementWait }),
      },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "footer",
      title: "Fix the ledger footer",
      repoId: repo.id,
      status: "queued",
      startPolicy: "when-ready",
    });
    const lines = () =>
      events.flatMap((event) =>
        event.type === "firstmate_note" && event.taskId === task.id ? [event.text] : [],
      );
    const details = () => supervisor.placement.runsOnFact(tasks.get(task.id) as TaskRecord)?.reason;
    const [stale, unknown, busy, held] = waits as [
      PlacementWait,
      PlacementWait,
      PlacementWait,
      PlacementWait,
    ];
    // Two other reasons, then processing capacity, then processing capacity
    // with memory set aside for other starts: two kinds, four sets of words.
    expect([stale.kind, unknown.kind, busy.kind, held.kind]).toEqual([
      "other",
      "other",
      "room",
      "room",
    ]);
    expect(new Set(waits.map((wait) => wait.words)).size).toBe(4);

    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(lines()).toEqual([`"Fix the ledger footer": ${stale.words}`]);
    expect(details()).toBe(stale.words);

    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(lines()).toHaveLength(1);
    expect(details()).toBe(unknown.words);

    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(lines()).toEqual([
      `"Fix the ledger footer": ${stale.words}`,
      `"Fix the ledger footer": ${busy.words}`,
    ]);
    expect(details()).toBe(busy.words);

    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(lines()).toHaveLength(2);
    expect(details()).toBe(held.words);
    // Start now answers with the latest words too, and says nothing new in Activity.
    expect(await supervisor.starts.startQueuedNow(task.id)).toContain(`: ${held.words}`);
    expect(lines()).toHaveLength(2);
  });

  // INF-67's R1: under load the quarter-second processor reading flickers,
  // so one sweep reads processing capacity short and the next only memory.
  it("says a wait for room once while memory stays short and the processor reading flickers", async () => {
    const dir = scratchDir("infinitary-automatic-room-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    const GIB = 1024 ** 3;
    const waits = [
      compared({
        rejections: ["cpu-busy", "memory-busy"],
        capacity: { cpu: 0.2, memoryBytes: GIB },
      }),
      compared({ rejections: ["memory-busy"], capacity: { cpu: 4.9, memoryBytes: GIB } }),
      compared({
        rejections: ["cpu-busy", "memory-busy"],
        capacity: { cpu: 0.2, memoryBytes: GIB },
      }),
      // The typecheck ended; another task that is starting still holds its room.
      compared({ rejections: ["memory-busy"], capacity: { cpu: 4.9, memoryBytes: 3 * GIB } }),
    ];
    let next = 0;
    const { supervisor, repos, tasks, events } = setup(fakeCrewmate(), {
      automatic: { choose: async () => ({ wait: waits[next++] as PlacementWait }) },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "totals",
      title: "Fix the ledger totals",
      repoId: repo.id,
      status: "queued",
      startPolicy: "when-ready",
    });
    const lines = () =>
      events.flatMap((event) =>
        event.type === "firstmate_note" && event.taskId === task.id ? [event.text] : [],
      );
    const details = () => supervisor.placement.runsOnFact(tasks.get(task.id) as TaskRecord)?.reason;
    // Three sets of words across four sweeps, each naming its own check.
    expect(new Set(waits.map((wait) => wait.words)).size).toBe(3);
    for (const wait of waits) {
      await supervisor.starts.dispatchQueuedTask(task.id);
      expect(details()).toBe(wait.words);
    }
    expect(lines()).toEqual([`"Fix the ledger totals": ${waits[0]?.words}`]);
  });

  // INF-416 piece F (T5): the words lived in supervisor memory, so a restart
  // forgot them and said the line again. They are not the could-not-start notice.
  it("keeps one line and its words across a restart", async () => {
    const dir = scratchDir("infinitary-automatic-restart-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    const wait = compared({
      rejections: ["cpu-busy"],
      capacity: { cpu: 0.2, memoryBytes: 5 * 1024 ** 3 },
    });
    const { supervisor, repos, tasks, events, db, paths, workspace } = setup(fakeCrewmate(), {
      automatic: { choose: async () => ({ wait }) },
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "restart-wait",
      title: "Fix the ledger header",
      repoId: repo.id,
      status: "queued",
      startPolicy: "when-ready",
    });
    const lines = () =>
      events.flatMap((event) =>
        event.type === "firstmate_note" && event.taskId === task.id ? [event.text] : [],
      );
    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(lines()).toEqual([`"Fix the ledger header": ${wait.words}`]);
    expect(tasks.get(task.id)?.startNotice ?? null).toBeNull();
    const savedWait = tasks.get(task.id)?.shape?.placement_wait;
    expect(savedWait).toEqual({ ...wait, since: expect.any(Number) });

    await supervisor.disposeAll();
    const restartedEvents: FmEvent[] = [];
    const restartedTasks = new TaskService({ db, strict: true });
    const restarted = reboot({ paths, db, workspace }, async () => fakeCrewmate(), {
      tasks: restartedTasks,
      broadcastEvent: (event) => {
        restartedEvents.push(event);
      },
      automaticPlacement: { choose: async () => ({ wait }) } as unknown as AutomaticPlacement,
      machines: {} as CrewMachines,
      router: { dynamicEnabled: () => true } as unknown as import("../routing/router").Router,
    });
    const restartedRecord = restartedTasks.get(task.id);
    if (!restartedRecord) throw new Error("the waiting task did not survive the restart");
    expect(restartedRecord.shape?.placement_wait).toEqual(savedWait);
    expect(restartedRecord.startNotice ?? null).toBeNull();
    expect(restarted.placement.runsOnFact(restartedRecord)?.reason).toBe(wait.words);
    await restarted.starts.dispatchQueuedTask(task.id);
    expect(
      restartedEvents.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : [])),
    ).toEqual([]);
    expect(restartedTasks.get(task.id)?.shape?.placement_wait).toEqual(savedWait);
    expect(restarted.placement.runsOnFact(restartedTasks.get(task.id) as TaskRecord)?.reason).toBe(
      wait.words,
    );
    expect(lines()).toEqual([`"Fix the ledger header": ${wait.words}`]);
    await restarted.disposeAll();
  });

  // INF-720, the captain's Fix 4: INF-653 and INF-665 waited 219 and 115
  // minutes on "different required system", since no paired computer runs
  // Linux, until the first mate happened to look. It hears that at once, and
  // once, though every sweep compares the same computers again.
  it("tells the first mate at once, and once, that no computer runs the system a task requires", async () => {
    const dir = scratchDir("infinitary-automatic-system-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/ledger.git"]);
    const wait = placementWait(
      [
        { name: "This computer", rejections: ["system-incompatible"], capacity: null },
        { name: "Mac mini", rejections: ["system-incompatible"], capacity: null },
      ],
      STANDARD,
    );
    const unserved = {
      required: ["linux" as const],
      computers: [
        { name: "This computer", system: "macos" as const },
        { name: "Mac mini", system: "macos" as const },
      ],
    };
    let hostNow = Date.parse("2026-10-20T19:24:00Z");
    const { supervisor, repos, tasks, inbox } = setup(fakeCrewmate(), {
      now: () => hostNow,
      automatic: { choose: async () => ({ wait, unserved }) },
    });
    // The first mate's lane, filled as its own seam fills it (`FirstmateAgent.notifyOp`).
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref),
      retryConverse: vi.fn(),
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "ledger" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const task = seedTask(tasks, {
      id: "compare",
      title: "Compare the Linux test failures on main",
      repoId: repo.id,
      status: "queued",
      startPolicy: "when-ready",
    });
    const key = task.key || task.id;
    const heard = () => inbox.allFor(FIRSTMATE_RECIPIENT);

    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(heard().map((row) => [row.ref, row.facts])).toEqual([
      [
        task.id,
        {
          kind: "system-wait",
          task: { id: task.id, key, title: task.title },
          ...unserved,
        },
      ],
    ]);
    expect(heard().map(renderWake)[0]).toContain(`${task.id} ${key} "${task.title}"`);

    // The first mate's turn read it, and the ready sweep compares the same
    // computers again, a minute at a time, long after a repeat would be new.
    inbox.ack(heard().map((row) => row.id));
    hostNow += INBOX_DEDUPE_WINDOW_MS + 60_000;
    await supervisor.starts.dispatchQueuedTask(task.id);
    hostNow += 60_000;
    await supervisor.starts.dispatchQueuedTask(task.id);
    expect(heard()).toEqual([]);
    expect(tasks.get(task.id)?.status).toBe("open");
  });

  // INF-1456: a person added an Intel Mac mini and expected Automatic to use
  // it, and every task of their project that declared no chip started on the
  // MacBook with nothing said. The first mate hears it once per project and
  // computer, though this computer took the task and the next task of the
  // same project leaves the mini out again.
  it("tells the first mate once that Automatic left the Intel Mac mini out of a project, with the change that lets it in", async () => {
    const dir = scratchDir("infinitary-automatic-left-out-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      "https://github.com/o/scheduler.git",
    ]);
    const leftOut = [
      {
        computerId: "mac-mini",
        name: "Mac mini",
        took: "This computer",
        system: "macos" as const,
        chip: "x64" as const,
        reasons: [
          {
            kind: "chip" as const,
            runs: "x64" as const,
            heldTo: ["arm64" as const],
            heldOn: "macos" as const,
          },
        ],
        widened: { chips: ["arm64" as const, "x64" as const] },
      },
    ];
    const { supervisor, repos, tasks, inbox } = setup(fakeCrewmate(), {
      automatic: { choose: async () => ({ computerId: null, leftOut }) },
    });
    supervisor.setFirstmateHooks({
      notifyOp: (wake, origin, ref) => inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref),
      retryConverse: vi.fn(),
    });
    const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "Scheduler" });
    repos.setRunsOn(repo.id, AUTOMATIC_COMPUTER);
    const queued = (id: string, title: string) =>
      seedTask(tasks, { id, title, repoId: repo.id, status: "queued", startPolicy: "when-ready" });
    const rotate = queued("rotate", "Remove and rotate scheduler mail credentials");
    const heard = () =>
      inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => row.facts?.kind === "computer-left-out");

    await supervisor.starts.dispatchQueuedTask(rotate.id);
    expect(heard().map((row) => row.facts)).toEqual([
      {
        kind: "computer-left-out",
        task: { id: rotate.id, key: rotate.key || rotate.id, title: rotate.title },
        project: { id: repo.id, name: "Scheduler" },
        computer: { name: "Mac mini", system: "macos", chip: "x64" },
        took: "This computer",
        reasons: leftOut[0]?.reasons,
        widened: { chips: ["arm64", "x64"] },
      },
    ]);
    const words = heard().map(renderWake)[0];
    expect(words).toContain("Mac mini runs on Intel (x64)");
    expect(words).toContain("held to this computer's Apple silicon (arm64)");
    expect(words).toContain(
      `app_change project-settings for ${repo.id} with changes {"placementRequirements":{"chips":["arm64","x64"]}}`,
    );

    inbox.ack(heard().map((row) => row.id));
    const digest = queued("digest", "Send the weekly scheduler digest");
    await supervisor.starts.dispatchQueuedTask(digest.id);
    expect(heard()).toEqual([]);
  });
});
