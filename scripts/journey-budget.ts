import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  APPLICATION_SUITES,
  E2E_MAX_WORKERS,
  FAR_LINUX_JOURNEYS,
  RENDERER_SUITES,
} from "../tests/e2e/lanes.ts";
import { MAC_ONLY_TAG } from "../tests/e2e/tags.ts";
import { needsMac } from "../tests/lint/e2eMacTag.ts";
import { legacyJobName } from "./ci-job-names.mjs";
import type { Reasons } from "./affected-journeys.ts";

// INF-658: the captain chose six minutes of journeys, not a job timeout; it sizes the Linux jobs.
export const JOURNEY_BUDGET_MS = 6 * 60 * 1000;
/**
 * INF-2486 cut D, approved by the captain: a Linux job under two minutes of
 * journeys joins its lane's lightest other job, since each job repeats the
 * checkout, install and build before its first test.
 */
export const SMALL_BIN_MS = 2 * 60 * 1000;
/** The PC's self-hosted Linux places, five at once (INF-1720's plan). */
export const LINUX_PLACES = 5;
const parallel = new Set([...APPLICATION_SUITES, ...RENDERER_SUITES].map((file) => basename(file)));
const farLinux = new Set(FAR_LINUX_JOURNEYS);
export const laneOf = (file: string): "parallel" | "desktop" =>
  parallel.has(basename(file)) ? "parallel" : "desktop";

export type ReportSuite = {
  file?: string;
  suites?: ReportSuite[];
  specs?: { file?: string; tests: { results: { duration: number; status: string }[] }[] }[];
};

/** Keep actual work, including hooks and retries reported by Playwright. */
export function journeyTimes(report: { suites: ReportSuite[] }): Map<string, number> {
  const times = new Map<string, number>();
  const walk = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? "";
      if (!file.endsWith(".spec.ts") || file.startsWith("../")) continue;
      const path = `tests/e2e/${basename(file)}`;
      const duration = spec.tests
        .flatMap((test) => test.results)
        .filter((result) => result.status !== "skipped")
        .reduce((sum, result) => sum + result.duration, 0);
      times.set(path, (times.get(path) ?? 0) + duration);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  if (![...times.values()].some((time) => time > 0))
    throw new Error("The passing verify result contains no measured journeys");
  return times;
}

/**
 * The journey times at `path`: one verify result, or a folder of the results
 * the chooser downloaded from one passing verify run, each artifact in a
 * folder of its own - every Mac journey lane's `e2e-results.json` since
 * INF-2779, or the one result of a run from before it. Nothing at `path`
 * reads as no timings.
 */
export function readJourneyTimes(path: string): Map<string, number> {
  if (!existsSync(path)) return new Map();
  const files = statSync(path).isDirectory()
    ? readdirSync(path, { recursive: true, encoding: "utf8" })
        .filter((file) => basename(file) === "e2e-results.json")
        .toSorted()
        .map((file) => join(path, file))
    : [path];
  return journeyTimes({
    suites: files.flatMap(
      (file) => (JSON.parse(readFileSync(file, "utf8")) as { suites: ReportSuite[] }).suites,
    ),
  });
}

const linuxReport = z.object({
  schemaVersion: z.number(),
  run: z.string(),
  attempt: z.string(),
  revision: z.string(),
  platform: z.string(),
  architecture: z.string(),
  lane: z.string(),
  suite: z.string(),
  shard: z.string(),
  job: z.string(),
  artifactSuffix: z.string(),
  jobStartedAt: z.number(),
  observedAt: z.number(),
  complete: z.boolean(),
  successful: z.boolean(),
  configuredWorkers: z.number().nullable(),
  actualWorkers: z.number().nullable(),
  selectedFiles: z.array(z.string()),
  missingFiles: z.array(z.string()),
  files: z.array(
    z.object({
      file: z.string(),
      project: z.string(),
      tests: z.number(),
      missing: z.number(),
      startMs: z.number().nullable(),
      endMs: z.number().nullable(),
      elapsedMs: z.number().nullable(),
      skipped: z.number(),
      workMs: z.number(),
    }),
  ),
});
/** A compact observation joined to GitHub's final job timestamps and conclusion. */
export type LinuxObservation = {
  report: z.infer<typeof linuxReport>;
  job: {
    conclusion: string;
    run: string;
    attempt: string;
    startedAt: number;
    completedAt: number;
  };
};
const completedJob = z.object({
  run_id: z.number(),
  run_attempt: z.number(),
  head_sha: z.string(),
  name: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  steps: z
    .array(
      z.object({
        name: z.string(),
        started_at: z.string().nullable(),
        completed_at: z.string().nullable(),
      }),
    )
    .default([]),
});

