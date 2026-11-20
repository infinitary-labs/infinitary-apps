import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { codeChecksFailure } from "../scripts/batch-stop.mjs";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-4305's finding: a failed check showed only "Process completed with exit
 * code 1." in GitHub's summary, because the journeys' and the timed unit
 * groups' reporters print the reason only into the log (docs/testing.md, "A
 * failed check says why"). Each case runs the real configuration, as a check
 * inside GitHub Actions runs it, over one failing test, and reads the error
 * line GitHub turns into the summary's annotation. The last cases run the
 * merge batch's own stop steps, whose twenty failures used to bury the one
 * real failure.
 */

// One Playwright or Vitest start a case: a Mac fastest 0.6 s; docs/test-cohorts.md holds the row.
vi.setConfig({ testTimeout: 15_000 });

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...process.env, CI: "true", GITHUB_ACTIONS: "true", ...extra };
  delete out.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete out.VITEST;
  delete out.VITEST_WORKER_ID;
  delete out.VITEST_POOL_ID;
  return out;
};

it("names a failed journey's file and reason in an error line inside GitHub Actions", () => {
  const dir = scratchDir("infinitary-annotations-journey-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const testModule = join(process.cwd(), "node_modules/@playwright/test/index.mjs");
  // Named after an application suite, so the real lanes place it.
  writeFileSync(
    join(dir, "view.spec.ts"),
    `import { test, expect } from ${JSON.stringify(testModule)};
test('shows the card', () => expect('closed').toBe('open'));\n`,
  );
  mkdirSync(join(dir, "output"));
  const config = join(dir, "playwright.config.ts");
  // The real configuration's reporters, less its JSON file under the run folder.
  writeFileSync(
    config,
    `import config from ${JSON.stringify(join(process.cwd(), "playwright.config.ts"))};
    import { E2E_PROJECTS } from ${JSON.stringify(join(process.cwd(), "tests/e2e/lanes.ts"))};
    export default { ...config, testDir: ${JSON.stringify(dir)}, globalSetup: undefined, globalTimeout: 0,
      tsconfig: ${JSON.stringify(join(process.cwd(), "tsconfig.node.json"))},
      projects: E2E_PROJECTS.filter((project) => project.name !== 'styles'),
      reporter: config.reporter.filter(([name]) => name !== 'json'),
      outputDir: ${JSON.stringify(join(dir, "output"))} };`,
  );
  const run = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--config", config],
    { encoding: "utf8", env: env({}) },
  );
  expect(run.status, run.stdout + run.stderr).toBe(1);
  const line = run.stdout.split("\n").find((text) => text.startsWith("::error "));
  expect(line, run.stdout).toMatch(/^::error file=.*view\.spec\.ts,title=.*shows the card/);
  expect(line).toContain("closed");
});

it("names a failed unit test's file and reason in an error line when the run also writes its timing file", () => {
  const dir = scratchDir("infinitary-annotations-unit-");
  const file = join(dir, "sum.test.ts");
  writeFileSync(
    file,
    `import { expect, it } from "vitest";
it("adds two numbers", () => expect(2 + 2).toBe(5));\n`,
  );
  const config = join(dir, "vitest.config.ts");
  // The real configuration's reporters, over this one file alone.
  writeFileSync(
    config,
    `import config from ${JSON.stringify(join(process.cwd(), "vitest.config.ts"))};
    export default { ...config, test: { reporters: config.test.reporters, root: ${JSON.stringify(dir)},
      include: ["sum.test.ts"] } };`,
  );
  const timing = join(dir, "timing.json");
  const run = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", config],
    { encoding: "utf8", env: env({ INFINITARY_TEST_TIMING_FILE: timing }) },
  );
  expect(run.status, run.stdout + run.stderr).toBe(1);
  const line = run.stdout.split("\n").find((text) => text.startsWith("::error "));
  expect(line, run.stdout + run.stderr).toMatch(/^::error file=.*sum\.test\.ts,.*adds two numbers/);
  expect(line).toContain("expected 4 to be 5");
});

