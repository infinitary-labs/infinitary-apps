// Writes tests/helpers/shardTimings.json, the measured time of each unit test
// file that scripts/shard-balance.ts balances the unit groups by (INF-2674).
//
//   node scripts/shard-timings.ts <vitest-report.json>...
//
// Each report comes from a run of the unit projects with `--reporter=json`; the
// Linux test groups of `verify.yml` upload theirs as `vitest-timing-<group>`.
// A file measured in several reports takes the longest, so a slow run is not
// understated. Run it again when files move or a group drifts apart, and commit
// the result.

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_TIMINGS_FILE, type ShardTimings } from "./shard-balance.ts";

type VitestReport = {
  testResults: { name: string; startTime: number; endTime: number }[];
};

const root = fileURLToPath(new URL("..", import.meta.url));

export function timingsFromReports(reports: readonly VitestReport[]): ShardTimings {
  const seconds: Record<string, number> = {};
  for (const report of reports) {
    for (const file of report.testResults) {
      const path = relative(root, file.name);
      const took = Math.max(0.1, Math.round((file.endTime - file.startTime) / 100) / 10);
      seconds[path] = Math.max(seconds[path] ?? 0, took);
    }
  }
  return Object.fromEntries(Object.entries(seconds).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reports = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, "utf8")));
  if (reports.length === 0) {
    console.error("usage: node scripts/shard-timings.ts <vitest-report.json>...");
    process.exit(2);
  }
  writeFileSync(SHARD_TIMINGS_FILE, `${JSON.stringify(timingsFromReports(reports), null, 2)}\n`);
}
