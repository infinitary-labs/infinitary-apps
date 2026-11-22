// Writes tests/helpers/shardTimings.json, the measured time of each unit test
// file that scripts/shard-balance.ts balances the unit groups by (INF-2674),
// and with --reach tests/helpers/reachTimings.json, the measured time of each
// integration and browser file, which the branch check's reader step weighs
// its parts by beside the unit record (INF-5493).
//
//   node scripts/shard-timings.ts <vitest-report.json>...           the unit groups' reports
//   node scripts/shard-timings.ts --reach <vitest-report.json>...   the integration and browser groups' reports
//
// Each report comes from a run with `--reporter=json`; the Linux test groups of
// `verify.yml` upload theirs as `vitest-timing-<group>`. A report from another
// checkout, such as a downloaded one, names each file by that checkout's path,
// so each file is named by its path from the repository root it shares with
// this one. A file measured in several reports takes the longest, so a slow run
// is not understated. Run it again when files move or a group drifts apart, and
// commit the result.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REACH_TIMINGS_FILE, SHARD_TIMINGS_FILE, type ShardTimings } from "./shard-balance.ts";

type VitestReport = {
  testResults: { name: string; startTime: number; endTime: number }[];
};

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * A reported file's path from the repository root: the longest end of its
 * path that names a file here, whichever checkout ran it. main's test groups
 * run from a checkout nested inside the machine's own, so a path under this
 * root is not yet its path from it. A file this repository no longer has
 * names nothing.
 */
export function repositoryPath(name: string, base = root): string | undefined {
  const parts = name.split(/[\\/]/);
  for (let start = 1; start < parts.length; start++) {
    const candidate = parts.slice(start).join("/");
    if (existsSync(join(base, candidate))) return candidate;
  }
  return undefined;
}

export function timingsFromReports(reports: readonly VitestReport[]): ShardTimings {
  const seconds: Record<string, number> = {};
  for (const report of reports) {
    for (const file of report.testResults) {
      const path = repositoryPath(file.name);
      if (path === undefined) continue;
      const took = Math.max(0.1, Math.round((file.endTime - file.startTime) / 100) / 10);
      seconds[path] = Math.max(seconds[path] ?? 0, took);
    }
  }
  return Object.fromEntries(Object.entries(seconds).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const reach = args[0] === "--reach";
  const reports = args
    .slice(reach ? 1 : 0)
    .map((path) => JSON.parse(readFileSync(path, "utf8")));
  if (reports.length === 0) {
    console.error("usage: node scripts/shard-timings.ts [--reach] <vitest-report.json>...");
    process.exit(2);
  }
  writeFileSync(
    reach ? REACH_TIMINGS_FILE : SHARD_TIMINGS_FILE,
    `${JSON.stringify(timingsFromReports(reports), null, 2)}\n`,
  );
}