/**
 * The Linux matrix journeys.yml runs, each group with its one-based part,
 * which its job name carries (scripts/ci-job-names.mjs), and whether it holds
 * a journey whose far computer is this one, which keeps it on LINUX_RUNNER's
 * places (`FAR_LINUX_JOURNEYS`, tests/e2e/lanes.ts).
 */
export function linuxParts<Bin extends { files: string }>(
  bins: readonly Bin[],
): (Bin & { part: string; farLinux: boolean })[] {
  return bins.map((bin, index) => ({
    ...bin,
    part: `${index + 1}/${bins.length}`,
    farLinux: bin.files.split(" ").some((file) => farLinux.has(basename(file))),
  }));
}

/** Read only schema-compatible reports with an unambiguous successful job identity. */
export function readLinuxObservations(directory: string, jobsFile: string): LinuxObservation[] {
  const observations: LinuxObservation[] = [];
  const jobs = z.array(completedJob).parse(JSON.parse(readFileSync(jobsFile, "utf8")));
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === "journey-timing.json") {
        // Optional timings cannot remove coverage or break the existing fallback.
        let parsed: ReturnType<typeof linuxReport.safeParse>;
        try {
          parsed = linuxReport.safeParse(JSON.parse(readFileSync(file, "utf8")));
        } catch {
          continue;
        }
        if (!parsed.success) continue;
        const report = parsed.data;
        const suffix =
          report.suite === "full"
            ? // A full group names its count since INF-2987; one from before was one of four.
              `journeys (${report.lane} ${report.shard.includes("/") ? report.shard : `${report.shard}/4`})`
            : `source-desktop (${report.lane})`;
        // GitHub timestamps have whole-second precision; the report clock has
        // milliseconds. Join the exporter and first timing step at that precision
        // so overlapping jobs with the same reusable name remain distinguishable.
        const during = (
          at: number,
          step: { started_at: string | null; completed_at: string | null },
        ) =>
          Math.floor(Date.parse(step.started_at ?? "") / 1000) <= Math.floor(at / 1000) &&
          Math.floor(at / 1000) <= Math.floor(Date.parse(step.completed_at ?? "") / 1000);
        const matches = jobs.filter(
          (job) =>
            String(job.run_id) === report.run &&
            String(job.run_attempt) === report.attempt &&
            job.head_sha === report.revision &&
            job.conclusion === "success" &&
            report.job === "source-desktop" &&
            // Read by the name it had before the trigger-first rename (scripts/ci-job-names.mjs).
            (legacyJobName(job.name) === suffix || legacyJobName(job.name).endsWith(` / ${suffix}`)) &&
            job.steps.some(
              (step) =>
                step.name === "Record the timing observation start" &&
                during(report.jobStartedAt, step),
            ) &&
            job.steps.some(
              (step) =>
                step.name === "Export compact Linux timing" && during(report.observedAt, step),
            ) &&
            Date.parse(job.started_at) <= report.jobStartedAt &&
            Date.parse(job.completed_at ?? "") >= report.observedAt,
        );
        // Reusable overflow calls can have the same displayed name. Never guess
        // between overlapping jobs; an ambiguous observation remains unmeasured.
        if (matches.length !== 1) continue;
        const job = matches[0];
        if (!job) continue;
        observations.push({
          report,
          job: {
            run: String(job.run_id),
            attempt: String(job.run_attempt),
            conclusion: job.conclusion ?? "unknown",
            startedAt: Date.parse(job.started_at),
            completedAt: Date.parse(job.completed_at ?? ""),
          },
        });
      }
    }
  };
  walk(directory);
  return observations;
}
type LinuxBin = { lane: "parallel" | "desktop"; files: string; estimatedMs: number };

