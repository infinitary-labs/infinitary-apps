import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budget,
  calibratedPlacement,
  JOURNEY_BUDGET_MS,
  journeyTimes,
  LINUX_PLACES,
  type LinuxObservation,
  laneOf,
  linuxParts,
  type ReportSuite,
  readJourneyTimes,
  readLinuxObservations,
  SMALL_BIN_MS,
} from "../scripts/journey-budget.ts";
import { runJobNames } from "./helpers/ciJobNames";
import { scratchDir } from "./helpers/scratchDirs.ts";
import { needsMac } from "./lint/e2eMacTag.ts";

// INF-658's approved choice sized the journeys' jobs at six measured minutes;
// INF-1720's plan packs Linux into at most one job per PC place; INF-1763's
// approved plan (the captain's principle of 2026-10-28) runs every chosen
// file on Linux and only the files holding tests that need a Mac on the Mac.
// Readings are from the passing verify run named by the plan.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/affected-journeys/verify-times.json", import.meta.url), "utf8"),
) as { times: Record<string, number> };
const times = new Map(Object.entries(fixture.times));
const reasons = new Map(
  [...times.keys()].map((file) => [file, ["imports tests/e2e/launch.ts, which the change edits"]]),
);
/** Whether a journey of this repository holds a test tagged MAC_ONLY_TAG, read from its source. */
const tagged = (file: string) => {
  try {
    return needsMac(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), file);
  } catch {
    return false;
  }
};
const linuxFiles = (result: ReturnType<typeof budget>) =>
  result.linux.flatMap((bin) => bin.files.split(" "));
/** The middle of a lane's measured readings, what an unmeasured file costs there (INF-2486 cut D). */
const middleReading = (lane: "parallel" | "desktop") => {
  const measured = [...times]
    .filter(([file, ms]) => ms > 0 && laneOf(file) === lane)
    .map(([, ms]) => ms)
    .sort((a, b) => a - b);
  return measured[Math.floor(measured.length / 2)] ?? 0;
};

