import { feedLineFrom } from "@shared/feed";
import type { ComputerResourcesView } from "@shared/resources";
import { describe, expect, it } from "vitest";
import day from "../../../tests/fixtures/memory-warnings/mac-mini-day.json";
import { renderWake, type TypedWake } from "../orchestrator/wakes";
import { type PressureLeftover, ResourcePressure } from "./resourcePressure";

const TASK_SHARES = [{ taskId: "task", processCount: 1, residentBytes: 45040 * 1024 }];

// INF-1621's recorded Mac reading; INF-3497 finding 5 keeps already-seen
// facts quiet even when a normal reading intervenes.
const view = (
  pressure: "normal" | "warning" | "critical",
  sequence: number,
  tasks: {
    taskId: string;
    processCount: number;
    residentBytes: number;
    cpuCores?: number;
  }[] = TASK_SHARES,
  label = "This computer",
  other: { processCount: number; residentBytes: number; cpuCores?: number } = {
    processCount: 0,
    residentBytes: 0,
  },
): ComputerResourcesView => ({
  computers: [
    {
      computerId: null,
      label,
      reading: {
        status: "fresh",
        ageMs: 0,
        observation: {
          epoch: "bd170962-0ab2-41e5-a1f7-fd7f9bb5ef56",
          sequence,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 14, idleFraction: 0.8 },
          memory: {
            totalBytes: 24 * 1024 ** 3,
            freeBytes: 15979 * 16384,
            memoryPressure: pressure,
          },
          processes: {
            status: "sampled",
            processCount: 1,
            tasks,
            other,
          },
        },
      },
    },
  ],
});

describe("accepted load plan pressure notification", () => {
  it("deduplicates unchanged pressure, keeps unknown distinct from normal, and includes task shares", () => {
    const wakes: TypedWake[] = [];
    const activity: string[] = [];
    const pressure = new ResourcePressure({
      taskKey: () => "INF-1629",
      notify: (wake) => wakes.push(wake),
      activity: (fact) => {
        activity.push(fact.text);
        // Keep the published event additive: existing note, optional warning tone.
        expect(feedLineFrom({ type: "firstmate_note", text: fact.text, tone: "warn" })).toEqual({
          kind: "warn",
          text: fact.text,
        });
        expect(feedLineFrom({ type: "firstmate_note", text: fact.text })).toEqual({
          kind: "info",
          text: fact.text,
        });
      },
    });
    pressure.observe(view("warning", 1));
    pressure.observe(view("warning", 2));
    pressure.observe({
      computers: [
        {
          computerId: null,
          label: "This computer",
          reading: { status: "unknown", reason: "timeout" },
        },
      ],
    });
    pressure.observe(view("warning", 3));
    expect(wakes).toHaveLength(1);
    expect(activity).toEqual([
      "This computer · Memory pressure warning · INF-1629: Processor use unavailable · 44.0 MB resident · 1 process",
    ]);
    expect(renderWake(wakes[0]!)).toContain("Nothing was killed, paused or slowed");
    expect(wakes[0]?.facts).toMatchObject({
      kind: "resource-pressure",
      tasks: [{ taskId: "task", key: "INF-1629", residentBytes: 45040 * 1024 }],
    });
    pressure.observe(view("critical", 4));
    pressure.observe(view("normal", 5));
    pressure.observe(view("warning", 6));
    expect(wakes).toHaveLength(2);
    expect(new Set(wakes.map((wake) => wake.once)).size).toBe(2);
  });
});

