// Writes tests/helpers/journeyTimings.json, the measured times
// scripts/journey-groups.ts balances the journey groups by (INF-2987).
//
//   node scripts/journey-group-timings.ts [--hosted] [--jobs <jobs.json>]... <report>...
//
// Each report is a passing full check's own result: a Linux journey group's
// `journey-timing.json` (the `journey-timing-Linux-*` artifacts of
// source-journeys.yml) or a Mac journey job's Playwright `e2e-results.json`
// (verify.yml's `e2e-results-<lane>` artifacts). A file's time is its tests'
// work over the workers that ran it, the share of its job's time it takes. A
// file measured in several reports takes the longest, so a slow run is not
// understated. Each `--jobs` file is GitHub's list of one such run's jobs
// (GET /repos/{owner}/{repo}/actions/runs/{run}/jobs): it measures each Mac
// job's time outside its journeys; without one the record keeps the times it
// has. With `--hosted`, the Mac reports and job lists are of GitHub's own
// Mac and write its times, `macHosted` and `macHostedJobs`, keeping the
// project's Macs' times as they are. Run it again when journeys move or the
// groups drift apart, and commit the result.

import { readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JOURNEY_TIMINGS_FILE,
  type JourneyTimings,
  readJourneyTimings,
} from "./journey-groups.ts";

/** A Linux journey group's compact report (scripts/journey-timing.ts). */
type LinuxReport = {
  platform: string;
  complete: boolean;
  actualWorkers: number | null;
  files: { file: string; workMs: number }[];
};

type PlaywrightSuite = {
  specs?: { file: string; tests: { results: { status?: string; duration: number }[] }[] }[];
  suites?: PlaywrightSuite[];
};

/** A Mac journey job's Playwright JSON result. */
type MacReport = {
  config: { metadata?: { actualWorkers?: number } };
  suites: PlaywrightSuite[];
};

type Job = {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: { name: string; started_at: string | null; completed_at: string | null }[];
};

/** The step a Mac job runs its journeys in (verify.yml), by its name now and
 * by the name GitHub gave it before it had one. */
export const JOURNEY_STEP = "Run this job's journeys";
const LEGACY_JOURNEY_STEP = /^Run cores="\$\(node scripts\/job-cores\.ts\)"/;

/** The Mac jobs whose time outside the journeys a group starts with, by the
 * end of their name (verify.yml's lane names): the parallel journeys job is
 * one job, or one of several groups on GitHub's Macs. */
const MAC_JOBS: Record<string, RegExp> = {
  parallel: / · Parallel journeys \(Mac(; group \d+\/\d+)?\)$/,
  mac: / · Native tests, replay and package \(Mac\)$/,
};

const seconds = (ms: number) => Math.max(0.1, Math.round(ms / 100) / 10);
const sorted = (record: Record<string, number>) =>
  Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : 1)));
const keepLongest = (record: Record<string, number>, key: string, value: number) => {
  record[key] = Math.max(record[key] ?? 0, value);
};

function macFileTimes(report: MacReport): Map<string, number> {
  const work = new Map<string, number>();
  const walk = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) {
      // Playwright names a file from its testDir, tests/e2e.
      const file = posix.normalize(posix.join("tests/e2e", spec.file));
      const ms = spec.tests
        .flatMap((test) => test.results)
        .filter((result) => result.status !== "skipped")
        .reduce((sum, result) => sum + result.duration, 0);
      work.set(file, (work.get(file) ?? 0) + ms);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return work;
}

/** Each Mac job's seconds outside its journeys step, from GitHub's job list. */
export function macJobTimes(jobs: readonly Job[]): Record<string, number> {
  const times: Record<string, number> = {};
  const span = (from: string | null, to: string | null) =>
    from && to ? Date.parse(to) - Date.parse(from) : Number.NaN;
  for (const [lane, name] of Object.entries(MAC_JOBS)) {
    for (const job of jobs.filter((candidate) => name.test(candidate.name))) {
      const whole = span(job.started_at, job.completed_at);
      const journeys = (job.steps ?? [])
        .filter((step) => step.name === JOURNEY_STEP || LEGACY_JOURNEY_STEP.test(step.name))
        .reduce((sum, step) => sum + span(step.started_at, step.completed_at), 0);
      if (Number.isFinite(whole) && Number.isFinite(journeys))
        keepLongest(times, lane, seconds(whole - journeys));
    }
  }
  return times;
}

export function timingsFromJourneyReports(
  reports: readonly (LinuxReport | MacReport)[],
  jobLists: readonly (readonly Job[])[],
  kept: JourneyTimings,
  hosted = false,
): JourneyTimings {
  const linux: Record<string, number> = {};
  const mac: Record<string, number> = {};
  for (const report of reports) {
    if ("files" in report) {
      if (report.platform !== "Linux" || !report.complete) continue;
      const workers = report.actualWorkers ?? 1;
      const work = new Map<string, number>();
      for (const entry of report.files) work.set(entry.file, (work.get(entry.file) ?? 0) + entry.workMs);
      for (const [file, ms] of work) keepLongest(linux, file, seconds(ms / workers));
    } else {
      const workers = report.config.metadata?.actualWorkers ?? 1;
      for (const [file, ms] of macFileTimes(report)) keepLongest(mac, file, seconds(ms / workers));
    }
  }
  const macJobs: Record<string, number> = {};
  for (const jobs of jobLists)
    for (const [lane, time] of Object.entries(macJobTimes(jobs))) keepLongest(macJobs, lane, time);
  const [files, own] = hosted ? (["macHosted", "macHostedJobs"] as const) : (["mac", "macJobs"] as const);
  return {
    ...kept,
    linux: Object.keys(linux).length ? sorted(linux) : kept.linux,
    [files]: Object.keys(mac).length ? sorted(mac) : kept[files],
    [own]: Object.keys(macJobs).length ? sorted(macJobs) : kept[own],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jobFiles = args.flatMap((arg, at) => (args[at - 1] === "--jobs" ? [arg] : []));
  const hosted = args.includes("--hosted");
  const reportFiles = args.filter(
    (arg, at) => arg !== "--jobs" && arg !== "--hosted" && args[at - 1] !== "--jobs",
  );
  if (reportFiles.length === 0) {
    console.error(
      "usage: node scripts/journey-group-timings.ts [--hosted] [--jobs <jobs.json>]... <report>...",
    );
    process.exit(2);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const jobLists = jobFiles.map((path) => {
    const answer = read(path);
    return (Array.isArray(answer) ? answer : (answer.jobs ?? answer.body?.jobs ?? [])) as Job[];
  });
  const timings = timingsFromJourneyReports(
    reportFiles.map(read),
    jobLists,
    readJourneyTimings(),
    hosted,
  );
  writeFileSync(JOURNEY_TIMINGS_FILE, `${JSON.stringify(timings, null, 2)}\n`);
}
