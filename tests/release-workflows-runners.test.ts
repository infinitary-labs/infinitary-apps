import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { budget, linuxParts } from "../scripts/journey-budget.ts";
import { fileArgument, laneFiles } from "../scripts/journey-groups.ts";
import {
  journeysRun,
  loadYamlFile,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** Which machine each job runs on: the real Mac, the queues and hosted machines. */

/**
 * The captain's INF-603 answer to question 7: production signing (the TestFlight
 * upload and release) runs on the real Mac through one configured label.
 * INF-643 separately authorizes disposable signing for installer verification,
 * and INF-816 moves its build/arm64 jobs into placement-service virtual Macs.
 * Neither publishes. Until REAL_MAC_RUNNER is set, production signing does not move.
 */
describe("the jobs that ask for the real Mac", () => {
  type Job = { "runs-on"?: string };
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  );
  const runsOn = (file: string, id: string) => {
    const jobs = (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
    return jobs[id]?.["runs-on"] ?? "";
  };

  it("is exactly the release's signing job and the TestFlight upload", () => {
    const asking = workflows.flatMap((file) =>
      Object.entries(
        (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs,
      ).flatMap(([id, job]) =>
        (job["runs-on"] ?? "").includes("REAL_MAC_RUNNER") ? [`${file}:${id}`] : [],
      ),
    );
    expect(asking.sort()).toEqual(["ios-release.yml:testflight", "release.yml:release"]);
  });

  it.each([
    ["release.yml", "release", "macos-15"],
    ["ios-release.yml", "testflight", "mini-mac"],
  ])("%s's %s job runs where it did until the switch sets the label", (file, id, fallback) => {
    const runner = (vars: Record<string, string>) =>
      workflowValue(runsOn(file, id), {
        vars,
        needs: { resolve: { outputs: { dry_run: "false" } } },
      });
    expect(runner({})).toBe(fallback);
    expect(runner({ MAC_RUNNER: "mini-mac" })).toBe("mini-mac");
    expect(runner({ MAC_RUNNER: "mini-mac-any", REAL_MAC_RUNNER: "mini-mac-real" })).toBe(
      "mini-mac-real",
    );
  });
});

/**
 * DOP-178's approved plan ("Have the placement service start a release's Mac
 * jobs before other waiting jobs"): a publishing run's Mac jobs ask for the
 * placement service's release-only queues, which MAC_QUEUES names as the
 * release_split, release_sign and release_light kinds (INF-2112; INF-2779's
 * three Mac lanes replaced release_check with release_split). Each keeps
 * its place - signing real, update and publication virtual, verification
 * any - and a dry run or an unset kind keeps today's label.
 */
describe("a release's own queues", () => {
  type Job = { "runs-on"?: string; uses?: string; with?: Record<string, string> };
  const release = (loadYamlFile(".github/workflows/release.yml") as { jobs: Record<string, Job> })
    .jobs;
  const testflight = (
    loadYamlFile(".github/workflows/ios-release.yml") as { jobs: Record<string, Job> }
  ).jobs.testflight;
  const verifyLane = (loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, Job> })
    .jobs.lane;
  const update = (loadYamlFile(".github/workflows/mac-update.yml") as { jobs: Record<string, Job> })
    .jobs.update;
  const releaseKinds = {
    release_split: "mini-mac-release-any",
    release_sign: "mini-mac-release-real",
    release_light: "mini-mac-release-virtual",
  };
  const ordinary = {
    MAC_RUNNER: "mini-mac-any",
    REAL_MAC_RUNNER: "mini-mac-real",
    VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
  };
  const queues = { MAC_QUEUES: JSON.stringify(releaseKinds) };
  /** Where each of a release run's Mac jobs starts, through its caller's inputs. */
  const placed = (dryRun: "true" | "false", vars: Record<string, string>) => {
    const needs = { resolve: { outputs: { dry_run: dryRun } } };
    const passed = (id: string, input: string) =>
      workflowValue(release[id]?.with?.[input] ?? "", { needs, vars });
    const updateIn = (id: string) =>
      workflowValue(update?.["runs-on"] ?? "", { inputs: { runner: passed(id, "runner") }, vars });
    // Every Mac lane of verify's, each a job of its own (INF-2779), starts in one place.
    const verify = ["mac", "parallel", "desktop-1", "desktop-2"].map((lane) =>
      workflowValue(verifyLane?.["runs-on"] ?? "", {
        matrix: { lane },
        inputs: { mac_runner: passed("verify", "mac_runner") },
        vars,
      }),
    );
    return {
      verify: new Set(verify).size === 1 ? verify[0] : verify,
      sign: workflowValue(release.release?.["runs-on"] ?? "", { needs, vars }),
      update: updateIn("update"),
      publish: workflowValue(release.publish?.["runs-on"] ?? "", { needs, vars }),
    };
  };

  it("sends a publishing run's Mac jobs to the release queues of their place kind", () => {
    expect(placed("false", { ...ordinary, ...queues })).toEqual({
      verify: "mini-mac-release-any",
      sign: "mini-mac-release-real",
      update: "mini-mac-release-virtual",
      publish: "mini-mac-release-virtual",
    });
    // TestFlight runs only for a release, so its own kind is its release queue.
    const named = {
      MAC_QUEUES: JSON.stringify({ ...releaseKinds, testflight: "mini-mac-testflight" }),
    };
    expect(workflowValue(testflight?.["runs-on"] ?? "", { vars: { ...ordinary, ...named } })).toBe(
      "mini-mac-testflight",
    );
  });

  it("keeps a dry run on the ordinary queues, so a rehearsal never takes a release's place", () => {
    expect(placed("true", { ...ordinary, ...queues })).toEqual({
      verify: "mini-mac-any",
      sign: "mini-mac-real",
      update: "mini-mac-virtual",
      publish: "mini-mac-virtual",
    });
  });

  it("keeps today's routing while the release kinds are unset", () => {
    const today = {
      verify: "mini-mac-any",
      sign: "mini-mac-real",
      update: "mini-mac-virtual",
      publish: "mini-mac-virtual",
    };
    expect(placed("false", ordinary)).toEqual(today);
    expect(placed("true", ordinary)).toEqual(today);
    expect(workflowValue(testflight?.["runs-on"] ?? "", { vars: ordinary })).toBe("mini-mac-real");
    expect(placed("false", {})).toEqual({ ...today, verify: "macos-15", sign: "macos-15" });
    // With only the ordinary kinds named, a publishing run goes where a dry run goes.
    const plain = {
      MAC_QUEUES: JSON.stringify({
        split: "mini-mac-split",
        sign: "mini-mac-sign",
        light: "mini-mac-light",
      }),
    };
    const ordinaryKinds = {
      verify: "mini-mac-split",
      sign: "mini-mac-sign",
      update: "mini-mac-light",
      publish: "mini-mac-light",
    };
    expect(placed("false", { ...ordinary, ...plain })).toEqual(ordinaryKinds);
    expect(placed("true", { ...ordinary, ...plain })).toEqual(ordinaryKinds);
  });
});

/**
 * INF-2112, the captain's approved design ("design a way for the user to
 * configure how much resource each type of job needs, and the placement
 * service coordinates which ones can go in parallel vs not"): each kind of Mac job
 * asks for the queue the MAC_QUEUES variable names for it, so the placement
 * service can hold each kind to its size. A publishing release asks for the
 * release kinds first. An unset kind keeps the job where it ran before.
 */
describe("each Mac job's kind", () => {
  type Job = {
    "runs-on"?: string;
    with?: Record<string, string>;
    strategy?: { matrix?: Record<string, unknown> };
    steps?: { id?: string; run?: string; env?: Record<string, string> }[];
  };
  const jobs = (file: string) =>
    (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
  const queues = {
    check: "q-check",
    split: "q-split",
    journeys: "q-journeys",
    phone: "q-phone",
    testflight: "q-testflight",
    build: "q-build",
    sign: "q-sign",
    light: "q-light",
    release_split: "q-release-split",
    release_build: "q-release-build",
    release_sign: "q-release-sign",
    release_light: "q-release-light",
    native: "q-native",
  };
  const today = {
    MAC_RUNNER: "mini-mac-any",
    REAL_MAC_RUNNER: "mini-mac-real",
    VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
  };
  const publishing = (dryRun: boolean) => ({ resolve: { outputs: { dry_run: String(dryRun) } } });

  it.each([
    ["verify.yml", "lane", { matrix: { lane: "mac" }, inputs: {} }, "native", "mini-mac-any"],
    ["verify.yml", "lane", { matrix: { lane: "parallel" }, inputs: {} }, "native", "mini-mac-any"],
    [
      "verify.yml",
      "lane",
      { matrix: { lane: "parallel-1" }, inputs: {} },
      "native",
      "mini-mac-any",
    ],
    ["verify.yml", "lane", { matrix: { lane: "desktop-1" }, inputs: {} }, "split", "mini-mac-any"],
    ["journeys.yml", "affected-journeys", { inputs: {} }, "journeys", "mini-mac-any"],
    ["phone.yml", "scene-evidence", {}, "light", "mini-mac-any"],
    ["ios-release.yml", "testflight", {}, "testflight", "mini-mac-real"],
    ["mac-installer.yml", "build", { inputs: {} }, "build", "mini-mac-virtual"],
    ["mac-installer.yml", "installed", {}, "light", "mini-mac-virtual"],
    ["mac-update.yml", "update", { inputs: {} }, "light", "mini-mac-virtual"],
    ["republish-casks.yml", "republish", { inputs: {} }, "light", "mini-mac-any"],
    ["release.yml", "release", { needs: publishing(true) }, "sign", "mini-mac-real"],
    ["release.yml", "publish", { needs: publishing(true) }, "light", "mini-mac-virtual"],
  ] as const)(
    "%s's %s job asks for the %s kind's queue, else where it ran before",
    (file, id, contexts, kind, before) => {
      const runner = (vars: Record<string, string>) =>
        workflowValue(jobs(file)[id]?.["runs-on"] ?? "", { ...contexts, vars });
      expect(runner({ ...today, MAC_QUEUES: JSON.stringify(queues) })).toBe(queues[kind]);
      expect(runner({ ...today, MAC_QUEUES: JSON.stringify({ [kind]: "" }) })).toBe(before);
      expect(runner(today)).toBe(before);
    },
  );

  // INF-2779 (the captain's approved three-job split, sized so every Mac
  // place can take one): until MAC_QUEUES names the split kind, each of the
  // full check's Mac lanes asks for the journeys kind's queue, a job of the
  // same size, then the full check's old check kind's, then MAC_RUNNER.
  it.each(["mac", "parallel", "desktop-1", "desktop-2"])(
    "falls back from the split kind through the journeys and check kinds for the %s lane",
    (lane) => {
      const runner = (named: Record<string, string>) =>
        workflowValue(jobs("verify.yml").lane?.["runs-on"] ?? "", {
          matrix: { lane },
          inputs: {},
          vars: { ...today, MAC_QUEUES: JSON.stringify(named) },
        });
      expect(runner({ journeys: "q-journeys", check: "q-check" })).toBe("q-journeys");
      expect(runner({ check: "q-check" })).toBe("q-check");
    },
  );

  // INF-6330's approved plan (option D): the native kind sends the mac and
  // parallel lanes to GitHub's Mac, even in a batch or a release that passes
  // its own queue, while the desktop lanes keep that queue; a request's
  // native_runner comes first, to measure a runner before the switch.
  it("sends the native tests and parallel journeys to the native kind, the desktop journeys where they ran", () => {
    const verify = jobs("verify.yml").lane;
    const placed = (inputs: Record<string, string>, named: Record<string, string>) => {
      const vars = { ...today, MAC_QUEUES: JSON.stringify(named) };
      const lanes = workflowValue(verify?.strategy?.matrix?.lane as string, { inputs, vars });
      return Object.fromEntries(
        (lanes as string[]).map((lane) => [
          lane,
          workflowValue(verify?.["runs-on"] ?? "", { matrix: { lane }, inputs, vars }),
        ]),
      );
    };
    const batch = { mac_runner: "q-release-split" };
    const { native: _unnamed, ...before } = queues;
    const split = (runner: string, desktop: string) => ({
      "linux-checks": "ubuntu-24.04",
      mac: runner,
      ...Object.fromEntries([1, 2, 3, 4].map((group) => [`parallel-${group}`, runner])),
      "desktop-1": desktop,
      "desktop-2": desktop,
    });
    expect(placed(batch, { ...queues, native: "macos-15" })).toEqual(
      split("macos-15", "q-release-split"),
    );
    expect(placed({}, { ...queues, native: "macos-15" })).toEqual(split("macos-15", "q-split"));
    // Until the native kind is named, every Mac lane stays where it ran, in
    // the one parallel journeys job.
    expect(placed(batch, before)).toEqual({
      "linux-checks": "ubuntu-24.04",
      mac: "q-release-split",
      parallel: "q-release-split",
      "desktop-1": "q-release-split",
      "desktop-2": "q-release-split",
    });
    expect(placed({ native_runner: "macos-15-intel" }, before)).toEqual(
      split("macos-15-intel", "q-split"),
    );
  });

  // INF-5571's approved plan, part 5: a publishing release's signed installer
  // build asks for the release_build queue, which the placement service starts
  // before release_sign, so it no longer waits behind the signing job. A dry
  // run, or MAC_QUEUES without the kind, keeps the build kind, then the label.
  it("puts a publishing release's installer build in the release_build queue", () => {
    const release = jobs("release.yml")["signed-installer"];
    const build = (dryRun: boolean, named: Record<string, string>) => {
      const vars = { ...today, MAC_QUEUES: JSON.stringify(named) };
      const runner = workflowValue(release?.with?.runner ?? "", {
        needs: publishing(dryRun),
        vars,
      });
      return workflowValue(jobs("mac-installer.yml").build?.["runs-on"] ?? "", {
        inputs: { runner },
        vars,
      });
    };
    expect(build(false, queues)).toBe("q-release-build");
    expect(build(true, queues)).toBe("q-build");
    const { release_build: _unserved, ...ordinary } = queues;
    expect(build(false, ordinary)).toBe("q-build");
    expect(build(false, {})).toBe("mini-mac-virtual");
  });

  it("leaves no Mac job without a kind", () => {
    const labels = new Set(Object.values(queues));
    const macJobs: string[] = [];
    for (const file of readdirSync(join(root, ".github/workflows"))) {
      if (!file.endsWith(".yml")) continue;
      for (const [id, job] of Object.entries(jobs(file))) {
        if (!job["runs-on"]) continue;
        // Each value of a one-key matrix, such as verify's lanes or the installer's chips.
        // One read from an earlier job's outputs, such as the alpha wait's
        // runs, is known only when the run makes it, so its runner is read
        // without a matrix value.
        const [key, values] = Object.entries(job.strategy?.matrix ?? {})[0] ?? [];
        const known = typeof values !== "string" || !values.includes("needs.");
        // verify's lanes are more on GitHub's Macs: both placements' lanes.
        const listed =
          known && typeof values === "string" && values.includes("${{")
            ? [
                ...new Set(
                  [{}, { MAC_QUEUES: JSON.stringify(queues) }].flatMap(
                    (vars) => workflowValue(values, { inputs: {}, vars }) as unknown[],
                  ),
                ),
              ]
            : values;
        const entries =
          key && known && Array.isArray(listed) ? listed.map((value) => ({ [key]: value })) : [{}];
        for (const matrix of entries) {
          const runner = (vars: Record<string, string>) =>
            workflowString(job["runs-on"] ?? "", {
              // A run of this project itself, never an outside pull request.
              github: {},
              vars,
              matrix,
              inputs: {},
              needs: publishing(true),
            });
          const before = runner({ ...today, MAC_QUEUES: "{}" });
          const configured = runner({ ...today, MAC_QUEUES: JSON.stringify(queues) });
          if (!/^(mini-mac|macos-15$)/.test(before) && !labels.has(configured)) continue;
          macJobs.push(`${file}:${id}`);
          expect(
            labels.has(String(runner({ ...today, MAC_QUEUES: JSON.stringify(queues) }))),
            `${file}:${id} ${JSON.stringify(matrix)}`,
          ).toBe(true);
        }
      }
    }
    expect(macJobs.length).toBeGreaterThanOrEqual(11);
  });

  it("gives the full Mac check's journeys half the job's cores, its size when the placement service names one", () => {
    // The desktop lane, and the parallel lanes' group in each of the parallel
    // and mac jobs, where the worker count tells (INF-2779, INF-2987).
    const lanes = {
      "desktop-1": "exec playwright test --no-deps --project=desktop",
      "desktop-2": "exec playwright test --no-deps --project=desktop",
      parallel:
        "exec playwright test --no-deps --project=styles --project=renderer --project=application",
      mac: "exec playwright test --no-deps --project=styles --project=renderer --project=application",
    };
    for (const [lane, command] of Object.entries(lanes)) {
      const workers = (cores?: string) =>
        journeysRun(lane, { cores })
          .replace(command, "")
          .split(" ")
          .filter((word) => word.startsWith("--workers="))
          .join(" ");
      expect(journeysRun(lane, { cores: "12" }).startsWith(`${command} --workers=6`), lane).toBe(
        true,
      );
      expect(workers("12"), lane).toBe("--workers=6");
      expect(workers("1"), lane).toBe("--workers=1");
      // No size named: half this machine, as `--workers=50%` gave.
      const half = `--workers=${Math.max(1, Math.floor(availableParallelism() / 2))}`;
      expect(workers(), lane).toBe(half);
      expect(workers("not a number"), lane).toBe(half);
    }
  });

  // INF-6330's approved plan (option D): on GitHub's Macs, a machine of the
  // job's own, the journeys take every core but one, and the parallel lanes
  // run in the four parallel jobs and the mac job.
  it("gives a GitHub Mac's journeys every core but one", () => {
    for (const lane of ["parallel-1", "parallel-4", "mac", "desktop-1"])
      expect(journeysRun(lane, { cores: "3", hosted: true }), lane).toContain(" --workers=2 ");
  });

  it.each([
    ["the project's Macs", false, "", ["parallel", "mac"]],
    ["GitHub's Macs", true, "", ["parallel-1", "parallel-2", "parallel-3", "parallel-4", "mac"]],
    [
      "GitHub's Macs, journeys part",
      true,
      "journeys",
      ["parallel-1", "parallel-2", "parallel-3", "parallel-4"],
    ],
    ["the project's Macs, journeys part", false, "journeys", ["parallel"]],
  ] as const)(
    "runs every parallel journey once across the jobs on %s",
    (_where, hosted, part, jobs) => {
      const files = jobs.flatMap((lane) =>
        journeysRun(lane, { cores: "3", hosted, part })
          .split(" ")
          .filter((word) => word.startsWith("/tests/")),
      );
      expect(files.toSorted()).toEqual(laneFiles("parallel").map(fileArgument).toSorted());
    },
  );
});

/**
 * INF-1720's approved plan: every Linux job of every workflow runs where the
 * repository variable LINUX_RUNNER sends it, the PC's shell-pc-linux places,
 * as ci.yml's already did, and on GitHub's hosted Ubuntu when it is unset.
 * The package check's Ubuntu 26.04 leg takes the PC's 26.04 image's label.
 * DOP-157's approved plan (direction A): the gate job - the one that opens
 * a request's journeys run - takes the PC's gate label, LINUX_RUNNER plus
 * -gate, whose runners take no other job, so a runner started for one runs
 * one. INF-2430's plan, piece 1: a release's own Linux
 * jobs run on GitHub's hosted Ubuntu whatever the variable says ("a release's
 * hosted machines" below). Each job's runner is evaluated both ways, for
 * every matrix entry, as a request or pull request starts it.
 */
it("sends every Linux job to LINUX_RUNNER, and hosted Ubuntu when it is unset, unless LINUX_QUEUES names its kind", () => {
  // INF-5387's plan, piece 1: the phone request's chooser takes the journeys' chooser's fast line.
  const gate = ["journeys.yml:choose-journeys", "phone.yml:request"];
  const hostedAlways = [
    "release.yml:resolve",
    "release.yml:notes",
    "release.yml:phone",
    // INF-2498's plan, piece 2: the uploads, on a machine GitHub hosts.
    "release.yml:upload",
    "ios-release.yml:resolve",
    // The Apple readiness job must not bring its credentials onto the fleet.
    "ios-release.yml:preflight",
    "ios-release.yml:availability",
    "ios-release.yml:external",
    // Its callers (INF-2441): main.yml, the swept batch and a Linux-only request.
    "linux-startup.yml:runtime-facts",
    // INF-2465: main's wait for the alpha cut, which main.yml alone calls;
    // its wait job is pending on no machine while a cut runs (INF-2834).
    "alpha-wait.yml:find",
    "alpha-wait.yml:wait",
    "alpha-wait.yml:ended",
    // The swept batch and main's sort of each push (INF-2430's plan, piece 3).
    "main.yml:sort",
    "main.yml:covered",
    // Main's last job, which dispatches its alpha cut (INF-3738).
    "main.yml:alpha",
    // A batch pull request's run of the swept batch (INF-3759's plan, piece
    // 2): its reading of the batch and of the failures, its last job, and
    // its confirms, which rerun failed files on the machines the sweep took,
    // hosted on Linux (INF-3012's direction A), beside each Linux test group
    // (INF-4382) and for the other failed jobs once the checks ended.
    "batch-checks.yml:batch",
    "batch-checks.yml:failures",
    "batch-checks.yml:confirm-later",
    "batch-checks.yml:passed",
    "verify.yml:linux-tests-confirm",
    // The batch's stops after a failed code check and the one job that then
    // names the failure: echoes, each on a hosted machine.
    "batch-checks.yml:stop",
    "batch-checks.yml:stopped",
    // A cut's watch for its first failed job and its stops after one
    // (INF-6038's plan): the same reading and echoes as the batch's.
    "release.yml:watch",
    "release.yml:stop",
    // The batch's reading of its Windows-relevant files (INF-4243's pick:
    // "On each combined batch that touches Windows-relevant files").
    "batch-checks.yml:windows-paths",
    // The batch's release notes check and phone contract flag: plain Node
    // reading the batch's commits, as release.yml's notes job does.
    "batch-checks.yml:notes",
    // The batch's push of its regenerated phone files, which holds a write
    // token, and its wait for the app to take that commit.
    "batch-checks.yml:push-regenerated",
    // The docs site's publish, which holds its publishing key (docs/docs-site.md, "Publishing").
    "docs-site-publish.yml:publish",
    // The Discord announcement, which holds the webhook (docs/alpha.md, "Announcing a stable").
    "release-announce.yml:announce",
    // An outside contributor's pull request reads what its change reaches
    // on GitHub's machines alone (docs/public-ci.md, "Outside contributors").
    "contributors.yml:paths",
    // The contributor agreement check, which holds a write token for an
    // outside pull request (docs/public-ci.md, "Outside contributors").
    "contributor-agreement.yml:check",
    // The check-file flag, which holds a write token for an outside pull
    // request (docs/public-ci.md, "Outside contributors").
    "check-file-flag.yml:flag",
    // The Careful review check, which holds a write token for an outside
    // pull request (docs/public-ci.md, "The Careful review check").
    "careful-review-check.yml:check",
    // The feedback labels, which hold a write token on any new issue
    // (docs/feedback.md, "Triage").
    "feedback-labels.yml:label",
    // The triage mark and the waiting-on-author timer, which hold a write
    // token on any issue or pull request (docs/public-ci.md, "Intake").
    "triage-mark.yml:mark",
    "waiting-on-author.yml:tick",
  ];
  // DOP-251's plan: each kind is one stage of moving Linux jobs to the Mac
  // mini's Linux guests (docs/testing.md, "Each Linux job's kind").
  const queues: Record<string, string[]> = {
    // INF-4496: the size warning line reads line counts with plain Node.
    light: [
      "verify.yml:request",
      "size-warning.yml:size-warning",
      // The AGENTS.md warning line counts words with plain Node too.
      "agent-memory.yml:agent-memory",
      // The docs site's check builds and browses the site, nothing that needs a desktop.
      "docs-site.yml:build-and-check",
      // The batch's watch polls its run for about 40 minutes; only this project's own batch reaches it.
      "batch-checks.yml:watch",
    ],
    light_gate: ["journeys.yml:replace-older-request"],
    ci: [
      "ci.yml:unit-tests",
      "ci.yml:integration-tests",
      "ci.yml:probe-tests",
      "replay.yml:replay-gate",
      "prompt-budget.yml:prompt-budget",
    ],
    gate: ["journeys.yml:choose-journeys", "phone.yml:request"],
    checks: ["verify.yml:lane", "verify.yml:linux-tests"],
    // The app journeys a request or a sweep runs on Linux, which may overflow to a
    // compute Mac's arm64 Linux guest when no PC place is free.
    journeys: ["source-journeys.yml:source-desktop"],
    // The branch check's three jobs (INF-5577's review): its build job runs
    // the critical path, which needs a desktop, so this kind names a queue
    // of desktop-ready Linux places. A wide change's later parts run beside
    // them (INF-5493).
    typecheck: [
      "ci.yml:code-checks",
      "ci.yml:reached-tests",
      "ci.yml:reached-tests-parts",
      "ci.yml:build",
      // The batch's regeneration of the phone's generated files, which installs as the code checks do.
      "batch-checks.yml:regenerate",
    ],
  };
  const queued = new Set<string>();
  type Job = { "runs-on"?: string; strategy?: { matrix?: Record<string, unknown> } };
  const evaluate = (value: string, contexts: Record<string, unknown>) =>
    value.includes("${{") ? workflowValue(value, contexts) : value;
  const linux: string[] = [];
  for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  )) {
    const { jobs } = loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> };
    for (const [id, job] of Object.entries(jobs)) {
      if (!job["runs-on"]) continue;
      const matrix = job.strategy?.matrix ?? {};
      const include = Array.isArray(matrix.include) ? (matrix.include as object[]) : [];
      const lanes =
        typeof matrix.lane === "string" ? evaluate(matrix.lane, { inputs: {}, vars: {} }) : [];
      const entries: object[] = include.length
        ? include
        : Array.isArray(lanes) && lanes.length
          ? lanes.map((lane) => ({ lane }))
          : [{}];
      for (const entry of entries) {
        const runner = (vars: Record<string, string>) =>
          evaluate(job["runs-on"] ?? "", {
            // INF-2202: phone is required, even while this inventory varies Linux labels.
            vars: { MAC_QUEUES: '{"phone":"mini-mac-phone"}', ...vars },
            // A run of this project itself; an outside pull request takes
            // hosted machines first (release-workflows-pr-checks.test.ts).
            github: {},
            matrix: entry,
            inputs: {},
            needs: {},
          });
        const hosted = runner({});
        if (typeof hosted !== "string" || !hosted.startsWith("ubuntu-")) continue;
        const name = `${file}:${id} ${JSON.stringify(entry)}`;
        linux.push(name);
        if (hostedAlways.includes(`${file}:${id}`)) {
          expect(hosted, name).toBe("ubuntu-24.04");
          expect(runner({ LINUX_RUNNER: "shell-pc-linux" }), name).toBe("ubuntu-24.04");
          continue;
        }
        // INF-2539's audit: one hosted image everywhere, never the moving `ubuntu-latest`.
        expect(hosted, name).toMatch(/^ubuntu-2\d\.04$/);
        expect(runner({ LINUX_RUNNER: "shell-pc-linux" }), name).toBe(
          gate.includes(`${file}:${id}`)
            ? "shell-pc-linux-gate"
            : hosted === "ubuntu-26.04"
              ? "shell-pc-linux-2604"
              : "shell-pc-linux",
        );
        // DOP-251's plan: LINUX_QUEUES moves a kind's jobs to its queue, and
        // every job of another kind, or none, stays where it was, with or
        // without LINUX_RUNNER. An empty variable changes nothing.
        for (const base of [{}, { LINUX_RUNNER: "shell-pc-linux" }] as Record<string, string>[]) {
          expect(runner({ ...base, LINUX_QUEUES: "{}" }), name).toBe(runner(base));
          for (const kind of Object.keys(queues)) {
            const moved = runner({
              ...base,
              LINUX_QUEUES: JSON.stringify({ [kind]: `q-${kind}` }),
            });
            if (queues[kind]?.includes(`${file}:${id}`)) {
              expect(moved, name).toBe(`q-${kind}`);
              queued.add(`${kind} ${file}:${id}`);
            } else expect(moved, name).toBe(runner(base));
          }
        }
      }
    }
  }
  expect([...queued].toSorted()).toEqual(
    Object.entries(queues)
      .flatMap(([kind, jobs]) => jobs.map((job) => `${kind} ${job}`))
      .toSorted(),
  );
  // The jobs the plan named, so a job the check could not read is not missed.
  for (const job of [
    "ci.yml:unit-tests",
    "source-journeys.yml:source-desktop",
    "verify.yml:request",
    "verify.yml:lane",
    "verify.yml:linux-tests",
    "replay.yml:replay-gate",
    "linux-startup.yml:runtime-facts",
    "linux-packages.yml:build",
    "linux-packages.yml:check",
    ...gate,
    ...hostedAlways,
  ])
    expect(
      linux.some((name) => name.startsWith(`${job} `)),
      job,
    ).toBe(true);
});