// INF-2299 finding 5: four warnings wrote 44 feed lines, a heading and one row
// per task, most of them using nothing. A warning is one line naming the
// computer and the task holding the most memory; the wake keeps every share.
describe("a memory warning in the feed", () => {
  // The Mac mini's 11:32 PM warning from that audit, as the feed showed it.
  const MB = 1024 ** 2;
  const shares = [
    ["INF-2245", 0.01, 225.7, 22],
    ["INF-2131", 0, 159.4, 1],
    ["INF-2025", 0.14, 833.8, 30],
    ["INF-2157", 0, 154.0, 1],
    ["INF-2271", 0, 9.1, 7],
    ["INF-2275", 0, 8.1, 7],
    ["INF-1706", 0, 10.0, 7],
  ].map(([taskId, cpuCores, mb, processCount]) => ({
    taskId: taskId as string,
    cpuCores: cpuCores as number,
    residentBytes: Math.round((mb as number) * MB),
    processCount: processCount as number,
  }));

  it("writes one line naming the computer and the task using the most memory", () => {
    const wakes: TypedWake[] = [];
    const activity: string[] = [];
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      notify: (wake) => wakes.push(wake),
      activity: (fact) => activity.push(fact.text),
    });
    pressure.observe(view("warning", 1, shares, "Kun's Mac mini"));
    expect(activity).toEqual([
      "Kun's Mac mini · Memory pressure warning · INF-2025 uses the most of 7 tasks: 0.14 processors · 833.8 MB resident · 30 processes",
    ]);
    expect(wakes[0]?.facts).toMatchObject({ kind: "resource-pressure" });
    expect(wakes[0]?.facts).toHaveProperty("tasks.length", shares.length);
  });

  // INF-3060 finding 6: a warning named HEAD-11, holding 268 MB and almost
  // no processor, while the pressure came from outside the crew. The outside
  // share is a reading of the Mac mini's own processes at the time of the fix.
  it("names the programs outside the tasks when they hold more than any task", () => {
    const activity: string[] = [];
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      notify: () => {},
      activity: (fact) => activity.push(fact.text),
    });
    const idle = [
      { taskId: "HEAD-11", cpuCores: 0.04, residentBytes: Math.round(268 * MB), processCount: 9 },
      { taskId: "INF-3060", cpuCores: 0, residentBytes: Math.round(141.2 * MB), processCount: 4 },
    ];
    const outside = { processCount: 977, residentBytes: Math.round(39685.3 * MB), cpuCores: 1.62 };
    pressure.observe(view("warning", 1, idle, "Kun's Mac mini", outside));
    expect(activity).toEqual([
      "Kun's Mac mini · Memory pressure warning · Programs not linked to open tasks use the most: 1.62 processors · 38.76 GB resident · 977 processes",
    ]);
  });

  it("says task use is unavailable when no processes were sampled", () => {
    const activity: string[] = [];
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      notify: () => {},
      activity: (fact) => activity.push(fact.text),
    });
    const unsampled = view("critical", 1);
    const reading = unsampled.computers[0]?.reading;
    if (reading?.status === "fresh")
      delete (reading.observation as { processes?: unknown }).processes;
    pressure.observe(unsampled);
    expect(activity).toEqual(["This computer · Memory pressure critical · Task use unavailable"]);
  });
});