/** INF-1987 change 2: estimate whole-file scheduling, never divide an indivisible file. */
export function calibratedPlacement(fallback: LinuxBin[], observations: LinuxObservation[]) {
  const measured = new Map<string, number>();
  const overhead = new Map<LinuxBin["lane"], number>();
  const workerCounts = new Map<LinuxBin["lane"], Set<number>>();
  for (const { report, job } of observations) {
    const configured = report.configuredWorkers;
    const workers = report.lane === "desktop" ? 1 : configured;
    if (
      report.schemaVersion !== 1 ||
      !report.complete ||
      !report.successful ||
      report.platform !== "Linux" ||
      report.architecture !== "X64" ||
      !["parallel", "desktop"].includes(report.lane) ||
      !["starter", "affected", "full"].includes(report.suite) ||
      typeof configured !== "number" ||
      !Number.isInteger(configured) ||
      configured < 1 ||
      configured > E2E_MAX_WORKERS ||
      workers === null ||
      typeof report.actualWorkers !== "number" ||
      report.actualWorkers < 1 ||
      report.actualWorkers > workers ||
      job.conclusion !== "success" ||
      job.run !== report.run ||
      job.attempt !== report.attempt ||
      !report.revision ||
      !Number.isFinite(job.startedAt) ||
      !Number.isFinite(job.completedAt) ||
      job.completedAt <= job.startedAt ||
      report.missingFiles.length > 0 ||
      report.files.some((file) => file.missing > 0) ||
      JSON.stringify([...new Set(report.files.map((file) => file.file))].sort()) !==
        JSON.stringify(report.selectedFiles.toSorted())
    )
      continue;
    const files = report.files.filter((file) => file.file.startsWith("tests/e2e/"));
    // Parallel reports may also contain styles files; their work still belongs
    // to the job's elapsed span, but they are not affected-journey selections.
    const executed = report.files.filter((file) => file.startMs !== null && file.endMs !== null);
    if (files.some((file) => laneOf(file.file) !== report.lane)) continue;
    const start = executed.length
      ? Math.min(...executed.map((file) => Number(file.startMs)))
      : job.startedAt;
    const end = executed.length ? Math.max(...executed.map((file) => Number(file.endMs))) : start;
    if (start < job.startedAt || end > job.completedAt || end < start) continue;
    const lane = report.lane as LinuxBin["lane"];
    const counts = workerCounts.get(lane) ?? new Set<number>();
    counts.add(Number(workers));
    workerCounts.set(lane, counts);
    overhead.set(
      lane,
      Math.max(overhead.get(lane) ?? 0, job.completedAt - job.startedAt - (end - start)),
    );
    const grouped = new Map<string, number>();
    for (const file of files) {
      // A completed observed skip is zero executed work, not missing data.
      const elapsed = file.elapsedMs ?? (file.skipped === file.tests ? 0 : Number.NaN);
      if (!Number.isFinite(elapsed) || elapsed < 0) continue;
      grouped.set(file.file, (grouped.get(file.file) ?? 0) + elapsed);
    }
    for (const [file, elapsed] of grouped)
      measured.set(file, Math.max(measured.get(file) ?? 0, elapsed));
  }
  const selected = fallback.flatMap((bin) => bin.files.split(" ")).filter(Boolean);
  const missing = selected.filter((file) => !measured.has(file)).sort();
  // Preserve modest selections' existing count and packing. Partial coverage
  // must not mix incomparable Mac sums and Linux elapsed observations.
  if (fallback.length < LINUX_PLACES || missing.length || !selected.length)
    return { linux: fallback, source: "conservative" as const, missing };
  const lanes = (["parallel", "desktop"] as const).filter((lane) =>
    selected.some((file) => laneOf(file) === lane),
  );
  if (lanes.some((lane) => !overhead.has(lane) || workerCounts.get(lane)?.size !== 1))
    return { linux: fallback, source: "conservative" as const, missing };
  const estimate = (lane: LinuxBin["lane"], files: string[]) => {
    const workers = Array.from({ length: [...(workerCounts.get(lane) ?? [1])][0] ?? 1 }, () => 0);
    for (const file of files) {
      const worker = workers.indexOf(Math.min(...workers));
      workers[worker] = (workers[worker] ?? 0) + (measured.get(file) ?? 0);
    }
    return Math.max(...workers) + (overhead.get(lane) ?? 0);
  };
  const pack = (lane: LinuxBin["lane"], places: number): LinuxBin[] => {
    const bins: string[][] = Array.from({ length: places }, () => []);
    for (const file of selected
      .filter((file) => laneOf(file) === lane)
      .sort((a, b) => (measured.get(b) ?? 0) - (measured.get(a) ?? 0) || a.localeCompare(b))) {
      // Prefer empty bins before equal-cost occupied bins, including skip-only files.
      const ranked = bins
        .map((files, index) => ({
          index,
          size: files.length,
          end: estimate(lane, [...files, file]),
        }))
        .sort((a, b) => a.end - b.end || a.size - b.size || a.index - b.index);
      bins[ranked[0]?.index ?? 0]?.push(file);
    }
    return bins
      .filter((files) => files.length)
      .map((files) => ({ lane, files: files.join(" "), estimatedMs: estimate(lane, files) }));
  };
  const current = fallback.map((bin) => ({
    ...bin,
    estimatedMs: estimate(bin.lane, bin.files.split(" ")),
  }));
  const finish = (bins: LinuxBin[]) => Math.max(...bins.map((bin) => bin.estimatedMs));
  const occupancy = (bins: LinuxBin[]) => bins.reduce((sum, bin) => sum + bin.estimatedMs, 0);
  let best = current;
  for (let first = 1; first <= LINUX_PLACES; first++) {
    if (lanes.length > 1 && first === LINUX_PLACES) continue;
    const candidate = lanes.flatMap((lane, index) =>
      pack(lane, index === 0 ? first : LINUX_PLACES - first),
    );
    // No extra jobs, and no predicted occupancy increase to buy an earlier tail.
    if (candidate.length !== fallback.length || occupancy(candidate) > occupancy(current)) continue;
    if (finish(candidate) < finish(best)) best = candidate;
  }
  return { linux: best, source: "linux" as const, missing };
}

