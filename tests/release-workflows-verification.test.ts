import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import vitestConfig from "../vitest.config";
import { E2E_PROJECTS } from "./e2e/lanes.ts";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import { runJobNames } from "./helpers/ciJobNames";
import {
  ciJobs,
  githubScript,
  loadYamlFile,
  PUBLISHES,
  root,
  signedChannel,
  VERIFY_E2E_RUN,
  verifyLinuxTests,
  type ChannelWorkflow as Workflow,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** Which verification a release waits for and inherits (release.yml, verify.yml). */

describe("the signed channel workflow", () => {
  const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const { jobOf, signingSteps, steps, step, lane, lanes } = signedChannel(release, verify);

  // INF-621: prove the full Mac job on a disposable runner without moving
  // the live MAC_RUNNER variable or changing Linux's placement.
  it("routes an isolated verification to its requested Mac without changing normal runs", () => {
    for (const event of ["workflow_call", "workflow_dispatch"]) {
      expect(verify.on[event]?.inputs?.mac_runner).toMatchObject({
        required: false,
        type: "string",
      });
    }
    const runner = (name: string, macRunner: string, configuredRunner: string) =>
      workflowValue(lane["runs-on"] ?? "", {
        matrix: { lane: name },
        inputs: { mac_runner: macRunner },
        vars: { MAC_RUNNER: configuredRunner },
      });
    expect(runner("mac", "mini-mac-inf621-proof", "mini-mac")).toBe("mini-mac-inf621-proof");
    expect(runner("mac", "", "mini-mac")).toBe("mini-mac");
    expect(runner("mac", "", "")).toBe("macos-15");
    expect(runner("linux-checks", "mini-mac-inf621-proof", "mini-mac")).toBe("ubuntu-24.04");
    // The Linux test groups keep Linux's placement too.
    expect(
      workflowValue(jobOf(verify, "linux-tests")["runs-on"] ?? "", {
        inputs: { mac_runner: "mini-mac-inf621-proof" },
        vars: { MAC_RUNNER: "mini-mac" },
      }),
    ).toBe("ubuntu-24.04");
  });

  // The captain's end state, under INF-2508's card: "the e2e journey +
  // browser tests should all run during the sweep batch" (INF-2505). The
  // swept batch's sweep is this full check, whose browser test group
  // installs the browser layer's Chromium and then runs every browser file.
  it("runs every browser file in the swept batch's check", () => {
    const batch = loadYamlFile(".github/workflows/infinitary-batch-checks.yml") as Workflow;
    const sweep = jobOf(batch, "sweep");
    expect(sweep.uses).toBe("./.github/workflows/verify.yml");
    const groups = verifyLinuxTests((sweep.with ?? {}) as Record<string, unknown>);
    const steps = groups.find(({ name }) => name.includes("Browser tests"))?.steps ?? [];
    const chromium = steps.findIndex(({ uses }) =>
      uses?.endsWith("/.github/actions/browser-chromium"),
    );
    // The whole browser project, in one group of one part.
    const everyBrowserFile = steps.findIndex(
      ({ run }) => run === "pnpm test --project browser --shard=1/1",
    );
    expect(chromium).toBeGreaterThanOrEqual(0);
    expect(everyBrowserFile).toBeGreaterThan(chromium);
    const projects = (vitestConfig.test?.projects ?? []).map((project) =>
      typeof project === "object" && "test" in project ? project.test?.name : undefined,
    );
    expect(projects).toContain("browser");
  });

  it("runs each profile's lanes as one matrix, so an omitted lane is absent from the run, never skipped", () => {
    expect(Object.keys(verify.jobs)).toEqual([
      "request",
      "linux-e2e",
      "installer",
      "lane",
      "linux-tests",
    ]);
    expect(verify.jobs["linux-e2e"]).toMatchObject({
      uses: "./.github/workflows/source-journeys.yml",
      with: { ref: "${{ inputs.ref || github.ref }}", suite: "full" },
    });
    // INF-2779 (the captain's three Mac jobs): native tests and the package,
    // the parallel journeys, and the one-worker desktop journeys.
    const all = ["linux-checks", "mac", "parallel", "desktop"];
    expect(lanes("stable")).toEqual(all);
    expect(lanes()).toEqual(all);
    expect(lanes("alpha")).toEqual(all);
    // INF-2259 adds an automatic-event success guard, not a manual profile skip.
    // Both manual profiles still resolve; lane jobs never turn a skip into a pass.
    for (const channel of ["stable", "alpha"])
      expect(
        workflowValue(jobOf(release, "resolve").if ?? "", {
          github: { event_name: "workflow_dispatch" },
          inputs: { channel },
        }),
      ).toBe(true);
    expect(workflowValue(lane.if ?? "", { inputs: {} })).toBe(true);
    expect(workflowValue(lane.if ?? "", { inputs: { installer_only: true } })).toBe(false);
    expect(workflowValue(jobOf(verify, "installer").if ?? "", { inputs: {} })).toBe(false);
    expect(
      workflowValue(jobOf(verify, "installer").if ?? "", { inputs: { installer_only: true } }),
    ).toBe(true);
    expect(Object.keys(release.jobs)).toEqual([
      "resolve",
      "notes",
      "verify",
      "linux",
      "phone",
      "release",
      "update",
      "upload",
      "publish",
    ]);
    const runner = (name: string) =>
      workflowValue(lane["runs-on"] ?? "", { matrix: { lane: name }, inputs: {}, vars: {} });
    expect(runner("linux-checks")).toBe("ubuntu-24.04");
    for (const mac of ["mac", "parallel", "desktop"]) expect(runner(mac), mac).toBe("macos-15");
    // What each lane runs, by its own step conditions on a passing run: the
    // linux-checks lane retains the full main gate, replacing the separate
    // cohort sweeps and changed-test repetitions with the full suite; the
    // Mac lanes retain the Mac-only selection, the journeys on their own jobs.
    const runsIn = (name: string) =>
      (lane.steps ?? [])
        .filter(
          (candidate) =>
            candidate.run &&
            (candidate.if === undefined ||
              workflowValue(candidate.if, {
                matrix: { lane: name },
                inputs: {},
                steps: Object.fromEntries(
                  (lane.steps ?? []).flatMap(({ id }) =>
                    id ? [[id, { outcome: "success" }]] : [],
                  ),
                ),
              }) === true),
        )
        .map((candidate) => candidate.run);
    // The requested full sweep's commands: a pull request's notes step has no
    // pull request to compare on main.
    const tests = (run: string) => (/^pnpm test(:probes|:repeats)? /.test(run) ? "pnpm test" : run);
    const mainGate = ciJobs("workflow_dispatch").flatMap(({ runs }) => runs.map(tests));
    // INF-2646: linux-checks and the Linux test groups beside it run them
    // together, the tests in the groups alone.
    const linuxTests = verifyLinuxTests({}).flatMap(({ runs }) => runs.map(tests));
    expect([...new Set([...runsIn("linux-checks"), ...linuxTests])].toSorted()).toEqual(
      [...new Set(mainGate)].toSorted(),
    );
    expect(runsIn("linux-checks").filter((run) => run?.startsWith("pnpm test"))).toEqual([]);
    const macUnit = 'mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n';
    expect(runsIn("mac")).toEqual(
      expect.arrayContaining([macUnit, "pnpm build", "pnpm replay:gate"]),
    );
    expect(runsIn("mac")).not.toContain(VERIFY_E2E_RUN);
    for (const journeys of ["parallel", "desktop"]) {
      expect(runsIn(journeys), journeys).toEqual(
        expect.arrayContaining(["pnpm build", VERIFY_E2E_RUN]),
      );
      expect(runsIn(journeys), journeys).not.toContain(macUnit);
      expect(runsIn(journeys), journeys).not.toContain("pnpm replay:gate");
    }
    for (const mac of ["mac", "parallel", "desktop"])
      expect(runsIn(mac), mac).not.toContain("pnpm typecheck");
    // The publication's summary names each profile's lanes and what it
    // omits, from the same profiles.
    const summary = step("Summarize the publication").env ?? {};
    for (const required of ["true", "false"]) {
      const context = {
        needs: { resolve: { outputs: { verify_required: required, main_run: "" } } },
      };
      expect(workflowValue(summary.LANES ?? "", context)).toBe(
        required === "true" ? "linux-checks, linux-e2e, mac, parallel and desktop" : "none",
      );
      expect(workflowValue(summary.OMITTED ?? "", context)).toMatch(
        required === "true" ? /^none$/ : /inherited from the published alpha, not passed/,
      );
    }
    // INF-2480: an alpha reusing main's checks runs every journey itself.
    const reused = {
      needs: {
        resolve: {
          outputs: {
            verify_required: "true",
            main_run: "https://github.com/infinitary-labs/infinitary/actions/runs/41657804530",
            main_journeys: "false",
          },
        },
      },
    };
    expect(workflowValue(summary.LANES ?? "", reused)).toBe(
      "linux-e2e, parallel and desktop (every journey)",
    );
    expect(workflowValue(summary.OMITTED ?? "", reused)).toBe(
      "linux-checks and mac; inherited from rolling main https://github.com/infinitary-labs/infinitary/actions/runs/41657804530, not repeated here",
    );
    // The captain on INF-2508: "Keep every journey in the batch, and let an
    // alpha reuse them". An alpha from a swept batch that ran every journey
    // runs no lane, and names the batch run it inherited them from.
    const batchRun = "https://github.com/infinitary-labs/infinitary/actions/runs/41600000001";
    const swept = {
      needs: {
        resolve: {
          outputs: { verify_required: "true", main_run: batchRun, main_journeys: "true" },
        },
      },
    };
    expect(workflowValue(summary.LANES ?? "", swept)).toBe("none");
    expect(workflowValue(summary.OMITTED ?? "", swept)).toBe(
      `linux-checks, linux-e2e, mac, parallel and desktop; inherited from ${batchRun}, not repeated here`,
    );
  });

  /**
   * INF-2480 (the captain: "old set at the release check only, from the first
   * piece on"): a call names its part. main.yml's checks part runs every lane
   * but the Linux journeys, with only the tests that need a Mac on the Mac;
   * the journeys part, which an alpha reusing main's checks runs, is every
   * journey on Linux and the Mac and none of the checks main already passed.
   * Each step's outcome feeds the next, as Actions gives them.
   */
  it("runs the old journey set in the journeys part and leaves it out of main's checks part", () => {
    const ran = (name: string, inputs: Record<string, unknown>) => {
      const outcomes: Record<string, { outcome: string }> = {};
      const commands: string[] = [];
      for (const candidate of lane.steps ?? []) {
        const runs =
          candidate.if === undefined ||
          workflowValue(candidate.if, { matrix: { lane: name }, inputs, steps: outcomes }) === true;
        if (candidate.id) outcomes[candidate.id] = { outcome: runs ? "success" : "skipped" };
        if (runs && candidate.run) commands.push(candidate.id ?? candidate.name ?? candidate.run);
      }
      return commands;
    };
    const linuxJourneys = (inputs: Record<string, unknown>) =>
      workflowValue(jobOf(verify, "linux-e2e").if ?? "", { inputs });
    const only = (inputs: Record<string, unknown>) =>
      workflowValue(
        (lane.steps ?? []).find((candidate) => candidate.id === "e2e")?.env?.INFINITARY_E2E_TAG ??
          "",
        { inputs },
      );
    // A call's inputs, with verify.yml's own defaults for those it leaves out.
    const called = (inputs: Record<string, unknown>) => ({
      ...Object.fromEntries(
        Object.entries(verify.on.workflow_call?.inputs ?? {}).flatMap(([name, input]) =>
          "default" in input ? [[name, input.default]] : [],
        ),
      ),
      ...inputs,
    });
    // The part is a call's alone; a request and every caller that names none run the whole check.
    expect(verify.on.workflow_call?.inputs?.part).toMatchObject({ default: "all", type: "string" });
    expect(verify.on.workflow_dispatch?.inputs).not.toHaveProperty("part");
    const whole = ran("mac", called({}));
    expect(linuxJourneys(called({}))).toBe(true);

    // main.yml's call: no Linux journey, and on the Mac only the tagged tests beside every check.
    const main = loadYamlFile(".github/workflows/main.yml") as Workflow;
    const checks = called(
      Object.values(main.jobs).find((job) => job.uses?.endsWith("verify.yml"))?.with ?? {},
    );
    expect(linuxJourneys(checks)).toBe(false);
    expect(workflowValue(lane.strategy?.matrix.lane ?? "", { inputs: checks })).toEqual([
      "linux-checks",
      "mac",
      "parallel",
      "desktop",
    ]);
    for (const name of ["linux-checks", "mac", "parallel", "desktop"])
      expect(ran(name, checks), name).toEqual(ran(name, called({})));
    // Every Linux test group, as in the whole check (INF-2646).
    const groupSteps = (inputs: Record<string, unknown>) =>
      verifyLinuxTests(inputs).map(({ steps }) => steps);
    expect(groupSteps(checks)).toEqual(groupSteps(called({})));
    expect(verifyLinuxTests(checks)).not.toEqual([]);
    expect(only(checks)).toBe(MAC_ONLY_TAG);

    // The journeys part: every Linux journey, and on the Mac every journey and
    // what it needs, in the two journey jobs alone (INF-2779).
    const journeys = called({ part: "journeys" });
    expect(linuxJourneys(journeys)).toBe(true);
    expect(workflowValue(lane.strategy?.matrix.lane ?? "", { inputs: journeys })).toEqual([
      "parallel",
      "desktop",
    ]);
    expect(verifyLinuxTests(journeys)).toEqual([]);
    expect(only(journeys)).toBe("");
    for (const name of ["parallel", "desktop"])
      expect(ran(name, journeys), name).toEqual([
        "install",
        "build",
        "recorder",
        "Read the dev Electron's signature",
        "e2e",
        "Summarize",
      ]);
    expect(whole).not.toContain("e2e");
    expect(whole).toEqual(
      expect.arrayContaining([
        "unit",
        "claude-client",
        "replay",
        "dev-signing",
        "package",
        "helper",
      ]),
    );
  });

  /**
   * INF-2779 (the captain approved "Three jobs: unit tests and package check,
   * parallel journeys, desktop journeys"): the two journey jobs together run
   * every journey project once, and the desktop job holds the one-worker
   * project, the one that keeps voice, paint budgets and demo recordings on
   * a quiet machine (tests/e2e/lanes.ts).
   */
  it("splits the Mac journeys between the parallel and desktop jobs, every project once", () => {
    const e2e = (lane.steps ?? []).find((candidate) => candidate.id === "e2e");
    const projects = (name: string) =>
      [
        ...String(
          workflowValue(e2e?.env?.PROJECTS ?? "", { matrix: { lane: name }, inputs: {} }),
        ).matchAll(/--project=(\S+)/g),
      ].map(([, project]) => project);
    const parallel = projects("parallel");
    const desktop = projects("desktop");
    expect([...parallel, ...desktop].toSorted()).toEqual(
      E2E_PROJECTS.map(({ name }) => name).toSorted(),
    );
    expect(desktop).toEqual(
      E2E_PROJECTS.filter((project) => project.workers === 1).map(({ name }) => name),
    );
    // Each job runs its own projects alone: the desktop project is the parallel
    // ones' teardown, so without --no-deps the parallel job would run it too.
    expect(e2e?.run).toContain("--no-deps $PROJECTS");
  });

  // Captain's accepted INF-1258 mac-unit-only option: all files still run
  // on Linux, and Mac retains every reviewed native/mixed file. Discover via
  // the real runner rather than matching strings in test source. --filesOnly
  // never imports a test or enables the opt-in Keychain probes.
  it("keeps the complete Linux suite and selects only the reviewed Mac files", () => {
    const unit = (lane.steps ?? []).find((candidate) => candidate.id === "unit");
    expect(unit?.run).toBe('mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n');
    // Linux runs its tests in groups that name projects and shards alone,
    // never a file (INF-2646; their coverage is held above).
    const linuxTests = verifyLinuxTests({}).flatMap(({ runs }) =>
      runs.filter((run) => run.startsWith("pnpm test ")),
    );
    expect(linuxTests).toHaveLength(8);
    for (const run of linuxTests)
      expect(run).toMatch(/^pnpm test( --project [\w-]+)+ --shard=\d+\/\d+$/);
    const filters = execFileSync(process.execPath, ["scripts/mac-unit-tests.ts"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(filters).toEqual([...MAC_UNIT_FILES]);
    const discover = (files: string[]) => {
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "list", "--filesOnly", ...files, "--json"],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { file: string; projectName: string }[]).map(
        ({ file, projectName }) => ({ file: file.slice(root.length + 1), projectName }),
      );
    };
    const linux = discover([]);
    const mac = discover(filters);
    expect(mac.map(({ file }) => file).sort()).toEqual([...MAC_UNIT_FILES].sort());
    expect(new Set(mac.map(({ file }) => file)).size).toBe(MAC_UNIT_FILES.length);
    // Every Mac file stays in its existing cohort and also runs on Linux;
    // Linux has no filter, so new platform-independent files need no list edit.
    expect(linux).toEqual(expect.arrayContaining(mac));
    expect(linux.length).toBeGreaterThan(mac.length);
    // INF-2267's accepted split: portable workflow edits keep their isolated
    // integration cohort without selecting native Mac bundle/executable checks.
    // INF-2625 splits those contracts into one file per workflow owner.
    const contracts = readdirSync(join(root, "tests"))
      .filter((name) => /^release-workflows-.+\.test\.ts$/.test(name))
      .map((name) => posix.join("tests", name));
    expect(contracts).toContain(posix.join("tests", basename(fileURLToPath(import.meta.url))));
    expect(linux.filter(({ file }) => contracts.includes(file))).toEqual(
      contracts.map((file) => ({ file, projectName: "integration" })),
    );
    expect(mac.some(({ file }) => contracts.includes(file))).toBe(false);
    expect(mac).toContainEqual({
      file: "tests/release-contract.test.ts",
      projectName: "integration",
    });
  }, 15_000);

  // INF-2074's sign-early, the captain's checked fix: "Build and sign an
  // alpha while its checks run, and publish only after they pass." The
  // signing job waits for the notes and the phone, never for a verify lane or the Linux packages; the update check, the
  // record and publication wait for every check.
  it("records and publishes only after full verification or explicitly inherited verification, never after a failed lane, and signs while the lanes run", () => {
    const signing = jobOf(release, "release");
    const update = jobOf(release, "update");
    const upload = jobOf(release, "upload");
    const publish = jobOf(release, "publish");
    expect(signing.needs).toEqual(["resolve", "notes", "phone"]);
    for (const required of ["true", "false", ""]) {
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        const needs = {
          resolve: {
            result: "success",
            outputs: { verify_required: required },
          },
          notes: { result: "success" },
          verify: { result },
          linux: { result: "success" },
          phone: { result: "success" },
          release: { result: "success" },
          update: { result: required === "true" ? "success" : "skipped" },
          upload: { result: "success" },
        };
        const verified =
          (required === "true" && result === "success") ||
          (required === "false" && result === "skipped");
        expect(workflowValue(jobOf(release, "verify").if ?? "", { needs })).toBe(
          required === "true",
        );
        // The signing job runs beside the lanes, whatever they end in.
        expect(workflowValue(signing.if ?? "", { needs })).toBe(
          required === "true" || required === "false",
        );
        expect(workflowValue(update.if ?? "", { needs })).toBe(
          required === "true" && result === "success",
        );
        expect(workflowValue(upload.if ?? "", { needs })).toBe(verified);
        expect(workflowValue(publish.if ?? "", { needs })).toBe(verified);
        // The checks and switches wait for every upload.
        for (const uploaded of ["failure", "cancelled", "skipped"])
          expect(
            workflowValue(publish.if ?? "", { needs: { ...needs, upload: { result: uploaded } } }),
          ).toBe(false);
        // Linux packages that did not pass on clean systems hold the update
        // check, the uploads and publication, never the signing.
        for (const linux of ["failure", "cancelled", "skipped"]) {
          const held = { needs: { ...needs, linux: { result: linux } } };
          expect(workflowValue(signing.if ?? "", held)).toBe(
            required === "true" || required === "false",
          );
          expect(workflowValue(update.if ?? "", held)).toBe(false);
          expect(workflowValue(upload.if ?? "", held)).toBe(false);
          expect(workflowValue(publish.if ?? "", held)).toBe(false);
        }
        // INF-1649: a release with no phone build that keeps changing things on it never signs.
        for (const phone of ["failure", "cancelled", "skipped"]) {
          for (const job of [signing, update, upload, publish]) {
            expect(
              workflowValue(job.if ?? "", {
                needs: { ...needs, phone: { result: phone } },
              }),
            ).toBe(false);
          }
        }
        // A release whose notes were not checked never signs, whatever else passed.
        for (const notes of ["failure", "cancelled", "skipped"]) {
          for (const job of [signing, update, upload, publish]) {
            expect(
              workflowValue(job.if ?? "", {
                needs: { ...needs, notes: { result: notes } },
              }),
            ).toBe(false);
          }
        }
      }
    }
    // While the lanes run, the signing job can record or publish nothing:
    // its token reads, and none of its steps publishes.
    expect(signing.permissions).toEqual({ contents: "read", actions: "read" });
    for (const candidate of signingSteps)
      expect(PUBLISHES.test(candidate.run ?? ""), candidate.id ?? candidate.name).toBe(false);
  });

  it("holds every job that holds signing material behind the phone (INF-1649 review R3)", () => {
    const jobs = (release as { jobs: Record<string, { needs?: string | string[] }> }).jobs;
    const needsOf = (name: string): string[] => {
      const needs = jobs[name]?.needs ?? [];
      return typeof needs === "string" ? [needs] : needs;
    };
    const waitsFor = (name: string, target: string): boolean =>
      needsOf(name).some((need) => need === target || waitsFor(need, target));
    const signing = Object.keys(jobs).filter((name) =>
      /secrets: ?inherit|"secrets":"inherit"|secrets\.(MAC_DEVELOPER_ID|CSC_)/.test(
        JSON.stringify(jobs[name]),
      ),
    );
    expect(signing).toEqual(expect.arrayContaining(["release"]));
    for (const name of signing) expect(waitsFor(name, "phone"), name).toBe(true);
    // INF-1900: the update check holds no signing material.
    expect(signing).not.toContain("update");
  });

  /**
   * A stable inherits its alpha's checks, or is refused. INF-2480 (the
   * captain: "old set at the release check only, from the first piece on"):
   * an alpha that reused main's checks ran every journey itself, and one
   * that ran no lane reused a main run from before it that carried every
   * journey, or (the captain on INF-2508: "Keep every journey in the batch,
   * and let an alpha reuse them") the swept batch a covered main run names;
   * each is promoted only beside main's exact-source run. Job names follow
   * alpha run 41685154411 and main run 41657804530.
   */
  it("inherits the published alpha's run, found by its number, only when both lanes passed in its latest attempt, and refuses the stable otherwise", async () => {
    const script = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "verification",
    )?.with?.script;
    expect(typeof script).toBe("string");
    const execute = githubScript(script as string, [
      "core",
      "exec",
      "github",
      "context",
      "process",
      "require",
    ]);
    const url = "https://github.com/example/project/actions/runs/123";
    const source = "c".repeat(40);
    const mainUrl = "https://github.com/example/project/actions/runs/41657804530";
    const linuxJourneys = ["parallel", "desktop"].flatMap((lane) =>
      [1, 2, 3, 4].map((shard) => `verify / linux-e2e / journeys (${lane} ${shard}/4)`),
    );
    // INF-2413: an alpha and main run after the trigger-first rename, their
    // jobs named as the workflows name them (docs/testing.md, "CI job names").
    const pass = { result: "success" };
    const renamed = (outputs: Record<string, string>) =>
      runJobNames("release.yml", {
        github: { event_name: "workflow_run", event: { workflow_run: { conclusion: "success" } } },
        needs: {
          resolve: { ...pass, outputs: { skip: "false", verify_required: "true", ...outputs } },
          ...Object.fromEntries(
            ["notes", "verify", "linux", "phone", "release", "update"].map((id) => [id, pass]),
          ),
        },
      });
    // GitHub lists a skipped call under its unevaluated name.
    const skippedVerify = String((jobOf(release, "verify") as { name?: string }).name);
    const renamedMain = runJobNames("main.yml", {
      github: { event_name: "push", sha: source },
      // A check that waited for an alpha cut, so the wait's jobs are named too.
      needs: {
        find: { outputs: { alphas: "[204]", waited: "true" } },
        sort: { outputs: { kind: "full" } },
      },
    });
    for (const scenario of [
      "alpha",
      "stable rehearsal without promotion",
      "eligible stable",
      "eligible stable named trigger first",
      "eligible stable named trigger first, from an alpha that ran only the journeys",
      "eligible stable named trigger first, from an alpha that reused a swept batch",
      "renamed stable without its update check",
      "eligible stable from before the update check",
      "eligible stable from an alpha that ran only the journeys",
      "eligible stable from an alpha that reused every lane",
      "eligible stable from an alpha that reused a swept batch",
      "failed mac",
      "skipped mac",
      "pending mac",
      "legacy alpha without mac",
      "alpha without installed-update proof",
      "failed Intel proof from before the update check",
      "pending Apple silicon proof",
      "failed alpha run",
      "missing alpha run",
      "alpha that ran only the journeys, with no main run",
      "alpha that ran only the journeys, missing a shard",
      "alpha that reused a main run without the journeys",
    ]) {
      const outputs: Record<string, string> = {};
      const failures: string[] = [];
      const summaries: string[] = [];
      const summary = {
        addHeading: () => summary,
        addRaw: (text: string) => {
          summaries.push(text);
          return summary;
        },
        write: async () => {},
      };
      // INF-1900: an alpha's update check on Apple silicon alone (Intel is
      // best effort), or the five-copy check on both chips an alpha released
      // before it passed instead.
      const legacy = scenario.endsWith("from before the update check");
      const updateCheck = legacy
        ? "Verify signed installer and updater"
        : "Update from the last published alpha";
      const journeysOnly = scenario.includes("ran only the journeys");
      const reusedEvery = scenario.includes("reused");
      const trigger = scenario.includes("trigger first") || scenario.startsWith("renamed");
      const lanes = reusedEvery
        ? ["verify"]
        : [
            "verify / Validate verification selection",
            ...(journeysOnly ? [] : ["verify / linux-checks"]),
            ...(scenario.endsWith("missing a shard") ? linuxJourneys.slice(1) : linuxJourneys),
            "verify / mac",
          ];
      const names = trigger
        ? [
            ...renamed(
              reusedEvery
                ? { main_run: mainUrl, main_journeys: "true" }
                : journeysOnly
                  ? { main_run: mainUrl }
                  : {},
            ).filter(
              (name) =>
                scenario !== "renamed stable without its update check" || !name.includes("update"),
            ),
            ...(reusedEvery ? [skippedVerify] : []),
          ]
        : [
            "Resolve the source commit and version",
            "Check the release notes",
            ...lanes,
            `${updateCheck} / Apple silicon`,
            ...(legacy ? [`${updateCheck} / Intel`] : []),
          ];
      const jobs = names
        .filter(
          (name) =>
            scenario !== "alpha without installed-update proof" || !name.startsWith(updateCheck),
        )
        .filter((name) => scenario !== "legacy alpha without mac" || name !== "verify / mac")
        .map((name) => ({
          name,
          status:
            (scenario === "pending mac" && name.endsWith("mac")) ||
            (scenario === "pending Apple silicon proof" && name.endsWith("Apple silicon"))
              ? "in_progress"
              : "completed",
          conclusion:
            name === "verify" || name === skippedVerify
              ? "skipped"
              : scenario === "failed Intel proof from before the update check" &&
                  name.endsWith("Intel")
                ? "failure"
                : name.endsWith("mac") && scenario === "failed mac"
                  ? "failure"
                  : name.endsWith("mac") && scenario === "skipped mac"
                    ? "skipped"
                    : "success",
        }));
      // main's exact-source run: its checks part, and every journey when it
      // came before INF-2480; or a covered push that names its swept batch,
      // whose sweep ran every journey on the source's files.
      const swept = scenario.endsWith("a swept batch");
      const tree = "f".repeat(40);
      const batchRun = {
        id: 41600000001,
        run_attempt: 1,
        path: ".github/workflows/batch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        head_repository: { full_name: "example/project" },
        repository: { full_name: "example/project" },
        html_url: "https://github.com/example/project/actions/runs/41600000001",
      };
      const batchJobs = [
        "sweep / linux-checks",
        "sweep / mac",
        ...linuxJourneys.map((name) => name.replace("verify / ", "sweep / ")),
        `verdict (tree ${tree})`,
      ].map((name) => ({
        name,
        run_id: batchRun.id,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      }));
      const mainRun = {
        id: 41657804530,
        run_attempt: 1,
        path: ".github/workflows/main.yml",
        event: "push",
        head_branch: "main",
        head_sha: source,
        status: "completed",
        conclusion: "success",
        head_repository: { full_name: "example/project" },
        repository: { full_name: "example/project" },
        html_url: mainUrl,
      };
      const mainJobs = (
        swept
          ? ["sort", `covered by batch ${batchRun.id}`, "verify"]
          : trigger
            ? renamedMain
            : [
                "verify / Validate verification selection",
                "verify / linux-checks",
                "verify / mac",
                ...(scenario === "eligible stable from an alpha that reused every lane"
                  ? linuxJourneys
                  : []),
              ]
      ).map((name) => ({
        name,
        run_id: mainRun.id,
        run_attempt: 1,
        head_sha: source,
        status: "completed",
        conclusion: swept && name === "verify" ? "skipped" : "success",
      }));
      const listRuns = Symbol("runs");
      const listJobs = Symbol("jobs");
      await execute(
        {
          setOutput: (name: string, value: string) => {
            outputs[name] = value;
          },
          setFailed: (message: string) => failures.push(message),
          info: () => {},
          summary,
        },
        {},
        {
          rest: {
            actions: {
              listWorkflowRuns: listRuns,
              listJobsForWorkflowRun: listJobs,
              getWorkflowRun: async ({ run_id }: { run_id: number }) => {
                expect(run_id).toBe(batchRun.id);
                return { data: batchRun };
              },
            },
            git: {
              getCommit: async ({ commit_sha }: { commit_sha: string }) => {
                expect(commit_sha).toBe(source);
                return { data: { sha: source, tree: { sha: tree } } };
              },
            },
          },
          paginate: async (method: symbol, parameters: Record<string, unknown>) => {
            if (method === listRuns && parameters.workflow_id === "main.yml") {
              // Only a push to main of the alpha's exact source vouches for it.
              expect(parameters).toMatchObject({ head_sha: source, event: "push", branch: "main" });
              return scenario.endsWith("with no main run") ? [] : [mainRun];
            }
            if (method === listRuns) {
              // Dispatched from main, the alpha's run records main's commit, never
              // the candidate it built: it is found by number, not by commit.
              expect(parameters).toMatchObject({
                workflow_id: "release.yml",
                branch: "main",
              });
              // INF-2259: automatic workflow_run alphas and manual candidates
              // share the same run-number namespace and remain promotable.
              expect(parameters.event).toBeUndefined();
              expect(parameters.head_sha).toBeUndefined();
              const other = {
                id: 99,
                head_sha: "d".repeat(40),
                run_number: 14,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/example/project/actions/runs/99",
              };
              if (scenario === "missing alpha run") return [other];
              return [
                other,
                {
                  id: 123,
                  head_sha: "e".repeat(40),
                  run_number: 13,
                  status: "completed",
                  conclusion: scenario === "failed alpha run" ? "failure" : "success",
                  html_url: url,
                },
              ];
            }
            expect(parameters.filter).toBe("latest");
            if (parameters.run_id === mainRun.id) return mainJobs;
            if (parameters.run_id === batchRun.id) return batchJobs;
            expect(parameters.run_id).toBe(123);
            return jobs;
          },
        },
        { repo: { owner: "example", repo: "project" } },
        {
          env: {
            CHANNEL: scenario === "alpha" ? "alpha" : "stable",
            PROMOTED_FROM:
              scenario === "alpha" || scenario === "stable rehearsal without promotion"
                ? ""
                : "1.2.3-alpha.13",
            SOURCE_COMMIT: source,
            GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)),
          },
        },
        createRequire(import.meta.url),
      );
      const inherited = scenario.startsWith("eligible stable");
      const refused =
        !inherited && !["alpha", "stable rehearsal without promotion"].includes(scenario);
      expect(outputs.required, scenario).toBe(inherited ? "false" : "true");
      expect(outputs.alpha_run, scenario).toBe(inherited ? url : "");
      expect(summaries.length, scenario).toBe(inherited ? 1 : 0);
      if (inherited) expect(summaries[0]).toContain("omitted, not passed here");
      if (journeysOnly && inherited)
        expect(summaries[0]).toContain(`every journey in its run ${url}, the rest in ${mainUrl}`);
      if (reusedEvery && inherited)
        expect(summaries[0]).toContain(
          `in ${swept ? batchRun.html_url : mainUrl}, which its run ${url} reused`,
        );
      expect(failures.length, scenario).toBe(refused ? 1 : 0);
      if (refused) expect(failures[0]).toContain("Alpha 1.2.3-alpha.13 cannot be promoted");
      console.log(
        JSON.stringify({
          scenario,
          verification: outputs.required === "true" ? ["linux-checks", "linux-e2e", "mac"] : [],
          alphaRun: outputs.alpha_run,
          refused: failures,
        }),
      );
    }
  });
});
