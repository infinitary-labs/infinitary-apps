import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { select } from "../scripts/affected-journeys.ts";
import {
  budget,
  JOURNEY_BUDGET_MS,
  journeyTimes,
  LINUX_PLACES,
  laneOf,
  macTime,
  proximity,
  type ReportSuite,
} from "../scripts/journey-budget.ts";

// INF-658's approved choice: six measured minutes on Mac, every extra file on
// Linux; INF-1720's plan packs that Linux overflow into at most one job per
// PC place. Readings are from the passing verify run named by the plan.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/affected-journeys/verify-times.json", import.meta.url), "utf8"),
) as { times: Record<string, number> };
const times = new Map(Object.entries(fixture.times));
const reasons = new Map(
  [...times.keys()].map((file) => [file, ["imports tests/e2e/launch.ts, which the change edits"]]),
);

describe("INF-658 measured journey placement", () => {
  it("keeps the closest changed journey on Mac and places every file exactly once", () => {
    const closest = "tests/e2e/task-browser.spec.ts";
    const result = budget(reasons, times, (file) => (file === closest ? 0 : 1));
    expect(result.mac).toContain(closest);
    expect(result.estimatedMacMs).toBeLessThanOrEqual(JOURNEY_BUDGET_MS);
    const all = [...result.mac, ...result.linux.flatMap((bin) => bin.files.split(" "))];
    expect(all.toSorted()).toEqual([...reasons.keys()].toSorted());
    expect(new Set(all).size).toBe(all.length);
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
    expect(
      budget(new Map([...reasons].reverse()), times, (file) => (file === closest ? 0 : 1)),
    ).toEqual(result);
  });

  it("keeps a modest overflow in six-minute groups, fewer than one job per PC place", () => {
    // Every serial desktop file, which fills most of the Mac's six minutes,
    // and about twenty-five minutes of parallel files: the overflow needs fewer
    // than five six-minute groups, so none grows past six minutes.
    const measured = [...times].filter(([, ms]) => ms > 0).sort((a, b) => a[0].localeCompare(b[0]));
    const picked = measured.filter(([file]) => laneOf(file) === "desktop").map(([file]) => file);
    let total = 0;
    for (const [file, ms] of measured.filter(([file]) => laneOf(file) === "parallel")) {
      if (total > 25 * 60 * 1000) break;
      picked.push(file);
      total += ms;
    }
    const pick = new Map(picked.map((file) => [file, ["the change edits this journey"]]));
    const result = budget(pick, times, () => 0);
    expect(result.linux.length).toBeGreaterThan(1);
    expect(result.linux.length).toBeLessThan(LINUX_PLACES);
    for (const bin of result.linux)
      expect(bin.estimatedMs <= JOURNEY_BUDGET_MS || !bin.files.includes(" ")).toBe(true);
    const all = [...result.mac, ...result.linux.flatMap((bin) => bin.files.split(" "))];
    expect(all.toSorted()).toEqual(picked.toSorted());
  });

  it("keeps a small pick on Mac, skips empty picks, and accounts for serial plus parallel work", () => {
    const files = ["tests/e2e/activity-updates.spec.ts", "tests/e2e/crew-orbit.spec.ts"];
    const small = new Map(files.map((file) => [file, ["the change edits this journey"]]));
    const result = budget(small, times, () => 0);
    expect(result.linux).toEqual([]);
    expect(result.mac.toSorted()).toEqual(files.toSorted());
    expect(macTime(files, (file) => times.get(file) ?? 0)).toBe(
      Math.max(...files.map((file) => times.get(file) ?? 0)),
    );
    expect(budget(new Map(), times, () => 0)).toMatchObject({
      mac: [],
      linux: [],
      estimatedMacMs: 0,
    });
  });

  it("does not lose a new or indivisibly slow file or pretend its time is known", () => {
    const unknown = "tests/e2e/new-journey.spec.ts";
    const result = budget(new Map([[unknown, ["the change edits this journey"]]]), times, () => 0);
    expect(result.unmeasured).toEqual([unknown]);
    expect([...result.mac, ...result.linux.flatMap((bin) => bin.files.split(" "))]).toEqual([
      unknown,
    ]);
    const slowest = [...times]
      .filter(([file]) => laneOf(file) === "desktop")
      .sort((a, b) => b[1] - a[1])[0];
    expect(slowest).toBeDefined();
    expect(result.estimatedMacMs || result.linux[0]?.estimatedMs).toBeGreaterThan(0);
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

  it("ranks edited journeys and direct helper importers ahead of distant shared helpers", () => {
    // Real import clauses from these existing journeys and their helper.
    const files = new Map([
      ["tests/e2e/task-record-height.spec.ts", 'import { launchApp } from "./launch";'],
      ["tests/e2e/launch.ts", 'import { startMockProvider } from "./mockProvider";'],
      ["tests/e2e/mockProvider.ts", "export function startMockProvider() {}"],
    ]);
    const read = (file: string) => files.get(file);
    const spec = "tests/e2e/task-record-height.spec.ts";
    expect(proximity(spec, [], new Set([spec]), read)).toBe(0);
    expect(proximity(spec, [], new Set(["tests/e2e/launch.ts"]), read)).toBe(1);
    expect(proximity(spec, [], new Set(["tests/e2e/mockProvider.ts"]), read)).toBe(2);
    // INF-631: a journey the change declares sits beside the screen readers,
    // ahead of a distant shared helper's importers.
    const declared = select({
      changed: ["src/core/tasks/taskService.ts"],
      sourceDiff: "",
      specs: [spec],
      read,
      declared: [spec],
    }).get(spec);
    expect(proximity(spec, declared ?? [], new Set(["src/core/tasks/taskService.ts"]), read)).toBe(
      1,
    );
    // INF-1136: so does a journey that calls a window method whose message the
    // change edits, here by sending the preload's method another channel.
    const caller = "tests/e2e/knowledge-gate.spec.ts";
    const preload = (channel: string) =>
      `const api: FirstmateApi = {\n  retention: {\n    scope: () => invoke("${channel}"),\n  },\n};\n`;
    const calls = select({
      changed: ["src/preload/index.ts"],
      sourceDiff: "",
      specs: [caller],
      read: (file) =>
        file === caller
          ? "return page.evaluate(() => window.infinitary.retention.scope());"
          : file === "src/preload/index.ts"
            ? preload("inf:retention:scope")
            : undefined,
      readBefore: (file) =>
        file === "src/preload/index.ts" ? preload("inf:retention:purge") : undefined,
    }).get(caller);
    expect(calls).toHaveLength(1);
    expect(proximity(caller, calls ?? [], new Set(["src/preload/index.ts"]), read)).toBe(1);
  });
});
