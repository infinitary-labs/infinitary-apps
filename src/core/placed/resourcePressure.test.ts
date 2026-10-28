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
): ComputerResourcesView => ({
  computers: [
    {
      computerId: null,
      label: "This computer",
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
            tasks: TASK_SHARES,
            other: { processCount: 0, residentBytes: 0 },
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
    expect(activity).toHaveLength(1 + TASK_SHARES.length);
    expect(activity.slice(1).join("\n")).toContain("INF-1629");
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
