import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { balanceShards, readShardTimings } from "../scripts/shard-balance.ts";
import { timingsFromReports } from "../scripts/shard-timings.ts";

// INF-2674, the captain: "split main's unit tests into groups by measured
// time instead of by file name". The fixture is the committed record of
// measured times, the one the unit groups are balanced by.
const timings = readShardTimings();
const files = Object.keys(timings);
const total = (group: string[]) => group.reduce((sum, file) => sum + (timings[file] ?? 0), 0);

describe("balanceShards", () => {
  it("puts every file in exactly one group", () => {
    const groups = balanceShards(files, 3, timings);
    expect(groups.flat().toSorted()).toEqual(files.toSorted());
  });

  it("gives the groups about the same measured time", () => {
    const times = balanceShards(files, 3, timings).map(total);
    // The longest file bounds how even greedy packing can be.
    const slowest = Math.max(...Object.values(timings));
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(slowest);
  });

  it("splits identically on every machine, whatever order it lists the files", () => {
    expect(balanceShards(files.toReversed(), 3, timings)).toEqual(balanceShards(files, 3, timings));
  });

  // INF-2987: a group whose job has other work takes fewer files.
  it("gives a group with a head start that much less time", () => {
    const headStart = Math.max(...Object.values(timings)) * 2;
    const groups = balanceShards(files, 3, timings, [headStart]);
    expect(groups.flat().toSorted()).toEqual(files.toSorted());
    const ends = groups.map((group, index) => total(group) + (index === 0 ? headStart : 0));
    const slowest = Math.max(...Object.values(timings));
    expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(slowest);
    expect(total(groups[0] ?? [])).toBeLessThan(
      Math.min(total(groups[1] ?? []), total(groups[2] ?? [])),
    );
  });

  it("weighs a file with no measured time like a typical file", () => {
    const groups = balanceShards([...files, "src/newest.test.ts"], 3, timings);
    expect(groups.flat()).toContain("src/newest.test.ts");
    expect(groups.flat()).toHaveLength(files.length + 1);
  });
});

describe("timingsFromReports", () => {
  it("keeps each file's longest measured time, by path from the repository root", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const result = timingsFromReports([
      { testResults: [{ name: `${root}src/a.test.ts`, startTime: 1000, endTime: 3500 }] },
      { testResults: [{ name: `${root}src/a.test.ts`, startTime: 0, endTime: 9000 }] },
    ]);
    expect(result).toEqual({ "src/a.test.ts": 9 });
  });

  // INF-5493: main's Linux test groups check out the repository at a path
  // of their own, so a report downloaded from one names each file by that
  // path; the record names it from this repository's root, and drops a file
  // the repository no longer has.
  it("names a downloaded report's files from the repository root", () => {
    const checkout =
      "/home/runner/work/infinitary-apps/infinitary-apps/Application Support/firstmate";
    const result = timingsFromReports([
      {
        testResults: [
          { name: `${checkout}/tests/shard-balance.test.ts`, startTime: 0, endTime: 1500 },
          { name: `${checkout}/tests/no-longer-here.test.ts`, startTime: 0, endTime: 1500 },
        ],
      },
    ]);
    expect(result).toEqual({ "tests/shard-balance.test.ts": 1.5 });
  });
});
