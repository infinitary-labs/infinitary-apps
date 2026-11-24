// Splits a journey lane into groups of about equal measured time (INF-2987,
// the captain: "Group journeys by measured time, add Linux groups and even
// out the three Mac jobs"). Playwright's own --shard cuts a lane's files into
// equal counts in listing order, so the group that drew the slow files ran
// minutes past the others and held up every batch run.
//
//   node scripts/journey-groups.ts --platform <linux|mac|mac-hosted> --lane <parallel|desktop>
//     --group <index>/<count> [--jobs <job>,...] -- <playwright test arguments>
//
// runs `pnpm exec playwright test <arguments>` over the group's files, and
// nothing when the group holds none. `--jobs` names the Mac job each group
// runs in, in group order: a group starts with the seconds its job spends
// outside the journeys (the record's `macJobs`), so the job with other work
// takes fewer journeys. The times are tests/helpers/journeyTimings.json,
// written by scripts/journey-group-timings.ts from the runs' own results.
// `mac-hosted` is GitHub's own Mac, which runs the same files about three
// times slower than the project's Macs and with fewer workers, so its groups
// are balanced by its own times.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_SUITES, FAR_LINUX_JOURNEYS, RENDERER_SUITES } from "../tests/e2e/lanes.ts";
import { balanceShards, fileWeights, type ShardTimings } from "./shard-balance.ts";

export type JourneyPlatform = "linux" | "mac" | "mac-hosted";
export type JourneyLane = "parallel" | "desktop";

/** Seconds of job time per journey file on each platform (a file's work over
 * the workers that ran it), and the seconds each Mac job spends outside its
 * share of the journeys, by the job's lane, on the project's Macs and on
 * GitHub's. */
export type JourneyTimings = {
  linux: ShardTimings;
  mac: ShardTimings;
  macJobs: Readonly<Record<string, number>>;
  macHosted: ShardTimings;
  macHostedJobs: Readonly<Record<string, number>>;
};

const FILE_TIMES = { linux: "linux", mac: "mac", "mac-hosted": "macHosted" } as const;
const JOB_TIMES = { linux: "macJobs", mac: "macJobs", "mac-hosted": "macHostedJobs" } as const;

export const JOURNEY_TIMINGS_FILE = fileURLToPath(
  new URL("../tests/helpers/journeyTimings.json", import.meta.url),
);

export function readJourneyTimings(file = JOURNEY_TIMINGS_FILE): JourneyTimings {
  return JSON.parse(readFileSync(file, "utf8")) as JourneyTimings;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const specs = (dir: string) =>
  readdirSync(`${root}${dir}`)
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => `${dir}/${file}`);

/**
 * A lane's spec files, by path from the repository root, as tests/e2e/lanes.ts
 * assigns them: the parallel lanes are the `styles` project's tests/renderer
 * and the renderer and application suites; the desktop lane is every other
 * file of tests/e2e (tests/e2e-lanes.test.ts holds this to Playwright's own
 * listing).
 */
export function laneFiles(lane: JourneyLane): string[] {
  const shared = new Set(
    [...RENDERER_SUITES, ...APPLICATION_SUITES].map((pattern) => pattern.replace(/^\*\*\//, "")),
  );
  const journeys = specs("tests/e2e");
  const inParallel = (file: string) => shared.has(file.slice("tests/e2e/".length));
  return lane === "parallel"
    ? [...specs("tests/renderer"), ...journeys.filter(inParallel)].toSorted()
    : journeys.filter((file) => !inParallel(file)).toSorted();
}

/**
 * The one-based group of each lane that holds every journey whose far
 * computer is this one on Linux (`FAR_LINUX_JOURNEYS`, tests/e2e/lanes.ts).
 * A full suite picks its groups inside the job, after its machine is chosen,
 * so only a fixed group lets source-journeys.yml mark that group's job to stay
 * off the arm64 guests, which have no SSH server and no x64 chip.
 */
export const FAR_LINUX_GROUP = 1;

const farLinux = new Set(FAR_LINUX_JOURNEYS);

/** Group `index` of `count` (one-based) of the lane's files on the platform. */
export function journeyGroup(
  options: {
    platform: JourneyPlatform;
    lane: JourneyLane;
    index: number;
    count: number;
    jobs?: readonly string[];
  },
  timings: JourneyTimings,
  files: readonly string[] = laneFiles(options.lane),
): string[] {
  const headStarts = (options.jobs ?? []).map((job) => {
    const seconds = timings[JOB_TIMES[options.platform]][job];
    if (seconds === undefined) throw new Error(`No measured time outside the journeys for job ${job}`);
    return seconds;
  });
  const measured = timings[FILE_TIMES[options.platform]];
  if (options.platform !== "linux")
    return balanceShards(files, options.count, measured, headStarts)[options.index - 1] ?? [];
  // The far journeys start their group as a job's own work starts a Mac
  // group, and every file keeps the weight it has over the whole lane.
  const weights = fileWeights(files, measured);
  const far = files.filter((file) => farLinux.has(basename(file))).toSorted();
  const farSeconds = far.reduce((sum, file) => sum + (weights.get(file) ?? 0), 0);
  const groups = balanceShards(
    files.filter((file) => !farLinux.has(basename(file))),
    options.count,
    Object.fromEntries(weights),
    Array.from(
      { length: options.count },
      (_, at) => (headStarts[at] ?? 0) + (at === FAR_LINUX_GROUP - 1 ? farSeconds : 0),
    ),
  );
  const group = groups[options.index - 1] ?? [];
  return options.index === FAR_LINUX_GROUP ? [...far, ...group] : group;
}

/** Playwright's file argument is a regular expression over the absolute path:
 * this one matches the one file, never another whose name ends the same way. */
export function fileArgument(file: string): string {
  return `/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function main(): void {
  const args = process.argv.slice(2);
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  const playwright = split < 0 ? [] : args.slice(split + 1);
  const value = (flag: string) => {
    const at = own.indexOf(flag);
    return at < 0 ? "" : (own[at + 1] ?? "");
  };
  const platform = value("--platform");
  const lane = value("--lane");
  const [index = 0, count = 0] = value("--group").split("/").map(Number);
  const jobs = value("--jobs").split(",").filter(Boolean);
  if (
    !Object.hasOwn(FILE_TIMES, platform) ||
    (lane !== "parallel" && lane !== "desktop") ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    index > count ||
    (jobs.length > 0 && jobs.length !== count)
  ) {
    console.error(
      "usage: node scripts/journey-groups.ts --platform <linux|mac|mac-hosted> --lane <parallel|desktop> --group <index>/<count> [--jobs <job>,...] -- <playwright test arguments>",
    );
    process.exit(2);
  }
  const files = journeyGroup(
    { platform: platform as JourneyPlatform, lane, index, count, jobs },
    readJourneyTimings(),
  );
  console.log(`Group ${index}/${count} of the ${lane} lane on ${platform}: ${files.length} files`);
  for (const file of files) console.log(`  ${file}`);
  if (files.length === 0) return;
  const result = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", ...playwright, ...files.map(fileArgument)],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
