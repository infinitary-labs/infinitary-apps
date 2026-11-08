import { feedLineFrom } from "@shared/feed";
import type { ComputerResourcesView } from "@shared/resources";
import { describe, expect, it } from "vitest";
import { renderWake, type TypedWake } from "../orchestrator/wakes";
import { ResourcePressure } from "./resourcePressure";

const TASK_SHARES = [{ taskId: "task", processCount: 1, residentBytes: 45040 * 1024 }];

// INF-1621: one wake for each macOS pressure fact, not every two-second sample.
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
    expect(wakes).toHaveLength(3);
    expect(new Set(wakes.map((wake) => wake.once)).size).toBe(3);
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
      "Kun's Mac mini · Memory pressure warning · Programs outside your tasks use the most: 1.62 processors · 38.76 GB resident · 977 processes",
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
