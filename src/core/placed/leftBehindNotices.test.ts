/**
 * The notices that carry what finished tasks left (INF-2574's approved plan
 * under direction C, piece 2, done criteria 3 to 5; docs/heavy-runs.md,
 * "Capacity and pressure"): the first mate hears once per run that a
 * finished task's run still counts as running while another waits, both
 * notices carry the computer's list, and the home asks a computer that runs
 * work for its list only when it lists the change.
 */

import type { LeftBehind } from "@shared/leftoverPrograms";
import type { LoadRun } from "@shared/load";
import type { ComputerResourcesView } from "@shared/resources";
import { describe, expect, it } from "vitest";
import { renderWake, type TypedWake } from "../orchestrator/wakes";
import {
  finishedTask,
  type LeftBehindFacts,
  LineBlocked,
  leftBehindReader,
} from "./leftBehindNotices";
import { ResourcePressure } from "./resourcePressure";

// The Nov 3 shape INF-2570 found by hand: a finished task's booking still
// counted as running on the Mac mini while runs waited behind it.
const FINISHED = "c0ffee01";
const OPEN = "beef0002";
const RECORDS = new Map([
  [FINISHED, { id: FINISHED, key: "INF-2413", status: "done" as const }],
  [OPEN, { id: OPEN, key: "INF-2461", status: "active" as const }],
]);
const finished = finishedTask((id) => RECORDS.get(id));

const run = (taskId: string, state: LoadRun["state"], id: string): LoadRun => ({
  id,
  taskId,
  demand: { cpu: 4, memoryBytes: 8 * 1024 ** 3 },
  state,
  ahead: 0,
});
const BOOKED = run(FINISHED, "running", "6f1c2b7e-1f0a-4c55-9d3e-2b8a4f6c9e10");
const OPEN_RUN = run(OPEN, "running", "0b5d1f3a-9c2e-4f7b-8a61-3e4d5c6b7a80");
const WAITER = run(OPEN, "waiting", "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");

const view = (
  runs: LoadRun[],
  pressure: "normal" | "warning" = "normal",
  computerId: string | null = "mini",
): ComputerResourcesView => ({
  computers: [
    {
      computerId,
      label: "Mac mini",
      reading: {
        status: "fresh",
        ageMs: 0,
        observation: {
          epoch: "bd170962-0ab2-41e5-a1f7-fd7f9bb5ef56",
          sequence: 1,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 14, idleFraction: 0.8 },
          memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 1024 ** 3, memoryPressure: pressure },
        },
      },
      load: { status: "fresh", runs },
    },
  ],
});

const STOP = {
  task: FINISHED,
  id: "s1",
  label: "scratch macOS machine",
  outcome: "timed-out" as const,
};
const RUN = { task: FINISHED, id: BOOKED.id, state: "running" as const, demand: BOOKED.demand };
const LIST: LeftBehind = {
  stops: [STOP],
  programs: [{ task: OPEN, pid: 4242, name: "qemu", started: "Tue Nov  3 21:25:01 2026" }],
  runs: [RUN],
  kept: [FINISHED, OPEN],
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a finished task's run blocking a computer's line", () => {
  it("tells the first mate once per run, with the computer's list, and stops nothing", async () => {
    const wakes: TypedWake[] = [];
    const blocked = new LineBlocked({
      finished,
      leftBehind: async () => ({
        stops: [{ ...STOP, key: "INF-2413" }],
        programs: [],
        runs: [{ ...RUN, key: "INF-2413" }],
      }),
      notify: (wake) => wakes.push(wake),
    });
    // Nothing waits: a finished task's run alone blocks no one.
    blocked.observe(view([BOOKED]));
    // An open task's run ahead of a waiter is its own crewmate's.
    blocked.observe(view([OPEN_RUN, WAITER]));
    await settle();
    expect(wakes).toEqual([]);

    blocked.observe(view([BOOKED, WAITER]));
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      once: `line-blocked:mini:${BOOKED.id}`,
      facts: {
        kind: "line-blocked",
        computerId: "mini",
        run: { taskId: FINISHED, key: "INF-2413", id: BOOKED.id },
        waiting: 1,
        leftBehind: { stops: [{ task: FINISHED, key: "INF-2413", id: "s1" }] },
      },
    });
    expect(renderWake(wakes[0] as TypedWake)).toContain(
      "do not kill, pause or slow running work; judge these facts and steer future work instead",
    );
  });

  it("waits until the computer lists the run, so a close still cleaning up raises nothing", async () => {
    // INF-3592's review, the captain's choice "Only after its close has
    // finished its own cleanup": the computer leaves a task out of its list
    // while its close runs, and an unreadable list tells nothing yet.
    const wakes: TypedWake[] = [];
    let answer: LeftBehindFacts | undefined | "unreadable" = {
      stops: [],
      programs: [],
      runs: [],
    };
    const blocked = new LineBlocked({
      finished,
      leftBehind: async () => {
        if (answer === "unreadable") throw new Error("out of reach");
        return answer;
      },
      notify: (wake) => wakes.push(wake),
    });
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    answer = "unreadable";
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    answer = undefined;
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    expect(wakes).toEqual([]);

    answer = { stops: [], programs: [], runs: [{ ...RUN, key: "INF-2413" }] };
    blocked.observe(view([BOOKED, WAITER]));
    await settle();
    expect(wakes.map((wake) => wake.once)).toEqual([`line-blocked:mini:${BOOKED.id}`]);
  });
});