/**
 * A test runs on the Mac only when it needs a Mac (docs/principles.md,
 * 2026-10-28): every picked file runs on Linux, and the Mac runs the picked
 * files that hold a test tagged MAC_ONLY_TAG, only those tests. A request may
 * run every picked file on the Mac as well (`everyOnMac`).
 */
export function budget(
  reasons: Reasons,
  times: Map<string, number>,
  tagged: (file: string) => boolean,
  everyOnMac = false,
  observations: LinuxObservation[] = [],
  applyLinux = false,
  platforms: "linux" | "mac" | "both" = "both",
) {
  // New and previously skipped journeys use the middle measured file of their
  // lane (INF-2486 cut D): the slowest gave each one a job of its own.
  const middle = (lane: "parallel" | "desktop") => {
    const measured = [...times]
      .filter(([path, ms]) => ms > 0 && laneOf(path) === lane)
      .map(([, ms]) => ms)
      .sort((a, b) => a - b);
    return measured[Math.floor(measured.length / 2)];
  };
  const cost = (file: string) =>
    times.get(file) || (times.size === 0 ? JOURNEY_BUDGET_MS : (middle(laneOf(file)) ?? 1));
  const ordered = [...reasons.keys()].sort((a, b) => a.localeCompare(b));
  const mac = ordered.filter((file) => everyOnMac || tagged(file));
  // INF-658's measured Linux rates: one Mac minute of parallel work per minute,
  // and 0.6 Mac minutes of serial work per minute. Sum is conservative for parallel files.
  const linuxCost = (file: string) => cost(file) / (laneOf(file) === "desktop" ? 0.6 : 1);
  type Bin = { lane: "parallel" | "desktop"; files: string; estimatedMs: number };
  // Longest file first, each into its lane's least loaded job: within six
  // minutes while `places` is unbounded, otherwise into exactly `places` jobs.
  const pack = (lane: Bin["lane"], places: number): Bin[] => {
    const bins: Bin[] = [];
    for (const file of ordered
      .filter((file) => laneOf(file) === lane)
      .sort((a, b) => linuxCost(b) - linuxCost(a) || a.localeCompare(b))) {
      const lightest = bins.toSorted((a, b) => a.estimatedMs - b.estimatedMs)[0];
      let bin =
        lightest &&
        (bins.length >= places || lightest.estimatedMs + linuxCost(file) <= JOURNEY_BUDGET_MS)
          ? lightest
          : undefined;
      if (!bin) {
        bin = { lane, files: "", estimatedMs: 0 };
        bins.push(bin);
      }
      bin.files = [bin.files, file].filter(Boolean).join(" ");
      bin.estimatedMs += linuxCost(file);
    }
    return bins;
  };
  const lanes = (["parallel", "desktop"] as const).filter((lane) =>
    ordered.some((file) => laneOf(file) === lane),
  );
  const joinSmall = (bins: Bin[]): Bin[] => {
    const kept = [...bins];
    for (const small of bins.toSorted((a, b) => a.estimatedMs - b.estimatedMs)) {
      if (small.estimatedMs >= SMALL_BIN_MS) continue;
      const into = kept
        .filter((bin) => bin !== small && bin.lane === small.lane)
        .toSorted((a, b) => a.estimatedMs - b.estimatedMs)[0];
      if (!into) continue;
      into.files = `${into.files} ${small.files}`;
      into.estimatedMs += small.estimatedMs;
      kept.splice(kept.indexOf(small), 1);
    }
    return kept;
  };
  let linux = lanes.flatMap((lane) => joinSmall(pack(lane, Number.POSITIVE_INFINITY)));
  if (linux.length > LINUX_PLACES) {
    // INF-1720's plan: the journeys run on the PC's Linux places, five at once,
    // so it packs into at most one job per place, each repeating the setup
    // once. Each lane takes places by its share of the work, one at least.
    const work = (lane: Bin["lane"]) =>
      ordered
        .filter((file) => laneOf(file) === lane)
        .reduce((sum, file) => sum + linuxCost(file), 0);
    const total = lanes.reduce((sum, lane) => sum + work(lane), 0);
    const first = lanes[0] as Bin["lane"];
    const share =
      lanes.length === 1
        ? LINUX_PLACES
        : Math.min(LINUX_PLACES - 1, Math.max(1, Math.round((LINUX_PLACES * work(first)) / total)));
    linux = lanes.flatMap((lane) => pack(lane, lane === first ? share : LINUX_PLACES - share));
  }
  const calibrated = calibratedPlacement(linux, observations);
  return {
    mac: platforms === "linux" ? [] : mac,
    // INF-1987: retain conservative execution when live adoption is unsupported.
    // The calibrated model remains inspectable and explicitly runnable for proofs.
    linux: platforms === "mac" ? [] : applyLinux ? calibrated.linux : linux,
    timingSource: applyLinux ? calibrated.source : "conservative",
    linuxCandidate: calibrated.linux,
    candidateTimingSource: calibrated.source,
    linuxUnmeasured: calibrated.missing,
    unmeasured: ordered.filter((file) => !times.get(file)),
  };
}

