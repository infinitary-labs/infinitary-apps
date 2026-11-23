import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { timingsFromJourneyReports } from "../scripts/journey-group-timings.ts";
import {
  fileArgument,
  type JourneyLane,
  type JourneyPlatform,
  journeyGroup,
  laneFiles,
  readJourneyTimings,
} from "../scripts/journey-groups.ts";
import { hostEnv } from "../src/core/hostEnv.ts";
import { root } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2987, the captain: "Group journeys by measured time, add Linux groups
// and even out the three Mac jobs". The fixture is the committed record of
// measured times the groups are balanced by, and trimmed results of the
// passing full check it was written from.
const timings = readJourneyTimings();
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(root, "tests/fixtures/journey-groups", name), "utf8"));

const splits: {
  platform: JourneyPlatform;
  lane: JourneyLane;
  count: number;
  jobs?: string[];
}[] = [
  // source-journeys.yml's full suite: six parallel groups and three serial.
  { platform: "linux", lane: "parallel", count: 6 },
  { platform: "linux", lane: "desktop", count: 3 },
  // verify.yml: the parallel lanes between the parallel and mac jobs.
  { platform: "mac", lane: "parallel", count: 2, jobs: ["parallel", "mac"] },
];

describe("journeyGroup", () => {
  it.each(splits)("puts every $lane file on $platform in exactly one of $count groups", (split) => {
    const groups = Array.from({ length: split.count }, (_, at) =>
      journeyGroup({ ...split, index: at + 1 }, timings),
    );
    expect(groups.flat().toSorted()).toEqual(laneFiles(split.lane));
    // The same split on every machine, whatever order it lists the files.
    expect(
      journeyGroup({ ...split, index: 1 }, timings, laneFiles(split.lane).toReversed()),
    ).toEqual(groups[0]);
  });

  it.each(splits)(
    "gives the $platform $lane groups about the same time, each job's own work counted",
    (split) => {
      const measured = timings[split.platform];
      const ends = Array.from({ length: split.count }, (_, at) => {
        const files = journeyGroup({ ...split, index: at + 1 }, timings);
        const own = split.jobs ? (timings.macJobs[split.jobs[at] ?? ""] ?? 0) : 0;
        return files.reduce((sum, file) => sum + (measured[file] ?? 0), own);
      });
      // The longest file bounds how even greedy packing can be.
      const slowest = Math.max(...laneFiles(split.lane).map((file) => measured[file] ?? 0));
      expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(slowest);
    },
  );

  it("gives the Mac job with more work of its own fewer journeys", () => {
    const split = {
      platform: "mac",
      lane: "parallel",
      count: 2,
      jobs: ["parallel", "mac"],
    } as const;
    const work = (index: number) =>
      journeyGroup({ ...split, index }, timings).reduce(
        (sum, file) => sum + (timings.mac[file] ?? 0),
        0,
      );
    expect(timings.macJobs.mac).toBeGreaterThan(timings.macJobs.parallel ?? 0);
    expect(work(2)).toBeLessThan(work(1));
    expect(() =>
      journeyGroup({ ...split, index: 1, jobs: ["parallel", "unknown"] }, timings),
    ).toThrow("unknown");
  });
});

describe("fileArgument", () => {
  // devices.spec.ts ends installed-devices.spec.ts's name: a group holding the
  // one must not run the other.
  it("selects exactly its own file in Playwright's own listing", () => {
    const listed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "--list",
          "--reporter=json",
          fileArgument("tests/e2e/devices.spec.ts"),
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      ),
    ) as { suites: { file: string }[] };
    expect([...new Set(listed.suites.map((suite) => suite.file))]).toEqual(["devices.spec.ts"]);
  }, 60_000);
});

describe("the journey groups command", () => {
  const run = (group: string) => {
    const dir = scratchDir("infinitary-journey-groups-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "pnpm.log");
    writeFileSync(log, "");
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n');
    chmodSync(join(bin, "pnpm"), 0o755);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/journey-groups.ts",
        "--platform",
        "linux",
        "--lane",
        "desktop",
        "--group",
        group,
        "--",
        "--no-deps",
        "--project=desktop",
      ],
      {
        cwd: root,
        env: { ...hostEnv(), PATH: `${bin}:${hostEnv().PATH}`, COMMAND_LOG: log },
        encoding: "utf8",
      },
    );
    return { status: result.status, stderr: result.stderr, call: readFileSync(log, "utf8").trim() };
  };

  it("runs Playwright over its group's files after the given arguments", () => {
    const { status, stderr, call } = run("2/3");
    expect(status, stderr).toBe(0);
    const files = journeyGroup({ platform: "linux", lane: "desktop", index: 2, count: 3 }, timings);
    expect(call).toBe(
      ["exec playwright test --no-deps --project=desktop", ...files.map(fileArgument)].join(" "),
    );
  });

  it("runs nothing for a group with no file, since Playwright with no file runs every one", () => {
    const count = laneFiles("desktop").length + 1;
    const { status, stderr, call } = run(`${count}/${count}`);
    expect(status, stderr).toBe(0);
    expect(call).toBe("");
  });

  it("refuses a group outside its count", () => {
    expect(run("4/3").status).toBe(2);
  });
});

describe("timingsFromJourneyReports", () => {
  // The fixtures come from the same run the committed record was written
  // from, so the writer must give back the record's own times for them.
  it("reads each platform's file times and each Mac job's own work as the record holds them", () => {
    const linux = fixture("linux-report.json");
    const mac = fixture("mac-report.json");
    const { jobs } = fixture("mac-jobs.json");
    const written = timingsFromJourneyReports([linux, mac], [jobs], {
      linux: {},
      mac: {},
      macJobs: {},
    });
    const linuxFiles = [...new Set(linux.files.map((entry: { file: string }) => entry.file))];
    expect(Object.keys(written.linux).toSorted()).toEqual(linuxFiles.toSorted());
    for (const file of Object.keys(written.linux))
      expect(written.linux[file], file).toBe(timings.linux[file]);
    expect(Object.keys(written.mac)).toHaveLength(mac.suites.length);
    for (const file of Object.keys(written.mac)) {
      expect(laneFiles("parallel")).toContain(file);
      expect(written.mac[file], file).toBe(timings.mac[file]);
    }
    expect(written.macJobs).toEqual(timings.macJobs);
  });

  it("keeps the record's times for what a run did not measure", () => {
    const kept = readJourneyTimings();
    expect(timingsFromJourneyReports([], [], kept)).toEqual(kept);
    const linux = { ...fixture("linux-report.json"), complete: false };
    expect(timingsFromJourneyReports([linux], [], kept).linux).toBe(kept.linux);
  });
});
