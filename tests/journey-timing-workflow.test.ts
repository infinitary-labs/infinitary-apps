import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { expect, it } from "vitest";
import type { journeyTiming } from "../scripts/journey-timing";
import { hostEnv } from "../src/core/hostEnv";
import { firstTry } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2018: a pinned candidate predating the workflow's exporter still yields
// timing for its own report and revision. Run the actual YAML command with real
// git checkouts and the captured Linux report (fixture README names its source).
// Integration budget: git + Node, default 5 s; no network, install or signing.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
};
const job = yaml.load(readFileSync(".github/workflows/source-journeys.yml", "utf8")).jobs[
  "source-desktop"
] as {
  defaults: { run: { "working-directory": string } };
  steps: Step[];
};

function value(expression: string, contexts: Record<string, unknown>): unknown {
  const functions = [
    { name: "always", minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(true) },
  ];
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver) as data.Dictionary;
  return JSON.parse(
    JSON.stringify(
      new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate(),
      data.replacer,
    ),
  );
}
function text(template: string, contexts: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) =>
    String(value(expression, contexts)),
  );
}

it.each(["success", "failure", "missing"])(
  "exports %s observations from an older candidate without its own helper",
  (outcome) => {
    // Node resolves the CLI entry through macOS's /var -> /private/var link.
    const root = realpathSync(scratchDir("infinitary-timing-workflow-"));
    const repository = join(root, "repository");
    const workspace = join(root, "Application Support", "workspace");
    const temp = join(root, "runner temp");
    for (const dir of [repository, workspace, temp]) mkdirSync(dir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...hostEnv(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(repository, "init", "-q");
    const save = () => {
      git(repository, "add", ".");
      git(
        repository,
        "-c",
        "user.name=Timing test",
        "-c",
        "user.email=timing@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      return git(repository, "rev-parse", "HEAD");
    };
    const reportBytes = readFileSync("tests/fixtures/journey-timing/linux-report.json");
    mkdirSync(join(repository, "playwright-report"));
    writeFileSync(join(repository, "playwright-report/source-results.json"), reportBytes);
    const candidate = save();
    mkdirSync(join(repository, "scripts"));
    writeFileSync(
      join(repository, "scripts/journey-timing.ts"),
      readFileSync("scripts/journey-timing.ts"),
    );
    const workflow = save();
    // A moving branch is not the workflow revision either.
    writeFileSync(
      join(repository, "scripts/journey-timing.ts"),
      "throw new Error('wrong workflow revision');\n",
    );
    const latest = save();
    const contexts = {
      github: { ref: latest, workflow_sha: workflow },
      inputs: { ref: candidate, suite: "full", files: "", "artifact-suffix": "source" },
      runner: { os: "Linux", temp },
      matrix: { lane: "desktop", shard: 1 },
      steps: { journeys: { outcome: outcome === "missing" ? "failure" : outcome } },
    };
    // Model checkout's ref/path/sparse inputs with local git; no candidate files
    // are supplied from the workflow checkout or from the current working copy.
    // Each checkout as GitHub takes the job's token the first time.
    for (const step of firstTry(job.steps).filter((step) => step.uses === "actions/checkout@v4")) {
      if (step.if && !value(step.if, contexts)) continue;
      const inputs = step.with ?? {};
      const destination = join(workspace, String(inputs.path ?? "."));
      git(root, "clone", "--shared", "--no-checkout", repository, destination);
      if (inputs["sparse-checkout"]) {
        git(
          destination,
          "sparse-checkout",
          "set",
          inputs["sparse-checkout-cone-mode"] === false ? "--no-cone" : "--cone",
          String(inputs["sparse-checkout"]),
        );
      }
      git(
        destination,
        "checkout",
        "--detach",
        inputs.ref ? text(String(inputs.ref), contexts) : contexts.github.ref,
      );
    }
    const cwd = join(workspace, job.defaults.run["working-directory"]);
    const candidateReport = join(cwd, "playwright-report/source-results.json");
    if (outcome === "missing") {
      // Missing reports are observations, not export failures or successful runs.
      git(cwd, "rm", "playwright-report/source-results.json");
    }
    const before = git(cwd, "status", "--porcelain");
    const step = job.steps.find((step) => step.name === "Export compact Linux timing");
    if (!step?.run) throw new Error("no timing export command");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", step.run], {
      cwd,
      env: {
        ...env,
        PATH: `${resolve(process.execPath, "..")}:${env.PATH}`,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: temp,
        GITHUB_RUN_ID: "41039506055",
        GITHUB_RUN_ATTEMPT: "1",
        RUNNER_OS: contexts.runner.os,
        RUNNER_ARCH: "X64",
        ...Object.fromEntries(
          Object.entries(step.env ?? {}).map(([key, template]) => [key, text(template, contexts)]),
        ),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const timing = JSON.parse(
      readFileSync(join(temp, "journey-timing.json"), "utf8"),
    ) as ReturnType<typeof journeyTiming>;
    expect(timing.revision).toBe(candidate);
    expect(timing.successful).toBe(outcome === "success");
    expect(timing.complete).toBe(outcome !== "missing");
    expect(timing.reportState).toBe(outcome === "missing" ? "missing" : "present");
    const raw = JSON.parse(reportBytes.toString());
    expect(timing.stats).toEqual(outcome === "missing" ? null : raw.stats);
    expect(timing.selectedFiles).toEqual(
      outcome === "missing"
        ? []
        : raw.suites.map((suite: { file: string }) => `tests/e2e/${suite.file}`).sort(),
    );
    expect(git(cwd, "rev-parse", "HEAD")).toBe(candidate);
    expect(git(cwd, "status", "--porcelain")).toBe(before);
    expect(existsSync(join(cwd, "scripts/journey-timing.ts"))).toBe(false);
    if (outcome !== "missing") expect(readFileSync(candidateReport).equals(reportBytes)).toBe(true);
  },
);
