import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import type { PlaywrightTestConfig } from "@playwright/test";
import type {
  JSONReport,
  JSONReportError,
  JSONReportSpec,
  JSONReportTest,
  JSONReportTestResult,
} from "@playwright/test/reporter";
import { describe, expect, it, vi } from "vitest";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import {
  firstTry,
  loadYamlFile,
  read,
  root,
  type WorkflowStep as Step,
  VERIFY_E2E_RUN,
  workflowString,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The full check's Mac lanes: their stages, their evidence and the signing proof (verify.yml). */

describe("local packaging identity (electron-builder.dev.yml)", () => {
  /** verify.yml's lanes: the Linux checks and, since INF-2779, three Mac jobs; on GitHub's
   * Macs the parallel journeys are four jobs, parallel-1 to parallel-4. */
  type Lane = "linux-checks" | "mac" | (typeof JOURNEY_LANES)[number];
  const JOURNEY_LANES = [
    "parallel",
    "parallel-1",
    "parallel-2",
    "parallel-3",
    "parallel-4",
    "desktop-1",
    "desktop-2",
  ] as const;
  /**
   * Whether Actions runs a step in a lane (the mac lane unless named) once
   * the earlier steps ended with these outcomes: its condition through
   * GitHub's own evaluator, with the status functions the job's state gives,
   * and a condition naming none of them runs only on success(). The call
   * names its part (INF-2480), the whole check unless named.
   */
  const stepRuns = (
    step: Step | undefined,
    outcomes: Record<string, string>,
    lane: Lane = "mac",
    part: "all" | "checks" | "journeys" = "all",
  ) => {
    const failed = Object.values(outcomes).includes("failure");
    const status: Array<[string, boolean]> = [
      ["success", !failed],
      ["failure", failed],
      ["always", true],
      ["cancelled", false],
    ];
    const functions = status.map(([name, value]) => ({
      name,
      minArgs: 0,
      maxArgs: 0,
      call: () => new data.BooleanData(value),
    }));
    const condition = (step?.if ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "") || "true";
    const expression = /\b(success|failure|always|cancelled)\(\)/.test(condition)
      ? condition
      : `success() && (${condition})`;
    const ast = new Parser(
      new Lexer(expression).lex().tokens,
      ["steps", "matrix", "inputs"],
      functions,
    ).parse();
    const steps = new data.Dictionary(
      ...Object.entries(outcomes).map(([id, outcome]) => ({
        key: id,
        value: new data.Dictionary({ key: "outcome", value: new data.StringData(outcome) }),
      })),
    );
    const matrix = new data.Dictionary({ key: "lane", value: new data.StringData(lane) });
    const inputs = new data.Dictionary({ key: "part", value: new data.StringData(part) });
    const context = new data.Dictionary(
      { key: "steps", value: steps },
      { key: "matrix", value: matrix },
      { key: "inputs", value: inputs },
    );
    const evaluator = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f])));
    return evaluator.evaluate().coerceString() === "true";
  };

  /**
   * Runs verify's Summarize step as Actions would (bash -e, the stages'
   * outcomes filled in) in a lane's checked-out workspace holding the files
   * `write` names, by their path in the working copy.
   */
  const summarizeRun = (
    summarize: Step | undefined,
    lane: Lane,
    outcomes: Record<string, string>,
    write?: (dir: string) => Record<string, unknown>,
  ) => {
    const stages = summarize?.env?.STAGES ?? "";
    const git = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const workspace = scratchDir("infinitary-verify-summary-");
    const identity = ["-c", "user.name=verify", "-c", "user.email=verify@localhost"];
    execFileSync("git", ["init", "-q", workspace], { env: git });
    execFileSync(
      "git",
      ["-C", workspace, ...identity, "commit", "-q", "--allow-empty", "-m", "c"],
      {
        env: git,
      },
    );
    for (const [path, contents] of Object.entries(write?.(workspace) ?? {})) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), JSON.stringify(contents));
    }
    const summary = join(workspace, "summary.md");
    const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", summarize?.run ?? ""], {
      cwd: workspace,
      env: {
        ...git,
        REQUESTED: "refs/heads/main",
        LANE: lane,
        STAGES: stages.replace(
          /\$\{\{ steps\.([\w-]+)\.outcome \}\}/g,
          (_, id: string) => outcomes[id] ?? "skipped",
        ),
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const sha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: git,
    }).trim();
    return { sha, summary: readFileSync(summary, "utf8") };
  };

  /**
   * A red verify has to be readable where it ran (scout
   * fm3000-e2e-rigidity-s2, I5; docs/testing.md "A red verify's
   * evidence"): the suite keeps zero retries and captures a failed journey
   * itself, and verify keeps Playwright's JSON result whenever the suite
   * ran and the result directories when it failed, for a bounded time -
   * neither upload able to fail the job, nor running when an earlier stage
   * kept e2e from starting. The summary reports; it never gates.
   */
  it("keeps a red e2e run's evidence without a retry, a secret or a new gate", async () => {
    // The config as Playwright loads it (no tsconfig project lists the file).
    const config = (
      (await import(join(root, "playwright.config.ts"))) as { default: PlaywrightTestConfig }
    ).default;
    expect(config.retries ?? 0).toBe(0);
    expect(config.use).toMatchObject({ trace: "retain-on-failure", screenshot: "only-on-failure" });
    const reporters = Array.isArray(config.reporter) ? config.reporter : [];
    // Inside GitHub Actions the github reporter also names each failure in
    // the check's summary (docs/testing.md, "A failed check says why").
    expect(reporters.map(([name]) => name)).toEqual([
      process.env.CI ? "dot" : "list",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github"] : []),
      "json",
    ]);
    // Each local run keeps its JSON result beside its result directories
    // (tests/e2e/runEvidence.ts); verify names the fixed path it keeps.
    const json = reporters.find(([name]) => name === "json")?.[1] as { outputFile?: string };
    expect(json?.outputFile ?? "").not.toBe("");

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: {
        lane: { steps: Step[] };
        installer: { uses: string; secrets?: unknown };
      };
    };
    const steps = verify.jobs.lane.steps;
    const e2e = steps.findIndex((step) => step.id === "e2e");
    // Half the job's cores: the Mac's runner slots share its processor (INF-741, INF-2112).
    expect(steps[e2e]?.run).toBe(VERIFY_E2E_RUN);
    const result = steps[e2e]?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "";
    expect(result).not.toBe("");
    const upload = (path: string) =>
      steps.find(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact@") &&
          step.with?.path === `Application Support/firstmate/${path}`,
      );
    const kept = upload(result);
    const failures = upload("test-results/");
    const demos = upload("test-results/runs/*/*/demo/");
    const runsAfter = (step: Step | undefined, e2eOutcome: string, lane: Lane) =>
      stepRuns(step, { e2e: e2eOutcome }, lane);
    const outcomes = ["success", "failure", "skipped"];
    // Each journey job keeps its own result and evidence, under a name of its
    // own so no two jobs' uploads meet (INF-2779).
    for (const lane of JOURNEY_LANES) {
      expect(outcomes.map((outcome) => runsAfter(kept, outcome, lane))).toEqual([
        true,
        true,
        false,
      ]);
      expect(outcomes.map((outcome) => runsAfter(failures, outcome, lane))).toEqual([
        false,
        true,
        false,
      ]);
    }
    const named = (step: Step | undefined, lane: Lane) =>
      workflowString(String(step?.with?.name ?? ""), {
        matrix: { lane },
        inputs: { all_journeys: true },
      });
    for (const step of [kept, failures])
      expect(new Set(JOURNEY_LANES.map((lane) => named(step, lane))).size).toBe(7);
    // A requested demo is kept whether the suite passed or failed, by the
    // desktop job, where the journeys that record one run (tests/e2e/lanes.ts).
    expect(outcomes.map((outcome) => runsAfter(demos, outcome, "desktop-1"))).toEqual([
      true,
      true,
      false,
    ]);
    for (const lane of ["parallel", "parallel-1"] as const)
      expect(outcomes.map((outcome) => runsAfter(demos, outcome, lane))).toEqual([
        false,
        false,
        false,
      ]);
    for (const step of [kept, failures, demos]) {
      expect(step?.with?.["if-no-files-found"]).toBe("ignore");
      expect(Number(step?.with?.["retention-days"])).toBeGreaterThan(0);
      expect(Number(step?.with?.["retention-days"])).toBeLessThanOrEqual(30);
      // Right after the suite: no later stage stands between it and them.
      expect(steps.indexOf(step as Step) - e2e).toBeGreaterThan(0);
      expect(steps.indexOf(step as Step) - e2e).toBeLessThanOrEqual(3);
    }
    // The graded perf rerun writes its own result, never over the suite's.
    const perf = steps.find((step) => step.id === "perf")?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE;
    expect(perf).toBeTruthy();
    expect(perf).not.toBe(result);
    // No verification job names a credential: the signed-installer call hands
    // its secrets on, so its job reads its own environment's credentials
    // (docs/public-ci.md, "Release environments").
    expect(JSON.stringify(verify)).not.toContain("secrets.");
    expect(verify.jobs.installer.uses).toBe("./.github/workflows/mac-installer.yml");
    expect(verify.jobs.installer.secrets).toBe("inherit");
    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { verify: Record<string, unknown> };
    };
    expect(release.jobs.verify.secrets).toBeUndefined();

    const summarize = steps.find((step) => step.name === "Summarize");
    expect(summarize).toMatchObject({
      if: "always() && matrix.lane != 'linux-checks'",
      "continue-on-error": true,
    });
    expect(summarize?.run).toContain(result);
    // Every stage the job names is reported, by its own outcome, in the job's order.
    // A checkout is named only for its second try (tests/workflow-hygiene.test.ts).
    const stages = summarize?.env?.STAGES ?? "";
    const reported = [...stages.matchAll(/([\w-]+)=\$\{\{ steps\.([\w-]+)\.outcome \}\}/g)];
    expect(reported.map(([, name, id]) => (name === id ? id : `${name}!=${id}`))).toEqual(
      steps.flatMap((step) =>
        step.id && !step.uses?.startsWith("actions/checkout@") ? [step.id] : [],
      ),
    );

    // A red suite: the failures listed by when they started, not by file order.
    const outcome = (
      status: "passed" | "failed" | "skipped",
      startTime: string,
      error?: JSONReportError,
    ): JSONReportTestResult => ({
      workerIndex: 0,
      parallelIndex: 0,
      status,
      duration: 1,
      error: error ? { message: error.message } : undefined,
      errors: error ? [error] : [],
      stdout: [],
      stderr: [],
      retry: 0,
      startTime,
      attachments: [],
      annotations: [],
    });
    const spec = (
      title: string,
      line: number,
      status: JSONReportTest["status"],
      results: JSONReportTestResult[],
    ): JSONReportSpec => ({
      tags: [],
      title,
      ok: status !== "unexpected",
      id: title,
      file: "rows.spec.ts",
      line,
      column: 1,
      tests: [
        {
          timeout: 60_000,
          annotations: [],
          expectedStatus: "passed",
          projectName: "desktop",
          projectId: "desktop",
          results,
          status,
        },
      ],
    });
    const red = (dir: string): Pick<JSONReport, "stats" | "suites" | "errors"> => ({
      stats: {
        startTime: "2026-09-30T00:00:00.000Z",
        duration: 9,
        expected: 1,
        unexpected: 2,
        flaky: 0,
        skipped: 1,
      },
      errors: [],
      suites: [
        {
          title: "rows.spec.ts",
          file: "rows.spec.ts",
          line: 0,
          column: 0,
          specs: [],
          suites: [
            {
              title: "the rows",
              file: "rows.spec.ts",
              line: 3,
              column: 1,
              specs: [
                spec("paints", 5, "expected", [outcome("passed", "2026-09-30T00:00:01.000Z")]),
                spec("moves", 20, "unexpected", [
                  outcome("failed", "2026-09-30T00:00:03.000Z", {
                    message: "Error: expect(locator).toBeVisible() failed",
                  }),
                ]),
                spec("docks", 12, "unexpected", [
                  outcome("failed", "2026-09-30T00:00:02.000Z", {
                    message:
                      "\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 2",
                    location: {
                      file: join(realpathSync(dir), "tests/e2e/rows.spec.ts"),
                      line: 14,
                      column: 5,
                    },
                  }),
                ]),
                spec("folds", 30, "skipped", []),
              ],
            },
          ],
        },
      ],
    });
    const failed = summarizeRun(
      summarize,
      "desktop-1",
      { install: "success", build: "success", recorder: "success", e2e: "failure" },
      (dir) => ({ [result]: red(dir) }),
    );
    expect(failed.summary).toContain(`\`refs/heads/main\` at \`${failed.sha}\``);
    expect(failed.summary).toContain("First failed stage: **e2e**.");
    expect(failed.summary).toContain("E2E: 1 passed, 2 failed, 0 flaky, 1 skipped or not run.");
    expect(failed.summary).toContain(
      "First to fail: **the rows › docks** (`rows.spec.ts:12`, desktop), at `tests/e2e/rows.spec.ts:14`",
    );
    expect(failed.summary).toContain(
      "```\nError: expect(received).toBe(expected)\n\nExpected: 2\n```",
    );
    expect(failed.summary).toContain(
      "- `rows.spec.ts:12` the rows › docks (desktop)\n- `rows.spec.ts:20` the rows › moves (desktop)",
    );

    // A failed stage is named, and an e2e suite that left no result claims none.
    const early = summarizeRun(summarize, "parallel", { install: "success", build: "failure" });
    expect(early.summary).toContain("First failed stage: **build**.");
    expect(early.summary).toContain("No e2e result: the suite did not run to its end.");
    // The native job runs no journeys, so its summary claims no e2e result either way.
    const native = summarizeRun(summarize, "mac", { install: "success", unit: "failure" });
    expect(native.summary).toContain("First failed stage: **unit**.");
    expect(native.summary).not.toContain("e2e result");
  });

  /**
   * INF-663 (the captain asked whether the full check discovers every
   * failure or only the first): each stage waits only on the stages it
   * needs, so a red unit test no longer skips the e2e suite, the client
   * check, the replay gate or the package smoke. The job still ends red on
   * any failure, so release.yml still refuses to sign ("signs only after
   * full verification", below). INF-2779 (the captain's three Mac jobs):
   * each stage runs in exactly one of them, so none is lost or run twice.
   */
  it("runs each stage when its own inputs passed, whatever else failed, and still ends red", () => {
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const stage = (id: string) => steps.find((step) => step.id === id);
    const ids = steps.flatMap((step) => (step.id ? [step.id] : []));
    const macLanes: Lane[] = ["mac", ...JOURNEY_LANES];
    const native: Lane[] = ["mac"];
    const needs: Record<string, { lanes: Lane[]; inputs: string[] }> = {
      unit: { lanes: native, inputs: ["install"] },
      // Every Mac job builds its own app: the build takes seconds (INF-724).
      build: { lanes: macLanes, inputs: ["install"] },
      // INF-2987: the mac job runs a group of the parallel lanes' journeys too.
      recorder: { lanes: macLanes, inputs: ["install"] },
      e2e: { lanes: macLanes, inputs: ["build", "recorder"] },
      "claude-client": { lanes: native, inputs: ["install"] },
      replay: { lanes: native, inputs: ["install"] },
      "dev-signing": { lanes: native, inputs: ["install"] },
      package: { lanes: native, inputs: ["build", "dev-signing"] },
      codesign: { lanes: native, inputs: ["package"] },
      "data-folder": { lanes: native, inputs: ["package"] },
      "bundled-git": { lanes: native, inputs: ["package"] },
      helper: { lanes: native, inputs: ["package"] },
    };
    const upstream = (id: string): string[] =>
      (needs[id]?.inputs ?? []).flatMap((input) => [input, ...upstream(input)]);
    const green = Object.fromEntries(ids.map((id) => [id, "success"]));
    for (const [id, { lanes, inputs }] of Object.entries(needs)) {
      expect(
        macLanes.filter((lane) => stepRuns(stage(id), green, lane)),
        `${id}'s Mac jobs`,
      ).toEqual(lanes);
      for (const lane of lanes) {
        // Every earlier stage it does not stand on failed: it still runs.
        const earlier = ids.slice(0, ids.indexOf(id));
        const unrelatedRed = Object.fromEntries(
          earlier.map((other) => [other, upstream(id).includes(other) ? "success" : "failure"]),
        );
        expect(
          stepRuns(stage(id), unrelatedRed, lane),
          `${id} after unrelated failures in ${lane}`,
        ).toBe(true);
        for (const input of inputs)
          for (const outcome of ["failure", "skipped"])
            expect(
              stepRuns(stage(id), { ...unrelatedRed, [input]: outcome }, lane),
              `${id} after ${input} ${outcome} in ${lane}`,
            ).toBe(false);
      }
    }

    // The failure INF-663 read on main (release run 39337627117): a red unit
    // stage skipped every later stage. Now each one runs in its own job.
    const unitRed = Object.fromEntries(
      ids.map((id) => [id, id === "unit" ? "failure" : "success"]),
    );
    const later = ids.slice(ids.indexOf("unit") + 1).filter((id) => id !== "perf");
    expect(
      later.filter(
        (id) => !(needs[id]?.lanes ?? native).every((lane) => stepRuns(stage(id), unitRed, lane)),
      ),
    ).toEqual([]);

    // The linux-checks lane the same way: a red check skips none of the others.
    const linux = steps.filter(
      (step) => step.run?.startsWith("pnpm ") && step.if?.includes("linux-checks"),
    );
    // Its tests run in verify.yml's Linux test groups, each a machine of its own.
    expect(linux.map((step) => step.run)).toEqual([
      "pnpm typecheck",
      "pnpm check",
      "pnpm lint:adherence",
    ]);
    for (const step of [...linux, stage("build")]) {
      const afterRed = { install: "success", "an earlier check": "failure" };
      expect(stepRuns(step, afterRed, "linux-checks"), step?.run).toBe(true);
      expect(stepRuns(step, { install: "failure" }, "linux-checks"), step?.run).toBe(false);
    }

    // A red stage still fails the job: only the summary, a report, may not,
    // beside a checkout, whose second try after the wait fails the job
    // (tests/workflow-hygiene.test.ts).
    expect(
      firstTry(steps)
        .filter((step) => step["continue-on-error"] && !step.uses?.startsWith("actions/checkout@"))
        .map((step) => step.name ?? step.id),
    ).toEqual(["Summarize"]);
  });

  /**
   * INF-2255 (the captain chose "Build separately" on "Keep main's full
   * coverage and separate signing proof"): where a check runs and whether it
   * proves real signing are separate. No journey route signs, whatever it
   * selects; the full check's signing proof runs in a job where no stage
   * launches the dev Electron (INF-2779), stops none of them when it fails,
   * and still ends its job red.
   */
  it("keeps the journeys off development signing and the full check's signing proof apart from them", () => {
    const signs = (step: Step) => /\bpnpm codesign:local\b/.test(step.run ?? "");
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    for (const [name, job] of Object.entries(journeys.jobs))
      expect((job.steps ?? []).filter(signs), `journeys.yml ${name}`).toEqual([]);

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const ids = steps.flatMap((step) => (step.id ? [step.id] : []));
    expect(steps.filter(signs).map((step) => step.id)).toEqual(["dev-signing"]);
    // No job launches the dev Electron once it signed it: the mac job's
    // group of journeys (INF-2987) ends before its signing stage starts.
    const stage = (id: string) => steps.find((step) => step.id === id);
    const green = Object.fromEntries(ids.map((id) => [id, "success"]));
    const lanes: Lane[] = ["linux-checks", "mac", ...JOURNEY_LANES];
    const runsIn = (id: string) => lanes.filter((lane) => stepRuns(stage(id), green, lane));
    expect(runsIn("dev-signing")).toEqual(["mac"]);
    expect(runsIn("perf")).not.toContain("mac");
    expect(runsIn("e2e")).toContain("mac");
    expect(ids.indexOf("e2e")).toBeLessThan(ids.indexOf("dev-signing"));
    // A red signing stage stops no journey stage, and skips the signed package's checks.
    const signingRed = { ...green, "dev-signing": "failure" };
    for (const lane of JOURNEY_LANES) expect(stepRuns(stage("e2e"), signingRed, lane)).toBe(true);
    expect(stepRuns(stage("package"), signingRed)).toBe(false);
    // And it still ends its job red: no signing stage may pass a failure.
    for (const id of ["dev-signing", "package", "codesign"])
      expect(stage(id)?.["continue-on-error"], id).toBeUndefined();
  });

  /**
   * The run-alone pass (docs/testing.md "Each test owns its prerequisites"):
   * each later Mac-only test of an edited spec file that shares one app runs
   * by itself on the Mac (INF-873: the rest run alone on Linux). INF-2340
   * (captain's route "alone-at-author") moved it from main's full check to
   * journeys.yml's proof of edited journeys: the Mac job hands the run-alone
   * pass the same tag as its rounds and keeps its result, and none of the
   * full check's Mac lanes runs it.
   */
  it("runs each later Mac-only test of an edited file alone with the journeys' proof, not in the full check", () => {
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    expect(verify.jobs.lane.steps.some((step) => step.run?.includes("e2e-alone"))).toBe(false);
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const steps = journeys.jobs["affected-journeys"]?.steps ?? [];
    const e2e = steps.find((step) => step.id === "e2e");
    const tag = (inputs: Record<string, unknown>) =>
      workflowString(e2e?.env?.ALONE_TAG ?? "", { inputs });
    expect(tag({}), "the Mac runs alone the tests that skip on Linux").toBe(
      `--alone-tag ${MAC_ONLY_TAG}`,
    );
    expect(tag({ mac_all: true }), "a request for every journey runs every later test alone").toBe(
      "",
    );
    const commands = (e2e?.run ?? "").split("\n").filter((line) => /journey-runs\.ts/.test(line));
    expect(commands).not.toHaveLength(0);
    const outs = commands.map(
      (command) => /--alone-out (\S+) \$ALONE_TAG -- \$ONLY$/.exec(command)?.[1],
    );
    expect(new Set(outs).size).toBe(1);
    const out = outs[0];
    expect(out, "the pass writes its result where the job keeps it").toBeTruthy();
    const kept = steps.find(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.path === `Application Support/firstmate/${out}/`,
    );
    expect(kept?.with?.name).toBe("e2e-alone-mac");
    expect(
      ["success", "failure", "skipped"].map((outcome) => stepRuns(kept, { e2e: outcome })),
    ).toEqual([true, true, false]);
  });

  it("holds one job-lifetime macOS sleep assertion for verify and signing", async () => {
    const actionPath = ".github/actions/keep-mac-awake/action.yml";
    const actionRef = "./.github/actions/keep-mac-awake";
    const action = loadYamlFile(actionPath) as {
      runs: { using: string; steps: Array<{ run?: string; shell?: string }> };
    };
    expect(action.runs.using).toBe("composite");
    const assertion = action.runs.steps.find((step) => step.run?.includes("caffeinate"));
    expect(assertion?.shell).toBe("bash");
    // One definition. Neither workflow copies the command.
    expect(read(".github/workflows/verify.yml")).not.toContain("caffeinate");
    expect(read(".github/workflows/release.yml")).not.toContain("caffeinate");

    type Step = {
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, string>;
    };
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: {
        lane: {
          defaults: { run: { "working-directory": string } };
          steps: Step[];
        };
      };
    };
    // The steps as they run when GitHub takes the job's token at every checkout.
    const mac = { ...verify.jobs.lane, steps: firstTry(verify.jobs.lane.steps) };
    expect(mac.defaults.run["working-directory"]).toBe("Application Support/firstmate");
    // The default working directory does not exist yet, so the action is
    // fetched on its own and the assertion starts before the real checkout -
    // in every lane on a Mac, all but the Linux checks (INF-2779).
    expect(mac.steps[0]).toMatchObject({ if: "matrix.lane != 'linux-checks'" });
    expect(mac.steps[1]).toMatchObject({ if: "matrix.lane != 'linux-checks'" });
    expect(mac.steps[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(mac.steps[0]?.with?.["sparse-checkout"]).toBe(".github/actions/keep-mac-awake");
    expect(mac.steps[1]?.uses).toBe(actionRef);
    expect(mac.steps[2]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
      with: { path: "Application Support/firstmate" },
    });
    const awakeAt = (steps: Step[]) => steps.findIndex((step) => step.uses === actionRef);
    expect(awakeAt(mac.steps)).toBeLessThan(
      mac.steps.findIndex((step) => step.run?.includes("pnpm test")),
    );

    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { release: { steps: Step[] } };
    };
    const signing = firstTry(release.jobs.release.steps);
    expect(signing[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(signing[1]?.uses).toBe(actionRef);
    expect(awakeAt(signing)).toBeLessThan(
      signing.findIndex((step) => step.name === "Restore Developer ID Application certificate"),
    );
    expect(awakeAt(signing)).toBeLessThan(
      signing.findIndex((step) => step.name === "Package and sign the universal app"),
    );

    // Execute the shared step as Actions would (bash -eo pipefail), in an
    // empty workspace with a stand-in caffeinate, and observe the assertion
    // and the worker it ties to. $PPID is this process, as the runner worker
    // is the parent of a job step. The step leaves the assertion in the
    // background; the shell then waits for that job, so the stand-in has
    // written its arguments by the time the shell exits - an order, not a
    // guess at how long a loaded runner takes to start it.
    const workspace = scratchDir("infinitary-runner-awake-");
    const bin = join(workspace, "bin");
    const args = join(workspace, "assertion-args");
    mkdirSync(bin);
    writeFileSync(join(bin, "caffeinate"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ASSERTION_ARGS"\n');
    chmodSync(join(bin, "caffeinate"), 0o755);
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", `${assertion?.run ?? "exit 1"}\nwait`],
      {
        cwd: workspace,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSERTION_ARGS: args },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(args, "utf8")).toBe(`-is\n-w\n${process.pid}\n`);
  });
});
