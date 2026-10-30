import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";

export type TimingContext = {
  run: string;
  attempt: string;
  revision: string;
  platform: string;
  architecture: string;
  lane: string;
  suite: string;
  shard: string;
  job: string;
  artifactSuffix: string;
  requestedFiles: string[];
  jobStartedAt: number;
  testStepStartedAt: number | null;
  observedAt: number;
  testStepOutcome: string;
};

/** INF-1987 change 1: project the existing source-journeys result, not its attachments or logs. */
export function journeyTiming(report: JSONReport | null, context: TimingContext) {
  const groups = new Map<
    string,
    {
      file: string;
      project: string;
      outcomes: Record<string, number>;
      tests: number;
      missing: number;
      attempts: {
        startMs: number;
        durationMs: number;
        status: string;
        worker: number;
        retry: number;
      }[];
    }
  >();
  const visit = (suite: JSONReportSuite) => {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        // Preserve renderer paths too; never collapse files to their basename.
        const file = resolve("tests/e2e", spec.file);
        const root = resolve(".");
        const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : spec.file;
        const key = JSON.stringify([relative, test.projectName]);
        let group = groups.get(key);
        if (!group) {
          group = {
            file: relative,
            project: test.projectName,
            outcomes: {},
            tests: 0,
            missing: 0,
            attempts: [],
          };
          groups.set(key, group);
        }
        group.tests++;
        group.outcomes[test.status] = (group.outcomes[test.status] ?? 0) + 1;
        if (!test.results.length) group.missing++;
        for (const result of test.results) {
          group.attempts.push({
            startMs: Date.parse(result.startTime),
            durationMs: result.duration,
            status: result.status ?? "missing",
            worker: result.workerIndex,
            retry: result.retry,
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  const files = [...groups.values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.project.localeCompare(b.project))
    .map((group) => {
      const executed = group.attempts.filter(
        (attempt) => attempt.status !== "skipped" && attempt.worker >= 0,
      );
      const startMs = executed.length
        ? Math.min(...executed.map((attempt) => attempt.startMs))
        : null;
      const endMs = executed.length
        ? Math.max(...executed.map((attempt) => attempt.startMs + attempt.durationMs))
        : null;
      return {
        ...group,
        startMs,
        endMs,
        elapsedMs: startMs === null || endMs === null ? null : endMs - startMs,
        workMs: executed.reduce((sum, attempt) => sum + attempt.durationMs, 0),
        skipped: group.attempts.filter((attempt) => attempt.status === "skipped").length,
      };
    });
  const selectedFiles = [...new Set(files.map((file) => file.file))].sort();
  const missingFiles = context.requestedFiles.filter((file) => !selectedFiles.includes(file));
  const complete =
    report !== null &&
    files.length > 0 &&
    missingFiles.length === 0 &&
    files.reduce((sum, file) => sum + file.tests, 0) ===
      report.stats.expected + report.stats.unexpected + report.stats.flaky + report.stats.skipped &&
    files.every(
      (file) =>
        file.missing === 0 &&
        file.attempts.every(
          (attempt) =>
            attempt.status !== "interrupted" &&
            attempt.status !== "missing" &&
            Number.isFinite(attempt.startMs) &&
            Number.isFinite(attempt.durationMs),
        ),
    );

  const successful =
    complete &&
    context.testStepOutcome === "success" &&
    report?.errors.length === 0 &&
    report.stats.unexpected === 0 &&
    report.stats.flaky === 0;
  return {
    schemaVersion: 1,
    ...context,
    reportState: report ? "present" : "missing",
    complete,
    successful,
    configuredWorkers: report?.config.workers ?? null,
    actualWorkers: report?.config.metadata.actualWorkers ?? null,
    selectedFiles,
    missingFiles,
    stats: report?.stats ?? null,
    timing: {
      // This observation precedes uploads and runner cleanup; it is not final job occupancy.
      jobObservedMs: context.observedAt - context.jobStartedAt,
      setupMs:
        context.testStepStartedAt === null
          ? null
          : context.testStepStartedAt - context.jobStartedAt,
      testStepObservedMs:
        context.testStepStartedAt === null ? null : context.observedAt - context.testStepStartedAt,
      playwrightMs: report?.stats.duration ?? null,
    },
    files,
  };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error("Usage: journey-timing.ts <source-results.json> <timing.json>");
  const env = process.env;
  const seconds = (value: string | undefined) => (value ? Number(value) * 1000 : null);
  const report = existsSync(input) ? (JSON.parse(readFileSync(input, "utf8")) as JSONReport) : null;
  const timing = journeyTiming(report, {
    run: env.GITHUB_RUN_ID ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT ?? "",
    revision: env.TIMING_REVISION ?? "",
    platform: env.RUNNER_OS ?? "",
    architecture: env.RUNNER_ARCH ?? "",
    lane: env.LANE ?? "",
    suite: env.SUITE ?? "",
    shard: env.SHARD ?? "",
    job: env.GITHUB_JOB ?? "",
    artifactSuffix: env.ARTIFACT_SUFFIX ?? "",
    requestedFiles: (env.FILES ?? "").split(/\s+/).filter(Boolean),
    jobStartedAt: seconds(env.TIMING_JOB_START) ?? Date.now(),
    testStepStartedAt: seconds(env.TIMING_TEST_START),
    observedAt: Date.now(),
    testStepOutcome: env.TEST_OUTCOME ?? "unknown",
  });
  writeFileSync(output, `${JSON.stringify(timing)}\n`);
  console.log(
    JSON.stringify({
      output,
      complete: timing.complete,
      successful: timing.successful,
      files: timing.selectedFiles.length,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
