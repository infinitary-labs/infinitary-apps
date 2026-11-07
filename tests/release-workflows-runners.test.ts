import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadYamlFile, root, workflowString, workflowValue } from "./helpers/releaseWorkflows";
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
    const verify = ["mac", "parallel", "desktop"].map((lane) =>
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
 * configure how much resource each type of job needs, and runner-up
 * coordinates which ones can go in parallel vs not"): each kind of Mac job
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
    release_sign: "q-release-sign",
    release_light: "q-release-light",
  };
  const today = {
    MAC_RUNNER: "mini-mac-any",
    REAL_MAC_RUNNER: "mini-mac-real",
    VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
  };
  const publishing = (dryRun: boolean) => ({ resolve: { outputs: { dry_run: String(dryRun) } } });

  it.each([
    ["verify.yml", "lane", { matrix: { lane: "mac" }, inputs: {} }, "split", "mini-mac-any"],
    ["verify.yml", "lane", { matrix: { lane: "parallel" }, inputs: {} }, "split", "mini-mac-any"],
    ["verify.yml", "lane", { matrix: { lane: "desktop" }, inputs: {} }, "split", "mini-mac-any"],
    ["journeys.yml", "affected-journeys", { inputs: {} }, "journeys", "mini-mac-any"],
    ["phone.yml", "scene-evidence", {}, "light", "mini-mac-any"],
    ["ios-release.yml", "testflight", {}, "testflight", "mini-mac-real"],
    ["mac-installer.yml", "build", {}, "build", "mini-mac-virtual"],
    ["mac-installer.yml", "installed", { matrix: { chip: "arm64" } }, "light", "mini-mac-virtual"],
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
  it.each(["mac", "parallel", "desktop"])(
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

  it("keeps the Intel installer check on its hosted Mac", () => {
    const runner = workflowValue(jobs("mac-installer.yml").installed?.["runs-on"] ?? "", {
      matrix: { chip: "x64" },
      vars: { MAC_QUEUES: JSON.stringify(queues) },
    });
    expect(runner).toBe("macos-15-intel");
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
        const listed =
          known && typeof values === "string" && values.includes("${{")
            ? workflowValue(values, { inputs: {} })
            : values;
        const entries =
          key && known && Array.isArray(listed) ? listed.map((value) => ({ [key]: value })) : [{}];
        for (const matrix of entries) {
          const runner = (vars: Record<string, string>) =>
            workflowString(job["runs-on"] ?? "", {
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
    const e2e = jobs("verify.yml").lane?.steps?.find((step) => step.id === "e2e");
    const run = e2e?.run ?? "";
    // The parallel journeys' job, where the worker count tells (INF-2779).
    const projects = workflowString(e2e?.env?.PROJECTS ?? "", { matrix: { lane: "parallel" } });
    const command = `exec playwright test --no-deps ${projects}`;
    const dir = scratchDir("infinitary-job-cores-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "pnpm.log");
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n');
    chmodSync(join(bin, "pnpm"), 0o755);
    const workers = (cores?: string) => {
      writeFileSync(log, "");
      const { RUNNER_UP_CORES: _unset, ...env } = process.env;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", run], {
        cwd: root,
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          COMMAND_LOG: log,
          INFINITARY_E2E_TAG: "",
          PROJECTS: projects,
          ...(cores === undefined ? {} : { RUNNER_UP_CORES: cores }),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(log, "utf8").trim();
    };
    expect(workers("12")).toBe(`${command} --workers=6`);
    expect(workers("1")).toBe(`${command} --workers=1`);
    // No size named: half this machine, as `--workers=50%` gave.
    expect(workers()).toBe(
      `${command} --workers=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
    );
    expect(workers("not a number")).toBe(
      `${command} --workers=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
    );
  });
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
  const gate = ["journeys.yml:choose-journeys"];
  const hostedAlways = [
    "release.yml:resolve",
    "release.yml:notes",
    "release.yml:phone",
    // INF-2498's plan, piece 2: the uploads, on a machine GitHub hosts.
    "release.yml:upload",
    "ios-release.yml:resolve",
    "ios-release.yml:availability",
    // main.yml is its only caller (INF-2441).
    "linux-startup.yml:runtime-facts",
    // INF-2465: main's wait for the alpha cut, which main.yml alone calls;
    // its wait job is pending on no machine while a cut runs (INF-2834).
    "alpha-wait.yml:find",
    "alpha-wait.yml:wait",
    "alpha-wait.yml:ended",
    // The swept batch and main's sort of each push (INF-2430's plan, piece 3).
    "main.yml:sort",
    "main.yml:covered",
    "infinitary-batch-checks.yml:passed",
  ];
  // DOP-251's plan: each kind is one stage of moving Linux jobs to the Mac
  // mini's Linux guests (docs/testing.md, "Each Linux job's kind").
  const queues: Record<string, string[]> = {
    light: ["verify.yml:request", "phone.yml:request"],
    ci: [
      "ci.yml:unit-tests",
      "ci.yml:integration-tests",
      "ci.yml:probe-tests",
      "replay.yml:replay-gate",
      "prompt-budget.yml:prompt-budget",
    ],
    gate: ["journeys.yml:choose-journeys"],
    checks: ["verify.yml:lane", "verify.yml:linux-tests"],
    // INF-2915's plan: the pull request's one job runs the critical path,
    // which needs a desktop, so this kind names only a PC queue.
    typecheck: ["ci.yml:typecheck-lint-build"],
  };
  const queued = new Set<string>();
  type Job = { "runs-on"?: string; strategy?: { matrix?: Record<string, unknown> } };
  const evaluate = (value: string, contexts: Record<string, unknown>) =>
    value.includes("${{") ? workflowValue(value, contexts) : value;
  const linux: string[] = [];
  // The shipped queue (docs/forge.md, "The shipped queue") is generated from
  // src/core/queue/shipped/ for every project and names its own runners;
  // this project's batch checks, which it calls, run where this check says.
  for (const file of readdirSync(join(root, ".github/workflows")).filter(
    (name) => name.endsWith(".yml") && name !== "infinitary-queue.yml",
  )) {
    const { jobs } = loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> };
    for (const [id, job] of Object.entries(jobs)) {
      if (!job["runs-on"]) continue;
      const matrix = job.strategy?.matrix ?? {};
      const include = Array.isArray(matrix.include) ? (matrix.include as object[]) : [];
      const lanes = typeof matrix.lane === "string" ? evaluate(matrix.lane, { inputs: {} }) : [];
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
  // Each kind reached every job the plan gave it.
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
  /** A caller's `with` value for a called workflow's input, as the call passes it. */
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
  const verified = (hosted: unknown, vars: Record<string, string>) => {
    const journeysHosted = passed(verify["linux-e2e"], "hosted", { inputs: { hosted } });
    return {
      request: runsOn(verify.request, { inputs: { hosted }, vars }),
      checks: runsOn(verify.lane, { matrix: { lane: "linux-checks" }, inputs: { hosted }, vars }),
      tests: runsOn(verify["linux-tests"], { inputs: { hosted }, vars }),
      journeys: runsOn(journeys, { inputs: { hosted: journeysHosted }, vars }),
    };
  };
  /** Where each of a release run's Linux jobs starts, through its calls' inputs. */
  const placedRelease = (dryRun: "true" | "false", vars: Record<string, string>) => {
    const needs = { resolve: { outputs: { dry_run: dryRun } } };
    const hosted = passed(release.linux, "hosted", { needs, vars });
    return {
      ...verified(passed(release.verify, "hosted", { needs, vars }), vars),
      build: runsOn(packages.build, { inputs: { hosted }, vars }),
      packages: (packages.check?.strategy?.matrix?.include ?? []).map(
        (matrix) =>
          `${matrix.system} ${matrix.image ?? matrix.runner}: ${runsOn(packages.check, { matrix, inputs: { hosted }, vars })}`,
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

  it("runs every Linux job of the continuous run on main on GitHub's hosted Ubuntu", () => {
    const calls = Object.values(main);
    const call = (file: string) => calls.find((job) => job.uses?.endsWith(`/${file}`));
    // A LINUX_QUEUES queue naming every kind moves none of them (DOP-251's plan).
    const queues = {
      ...pc,
      LINUX_QUEUES: JSON.stringify({ light: "q", checks: "q" }),
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
      // full check (INF-2430's plan, piece 3).
      "infinitary-batch-checks.yml:critical-path",
      "infinitary-batch-checks.yml:sweep",
      "main.yml:verify",
      "release.yml:linux",
      "release.yml:verify",
      "verify.yml:linux-e2e",
    ]);
    // verify.yml passes on only what its own caller passed.
    expect(passed(verify["linux-e2e"], "hosted", { inputs: {} })).toBe(false);
    // A request names no hosted input of its own.
    for (const file of ["verify.yml", "linux-packages.yml", "source-journeys.yml", "phone.yml"])
      expect(workflow(file).on.workflow_dispatch?.inputs ?? {}, file).not.toHaveProperty("hosted");
  });
});
