import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { expect } from "vitest";
import { hostEnv } from "../../src/core/hostEnv";
import { scratchDir } from "./scratchDirs";

/**
 * INF-2267: shared by the workflow contract tests (tests/workflow-*.test.ts)
 * and behavioral alpha-handoff tests. The packaging, signing, and release
 * files ARE the shipping contract, so their invariants are asserted from
 * the real files; a failed check is the gate working. Each contract test
 * names the workflow paths it reads itself, so a change to a workflow
 * selects it (scripts/unit-reach.ts reads literal paths, never this file's).
 */
export const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const read = (path: string) => readFileSync(join(root, path), "utf8");
const require = createRequire(import.meta.url);

/** YAML parser electron-builder uses for electron-builder.yml. */
export function loadYamlFile(path: string): Record<string, unknown> {
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (input: string) => unknown;
  };
  const parsed = yaml.load(read(path));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} did not parse as a mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** A workflow `if:` or `${{ }}` value, evaluated as GitHub Actions does, as plain JSON. */
export function workflowValue(
  value: string,
  contexts: Record<string, unknown>,
  status: Record<"success" | "failure" | "always" | "cancelled", boolean> = {
    success: true,
    failure: false,
    always: true,
    cancelled: false,
  },
): unknown {
  const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const functions = Object.entries(status).map(([name, result]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(result),
  }));
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver) as data.Dictionary;
  const result = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate();
  return JSON.parse(JSON.stringify(result, data.replacer));
}

/** A string carrying `${{ }}` expressions, interpolated as GitHub Actions does. */
export function workflowString(template: string, contexts: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = workflowValue(expression, contexts);
    return value === null ? "" : String(value);
  });
}

/**
 * An actions/github-script body as a function of `parameters`, run with
 * Node's real module loader so its `await import(...)` of a checked-out
 * script works; Vitest's realm installs no loader on a constructed function.
 */