describe("INF-1763 journey placement", () => {
  // INF-2259: CI can omit Mac proof already gathered locally, and missing
  // historical timings may change scheduling but never selected coverage.
  it("targets either platform independently and keeps every selection without timings", () => {
    const selection = new Map([
      ["tests/e2e/devices.spec.ts", ["selected native device checks"]],
      ["tests/e2e/task-browser.spec.ts", ["selected portable browser checks"]],
    ]);
    const linux = budget(selection, new Map(), tagged, false, [], false, "linux");
    expect(linux.mac).toEqual([]);
    expect(linuxFiles(linux).toSorted()).toEqual([...selection.keys()].toSorted());
    expect(linux.unmeasured.toSorted()).toEqual([...selection.keys()].toSorted());
    const mac = budget(selection, new Map(), tagged, false, [], false, "mac");
    expect(mac.mac).toEqual(["tests/e2e/devices.spec.ts"]);
    expect(mac.linux).toEqual([]);
  });
  it("runs every chosen file on Linux once and only the tagged files on the Mac", () => {
    const result = budget(reasons, times, tagged);
    const all = linuxFiles(result);
    expect(all.toSorted()).toEqual([...reasons.keys()].toSorted());
    expect(new Set(all).size).toBe(all.length);
    expect(result.mac).toEqual([...reasons.keys()].filter(tagged).toSorted());
    expect(result.mac).toContain("tests/e2e/window-wash.spec.ts");
    expect(result.mac).not.toContain("tests/e2e/task-browser.spec.ts");
    // INF-1720: every journey overflows far past five six-minute groups, and
    // still runs as one job per PC place, each lane in at least one.
    expect(result.linux).toHaveLength(LINUX_PLACES);
    expect(new Set(result.linux.map((bin) => bin.lane))).toEqual(new Set(["parallel", "desktop"]));
    for (const bin of result.linux) {
      const files = bin.files.split(" ");
      expect(files.every((file) => laneOf(file) === bin.lane)).toBe(true);
      const estimated = files.reduce(
        (sum, file) =>
          sum + (times.get(file) || middleReading(bin.lane)) / (bin.lane === "desktop" ? 0.6 : 1),
        0,
      );
      expect(bin.estimatedMs).toBeCloseTo(estimated);
    }
    expect(budget(new Map([...reasons].reverse()), times, tagged)).toEqual(result);
  });

  it("starts no Mac job for a shared journey, and puts a tagged one on both", () => {
    const shared = budget(
      new Map([["tests/e2e/task-browser.spec.ts", ["the change edits this journey"]]]),
      times,
      tagged,
    );
    expect(shared.mac).toEqual([]);
    expect(linuxFiles(shared)).toEqual(["tests/e2e/task-browser.spec.ts"]);
    // A tagged test is never sent to Linux alone: its file runs on the Mac too.
    const wash = budget(
      new Map([["tests/e2e/window-wash.spec.ts", ["the change edits this journey"]]]),
      times,
      tagged,
    );
    expect(wash.mac).toEqual(["tests/e2e/window-wash.spec.ts"]);
    expect(linuxFiles(wash)).toEqual(["tests/e2e/window-wash.spec.ts"]);
    expect(budget(new Map(), times, tagged)).toMatchObject({ mac: [], linux: [] });
  });

  it("puts every chosen file on the Mac as well when a request asks", () => {
    const files = ["tests/e2e/activity-updates.spec.ts", "tests/e2e/window-wash.spec.ts"];
    const asked = new Map(files.map((file) => [file, ["the request names this journey"]]));
    const result = budget(asked, times, tagged, true);
    expect(result.mac).toEqual(files);
    expect(linuxFiles(result).toSorted()).toEqual(files);
  });

  it("keeps a modest overflow in six-minute groups, fewer than one job per PC place", () => {
    // About fifteen minutes of parallel files: they need fewer than five
    // six-minute groups, so none grows past six minutes.
    const measured = [...times].filter(([, ms]) => ms > 0).sort((a, b) => a[0].localeCompare(b[0]));
    const picked: string[] = [];
    let total = 0;
    for (const [file, ms] of measured.filter(([file]) => laneOf(file) === "parallel")) {
      if (total > 15 * 60 * 1000) break;
      picked.push(file);
      total += ms;
    }
    const pick = new Map(picked.map((file) => [file, ["the change edits this journey"]]));
    const result = budget(pick, times, tagged);
    expect(result.linux.length).toBeGreaterThan(1);
    expect(result.linux.length).toBeLessThan(LINUX_PLACES);
    for (const bin of result.linux)
      expect(bin.estimatedMs <= JOURNEY_BUDGET_MS || !bin.files.includes(" ")).toBe(true);
    expect(linuxFiles(result).toSorted()).toEqual(picked.toSorted());
  });

  it("does not lose a new or indivisibly slow file or pretend its time is known", () => {
    const unknown = "tests/e2e/new-journey.spec.ts";
    const result = budget(new Map([[unknown, ["the change edits this journey"]]]), times, tagged);
    expect(result.unmeasured).toEqual([unknown]);
    expect(linuxFiles(result)).toEqual([unknown]);
    const slowest = [...times]
      .filter(([file]) => laneOf(file) === "desktop")
      .sort((a, b) => b[1] - a[1])[0];
    expect(slowest).toBeDefined();
    expect(result.linux[0]?.estimatedMs).toBeGreaterThan(0);
  });

  // INF-2486 cut D, approved by the captain: an unmeasured file costs its
  // lane's middle reading, and a job under two minutes joins its lane's
  // lightest job, since each job repeats the checkout, install and build.
  it("places new journeys at their lane's middle reading, not its slowest", () => {
    // PR #794's three new runbook journeys each took a job of their own.
    const fresh = [
      "tests/e2e/new-runbooks.spec.ts",
      "tests/e2e/new-installed-runbooks.spec.ts",
      "tests/e2e/new-personal-runbooks.spec.ts",
    ];
    for (const file of fresh) expect(laneOf(file)).toBe("desktop");
    const result = budget(
      new Map(fresh.map((file) => [file, ["the change edits this journey"]])),
      times,
      tagged,
    );
    expect(result.unmeasured.toSorted()).toEqual(fresh.toSorted());
    expect(result.linux).toHaveLength(1);
    expect(result.linux[0]?.estimatedMs).toBeCloseTo(
      (fresh.length * middleReading("desktop")) / 0.6,
    );
  });

  it("joins a job under two minutes to its lane's lightest job", () => {
    // Real readings: the first-fit packing alone leaves gitlab-delivery, 1.6
    // minutes, in a third job, since neither six-minute job has room for it.
    const picked = [
      "tests/e2e/task-browser-booking.spec.ts",
      "tests/e2e/quit-mid-turn.spec.ts",
      "tests/e2e/forge-signin.spec.ts",
      "tests/e2e/run-work.spec.ts",
      "tests/e2e/gitlab-delivery.spec.ts",
    ];
    for (const file of picked) expect(laneOf(file)).toBe("parallel");
    expect(times.get("tests/e2e/gitlab-delivery.spec.ts")).toBeLessThan(SMALL_BIN_MS);
    const result = budget(
      new Map(picked.map((file) => [file, ["the change edits this journey"]])),
      times,
      tagged,
    );
    expect(result.linux).toHaveLength(2);
    expect(linuxFiles(result).toSorted()).toEqual(picked.toSorted());
    for (const bin of result.linux) expect(bin.estimatedMs).toBeGreaterThanOrEqual(SMALL_BIN_MS);
  });

  it("reads real passing Playwright durations and refuses an empty timing artifact", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("./fixtures/affected-journeys/verify-report.json", import.meta.url),
        "utf8",
      ),
    ) as { suites: ReportSuite[] };
    const parsed = journeyTimes(report);
    for (const [file, duration] of parsed) expect(duration).toBe(times.get(file));
    expect(parsed.size).toBeGreaterThan(0);
    expect(() => journeyTimes({ suites: [] })).toThrow("no measured journeys");
  });

  // INF-2779: since the Mac journeys run in two jobs, a passing full check
  // keeps one result per job, and the chooser downloads each into a folder of
  // its own; a run from before kept one result, and a pull request with no
  // passing run downloads nothing.
  it("reads a split check's two results as one run's times, as one result's, and none as none", () => {
    const fixture = new URL("./fixtures/affected-journeys/verify-report.json", import.meta.url);
    const report = JSON.parse(readFileSync(fixture, "utf8")) as { suites: ReportSuite[] };
    const whole = journeyTimes(report);
    const dir = scratchDir("journey-times-");
    expect(report.suites).toHaveLength(2);
    report.suites.forEach((suite, index) => {
      const job = join(dir, ["e2e-results-parallel", "e2e-results-desktop"][index] ?? "");
      mkdirSync(job);
      writeFileSync(join(job, "e2e-results.json"), JSON.stringify({ suites: [suite] }));
    });
    expect(readJourneyTimes(dir)).toEqual(whole);
    expect(readJourneyTimes(fileURLToPath(fixture))).toEqual(whole);
    expect(readJourneyTimes(join(dir, "nothing-downloaded")).size).toBe(0);
  });
});

