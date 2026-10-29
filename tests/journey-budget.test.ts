import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  budget,
  JOURNEY_BUDGET_MS,
  journeyTimes,
  LINUX_PLACES,
  laneOf,
  type ReportSuite,
} from "../scripts/journey-budget.ts";
import { needsMac } from "./lint/e2eMacTag.ts";

// INF-658's approved choice sized the journeys' jobs at six measured minutes;
// INF-1720's plan packs Linux into at most one job per PC place; INF-1763's
// approved plan (the captain's principle of 2026-10-28) runs every chosen
// file on Linux and only the files holding tests that need a Mac on the Mac.
// Readings are from the passing verify run named by the plan.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/affected-journeys/verify-times.json", import.meta.url), "utf8"),
) as { times: Record<string, number> };
const times = new Map(Object.entries(fixture.times));
const reasons = new Map(
  [...times.keys()].map((file) => [file, ["imports tests/e2e/launch.ts, which the change edits"]]),
);
/** Whether a journey of this repository holds a test tagged MAC_ONLY_TAG, read from its source. */
const tagged = (file: string) => {
  try {
    return needsMac(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), file);
  } catch {
    return false;
  }
};
const linuxFiles = (result: ReturnType<typeof budget>) =>
  result.linux.flatMap((bin) => bin.files.split(" "));

describe("INF-1763 journey placement", () => {
  it("runs every chosen file on Linux once and only the tagged files on the Mac", () => {
    const result = budget(reasons, times, tagged);
    const all = linuxFiles(result);
    expect(all.toSorted()).toEqual([...reasons.keys()].toSorted());
    expect(new Set(all).size).toBe(all.length);
    expect(result.mac).toEqual([...reasons.keys()].filter(tagged).toSorted());
    expect(result.mac).toContain("tests/e2e/window-wash.spec.ts");
    expect(result.mac).not.toContain("tests/e2e/task-browser.spec.ts");
    // INF-1720: every journey overflows far past five six-minute groups, and
    // still runs as one job per PC place, each lane in at least one.
    expect(result.linux).toHaveLength(LINUX_PLACES);
    expect(new Set(result.linux.map((bin) => bin.lane))).toEqual(new Set(["parallel", "desktop"]));
    for (const bin of result.linux) {
      const files = bin.files.split(" ");
      expect(files.every((file) => laneOf(file) === bin.lane)).toBe(true);
      const slowest = Math.max(
        ...[...times].filter(([file]) => laneOf(file) === bin.lane).map(([, ms]) => ms),
      );
      const estimated = files.reduce(
        (sum, file) => sum + (times.get(file) || slowest) / (bin.lane === "desktop" ? 0.6 : 1),
        0,
      );
      expect(bin.estimatedMs).toBeCloseTo(estimated);
    }
    expect(budget(new Map([...reasons].reverse()), times, tagged)).toEqual(result);
  });

  it("starts no Mac job for a shared journey, and puts a tagged one on both", () => {
    const shared = budget(
      new Map([["tests/e2e/task-browser.spec.ts", ["the change edits this journey"]]]),
      times,
      tagged,
    );
    expect(shared.mac).toEqual([]);
    expect(linuxFiles(shared)).toEqual(["tests/e2e/task-browser.spec.ts"]);
    // A tagged test is never sent to Linux alone: its file runs on the Mac too.
    const wash = budget(
      new Map([["tests/e2e/window-wash.spec.ts", ["the change edits this journey"]]]),
      times,
      tagged,
    );
    expect(wash.mac).toEqual(["tests/e2e/window-wash.spec.ts"]);
    expect(linuxFiles(wash)).toEqual(["tests/e2e/window-wash.spec.ts"]);
    expect(budget(new Map(), times, tagged)).toMatchObject({ mac: [], linux: [] });
  });

  it("puts every chosen file on the Mac as well when a request asks", () => {
    const files = ["tests/e2e/activity-updates.spec.ts", "tests/e2e/window-wash.spec.ts"];
    const asked = new Map(files.map((file) => [file, ["the request names this journey"]]));
    const result = budget(asked, times, tagged, true);
    expect(result.mac).toEqual(files);
    expect(linuxFiles(result).toSorted()).toEqual(files);
  });

  it("keeps a modest overflow in six-minute groups, fewer than one job per PC place", () => {
    // About fifteen minutes of parallel files: they need fewer than five
    // six-minute groups, so none grows past six minutes.
    const measured = [...times].filter(([, ms]) => ms > 0).sort((a, b) => a[0].localeCompare(b[0]));
    const picked: string[] = [];
    let total = 0;
    for (const [file, ms] of measured.filter(([file]) => laneOf(file) === "parallel")) {
      if (total > 15 * 60 * 1000) break;
      picked.push(file);
      total += ms;
    }
    const pick = new Map(picked.map((file) => [file, ["the change edits this journey"]]));
    const result = budget(pick, times, tagged);
    expect(result.linux.length).toBeGreaterThan(1);
    expect(result.linux.length).toBeLessThan(LINUX_PLACES);
    for (const bin of result.linux)
      expect(bin.estimatedMs <= JOURNEY_BUDGET_MS || !bin.files.includes(" ")).toBe(true);
    expect(linuxFiles(result).toSorted()).toEqual(picked.toSorted());
  });

  it("does not lose a new or indivisibly slow file or pretend its time is known", () => {
    const unknown = "tests/e2e/new-journey.spec.ts";
    const result = budget(new Map([[unknown, ["the change edits this journey"]]]), times, tagged);
    expect(result.unmeasured).toEqual([unknown]);
    expect(linuxFiles(result)).toEqual([unknown]);
    const slowest = [...times]
      .filter(([file]) => laneOf(file) === "desktop")
      .sort((a, b) => b[1] - a[1])[0];
    expect(slowest).toBeDefined();
    expect(result.linux[0]?.estimatedMs).toBeGreaterThan(0);
  });

  it("reads real passing Playwright durations and refuses an empty timing artifact", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("./fixtures/affected-journeys/verify-report.json", import.meta.url),
        "utf8",
      ),
    ) as { suites: ReportSuite[] };
    const parsed = journeyTimes(report);
    for (const [file, duration] of parsed) expect(duration).toBe(times.get(file));
    expect(parsed.size).toBeGreaterThan(0);
    expect(() => journeyTimes({ suites: [] })).toThrow("no measured journeys");
  });
});
