import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUsageReport } from "./usageReport";

/**
 * Intent: INF-3776's approved plan - the Antigravity allowance shows the
 * Gemini group's limits from the program's own usage report, and a report
 * it cannot read shows no reading rather than a wrong one. The fixture is
 * the program's real answer to `agy -p /usage --output-format json`, with
 * its conversation id replaced.
 */

const REPORT = readFileSync("tests/fixtures/antigravity/usage-report.json", "utf8");
const NOW = Date.parse("2026-11-12T05:40:00Z");

describe("the Antigravity usage report", () => {
  it("reads the Gemini group's weekly limit as the plan's weekly window, leaving the other group out", () => {
    const windows = parseUsageReport(REPORT, NOW);

    expect(windows).toHaveLength(1);
    const [weekly] = windows ?? [];
    expect(weekly?.windowId).toBe("seven_day");
    expect(weekly?.status).toBe("allowed");
    expect(weekly?.utilization).toBeCloseTo(1 - 0.9783080220222473);
    expect(weekly?.resetsAt).toBe(Date.parse("2026-11-19T02:32:13Z"));
    expect(weekly?.at).toBe(NOW);
  });

  it("reads a spent Gemini limit as refused", () => {
    const spent = REPORT.replace("0.9783080220222473", "0");

    expect(parseUsageReport(spent, NOW)?.[0]).toMatchObject({ status: "rejected", utilization: 1 });
  });

  it("reads nothing from an answer that is not the usage report", () => {
    expect(parseUsageReport("", NOW)).toBeUndefined();
    expect(parseUsageReport("Please sign in", NOW)).toBeUndefined();
    const withoutGemini = JSON.parse(REPORT);
    withoutGemini.command.data.groups = withoutGemini.command.data.groups.slice(1);
    expect(parseUsageReport(JSON.stringify(withoutGemini), NOW)).toBeUndefined();
  });
});