// INF-1987's accepted change 2: captured Linux observations, same five jobs,
// complete file identity, conservative fallback and indivisible-file tails.
const observations = (): LinuxObservation[] =>
  (["desktop", "parallel"] as const).map((lane) => {
    const report = JSON.parse(
      readFileSync(
        new URL(`./fixtures/journey-timing/compact-${lane}.json`, import.meta.url),
        "utf8",
      ),
    );
    return {
      report,
      job: {
        conclusion: "success",
        run: report.run,
        attempt: report.attempt,
        startedAt: Date.parse(lane === "desktop" ? "2026-10-30T19:07:41Z" : "2026-10-30T19:07:33Z"),
        completedAt: Date.parse(
          lane === "desktop" ? "2026-10-30T19:11:34Z" : "2026-10-30T19:12:15Z",
        ),
      },
    };
  });
const capturedBins = () => {
  const files = observations();
  const parallelFiles = files[1]?.report.selectedFiles ?? [];
  const desktopFiles = files[0]?.report.selectedFiles ?? [];
  return [
    { lane: "parallel" as const, files: parallelFiles.slice(0, 5).join(" "), estimatedMs: 1 },
    { lane: "parallel" as const, files: parallelFiles.slice(5).join(" "), estimatedMs: 1 },
    ...[desktopFiles.slice(0, 1), desktopFiles.slice(1, 2), desktopFiles.slice(2)].map((group) => ({
      lane: "desktop" as const,
      files: group.join(" "),
      estimatedMs: 1,
    })),
  ];
};