export function githubScript(
  script: string,
  parameters: string[],
): (...args: unknown[]) => Promise<unknown> {
  return compileFunction(`return (async () => {\n${script}\n})()`, parameters, {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (...args: unknown[]) => Promise<unknown>;
}

/** INF-2259: execute the real dispatch shell, recording only its expensive command. */
export function recordedWorkflowCall(
  command: string,
  environment: Record<string, string>,
): string[] {
  const folder = scratchDir("infinitary-workflow-call-");
  const home = join(folder, "home");
  const bin = join(folder, "bin");
  const log = join(folder, "command");
  mkdirSync(home);
  mkdirSync(bin);
  for (const program of ["node", "scripts/virtual-mac/phone.sh"]) {
    const path = join(program.includes("/") ? folder : bin, program);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(program)} "$@" > "$COMMAND_LOG"\n`,
      { mode: 0o755 },
    );
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command], {
    cwd: folder,
    env: {
      ...hostEnv(),
      HOME: home,
      CFFIXED_USER_HOME: home,
      PATH: `${bin}:${hostEnv().PATH}`,
      RUNNER_TEMP: folder,
      COMMAND_LOG: log,
      ...environment,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(log, "utf8").trim().split("\n");
}

/** verify.yml's full Mac e2e command: half the job's cores (scripts/job-cores.ts). */
export const VERIFY_E2E_RUN =
  'cores="$(node scripts/job-cores.ts)"\npnpm exec playwright test --workers=$(( cores > 1 ? cores / 2 : 1 ))\n';

/** A ci.yml job that calls another workflow and starts no machine of its own. */
export type CiCall = { if?: string; needs?: unknown; uses: string; with?: Record<string, unknown> };

/**
 * ci.yml, its machine jobs apart from the jobs that call another workflow
 * (INF-2507's critical path), whose machines run that workflow's steps.
 */
export function loadCi(): {
  on: Record<string, unknown>;
  jobs: Record<string, CiJob>;
  calls: Record<string, CiCall>;
} {
  const ci = loadYamlFile(".github/workflows/ci.yml") as {
    on: Record<string, unknown>;
    jobs: Record<string, CiJob | CiCall>;
  };
  const jobs: Record<string, CiJob> = {};
  const calls: Record<string, CiCall> = {};
  for (const [id, job] of Object.entries(ci.jobs)) {
    if ("uses" in job) calls[id] = job;
    else jobs[id] = job;
  }
  return { on: ci.on, jobs, calls };
}

export type CiJob = {
  name?: string;
  if?: string;
  needs?: unknown;
  "runs-on": string;
  "continue-on-error"?: boolean;
  strategy?: { matrix: Record<string, unknown[]>; "fail-fast"?: boolean };
  steps: Array<{
    id?: string;
    run?: string;
    uses?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
    if?: string;
    "continue-on-error"?: boolean;
    "timeout-minutes"?: number;
  }>;
};

/**
 * The machines ci.yml starts for one event: one per job and matrix entry
 * whose condition holds, each with its name and, in order, the commands of
 * the steps whose conditions hold on a passing run, interpolated as GitHub
 * Actions does. A job that calls another workflow runs that workflow's
 * commands, not ci.yml's, and is left out. A requested full sweep (workflow_dispatch) is the gate
 * main.yml's full check repeats; a pull request adds its own notes and
 * changed-file reader steps.
 */
export function ciJobs(
  eventName: string,
  sweep = eventName === "workflow_dispatch",
): { id: string; name: string; runs: string[] }[] {
  const ci = loadCi();
  const github = { event_name: eventName };
  // A request asks for the sweep through ci.yml's `sweep` input.
  const inputs = { sweep };
  return Object.entries(ci.jobs).flatMap(([id, job]) => {
    if (job.if !== undefined && workflowValue(job.if, { github, inputs }) !== true) return [];
    const matrix = Object.entries(job.strategy?.matrix ?? {});
    if (matrix.some(([, values]) => !Array.isArray(values))) {
      throw new Error(`${id}: only a matrix of plain lists is read here`);
    }
    const entries = matrix.reduce<Record<string, unknown>[]>(
      (combos, [key, values]) =>
        combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value }))),
      [{}],
    );
    return entries.map((entry, index) => {
      const contexts = {
        matrix: entry,
        strategy: { "job-index": index, "job-total": entries.length },
      };
      return {
        id,
        name: workflowString(job.name ?? id, { github, ...contexts }),
        // A run line reads its step's environment, which carries the matrix
        // values (INF-2539: no expression inside a shell script).
        runs: job.steps.flatMap((step) =>
          step.run &&
          (step.if === undefined || workflowValue(step.if, { github, ...contexts }) === true)
            ? [interpolated(step, contexts)]
            : [],
        ),
      };
    });
  });
}

/** A step's run line with the step's environment read in, as its shell reads it (INF-2539: the matrix values reach a script only through its environment). */
export function interpolated(
  step: CiJob["steps"][number],
  contexts: Record<string, unknown>,
): string {
  return workflowString(step.run ?? "", contexts)
    .replace(/"?\$\{?(\w+)\}?"?/g, (whole, name: string) =>
      step.env?.[name] === undefined ? whole : workflowString(step.env[name], contexts),
    )
    .trim();
}

/**
 * The machines verify.yml's Linux test groups start for a call's inputs
 * (INF-2646), verify.yml's own defaults filling the inputs it leaves out:
 * one per matrix entry when the job's condition holds, each with its name,
 * the steps that run on a passing run, in order, and their commands.
 */
export function verifyLinuxTests(given: Record<string, unknown>): {
  name: string;
  steps: { uses?: string; run?: string }[];
  runs: string[];
}[] {
  const verify = loadYamlFile(".github/workflows/verify.yml") as {
    on: { workflow_call: { inputs: Record<string, { default?: unknown }> } };
    jobs: Record<string, CiJob>;
  };
  const inputs = {
    ...Object.fromEntries(
      Object.entries(verify.on.workflow_call.inputs).flatMap(([name, input]) =>
        "default" in input ? [[name, input.default]] : [],
      ),
    ),
    ...given,
  };
  const job = verify.jobs["linux-tests"];
  if (!job) throw new Error("verify.yml has no linux-tests job");
  if (job.if !== undefined && workflowValue(job.if, { inputs }) !== true) return [];
  const entries = (job.strategy?.matrix.include ?? []) as Record<string, unknown>[];
  return entries.map((matrix) => {
    const contexts = { inputs, matrix };
    const steps = job.steps
      .filter((step) => step.if === undefined || workflowValue(step.if, contexts) === true)
      .map((step) => (step.run ? { run: interpolated(step, contexts) } : { uses: step.uses }));
    return {
      name: workflowString(job.name ?? "linux-tests", contexts),
      steps,
      runs: steps.flatMap(({ run }) => (run ? [run] : [])),
    };
  });
}

/** A workflow step as the full check's and the journeys' contracts read it. */
export type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number>;
  "continue-on-error"?: boolean;
};

export type ChannelStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
export type ChannelJob = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, string>;
  secrets?: unknown;
  "runs-on"?: string;
  strategy?: { matrix: Record<string, string> };
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: ChannelStep[];
};
export type ChannelWorkflow = {
  on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
  concurrency: { group: string; "cancel-in-progress": string };
  env: Record<string, string>;
  permissions: Record<string, string>;
  jobs: Record<string, ChannelJob>;
};

/** The signed channel workflow's jobs and steps (docs/alpha.md "The signed channel workflow"). */
export function signedChannel(release: ChannelWorkflow, verify: ChannelWorkflow) {
  const jobOf = (workflow: ChannelWorkflow, id: string): ChannelJob => {
    const job = workflow.jobs[id];
    if (!job) throw new Error(`no job "${id}"`);
    return job;
  };
  // INF-1716 and INF-2498's plan, piece 2: the signing job ends at the
  // checked disk image, the upload job continues from its handoff, and the
  // publication job checks every copy and switches; a release's operations
  // are the signing job's steps, then the upload job's, then the
  // publication job's.
  const signingSteps = jobOf(release, "release").steps ?? [];
  const uploadSteps = jobOf(release, "upload").steps ?? [];
  const publishSteps = jobOf(release, "publish").steps ?? [];
  const steps = [...signingSteps, ...uploadSteps, ...publishSteps];
  const step = (id: string) => {
    const found = steps.find((candidate) => (candidate.id ?? candidate.name) === id);
    if (!found)
      throw new Error(`release.yml's signing, upload and publication jobs have no step "${id}"`);
    return found;
  };
  const lane = jobOf(verify, "lane");
  /** The lanes verify runs for a profile, through its own matrix expression. */
  const lanes = (profile?: string) =>
    workflowValue(lane.strategy?.matrix.lane ?? "", { inputs: profile ? { profile } : {} });

  return { jobOf, signingSteps, uploadSteps, publishSteps, steps, step, lane, lanes };
}

/** What publishes a release's files or switches a cask or feed to them. */
export const PUBLISHES =
  /gh release (create|upload)|publish-release-asset\.sh|publish-(?:tap|feeds)\.sh live|publish-downloads\.ts|git push/;
/** What puts a file on a place, as opposed to switching a cask or feed to it. */
export const UPLOADS = /gh release (create|upload)|publish-release-asset\.sh|publish-downloads\.ts/;
export const PUBLICATION_TOKEN =
  /secrets\.(GITHUB_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|HOMEBREW_TAP_TOKEN|OLD_TAP_TOKEN)/;
