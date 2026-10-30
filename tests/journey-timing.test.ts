import { readFileSync } from "node:fs";
import type { JSONReport } from "@playwright/test/reporter";
import { describe, expect, it } from "vitest";
import { journeyTiming, type TimingContext } from "../scripts/journey-timing.ts";

// INF-1987 change 1: small Linux observations independent of evidence bundles.
// Real source-desktop artifact 12970966303; fixture README records its projection.
const fixture = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/journey-timing/linux-report.json", import.meta.url), "utf8"),
  ) as JSONReport;
const context: TimingContext = {
  run: "41039506055",
  attempt: "1",
  revision: "retained-fixture",
  platform: "Linux",
  architecture: "X64",
  lane: "desktop",
  suite: "starter",
  shard: "1",
  job: "source-desktop",
  artifactSuffix: "source",
  requestedFiles: [],
  jobStartedAt: Date.parse("2026-10-30T10:33:00Z"),
  testStepStartedAt: Date.parse("2026-10-30T10:34:00Z"),
  observedAt: Date.parse("2026-10-30T10:37:10Z"),
  testStepOutcome: "success",
};

describe("accepted compact Linux timing evidence", () => {
  it("preserves real selection, workers, outcomes and measured intervals without carrying bulky report data", () => {
    const raw = fixture();
    const timing = journeyTiming(raw, context);
    expect(timing.complete).toBe(true);
    expect(timing.successful).toBe(true);
    expect(timing.actualWorkers).toBe(raw.config.metadata.actualWorkers);
    expect(timing.configuredWorkers).toBe(raw.config.workers);
    expect(timing.selectedFiles).toEqual(
      raw.suites.map((suite) => `tests/e2e/${suite.file}`).sort(),
    );
    expect(new Set(timing.selectedFiles).size).toBe(timing.selectedFiles.length);
    expect(timing.files.reduce((sum, file) => sum + file.tests, 0)).toBe(
      raw.stats.expected + raw.stats.skipped,
    );
    expect(timing.files.reduce((sum, file) => sum + file.skipped, 0)).toBe(raw.stats.skipped);
    const devices = timing.files.find((file) => file.file.endsWith("/devices.spec.ts"));
    const results =
      raw.suites[0]?.specs
        .flatMap((spec) => spec.tests.flatMap((test) => test.results))
        .filter((result) => result.status !== "skipped") ?? [];
    expect(devices?.workMs).toBe(results.reduce((sum, result) => sum + result.duration, 0));
    expect(devices?.elapsedMs).toBe(
      Math.max(...results.map((result) => Date.parse(result.startTime) + result.duration)) -
        Math.min(...results.map((result) => Date.parse(result.startTime))),
    );
    expect(timing.timing.setupMs).toBe(Number(context.testStepStartedAt) - context.jobStartedAt);
    expect(timing.timing.jobObservedMs).toBe(context.observedAt - context.jobStartedAt);
    // A consumer reads only compact facts, not serialized attachment or log payloads.
    expect(Object.keys(timing.files[0]?.attempts[0] ?? {}).sort()).toEqual([
      "durationMs",
      "retry",
      "startMs",
      "status",
      "worker",
    ]);
    expect(timing.stats).toEqual(raw.stats);
    expect(timing.run).toBe(context.run);
    expect(timing.attempt).toBe(context.attempt);
    expect(timing.revision).toBe(context.revision);
  });

  it("keeps observed skips distinct from absent reports, absent files and unexecuted tests", () => {
    const raw = fixture();
    const timing = journeyTiming(raw, context);
    expect(timing.files.some((file) => file.skipped > 0)).toBe(true);
    const absent = journeyTiming(null, { ...context, requestedFiles: timing.selectedFiles });
    expect(absent.reportState).toBe("missing");
    expect(absent.actualWorkers).toBeNull();
    expect(absent.complete).toBe(false);
    expect(absent.missingFiles).toEqual(timing.selectedFiles);
    expect(absent.files).toEqual([]);
    const missingFile = journeyTiming(raw, {
      ...context,
      requestedFiles: [...timing.selectedFiles, "tests/e2e/answer-delivery.spec.ts"],
    });
    expect(missingFile.complete).toBe(false);
    expect(missingFile.missingFiles).toEqual(["tests/e2e/answer-delivery.spec.ts"]);
    const truncated = fixture();
    truncated.suites.pop();
    expect(journeyTiming(truncated, context).complete).toBe(false);
    const test = raw.suites[0]?.specs[0]?.tests[0];
    if (!test) throw new Error("fixture has no first test");
    test.results = [];
    const unexecuted = journeyTiming(raw, context);
    expect(unexecuted.complete).toBe(false);
    expect(unexecuted.files[0]?.missing).toBe(1);
  });

  it("keeps an entirely skipped selection observed with no executed interval", () => {
    const raw = fixture();
    for (const suite of raw.suites) {
      suite.specs = suite.specs.filter((spec) =>
        spec.tests.every((test) => test.status === "skipped"),
      );
    }
    raw.stats.expected = 0;
    const timing = journeyTiming(raw, context);
    expect(timing.complete).toBe(true);
    expect(timing.files.length).toBeGreaterThan(0);
    for (const file of timing.files) {
      expect(file.skipped).toBe(file.tests);
      expect(file.elapsedMs).toBeNull();
      expect(file.workMs).toBe(0);
    }
  });

  it("never labels failed or interrupted execution successful and retains work from completed attempts", () => {
    const raw = fixture();
    expect(journeyTiming(raw, { ...context, testStepOutcome: "failure" }).successful).toBe(false);
    raw.stats.unexpected++;
    expect(journeyTiming(raw, context).successful).toBe(false);
    const result = raw.suites[0]?.specs[0]?.tests[0]?.results[0];
    if (!result) throw new Error("fixture has no first result");
    result.status = "interrupted";
    expect(journeyTiming(raw, context).complete).toBe(false);
  });
});