describe("INF-1987 Linux-calibrated placement", () => {
  it("retains conservative execution until adoption is supported, with an explicit verification-only candidate path", () => {
    const source = observations();
    const pick = new Map(
      source
        .flatMap(({ report }) => report.selectedFiles)
        .map((file) => [file, ["captured Linux selection"]]),
    );
    // With no Mac artifact at all, each file is placed at the six-minute
    // budget, so the conservative fallback requires five jobs.
    const olderMac = new Map<string, number>();
    const original = budget(pick, olderMac, tagged);
    const advisory = budget(pick, olderMac, tagged, false, source);
    const explicit = budget(pick, olderMac, tagged, false, source, true);
    expect(original.linux).toHaveLength(LINUX_PLACES);
    expect(advisory.candidateTimingSource).toBe("linux");
    expect(advisory.linuxCandidate).not.toEqual(original.linux);
    expect(advisory.linux).toEqual(original.linux);
    expect(advisory.mac).toEqual(original.mac);
    expect(advisory.timingSource).toBe("conservative");
    expect(explicit.linux).toEqual(advisory.linuxCandidate);
    expect(explicit.mac).toEqual(original.mac);
    expect(linuxFiles(explicit).toSorted()).toEqual([...pick.keys()].toSorted());
  });
  it("packs real captured files deterministically in the existing five jobs, respecting the long-file tail and setup", () => {
    const bins = capturedBins();
    const result = calibratedPlacement(bins, observations());
    expect(result.source).toBe("linux");
    expect(result.linux).toHaveLength(LINUX_PLACES);
    const before = bins.flatMap((bin) => bin.files.split(" ")).sort();
    const after = result.linux.flatMap((bin) => bin.files.split(" ")).sort();
    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
    expect(calibratedPlacement(bins, observations().reverse())).toEqual(result);
    for (const bin of result.linux) {
      const files = bin.files.split(" ");
      expect(files.every((file) => laneOf(file) === bin.lane)).toBe(true);
      const source = observations().find((observation) => observation.report.lane === bin.lane);
      if (!source) throw new Error("missing captured lane");
      const groups = source.report.files.filter((file) => files.includes(file.file));
      const tail = Math.max(...groups.map((file) => file.elapsedMs ?? 0));
      // Every job must pay setup/cleanup as well as its largest intact file.
      expect(bin.estimatedMs).toBeGreaterThan(tail);
    }
  });

  it("keeps small selections and all missing, failed or incompatible observations on the exact prior placement", () => {
    const bins = capturedBins();
    const small = bins.slice(0, 1);
    expect(calibratedPlacement(small, observations()).linux).toEqual(small);
    const bad: LinuxObservation[][] = [[], observations().slice(0, 1)];
    for (const mutate of [
      (o: LinuxObservation) => {
        o.job.conclusion = "failure";
      },
      (o: LinuxObservation) => {
        o.job.attempt = "2";
      },
      (o: LinuxObservation) => {
        o.report.complete = false;
      },
      (o: LinuxObservation) => {
        o.report.platform = "macOS";
      },
      (o: LinuxObservation) => {
        o.report.actualWorkers = null;
      },
      (o: LinuxObservation) => {
        o.report.configuredWorkers = 0;
      },
      (o: LinuxObservation) => {
        o.report.architecture = "ARM64";
      },
      (o: LinuxObservation) => {
        o.report.files.pop();
      },
    ]) {
      const changed = observations();
      for (const observation of changed) mutate(observation);
      bad.push(changed);
    }
    for (const input of bad) expect(calibratedPlacement(bins, input).linux).toEqual(bins);
    const unknown = bins.map((bin) => ({ ...bin }));
    if (unknown[0]) unknown[0].files += " tests/e2e/new-journey.spec.ts";
    const result = calibratedPlacement(unknown, observations());
    expect(result.linux).toEqual(unknown);
    expect(result.missing).toContain("tests/e2e/new-journey.spec.ts");
  });

  it("never drops observed skip-only files or mistakes them for missing readings", () => {
    const input = observations();
    // Retain real skipped outcomes from the compact report, removing executed
    // groups to model a selection consisting only of observed Linux skips.
    const desktop = input[0];
    if (!desktop) throw new Error("missing desktop report");
    const skipped = desktop.report.files.find((file) => file.skipped > 0);
    if (!skipped) throw new Error("captured report contains no skips");
    skipped.tests = skipped.skipped;
    skipped.elapsedMs = null;
    skipped.startMs = null;
    skipped.endMs = null;
    skipped.workMs = 0;
    const bins = capturedBins();
    const result = calibratedPlacement(bins, input);
    expect(result.missing).not.toContain(skipped.file);
    expect(result.linux.flatMap((bin) => bin.files.split(" "))).toContain(skipped.file);
    desktop.report.files = [skipped];
    desktop.report.selectedFiles = [skipped.file];
    expect(
      calibratedPlacement([{ lane: "desktop", files: skipped.file, estimatedMs: 1 }], [desktop])
        .missing,
    ).toEqual([]);
  });

  it("joins artifact contents to one successful completed job of the same run, attempt and checkout", () => {
    const dir = scratchDir("linux-placement-");
    const source = observations()[0];
    if (!source) throw new Error("missing captured observation");
    const reportDir = `${dir}/reports`;
    mkdirSync(reportDir);
    writeFileSync(`${reportDir}/journey-timing.json`, JSON.stringify(source.report));
    const jobsFile = `${dir}/jobs.json`;
    const job = {
      run_id: Number(source.job.run),
      run_attempt: Number(source.job.attempt),
      head_sha: source.report.revision,
      name: "linux-overflow / source-desktop (desktop)",
      conclusion: "success",
      started_at: new Date(source.job.startedAt).toISOString(),
      completed_at: new Date(source.job.completedAt).toISOString(),
      steps: [
        {
          name: "Record the timing observation start",
          started_at: "2026-10-30T19:07:45Z",
          completed_at: "2026-10-30T19:07:45Z",
        },
        {
          name: "Export compact Linux timing",
          started_at: "2026-10-30T19:11:26Z",
          completed_at: "2026-10-30T19:11:26Z",
        },
      ],
    };
    writeFileSync(jobsFile, JSON.stringify([job]));
    const read = readLinuxObservations(reportDir, jobsFile);
    expect(read).toHaveLength(1);
    expect(read[0]?.job).toEqual(source.job);
    expect(read[0]?.report.selectedFiles).toEqual(source.report.selectedFiles);
    // INF-2413: the same job named trigger first, as journeys.yml names a
    // selected Linux group (docs/testing.md, "CI job names"), joins alike;
    // under both names at once it is two jobs, so it stays unmeasured.
    const [part] = linuxParts([{ lane: "desktop" as const, files: "x", estimatedMs: 1 }]);
    const renamed = runJobNames("journeys.yml", {
      github: { event_name: "workflow_dispatch" },
      needs: {
        "choose-journeys": {
          result: "success",
          outputs: { count: "0", "linux-count": "1", linux: JSON.stringify({ include: [part] }) },
        },
      },
    }).find((name) => name.includes("Selected app journeys (Linux"));
    expect(renamed).toBe(
      "Manual request · Selected journeys (Linux; part 1/1) / Manual request · Selected app journeys (Linux; serial; part 1/1)",
    );
    writeFileSync(jobsFile, JSON.stringify([{ ...job, name: renamed }]));
    expect(readLinuxObservations(reportDir, jobsFile)).toHaveLength(1);
    writeFileSync(jobsFile, JSON.stringify([job, { ...job, name: renamed }]));
    expect(readLinuxObservations(reportDir, jobsFile)).toEqual([]);
    writeFileSync(jobsFile, JSON.stringify([{ ...job, head_sha: "different-checkout" }]));
    expect(readLinuxObservations(reportDir, jobsFile)).toEqual([]);
    // INF-1987 broad batches overlap with identical reusable names. The real
    // report timestamps identify the right job, not just its enclosing interval.
    writeFileSync(jobsFile, JSON.stringify([job, { ...job, steps: [] }]));
    expect(readLinuxObservations(reportDir, jobsFile)).toHaveLength(1);
    writeFileSync(jobsFile, JSON.stringify([job, job]));
    expect(readLinuxObservations(reportDir, jobsFile)).toEqual([]);
    writeFileSync(`${reportDir}/journey-timing.json`, "not-json");
    expect(readLinuxObservations(reportDir, jobsFile)).toEqual([]);
  });
});