/**
 * INF-5159: a journey whose far computer is this one needs an SSH server and
 * an x64 chip there, and a compute Mac's arm64 Linux guest has neither, so
 * its tests skipped there and the untagged-skip step failed the request. A
 * journey request's Linux part that holds one keeps LINUX_RUNNER's places
 * while LINUX_QUEUES sends the journeys kind to the queue that overflows to
 * those guests; every other part still takes that queue (docs/testing.md,
 * "Each Linux job's kind").
 */
it("keeps a journey request's Linux part whose far computer is this one on LINUX_RUNNER's places", () => {
  type Job = { "runs-on"?: string; with?: Record<string, unknown> };
  const jobs = (file: string) =>
    (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
  const overflow = jobs("journeys.yml")["linux-overflow"];
  const journeys = jobs("source-journeys.yml")["source-desktop"];
  const vars = {
    LINUX_RUNNER: "shell-pc-linux",
    LINUX_QUEUES: JSON.stringify({ journeys: "fleet-linux-pr" }),
  };
  /** Where each Linux part of a request for these files starts, as journeys.yml calls it. */
  const placed = (files: string[], hosted = false) => {
    const reasons = new Map(files.map((file) => [file, ["requested by name"]]));
    // The Mac readings of a passing verify run, as the chooser reads its newest.
    const times = new Map<string, number>(
      Object.entries(
        JSON.parse(
          readFileSync(join(root, "tests/fixtures/affected-journeys/verify-times.json"), "utf8"),
        ).times,
      ),
    );
    const { linux } = budget(reasons, times, () => false, false, [], false, "linux");
    return linuxParts(linux).map((matrix) => {
      const passed = (input: string) =>
        workflowValue(String(overflow?.with?.[input] ?? ""), { matrix, inputs: { hosted } });
      return {
        files: matrix.files,
        runner: workflowValue(journeys?.["runs-on"] ?? "", {
          inputs: { hosted: passed("hosted"), "far-linux": passed("far-linux") },
          vars,
        }),
      };
    });
  };
  // The files of request run 44574860414's Linux part that took a guest.
  const request = [
    "tests/e2e/activity-runs.spec.ts",
    "tests/e2e/integrations-mcp.spec.ts",
    "tests/e2e/observe-windowing.spec.ts",
    "tests/e2e/personal-resources.spec.ts",
    "tests/e2e/release-notes.spec.ts",
    "tests/e2e/run-work-ssh.spec.ts",
    "tests/e2e/window-shot.spec.ts",
  ];
  const parts = placed(request);
  expect(parts.flatMap((part) => part.files.split(" ")).toSorted()).toEqual(request);
  for (const part of parts)
    expect(part.runner, part.files).toBe(
      part.files.includes("run-work-ssh.spec.ts") ? "shell-pc-linux" : "fleet-linux-pr",
    );
  const others = request.filter((file) => !file.includes("run-work-ssh"));
  expect(placed(others).map((part) => part.runner)).toEqual(
    placed(others).map(() => "fleet-linux-pr"),
  );
  expect(placed(request, true).map((part) => part.runner)).toEqual(
    placed(request, true).map(() => "ubuntu-24.04"),
  );
});

/**
 * INF-2430's plan, piece 1 (captain: "move the linux jobs to hosted now"):
 * every Linux job that main.yml or release.yml starts, publishing or dry run,
 * runs on GitHub's hosted ubuntu-24.04, and the Ubuntu 26.04 package check on
 * ubuntu-26.04, whatever LINUX_RUNNER says. Only those two callers pass
 * hosted; a request and a pull request keep today's labels, and the retired
 * RELEASE_LINUX_RUNNER moves no job (docs/testing.md, "A release's hosted
 * machines").
 */
describe("a release's hosted machines", () => {
  type Job = {
    "runs-on"?: string;
    uses?: string;
    with?: Record<string, unknown>;
    strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  };
  type Workflow = {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    jobs: Record<string, Job>;
  };
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  );
  const workflow = (file: string) => loadYamlFile(`.github/workflows/${file}`) as Workflow;
  const release = workflow("release.yml").jobs;
  const main = workflow("main.yml").jobs;
  const verify = workflow("verify.yml").jobs;
  const journeys = workflow("source-journeys.yml").jobs["source-desktop"];
  const packages = workflow("linux-packages.yml").jobs;
  const ios = workflow("ios-release.yml").jobs;
  const runsOn = (job: Job | undefined, contexts: Record<string, unknown>) =>
    workflowValue(job?.["runs-on"] ?? "", contexts);
  const literal = (job: Job | undefined) => {
    const value = job?.["runs-on"] ?? "";
    return value.includes("${{") ? undefined : value;
  };
  const passed = (job: Job | undefined, input: string, contexts: Record<string, unknown>) => {
    const value = job?.with?.[input];
    return typeof value === "string" && value.includes("${{")
      ? workflowValue(value, contexts)
      : value;
  };
  const pc = { LINUX_RUNNER: "shell-pc-linux" };
  const everyCheck = (label: (runner: string) => string) =>
    (packages.check?.strategy?.matrix?.include ?? []).map(
      (matrix) =>
        `${matrix.system} ${matrix.image ?? matrix.runner}: ${label(matrix.runner ?? "")}`,
    );

  /** Where verify.yml's Linux jobs start when a caller passes `hosted`. */
  const verified = (hosted: unknown, vars: Record<string, string>, fleetTests: unknown = false) => {
    const journeysHosted = passed(verify["linux-e2e"], "hosted", { inputs: { hosted } });
    return {
      request: runsOn(verify.request, { inputs: { hosted }, vars }),
      checks: runsOn(verify.lane, { matrix: { lane: "linux-checks" }, inputs: { hosted }, vars }),
      tests: runsOn(verify["linux-tests"], { inputs: { hosted, fleet_tests: fleetTests }, vars }),
      journeys: runsOn(journeys, { inputs: { hosted: journeysHosted }, vars }),
    };
  };
  /** Where each of a release run's Linux jobs starts, through its calls' inputs. */
  const placedRelease = (dryRun: "true" | "false", vars: Record<string, string>) => {
    const needs = { resolve: { outputs: { dry_run: dryRun } } };
    const hosted = passed(release.linux, "hosted", { needs, vars });
    const release_runner = passed(release.linux, "release_runner", { needs, vars });
    return {
      ...verified(passed(release.verify, "hosted", { needs, vars }), vars),
      build: runsOn(packages.build, { inputs: { hosted, release_runner }, vars }),
      packages: (packages.check?.strategy?.matrix?.include ?? []).map(
        (matrix) =>
          `${matrix.system} ${matrix.image ?? matrix.runner}: ${runsOn(packages.check, { matrix, inputs: { hosted, release_runner }, vars })}`,
      ),
      own: ["resolve", "notes", "phone", "upload"].map((id) => literal(release[id])),
    };
  };
  const hostedRelease = {
    request: "ubuntu-24.04",
    checks: "ubuntu-24.04",
    tests: "ubuntu-24.04",
    journeys: "ubuntu-24.04",
    build: "ubuntu-24.04",
    packages: everyCheck((runner) => runner),
    own: ["ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04"],
  };

  it("runs every Linux job of a release on GitHub's hosted Ubuntu, publishing or dry run", () => {
    // The retired release label moves nothing (INF-2111's RELEASE_LINUX_RUNNER).
    const retired = { ...pc, RELEASE_LINUX_RUNNER: "shell-pc-linux-release" };
    for (const dryRun of ["false", "true"] as const)
      for (const vars of [pc, retired, {}])
        expect(placedRelease(dryRun, vars)).toEqual(hostedRelease);
    expect(everyCheck((runner) => runner)).toContain("ubuntu-host ubuntu-26.04: ubuntu-26.04");
    // The phone release's two Linux jobs run hosted for every dispatch; its
    // phone check has no Linux job (INF-2539).
    for (const id of ["resolve", "availability"]) expect(literal(ios[id]), id).toBe("ubuntu-24.04");
    expect(ios.phone?.with).not.toHaveProperty("hosted");
  });

  it("routes only publishing release packages to the configured release queue", () => {
    const vars = { ...pc, RELEASE_LINUX_PACKAGES_RUNNER: "shell-pc-linux-release" };
    expect(placedRelease("false", vars)).toEqual({
      ...hostedRelease,
      build: vars.RELEASE_LINUX_PACKAGES_RUNNER,
      packages: everyCheck((runner) =>
        runner === "ubuntu-26.04"
          ? `${vars.RELEASE_LINUX_PACKAGES_RUNNER}-2604`
          : vars.RELEASE_LINUX_PACKAGES_RUNNER,
      ),
    });
    expect(placedRelease("true", vars)).toEqual(hostedRelease);
    expect(placedRelease("false", pc)).toEqual(hostedRelease);
  });

  it("runs every Linux job of the continuous run on main on GitHub's hosted Ubuntu", () => {
    const calls = Object.values(main);
    const call = (file: string) => calls.find((job) => job.uses?.endsWith(`/${file}`));
    // A LINUX_QUEUES queue naming every kind moves none of them (DOP-251's plan).
    const queues = {
      ...pc,
      LINUX_QUEUES: JSON.stringify({ light: "q", checks: "q", journeys: "q" }),
    };
    for (const vars of [pc, queues, {}]) {
      expect(verified(passed(call("verify.yml"), "hosted", { vars }), vars)).toEqual({
        request: "ubuntu-24.04",
        checks: "ubuntu-24.04",
        tests: "ubuntu-24.04",
        journeys: "ubuntu-24.04",
      });
    }
    // Main calls no phone check (INF-2492), so it starts no phone Linux job.
    expect(call("phone.yml")).toBeUndefined();
    // The startup fixtures, which main alone calls (INF-2441), name hosted Ubuntu.
    expect(call("linux-startup.yml")).toBeDefined();
    expect(literal(workflow("linux-startup.yml").jobs["runtime-facts"])).toBe("ubuntu-24.04");
    expect(Object.keys(workflow("linux-startup.yml").on)).toEqual(["workflow_call"]);
  });

  it("places batch test groups on the PC queue, ignoring the mixed fleet and falling back to hosted", () => {
    const sweep = workflow("batch-checks.yml").jobs.sweep;
    const hosted = passed(sweep, "hosted", {});
    const fleetTests = passed(sweep, "fleet_tests", {});
    const other = { request: "ubuntu-24.04", checks: "ubuntu-24.04", journeys: "ubuntu-24.04" };
    for (const [vars, tests] of [
      [{ ...pc, LINUX_QUEUES: JSON.stringify({ checks: "fleet-linux" }) }, "shell-pc-linux"],
      [{ LINUX_QUEUES: JSON.stringify({ checks: "fleet-linux" }) }, "ubuntu-24.04"],
      [pc, "shell-pc-linux"],
      [{}, "ubuntu-24.04"],
    ] as const) {
      expect(verified(hosted, vars, fleetTests)).toEqual({ ...other, tests });
    }
    expect(workflow("verify.yml").on.workflow_call?.inputs?.fleet_tests).toMatchObject({
      default: false,
    });
  });

  it("keeps a request's Linux jobs on today's labels", () => {
    // A request passes no hosted input, so its calls see it unset.
    const requested = (vars: Record<string, string>) => ({
      ...verified(null, vars),
      build: runsOn(packages.build, { inputs: {}, vars }),
      packages: (packages.check?.strategy?.matrix?.include ?? []).map(
        (matrix) =>
          `${matrix.system} ${matrix.image ?? matrix.runner}: ${runsOn(packages.check, { matrix, inputs: {}, vars })}`,
      ),
    });
    expect(requested(pc)).toEqual({
      request: "shell-pc-linux",
      checks: "shell-pc-linux",
      tests: "shell-pc-linux",
      journeys: "shell-pc-linux",
      build: "shell-pc-linux",
      packages: everyCheck((runner) =>
        runner === "ubuntu-26.04" ? "shell-pc-linux-2604" : "shell-pc-linux",
      ),
    });
    expect(requested({})).toEqual({
      request: "ubuntu-24.04",
      checks: "ubuntu-24.04",
      tests: "ubuntu-24.04",
      journeys: "ubuntu-24.04",
      build: "ubuntu-24.04",
      packages: everyCheck((runner) => runner),
    });
  });

  it("lets only main's, the swept batch's and a release's calls pass hosted, never a request", () => {
    const passing: string[] = [];
    for (const file of workflows) {
      for (const [id, job] of Object.entries(workflow(file).jobs)) {
        if (job.with?.hosted === undefined) continue;
        const value = passed(job, "hosted", {
          vars: pc,
          needs: { resolve: { outputs: { dry_run: "false" } } },
          inputs: { hosted: true },
        });
        if (value === true) passing.push(`${file}:${id}`);
      }
    }
    expect(passing.sort()).toEqual([
      // The swept batch's critical path (INF-2507) and its sweep, the alpha's
      // full check (INF-2430's plan, piece 3), on a batch pull request
      // (INF-3759's plan, piece 2).
      "batch-checks.yml:critical-path",
      "batch-checks.yml:sweep",
      // An outside contributor's pull request (docs/public-ci.md, "Outside
      // contributors"): the swept batch's full check, its edited journeys'
      // rounds and its Windows build, and journeys.yml's Linux part on what
      // its caller passed.
      "contributors.yml:journeys",
      "contributors.yml:sweep",
      "contributors.yml:windows",
      "journeys.yml:linux-overflow",
      "main.yml:verify",
      "release.yml:linux",
      "release.yml:verify",
      "verify.yml:linux-e2e",
    ]);
    // verify.yml passes on only what its own caller passed.
    expect(passed(verify["linux-e2e"], "hosted", { inputs: {} })).toBe(false);
    expect(passed(workflow("journeys.yml").jobs["linux-overflow"], "hosted", { inputs: {} })).toBe(
      false,
    );
    // A request names no hosted input of its own.
    for (const file of [
      "verify.yml",
      "linux-packages.yml",
      "source-journeys.yml",
      "phone.yml",
      "journeys.yml",
      "windows.yml",
    ])
      expect(workflow(file).on.workflow_dispatch?.inputs ?? {}, file).not.toHaveProperty("hosted");
  });
});

/**
 * INF-6155's answer: the unsigned Windows installer reads no secret, so its build
 * runs on GitHub's hosted Windows, while the fresh Windows 11 check stays on the
 * project's own machine.
 */
describe("windows.yml's runners", () => {
  type Job = { "runs-on"?: string };
  const jobs = (loadYamlFile(".github/workflows/windows.yml") as { jobs: Record<string, Job> })
    .jobs;
  const runner = (id: string, vars: Record<string, string>, hosted = false) =>
    workflowValue(jobs[id]?.["runs-on"] ?? "", { vars, inputs: { hosted } });

  it("builds on hosted Windows unless a place is named, and always when hosted", () => {
    expect(runner("build", {})).toBe("windows-2025");
    expect(runner("build", { WINDOWS_RUNNER: "shell-pc-windows" })).toBe("shell-pc-windows");
    expect(runner("build", { WINDOWS_RUNNER: "shell-pc-windows" }, true)).toBe("windows-2025");
  });

  it("checks the installer on the clean Windows 11 machine whatever else is set", () => {
    expect(runner("check", {})).toBe("shell-pc-win11");
    expect(runner("check", { WINDOWS_CLEAN_RUNNER: "clean" })).toBe("clean");
  });
});