it("names a generated file out of step and the command that refreshes it, in the real generator's check", () => {
  // The runbook fallback's generator and what it reads, at their places in a scratch tree.
  const dir = scratchDir("infinitary-annotations-generated-");
  for (const file of [
    "scripts/generate-runbook-fallback.ts",
    "scripts/github-errors.ts",
    "resources/runbooks/delivery/crew.md",
    "resources/runbooks/naming/guide.md",
    "resources/runbooks/testing/crew.md",
    "src/core/runbooks/fallback.generated.ts",
  ]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(file, join(dir, file));
  }
  const check = () =>
    spawnSync(process.execPath, ["scripts/generate-runbook-fallback.ts", "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: env({}),
    });
  expect(check().status).toBe(0);
  // A Markdown edit committed without running the generator.
  writeFileSync(
    join(dir, "resources/runbooks/naming/guide.md"),
    `${readFileSync(join(dir, "resources/runbooks/naming/guide.md"), "utf8")}\nOne more rule.\n`,
  );
  const stale = check();
  expect(stale.status).toBe(1);
  expect(stale.stderr.split("\n")[0]).toBe(
    "::error file=src/core/runbooks/fallback.generated.ts,title=Generated file out of step::src/core/runbooks/fallback.generated.ts: out of step with its generator; run node scripts/generate-runbook-fallback.ts and commit the result",
  );
});

type Step = { run: string; env?: Record<string, string> };
const batchJobs = (
  loadYamlFile(".github/workflows/batch-checks.yml") as { jobs: Record<string, { steps: Step[] }> }
).jobs;
const runStep = (step: Step, stepEnv: Record<string, string>) =>
  spawnSync("bash", ["-e", "-c", step.run], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...stepEnv },
  });

it("passes each batch stop, with a notice, so the stops add no failure beside the real one", () => {
  const [step, ...rest] = batchJobs.stop!.steps;
  expect(rest).toEqual([]);
  const ran = runStep(step!, { JOB: "verify-lane-mac" });
  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe(
    "::notice::The code checks failed, so this batch stopped its verify-lane-mac job.\n",
  );
  const afterConfirm = runStep(step!, { JOB: "verify-lane-mac", STOP: "confirm" });
  expect(afterConfirm.status).toBe(0);
  expect(afterConfirm.stdout).toBe(
    "::notice::A confirm failed again, so this batch stopped its verify-lane-mac job.\n",
  );
});

it("fails the stopped batch with one error line naming the code checks' failed step", () => {
  // The batch run whose size check refused a file, as GitHub listed its jobs.
  const sizeCheckRun = JSON.parse(
    readFileSync(
      new URL("./fixtures/batch-stop/batch-run-size-check.json", import.meta.url),
      "utf8",
    ),
  ) as Parameters<typeof codeChecksFailure>[0];
  const [step, ...rest] = batchJobs.stopped!.steps;
  expect(rest).toEqual([]);
  const failed = workflowValue(step!.env!.FAILED!, {
    needs: { watch: { outputs: { failed: codeChecksFailure(sizeCheckRun) } } },
  }) as string;
  const ran = runStep(step!, { FAILED: failed });
  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe(
    '::error title=The code checks failed::Code checks and build (Linux) failed at "Run pnpm check". Their own error lines say why; the batch stopped its other checks, which show as cancelled.\n',
  );
  // A watch that named nothing still leaves a reason.
  expect(runStep(step!, { FAILED: "" }).stdout).toMatch(
    /^::error title=The code checks failed::The code checks failed\. /,
  );
});

it("fails the batch a confirm stopped with one error line naming the confirm and its files", () => {
  // PR #1790's batch: the watch's words for its first confirm that failed again.
  const [step] = batchJobs.stopped!.steps;
  const ran = runStep(step!, {
    STOP: "confirm",
    FAILED:
      "Confirm failed Integration tests (Linux; group 1/2) failed again on tests/gitlabMergeReview.test.ts src/core/core.projects.test.ts src/core/placed/placedSignIns.test.ts",
  });
  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe(
    "::error title=A confirm failed again::Confirm failed Integration tests (Linux; group 1/2) failed again on tests/gitlabMergeReview.test.ts src/core/core.projects.test.ts src/core/placed/placedSignIns.test.ts. Its own error lines say why; the batch stopped its other checks, which show as cancelled.\n",
  );
  expect(runStep(step!, { STOP: "confirm", FAILED: "" }).stdout).toMatch(
    /^::error title=A confirm failed again::A confirm failed again\. /,
  );
});