// INF-4182's plan: a memory warning is one thing with an ID - the computer and
// when it began - told once until the computer stays clear for 30 minutes.
describe("a memory warning told once", () => {
  const MINUTE = 60_000;
  const leftover: PressureLeftover = {
    id: "task-event:closed:1",
    taskId: "closed",
    key: "INF-1629",
    report: {
      stops: [{ label: "scratch machine", outcome: "failed", exitCode: 1 }],
      programs: [{ pid: 4118, name: "sleep", outcome: "survived" }],
      holders: "checked",
    },
  };

  /** A stand-in inbox that queues each once-name a single time, as the durable one does. */
  function inbox() {
    const names: string[] = [];
    return {
      names,
      heard: (prefix: string) => names.filter((name) => name.startsWith(prefix)),
      queue: (wake: TypedWake) => {
        if (wake.once !== undefined && names.includes(wake.once)) return null;
        if (wake.once !== undefined) names.push(wake.once);
        return names.length;
      },
    };
  }

  function watcher(
    options: {
      leftovers?: () => PressureLeftover[];
      store?: ReturnType<typeof inbox>;
      start?: number;
    } = {},
  ) {
    const store = options.store ?? inbox();
    const clock = { now: options.start ?? Date.parse("2026-11-13T13:00:00.000Z") };
    const wakes: TypedWake[] = [];
    const activity: { text: string; pressure: string }[] = [];
    const pressure = new ResourcePressure({
      taskKey: (id) => id,
      leftovers: options.leftovers,
      now: () => clock.now,
      heard: store.heard,
      notify: (wake) => {
        const queued = store.queue(wake);
        if (queued !== null) wakes.push(wake);
        return queued;
      },
      activity: (fact) => activity.push({ text: fact.text, pressure: fact.pressure }),
    });
    return { pressure, clock, wakes, activity, store };
  }

  // The Mac mini on Nov 13 (INF-4165's evidence, read by INF-4182): 53
  // notices, 49 of them only for a newly seen task, while its level went
  // back to normal at least 41 times. A warning that ends only after 30
  // minutes clear is told 6 times that day; with the old rule it was 53.
  it("tells the same warning once through a day of real readings", () => {
    const { pressure, clock, wakes, activity } = watcher();
    let sequence = 0;
    for (const [at, level, taskIds] of day.readings as [
      string,
      "normal" | "warning" | "critical",
      string[]?,
    ][]) {
      clock.now = Date.parse(at);
      const tasks = (taskIds ?? ["task"]).map((taskId) => ({ ...TASK_SHARES[0]!, taskId }));
      pressure.observe(view(level, ++sequence, tasks, "Mac mini"));
    }
    const begun = wakes.filter((wake) => wake.facts.kind === "resource-pressure");
    const ended = wakes.filter((wake) => wake.facts.kind === "memory-warning-ended");
    expect(begun).toHaveLength(6);
    // Each of them ended before the day did.
    expect(ended).toHaveLength(6);
    expect(begun.map((wake) => wake.once)).toEqual(
      begun.map((wake) => (wake.facts as { warning: { id: string } }).warning.id),
    );
    expect(activity).toHaveLength(begun.length + ended.length);
  });

  it("names recorded leftovers in its one notice and stays quiet on new tasks, leftovers and flips", () => {
    let leftovers: PressureLeftover[] = [leftover];
    const { pressure, clock, wakes, activity } = watcher({ leftovers: () => leftovers });
    pressure.observe(view("warning", 1));
    expect(activity.map((line) => line.text)).toEqual([
      'This computer · Memory pressure warning · Leftovers recorded at close: INF-1629: stop "scratch machine" failed, sleep survived · Current use unknown',
    ]);
    expect(wakes[0]).toMatchObject({
      facts: { recordedLeftovers: [leftover], leftoverUse: "unknown" },
      once: `memory-warning:home:${clock.now}`,
    });
    expect(renderWake(wakes[0]!)).toContain(
      `This is memory warning memory-warning:home:${clock.now}`,
    );
    leftovers = [leftover, { ...leftover, id: "task-event:closed:2" }];
    clock.now += 10 * MINUTE;
    pressure.observe(view("warning", 2, [...TASK_SHARES, { ...TASK_SHARES[0]!, taskId: "new" }]));
    pressure.observe(view("normal", 3));
    pressure.observe(view("warning", 4));
    pressure.observe({
      computers: [
        {
          computerId: null,
          label: "This computer",
          reading: { status: "unknown", reason: "timeout" },
        },
      ],
    });
    clock.now += 40 * MINUTE;
    pressure.observe({ computers: [] });
    expect(wakes).toHaveLength(1);
    expect(activity).toHaveLength(1);
  });

  it("tells a first turn to critical once more under the same ID", () => {
    const { pressure, clock, wakes, activity } = watcher();
    pressure.observe(view("warning", 1));
    const id = `memory-warning:home:${clock.now}`;
    clock.now += MINUTE;
    pressure.observe(view("critical", 2));
    pressure.observe(view("warning", 3));
    pressure.observe(view("critical", 4));
    expect(wakes.map((wake) => wake.once)).toEqual([id, `${id}:critical`]);
    expect(wakes[1]?.facts).toMatchObject({ pressure: "critical", warning: { id } });
    expect(activity.map((line) => line.pressure)).toEqual(["warning", "critical"]);
  });

  it("ends a warning once the computer reads normal after 30 minutes clear, then tells a new one", () => {
    const { pressure, clock, wakes, activity } = watcher();
    const began = clock.now;
    pressure.observe(view("warning", 1));
    clock.now += 29 * MINUTE;
    pressure.observe(view("normal", 2));
    expect(wakes).toHaveLength(1);
    clock.now += MINUTE;
    pressure.observe(view("normal", 3));
    pressure.observe(view("normal", 4));
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toMatchObject({
      facts: {
        kind: "memory-warning-ended",
        warning: { id: `memory-warning:home:${began}` },
        clearMinutes: 30,
      },
      once: `memory-clear:home:${began}`,
    });
    expect(renderWake(wakes[1]!)).toContain("Show no card for this.");
    expect(activity[1]).toEqual({
      text: "This computer · Memory warning ended · Normal for 30 minutes",
      pressure: "normal",
    });
    clock.now += MINUTE;
    pressure.observe(view("warning", 5));
    expect(wakes[2]?.once).toBe(`memory-warning:home:${clock.now}`);
  });

  it("keeps computers apart", () => {
    const { pressure, wakes } = watcher();
    const remote = view("warning", 1);
    remote.computers[0]!.computerId = "work";
    pressure.observe(view("warning", 1));
    pressure.observe(remote);
    expect(wakes.map((wake) => wake.facts)).toMatchObject([
      { computerId: null },
      { computerId: "work" },
    ]);
  });

  it("tells nothing again after a restart, and counts the clear time from the restart", () => {
    const store = inbox();
    const first = watcher({ store });
    first.pressure.observe(view("warning", 1));
    first.clock.now += MINUTE;
    first.pressure.observe(view("critical", 2));
    // The restarted app reads its open warning back when it starts, an hour on.
    const second = watcher({ store, start: first.clock.now + 60 * MINUTE });
    second.pressure.observe(view("warning", 1));
    second.pressure.observe(view("critical", 2));
    second.clock.now += 20 * MINUTE;
    second.pressure.observe(view("normal", 3));
    expect(second.wakes).toHaveLength(0);
    second.clock.now += 10 * MINUTE;
    second.pressure.observe(view("normal", 4));
    expect(second.wakes.map((wake) => wake.facts.kind)).toEqual(["memory-warning-ended"]);
    expect(second.activity).toHaveLength(1);
  });

  it("writes no Activity line when its wake was already queued", () => {
    const store = inbox();
    const { pressure, clock, activity } = watcher({ store });
    store.names.push(`memory-warning:home:${clock.now}`);
    pressure.observe(view("warning", 1));
    expect(activity).toHaveLength(0);
  });
});
