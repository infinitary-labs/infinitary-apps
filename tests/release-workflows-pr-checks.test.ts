import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it, vi } from "vitest";
import { laneOf } from "../scripts/journey-budget.ts";
import vitestConfig from "../vitest.config";
import {
  type CiJob,
  ciJobs,
  loadCi,
  loadYamlFile,
  root,
  type WorkflowStep as Step,
  verifyLinuxTests,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The pull request's checks and main's sweep jobs (ci.yml). */

describe("local packaging identity (electron-builder.dev.yml)", () => {
  /**
   * Captain: "ok move it too but as a separate task" extends INF-2224
   * to probes: retain the real PR gates, move all full sweeps to main.
   * Exercise the actual job condition with GitHub's expression evaluator,
   * including a release's own notes pull request, rather than looking for a
   * string. No upstream jobs: the implicit success() condition is true here.
   */
  // Captain's pick from INF-2588: a request checks code and build only unless
  // it asks for the sweep, so a lint before a pull request costs no sweep.
  it("starts no test sweep on a request that does not ask for it", () => {
    const names = ciJobs("workflow_dispatch", false).map((job) => job.id);
    expect(names).toEqual(["typecheck-lint-build"]);
  });

  it.each([
    ["requested full sweep", "workflow_dispatch", "", "refs/heads/fm/task-ci-contract"],
    ["ordinary proposal", "pull_request", "fm/task-ci-contract", "refs/pull/42/merge"],
    ["release notes and record", "pull_request", "fm/task-release-alpha", "refs/pull/471/merge"],
  ])("runs the real Linux gate for %s", (_name, eventName, headRef, ref) => {
    const ci = loadCi();
    // The event must reach every job, not disappear behind a branch/path filter.
    expect(ci.on).toHaveProperty("pull_request", null);
    // INF-2340 (captain's route "drop-ci-main"): a push to main starts none of
    // these jobs, since main.yml's full check runs the same commands.
    expect(Object.keys(ci.on).toSorted()).toEqual(["pull_request", "workflow_dispatch"]);
    const github = new data.Dictionary(
      { key: "event_name", value: new data.StringData(eventName) },
      { key: "head_ref", value: new data.StringData(headRef) },
      { key: "base_ref", value: new data.StringData(eventName === "pull_request" ? "main" : "") },
      { key: "ref", value: new data.StringData(ref) },
    );
    const gate = ci.jobs["typecheck-lint-build"]?.steps ?? [];
    // INF-2414 (captain: "why can't we catch release note problems before
    // merge?"): the pull request's notes step (docs/release-notes.md, "The
    // release check").
    const notes = gate.find((step) =>
      step.run?.startsWith("node scripts/release-notes.ts change "),
    );
    expect(notes).toBeDefined();
    // INF-2915's plan: the paths step decides the build, the browser tests
    // and the critical path (scripts/pr-paths.ts).
    const paths = gate.find((step) => step.id === "paths");
    expect(paths?.run).toBe("node scripts/pr-paths.ts --base HEAD^1");
    // INF-2441 (captain's choice: "Run the tests that read each changed file
    // inside the pull request's build check"): the pull request's round of
    // the unit and integration tests that read a changed file (docs/testing.md).
    const reach = gate.find((step) =>
      step.run?.startsWith("node scripts/unit-repeats.ts --reach "),
    );
    expect(reach).toBeDefined();
    // INF-2505, gated by INF-2915's plan: the browser project in the build
    // check, after installing the Chromium it draws in.
    const chromium = gate.find((step) => step.uses === "./.github/actions/browser-chromium");
    const browser = gate.find((step) => step.run === "pnpm test --project browser");
    expect(chromium).toBeDefined();
    expect(browser).toBeDefined();
    // INF-2915's plan: the build skips on a light version, and the critical
    // path runs inside the build check on the app it built.
    // The adherence lint runs on a request, as in main's check, never on a
    // pull request (INF-2915's plan).
    const adherence = gate.find((step) => step.run === "pnpm lint:adherence");
    expect(adherence).toBeDefined();
    const build = gate.find((step) => step.run === "pnpm build");
    const desktop = gate.find((step) => step.uses === "./.github/actions/linux-desktop");
    const criticalPath = gate.find((step) => step.id === "critical-path");
    const skips = gate.find((step) => step.run?.startsWith("node scripts/untagged-skips.ts "));
    const evidence = gate.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    for (const step of [build, desktop, criticalPath, skips, evidence]) expect(step).toBeDefined();
    const gated = [notes, paths, reach, chromium, browser, adherence, build, desktop];
    gated.push(criticalPath, skips);
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.needs, id).toBeUndefined();
      const expression = (job.if ?? "true").replace(/^\$\{\{\s*|\s*\}\}$/g, "");
      const ast = new Parser(new Lexer(expression).lex().tokens, ["github", "inputs"], []).parse();
      const eligible = new Evaluator(
        ast,
        new data.Dictionary(
          { key: "github", value: github },
          {
            key: "inputs",
            value: new data.Dictionary({
              key: "sweep",
              value: new data.BooleanData(_name === "requested full sweep"),
            }),
          },
        ),
      );
      const fullSweep = id === "unit-tests" || id === "integration-tests" || id === "probe-tests";
      expect(eligible.evaluate().coerceString(), id).toBe(
        fullSweep && eventName === "pull_request" ? "false" : "true",
      );
      // A no-op success would not solve the problem: keep the real gate and
      // fail on any gate step's failure, without step-level skips beyond the
      // gate's pull request and changed-path steps and the critical path's
      // failure evidence.
      // INI-9's plan: every job runs where LINUX_RUNNER sends it, the
      // placement service's shell-pc-linux places, and back on GitHub's
      // hosted Linux when the variable is unset.
      expect(workflowString(job["runs-on"], { vars: {} }), id).toBe("ubuntu-24.04");
      expect(workflowString(job["runs-on"], { vars: { LINUX_RUNNER: "shell-pc-linux" } }), id).toBe(
        "shell-pc-linux",
      );
      expect(job["continue-on-error"], id).toBeFalsy();
      expect(
        job.steps.every(
          (step) =>
            !step["continue-on-error"] && (gated.includes(step) || step === evidence || !step.if),
        ),
        id,
      ).toBe(true);
    }
    // INF-2915's plan: the critical path is a step of the build check, so
    // ci.yml calls no other workflow.
    expect(Object.keys(ci.calls)).toEqual([]);
    // Every machine installs from the lockfile before it runs anything but a
    // pull request's notes and paths steps, plain Node that needs no install
    // and reads the base parent its checkout fetched; a requested full sweep
    // has no pull request to compare, and release.yml's notes job covers each
    // change on main. The jobs together run each check once: a pull request
    // runs the unit tests that read its changed files in the gate, where no
    // unit sweep runs, and a requested sweep runs none there; the sweeps are
    // the next case's.
    const install = "pnpm install --frozen-lockfile";
    const machines = ciJobs(eventName);
    for (const { id, name, runs } of machines)
      expect(runs.slice(0, runs.indexOf(install) + 1), name).toEqual(
        eventName === "pull_request" && id === "typecheck-lint-build"
          ? [notes?.run, paths?.run, install]
          : [install],
      );
    const checks = machines
      .flatMap(({ runs }) => runs.slice(runs.indexOf(install) + 1))
      .filter((run) => !run.startsWith("pnpm test"));
    expect(checks.toSorted()).toEqual(
      [
        "pnpm build",
        "pnpm check",
        "pnpm typecheck",
        ...(eventName === "pull_request"
          ? [reach?.run, criticalPath?.run, skips?.run]
          : ["pnpm lint:adherence"]),
      ].toSorted(),
    );
    // The browser project runs once: in a pull request's gate, and in a
    // requested sweep's unit-tests, whose gate runs none.
    const browserRuns = machines.flatMap(({ id, runs }) =>
      runs.filter((run) => /^pnpm test .*--project browser\b/.test(run)).map(() => id),
    );
    expect(browserRuns).toEqual([
      eventName === "pull_request" ? "typecheck-lint-build" : "unit-tests",
    ]);
  });

  // INF-2915's plan, the captain's direction B with the light profile: the
  // paths step's two verdicts decide what the pull request's gate runs past
  // its code checks and the unit and integration tests that read a changed
  // file, which every version runs.
  it.each([
    [{ build: true, browser: true }, ["build", "browser", "critical path"]],
    [{ build: true, browser: false }, ["build", "critical path"]],
    [{ build: false, browser: true }, ["browser"]],
    [{ build: false, browser: false }, []],
  ])("runs only what the paths step decided for %j", (paths, expected) => {
    const [gate] = ciJobs("pull_request", false, paths);
    const runs = gate?.runs ?? [];
    const ran = [
      runs.includes("pnpm build") && "build",
      runs.includes("pnpm test --project browser") && "browser",
      runs.some((run) => run.includes("--files tests/e2e/critical-path.spec.ts")) &&
        "critical path",
    ].filter(Boolean);
    expect(ran).toEqual(expected);
    for (const always of ["pnpm typecheck", "pnpm check"]) expect(runs).toContain(always);
    expect(runs.some((run) => run.startsWith("node scripts/unit-repeats.ts --reach "))).toBe(true);
  });

  // INF-2915's plan: the startup fixtures, which caught nothing on 504 pull
  // request runs, leave the pull request; main's check runs them once per
  // push on hosted Ubuntu (linux-startup.yml, docs/testing.md "Linux
  // automatic startup fixtures").
  it("runs the Linux startup fixtures in main's check, not on a pull request", () => {
    const ci = loadCi();
    const fixtures = (job: CiJob) =>
      job.steps.some((step) => step.uses === "./.github/actions/linux-startup");
    expect(Object.values(ci.jobs).filter(fixtures)).toEqual([]);
    const main = loadYamlFile(".github/workflows/main.yml") as {
      jobs: Record<string, { uses?: string }>;
    };
    expect(Object.values(main.jobs).map((job) => job.uses)).toContain(
      "./.github/workflows/linux-startup.yml",
    );
  });

  /**
   * INF-2480's plan (captain: "path six-steps (launch, sign in, project,
   * first mate, crewmate card, merge)", done when "One desktop journey walks
   * the chosen path on Linux on every pull request"), INF-2507, and
   * INF-2915's plan (the captain's direction B: "the critical path inside
   * the build job"): every pull request that builds the app runs the
   * critical-path journey in the desktop lane, in the build check after the
   * build, on the Linux desktop the source desktop workflow prepares the
   * same way.
   */
  it("runs the critical-path journey inside the build check after the build", () => {
    const job = loadCi().jobs["typecheck-lint-build"];
    const steps = job?.steps ?? [];
    const at = (find: (step: Step) => boolean) => steps.findIndex(find);
    const build = at((step) => step.run === "pnpm build");
    const desktop = at((step) => step.uses === "./.github/actions/linux-desktop");
    const journey = at((step) => step.id === "critical-path");
    expect(build).toBeGreaterThan(-1);
    expect(desktop).toBeGreaterThan(build);
    expect(journey).toBeGreaterThan(desktop);
    const step = steps[journey];
    const file = "tests/e2e/critical-path.spec.ts";
    expect(existsSync(join(root, file))).toBe(true);
    expect(laneOf(file)).toBe("desktop");
    // The pull request's merge commit against its base parent: an edit to
    // the journey runs it three rounds and alone (scripts/journey-runs.ts).
    expect(step?.run).toBe(
      `scripts/on-screen.sh node scripts/journey-runs.ts --base HEAD^1 --files ${file} --alone-out playwright-report/alone -- --project=desktop`,
    );
    const checkout = steps.find((candidate) => candidate.uses === "actions/checkout@v4");
    expect(checkout?.with?.["fetch-depth"]).toBe(2);
    // Every pull request version that builds the app, and no request.
    for (const [event, built, runs] of [
      ["pull_request", "true", true],
      ["pull_request", "false", false],
      ["workflow_dispatch", "", false],
    ] as const) {
      const contexts = {
        github: { event_name: event },
        steps: { paths: { outputs: { build: built } } },
      };
      expect(workflowValue(steps[desktop]?.if ?? "true", contexts), `${event} ${built}`).toBe(runs);
      expect(workflowValue(step?.if ?? "true", contexts), `${event} ${built}`).toBe(runs);
    }
    // The source desktop workflow prepares its desktop through the same action.
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    expect(
      source.jobs["source-desktop"].steps.filter((candidate) =>
        candidate.uses?.endsWith("/.github/actions/linux-desktop"),
      ),
    ).toHaveLength(1);
  });

  // DOP-66 fix 1: the rebuilt shell PC image owns the pnpm store;
  // hosted runners still need setup-node's cache. DOP-251's plan: a job
  // LINUX_QUEUES sends to a self-hosted queue, such as the Mac mini's Linux
  // guests whose image bakes the store, restores no cache even while
  // LINUX_RUNNER is unset, so the cache follows the machine, not a variable.
  // Evaluate the real inputs of every Linux job that installs.
  it.each([
    ["hosted Linux", "github-hosted", {}, "pnpm"],
    // INF-2430's plan, piece 1: main's and a release's Linux jobs run hosted
    // while LINUX_RUNNER names the PC, and keep the cache.
    [
      "hosted Linux while LINUX_RUNNER is set",
      "github-hosted",
      { LINUX_RUNNER: "shell-pc-linux" },
      "pnpm",
    ],
    ["shell PC", "self-hosted", { LINUX_RUNNER: "shell-pc-linux" }, ""],
    ["a LINUX_QUEUES queue", "self-hosted", { LINUX_QUEUES: '{"ci":"mini-linux"}' }, ""],
  ])("selects the pnpm cache for %s", (_name, environment, vars, expected) => {
    const installs: string[] = [];
    for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
      name.endsWith(".yml"),
    )) {
      const { jobs } = loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, CiJob> };
      for (const [id, job] of Object.entries(jobs)) {
        if (!job.steps?.some((step) => step.run?.startsWith("pnpm install"))) continue;
        const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
        const cache = setup?.with?.cache;
        // A literal cache belongs to a Mac job, which runs on its own rules.
        if (typeof cache !== "string" || !cache.includes("${{")) continue;
        installs.push(`${file}:${id}`);
        const contexts = { vars, runner: { environment }, matrix: { lane: "linux-checks" } };
        expect(workflowString(cache, contexts), `${file}:${id}`).toBe(expected);
      }
    }
    expect(installs).toEqual(
      expect.arrayContaining([
        "ci.yml:typecheck-lint-build",
        "ci.yml:unit-tests",
        "ci.yml:integration-tests",
        "ci.yml:probe-tests",
        "replay.yml:replay-gate",
        "verify.yml:lane",
        "verify.yml:linux-tests",
        "linux-packages.yml:build",
        "linux-packages.yml:check",
        "source-journeys.yml:source-desktop",
        "journeys.yml:choose-journeys",
      ]),
    );
  });

  /**
   * FI3-1204 / INF-2224: main runs full sweeps on several machines at once, and
   * split it must still run every test: each vitest project in exactly one
   * job, or in shards of one count that together cover it. The captain
   * explicitly includes every probe, not just affected files.
   */
  const vitestProjects = () => {
    const projects = (vitestConfig.test?.projects ?? []).map((project) => {
      const name =
        typeof project === "object" && "test" in project ? project.test?.name : undefined;
      if (typeof name !== "string") throw new Error("every vitest project is named");
      return name;
    });
    expect(projects).toEqual(
      expect.arrayContaining(["pure", "unit", "unit-isolated", "integration", "probe"]),
    );
    return projects;
  };
  /** Each vitest project's shards across the jobs' `pnpm test` commands, "whole" for an unsharded run. */
  const vitestShards = (jobs: { name: string; runs: string[] }[], projects: string[]) => {
    const shardsOf = new Map<string, string[]>();
    for (const { name, runs } of jobs) {
      for (const run of runs) {
        const [tool, script, ...args] = run.split(/\s+/);
        if (tool !== "pnpm" || script !== "test") continue;
        const selected: string[] = [];
        let shard = "whole";
        for (let index = 0; index < args.length; index++) {
          const arg = args[index] ?? "";
          if (arg === "--project") selected.push(args[++index] ?? "");
          else if (arg.startsWith("--shard=")) shard = arg.slice("--shard=".length);
          else throw new Error(`${name} passes vitest an argument this check cannot read: ${arg}`);
        }
        for (const project of selected.length > 0 ? selected : projects) {
          shardsOf.set(project, [...(shardsOf.get(project) ?? []), shard]);
        }
      }
    }
    return shardsOf;
  };
  /** Whether a project's shards are one whole run, or each part of one count once. */
  const coversOnce = (shards: string[]) => {
    const whole = shards.length === 1 && shards[0] === "whole";
    const cover = shards.map((_, index) => `${index + 1}/${shards.length}`);
    return whole || shards.toSorted().join() === cover.toSorted().join();
  };

  it("runs every vitest project once across ci.yml's sweep jobs, a sharded one in shards that cover it", () => {
    const projects = vitestProjects();
    const shardsOf = vitestShards(ciJobs("workflow_dispatch"), projects);
    expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
    expect(shardsOf.get("probe")).toEqual(["whole"]);
    for (const [project, shards] of shardsOf) expect(coversOnce(shards), project).toBe(true);
  });

  /**
   * INF-2646 (the captain approved INF-2641's split of main's Linux tests
   * across GitHub's hosted machines): verify.yml's Linux test groups run every
   * vitest project, each in one group or in shards of one count that
   * together cover it, every probe included, so the split loses no file.
   * Each group is a machine of its own, and one red group skips no other.
   */
  it("runs every vitest project once across verify.yml's Linux test groups, a sharded one in shards that cover it", () => {
    const projects = vitestProjects();
    for (const inputs of [{}, { part: "checks", hosted: true, all_journeys: false }]) {
      const groups = verifyLinuxTests(inputs);
      expect(groups.map(({ name }) => name)).toEqual([
        "Manual request · Unit tests (Linux; group 1/3)",
        "Manual request · Unit tests (Linux; group 2/3)",
        "Manual request · Unit tests (Linux; group 3/3)",
        "Manual request · Integration tests (Linux; group 1/2)",
        "Manual request · Integration tests (Linux; group 2/2)",
        "Manual request · Environment checks (Linux; group 1/2)",
        "Manual request · Environment checks (Linux; group 2/2)",
        "Manual request · Browser tests (Linux)",
      ]);
      const shardsOf = vitestShards(groups, projects);
      expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
      for (const [project, shards] of shardsOf) expect(coversOnce(shards), project).toBe(true);
      // Every probe, in two groups that cover them, never a changed-path selection.
      expect(shardsOf.get("probe")?.toSorted()).toEqual(["1/2", "2/2"]);
      // The browser group installs its Chromium before its tests.
      const browser = groups.find(({ name }) => name.includes("Browser tests"))?.steps ?? [];
      const chromium = browser.findIndex(({ uses }) =>
        uses?.endsWith("/.github/actions/browser-chromium"),
      );
      expect(chromium).toBeGreaterThanOrEqual(0);
      expect(browser.findIndex(({ run }) => run?.startsWith("pnpm test "))).toBeGreaterThan(
        chromium,
      );
    }
    // The journeys part, and an installer check, run none of them.
    expect(verifyLinuxTests({ part: "journeys" })).toEqual([]);
    expect(verifyLinuxTests({ installer_only: true })).toEqual([]);
    expect(verifyLinuxTests({ installer_reuse: "reviewed declaration" })).toEqual([]);
    const job = (loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, CiJob> })
      .jobs["linux-tests"];
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    // Each group's test step keeps the full check's 60-minute limit.
    const test = job?.steps.find((step) => step.run?.startsWith("pnpm test "));
    expect(test?.["timeout-minutes"]).toBe(60);
  });
});