function main() {
  const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1] ?? "";
  const reasons = new Map<string, string[]>(
    Object.entries(JSON.parse(readFileSync(value("--selection"), "utf8"))),
  );
  // Historical timings optimize placement; their absence never removes an explicitly selected file.
  const times = readJourneyTimes(value("--timings"));
  const platforms = process.argv.includes("--platforms") ? value("--platforms") : "both";
  if (platforms !== "linux" && platforms !== "mac" && platforms !== "both")
    throw new Error("Journey platforms must be linux, mac or both.");
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const result = budget(
    reasons,
    times,
    (file) => needsMac(read(file) ?? "", file),
    process.argv.includes("--every-on-mac"),
    process.argv.includes("--linux-timings")
      ? readLinuxObservations(value("--linux-timings"), value("--linux-jobs"))
      : [],
    process.argv.includes("--apply-linux"),
    platforms,
  );
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `count=${result.mac.length}\nfiles=${result.mac.join(" ")}\nlinux-count=${result.linux.length}\nlinux=${JSON.stringify({ include: linuxParts(result.linux) })}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Journey placement\n\n${times.size === 0 ? "No historical timings: every selected file is scheduled. Budget-sized placeholders guide binning, not measured durations.\n\n" : ""}Mac: ${result.mac.length} files${process.argv.includes("--every-on-mac") ? ", every test, as requested" : `, only their tests tagged ${MAC_ONLY_TAG}`}.\n\n` +
        result.mac.map((file) => `- Mac: ${file}: ${reasons.get(file)?.join("; ")}`).join("\n") +
        "\n\n" +
        result.linux
          .map(
            (bin, index) =>
              `- Linux ${index + 1} (${bin.lane}): ${(bin.estimatedMs / 60000).toFixed(1)} minutes: ${bin.files}`,
          )
          .join("\n") +
        "\n\nCalibrated candidate (not automatic adoption):\n" +
        result.linuxCandidate
          .map(
            (bin, index) =>
              `- Candidate ${index + 1} (${bin.lane}): ${(bin.estimatedMs / 60000).toFixed(1)} minutes: ${bin.files}`,
          )
          .join("\n") +
        `\n\nExecution timing source: ${result.timingSource}. Candidate timing source: ${result.candidateTimingSource}. Calibrated placement is advisory unless explicitly requested for verification. Linux files without comparable readings: ${result.linuxUnmeasured.join(", ") || "none"}.\n\nUnmeasured Mac files (middle measured lane file used): ${result.unmeasured.join(", ") || "none"}. Linux-calibrated estimates include observed job overhead; conservative estimates exclude setup. Neither estimates runner waits. Indivisible files, and groups past the PC's ${LINUX_PLACES} Linux places, can exceed six minutes.\n`,
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
