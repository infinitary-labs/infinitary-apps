import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { FreezeIncident, FreezeLine } from "./freezeRecorder";
import { FreezeTally } from "./freezeTally";

// INF-3044, the captain's ask: "i want the "once per version" alert to cover
// all freezses that happened from that app version". Their chosen plan: one
// summary when the app first starts on the next version, covering every
// stall of the old one, with every location by its count and time, most
// time first.

const OLD = "0.6.3-alpha.280";
const NEXT = "0.6.3-alpha.281";
const build = (version: string) => ({
  computer: "a Mac",
  version,
  commit: "c1e941529438207bf1cca34c437df3c2e9d80477",
  mutable: false,
});

/** INF-2971's audit of alpha.280: its two busiest call paths and the rest. */
const FEED = [
  { name: "listFeed", file: "index.js", line: 52_310, column: 11 },
  { name: "recentFeed", file: "index.js", line: 61_022, column: 7 },
];
const TASK_NAME = [{ name: "resolveKey", file: "index.js", line: 40_118, column: 5 }];
const OTHER = [{ name: "drainWakes", file: "index.js", line: 41_510, column: 9 }];

function stall(index: number, frames: FreezeLine["frames"], wallMs: number): FreezeLine {
  return {
    incidentId: `fz-${index}`,
    status: "completed",
    at: new Date(Date.parse("2026-11-07T08:00:00.000Z") + index * 20_000).toISOString(),
    build: build(OLD),
    wallMs,
    cpuMs: wallMs - 10,
    frames,
    ...(index % 50 === 0 ? { uncertain: "waited" as const } : {}),
  };
}

describe("the per-version freeze tally", () => {
  it("summarizes all of a version's stalls over its runs once, when the next version first starts", () => {
    const path = join(scratchDir("infinitary-freeze-tally-"), "freeze-tally.json");
    // Two runs of the old version, 600 stalls between them: more than the
    // 500-line record keeps.
    let index = 0;
    for (const run of [300, 300]) {
      const tally = new FreezeTally(path, OLD, build(OLD));
      tally.startRun();
      tally.ran(3 * 60 * 60_000);
      for (let n = 0; n < run; n += 1, index += 1) {
        const frames = index % 3 === 0 ? FEED : index % 3 === 1 ? TASK_NAME : OTHER;
        tally.add(stall(index, frames, frames === FEED ? 180 : frames === TASK_NAME ? 120 : 60));
      }
      tally.flush();
    }

    // The next version's first start: a force-quit stall the old version
    // left unfinished is recovered first and still counts for it.
    const next = new FreezeTally(path, NEXT, build(NEXT));
    next.startRun();
    const unfinished: FreezeIncident = {
      incidentId: "fz-force-quit",
      status: "interrupted",
      at: "2026-11-07T14:00:00.000Z",
      interruptedAt: "2026-11-07T14:05:00.000Z",
      build: build(OLD),
    };
    next.add(unfinished);
    const summaries = next.takeEarlier();
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    if (!summary) throw new Error("no summary");
    expect(summary).toMatchObject({
      version: OLD,
      build: build(OLD),
      runs: 2,
      runningMs: 6 * 60 * 60_000,
      stalls: 600,
      stallMs: 200 * (180 + 120 + 60),
      interrupted: 1,
      example: { incidentId: "fz-0", wallMs: 180 },
    });
    expect(summary.locations.reduce((sum, location) => sum + location.stalls, 0)).toBe(600);
    expect(summary.locations.map((location) => location.frames)).toEqual([FEED, TASK_NAME, OTHER]);
    expect(summary.locations[0]).toMatchObject({
      stalls: 200,
      stallMs: 200 * 180,
      cpuMs: 200 * 170,
      longestMs: 180,
      firstAt: "2026-11-07T08:00:00.000Z",
      waited: 4,
      late: 0,
    });

    const again = new FreezeTally(path, NEXT, build(NEXT));
    again.startRun();
    expect(again.takeEarlier()).toEqual([]);
  });

  it("keeps the current version's stalls across its own restarts", () => {
    const path = join(scratchDir("infinitary-freeze-tally-same-"), "freeze-tally.json");
    const first = new FreezeTally(path, OLD, build(OLD));
    first.startRun();
    first.add(stall(0, FEED, 180));
    first.flush();
    const second = new FreezeTally(path, OLD, build(OLD));
    second.startRun();
    expect(second.takeEarlier()).toEqual([]);
    second.add(stall(1, FEED, 200));
    second.flush();
    const [summary] = new FreezeTally(path, NEXT).takeEarlier();
    expect(summary).toMatchObject({ runs: 2, stalls: 2, stallMs: 380 });
    expect(summary?.locations).toHaveLength(1);
  });

  it("answers nothing for a version that ran without a stall", () => {
    const path = join(scratchDir("infinitary-freeze-tally-quiet-"), "freeze-tally.json");
    const quiet = new FreezeTally(path, OLD, build(OLD));
    quiet.startRun();
    quiet.flush();
    expect(new FreezeTally(path, NEXT).takeEarlier()).toEqual([]);
  });
});