describe("a computer's list as the home reads it", () => {
  const work = (changes: string[] | undefined, inReach = true) => {
    const asked: string[] = [];
    return {
      asked,
      work: {
        inReach: () => inReach,
        version: () => (changes ? { changes } : undefined),
        ask: async (_deviceId: string, channel: string) => {
          asked.push(channel);
          return LIST;
        },
      },
    };
  };

  it("asks a computer that lists the change, keeping only tasks this home records as finished", async () => {
    const { work: devices, asked } = work(["left-behind"]);
    const resolved: [string | null, readonly string[]][] = [];
    const read = leftBehindReader({
      here: { list: async () => ({ stops: [], programs: [], runs: [], kept: [] }) },
      work: devices as never,
      finished,
      resolve: (computerId, kept) => resolved.push([computerId, kept]),
    });
    expect(await read("mini")).toEqual({
      stops: [{ ...LIST.stops[0], key: "INF-2413" }],
      // The program belongs to a task this home records as open: its crewmate owns it.
      programs: [],
      runs: [{ ...LIST.runs[0], key: "INF-2413" }],
    });
    expect(asked).toEqual(["inf:computer:left-behind"]);
    // Every task still keeping something there, finished or not, so the home
    // marks the others' close reports resolved.
    expect(resolved).toEqual([["mini", [FINISHED, OPEN]]]);
  });

  it("asks nothing of a computer without the change or out of reach", async () => {
    for (const { work: devices, asked } of [work(undefined), work(["left-behind"], false)]) {
      const read = leftBehindReader({
        here: { list: async () => LIST },
        work: devices as never,
        finished,
      });
      expect(await read("mini")).toBeUndefined();
      expect(asked).toEqual([]);
    }
  });

  it("reads this home's own list without asking a computer", async () => {
    const { work: devices, asked } = work(["left-behind"]);
    const read = leftBehindReader({
      here: { list: async () => LIST },
      work: devices as never,
      finished,
    });
    expect((await read(null))?.stops).toEqual([{ ...LIST.stops[0], key: "INF-2413" }]);
    expect(asked).toEqual([]);
  });
});

describe("the pressure notice carries the computer's list", () => {
  it("adds what finished tasks left, and leaves an empty list out", async () => {
    const wakes: TypedWake[] = [];
    let list = {
      stops: [{ ...STOP, key: "INF-2413" }],
      programs: [],
      runs: [],
    };
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      leftBehind: async () => list,
      notify: (wake) => wakes.push(wake),
      activity: () => {},
    });
    pressure.observe(view([], "warning", null));
    await settle();
    expect(wakes[0]?.facts).toMatchObject({
      kind: "resource-pressure",
      leftBehind: { stops: [{ id: "s1", key: "INF-2413" }] },
    });

    list = { stops: [], programs: [], runs: [] };
    const quiet = new ResourcePressure({
      taskKey: (id) => id,
      leftBehind: async () => list,
      notify: (wake) => wakes.push(wake),
      activity: () => {},
    });
    quiet.observe(view([], "warning", null));
    await settle();
    expect(wakes[1]?.facts).not.toHaveProperty("leftBehind");
  });

  it("stops naming a close report the list read just marked resolved, in the wake and the Activity line", async () => {
    // INF-3592's review, the captain's choice "Mark it resolved too, so later
    // notices stop naming it".
    const wakes: TypedWake[] = [];
    const lines: string[] = [];
    let resolved = false;
    const recorded = {
      id: "event-1",
      taskId: FINISHED,
      key: "INF-2413",
      report: {
        stops: [{ label: "scratch macOS machine", outcome: "timed-out" as const }],
        programs: [],
        holders: "checked" as const,
      },
    };
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      leftovers: () => (resolved ? [] : [recorded]),
      leftBehind: async () => {
        resolved = true;
        return { stops: [], programs: [], runs: [] };
      },
      notify: (wake) => wakes.push(wake),
      activity: (fact) => lines.push(fact.text),
    });
    pressure.observe(view([], "warning", null));
    await settle();
    expect(wakes[0]?.facts).not.toHaveProperty("recordedLeftovers");
    expect(lines.join("\n")).not.toContain("scratch macOS machine");
  });
});
