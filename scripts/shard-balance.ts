// Splits test files into groups of about equal measured time (INF-2674, the
// captain: "split main's unit tests into groups by measured time instead of
// by file name"). vitest's own --shard cuts a hash of each file's path into
// equal counts of files, so a group that draws the slow files runs far past
// the others (group 3 of 3 took 15 minutes against 6 to 9).
//
//   node scripts/shard-balance.ts <index>/<count> [file ...]   prints a group's files
//
// The times are tests/helpers/shardTimings.json, written by
// scripts/shard-timings.ts from a vitest JSON report.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Seconds of work per test file, keyed by its path from the repository root. */
export type ShardTimings = Readonly<Record<string, number>>;

/** The measured times committed beside the sequencer. */
export const SHARD_TIMINGS_FILE = fileURLToPath(
  new URL("../tests/helpers/shardTimings.json", import.meta.url),
);

export function readShardTimings(file = SHARD_TIMINGS_FILE): ShardTimings {
  return JSON.parse(readFileSync(file, "utf8")) as ShardTimings;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

/**
 * Every file lands in exactly one of `count` groups: the longest first into
 * the group with the least time so far. A file with no measured time (a new
 * one) weighs the median of the measured ones, so a new file spreads like a
 * typical one. The same files and times always give the same groups, since
 * every group's machine computes the split alone.
 */
export function balanceShards(
  files: readonly string[],
  count: number,
  timings: ShardTimings,
): string[][] {
  const measured = new Map(Object.entries(timings));
  const unknownWeight = median(files.flatMap((file) => measured.get(file) ?? []));
  const weighted = files
    .map((file) => ({ file, weight: measured.get(file) ?? unknownWeight }))
    .toSorted((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const groups = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }));
  for (const { file, weight } of weighted) {
    const lightest = groups.reduce((least, group) => (group.total < least.total ? group : least));
    lightest.files.push(file);
    lightest.total += weight;
  }
  return groups.map((group) => group.files);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [shard, ...files] = process.argv.slice(2);
  const [index = 0, count = 0] = (shard ?? "").split("/").map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
    console.error("usage: node scripts/shard-balance.ts <index>/<count> [file ...]");
    process.exit(2);
  }
  const timings = readShardTimings();
  const groups = balanceShards(files.length ? files : Object.keys(timings), count, timings);
  console.log((groups[index - 1] ?? []).join("\n"));
}
