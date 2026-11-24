import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { expect } from "vitest";
import { SIGNING_TEAMS } from "../../scripts/release-signing-team.ts";
import { laterParts } from "../../scripts/unit-repeats.ts";
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

/** verify.yml's full Mac e2e command: half the job's cores on the project's own Macs, whose
 * runner slots share a processor, and every core but one on GitHub's (scripts/job-cores.ts); the
 * job's group of the desktop lane alone, or the job's group of the parallel lanes
 * (scripts/journey-groups.ts, INF-2987). */
export const VERIFY_E2E_RUN = [
  'cores="$(node scripts/job-cores.ts)"',
  "platform=mac",
  'workers="--workers=$(( cores > 1 ? cores / 2 : 1 ))"',
  'if [ "$RUNNER_KIND" = github-hosted ]; then',
  "  platform=mac-hosted",
  '  workers="--workers=$(( cores > 1 ? cores - 1 : 1 ))"',
  "fi",
  'if [ "${LANE#desktop-}" != "$LANE" ]; then',
  '  node scripts/journey-groups.ts --platform "$platform" --lane desktop --group "${LANE#desktop-}/2" -- --no-deps --project=desktop "$workers"',
  "else",
  "  # The parallel jobs' groups come first, in their order, and the",
  "  # mac job's last. On GitHub's Macs the parallel jobs are four",
  "  # (parallel-1 to parallel-4) and the mac job is there too, since",
  "  # one runs-on label sends both; elsewhere one, parallel.",
  "  parallel=1",
  '  [ "$LANE" = parallel ] || [ "$platform" = mac ] || parallel=4',
  '  case "$LANE" in',
  "    parallel) index=1 ;;",
  '    parallel-*) index="${LANE#parallel-}" ;;',
  "    *) index=$((parallel + 1)) ;;",
  "  esac",
  '  if [ "$PART" = journeys ]; then',
  "    # No mac job: the parallel jobs take every group.",
  '    group="$index/$parallel"',
  "    jobs=",
  "  else",
  '    group="$index/$((parallel + 1))"',
  '    jobs="--jobs $(printf \'parallel,%.0s\' $(seq "$parallel"))mac"',
  "  fi",
  "  # shellcheck disable=SC2086 # one word per job name",
  '  node scripts/journey-groups.ts --platform "$platform" --lane parallel --group "$group" $jobs -- --no-deps --project=styles --project=renderer --project=application "$workers" --pass-with-no-tests',
  "fi",
  "",
].join("\n");

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
    name?: string;
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
  // What the paths step of a pull request or a pushed branch decided
  // (scripts/pr-paths.ts); a request runs no paths step.
  paths: { build: boolean; browser: boolean } = { build: true, browser: true },
  // The batch version the base step of a pushed branch built on one names,
  // as a held batch's repair is; empty for every other branch.
  batch = "",
  // How many parts the tests a change reaches take (scripts/unit-repeats.ts,
  // reachParts), which the code checks count for reached-tests-parts.
  parts = 1,
): { id: string; name: string; runs: string[] }[] {
  const ci = loadCi();
  const repository = "infinitary-labs/infinitary-apps";
  const github = {
    event_name: eventName,
    repository,
    event: { pull_request: { head: { repo: { full_name: repository } } } },
  };
  const steps =
    eventName !== "workflow_dispatch"
      ? batch
        ? {
            base: { outputs: { batch } },
            paths: { outputs: {} },
            "critical-path": { outcome: "skipped" },
          }
        : {
            base: { outputs: {} },
            paths: { outputs: { build: String(paths.build), browser: String(paths.browser) } },
            "critical-path": { outcome: paths.build ? "success" : "skipped" },
          }
      : { base: { outputs: {} }, paths: { outputs: {} }, "critical-path": { outcome: "skipped" } };
  // A request asks for the sweep through ci.yml's `sweep` input.
  const inputs = { sweep };
  // The code checks' count of the parts, when its step runs, in the output
  // its own script writes.
  const count = ci.jobs["code-checks"]?.steps.find((step) => step.id === "reach-parts");
  const counted =
    count?.if === undefined || workflowValue(count.if, { github, steps }) === true
      ? laterParts(Array.from({ length: parts }, () => []))
      : "";
  const needs = { "code-checks": { outputs: { "reach-parts": counted } } };
  return Object.entries(ci.jobs).flatMap(([id, job]) => {
    if (job.if !== undefined && workflowValue(job.if, { github, inputs, needs }) !== true)
      return [];
    const { include, ...axes } = (job.strategy?.matrix ?? {}) as Record<string, unknown[]> & {
      include?: unknown;
    };
    const matrix = Object.entries(axes);
    if (matrix.some(([, values]) => !Array.isArray(values))) {
      throw new Error(`${id}: only a matrix of plain lists is read here`);
    }
    // A matrix the code checks counted lists its entries in the JSON their step wrote.
    const entries =
      typeof include === "string"
        ? (workflowValue(include, { needs }) as Record<string, unknown>[])
        : matrix.reduce<Record<string, unknown>[]>(
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
          (step.if === undefined || workflowValue(step.if, { github, steps, ...contexts }) === true)
            ? [interpolated(step, { github, ...contexts })]
            : [],
        ),
      };
    });
  });
}

/**
 * A job's steps when GitHub takes its token at every checkout: a checkout's
 * wait and its second try run only once it failed, so they are left out
 * (docs/testing.md, "GitHub refusing a job's token";
 * tests/workflow-hygiene.test.ts holds every checkout of main's check and a
 * release to them).
 */
export function firstTry<S extends { id?: string; if?: string; uses?: string }>(steps: S[]): S[] {
  const checkouts = new Set(
    steps.flatMap((step) =>
      step.uses?.startsWith("actions/checkout@") && step.id ? [step.id] : [],
    ),
  );
  return steps.filter((step) => {
    const after = /^\$\{\{ !cancelled\(\) && steps\.([\w-]+)\.outcome == 'failure' \}\}$/.exec(
      step.if ?? "",
    )?.[1];
    return after === undefined || !checkouts.has(after);
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
    const steps = firstTry(job.steps)
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
  /** The lanes verify runs for a profile, through its own matrix expression; `vars` are the
   * project's variables, none by default, so the Mac jobs go to GitHub's Macs. */
  const lanes = (profile?: string, vars: Record<string, unknown> = {}) =>
    workflowValue(lane.strategy?.matrix.lane ?? "", {
      inputs: profile ? { profile } : {},
      vars,
    });

  return { jobOf, signingSteps, uploadSteps, publishSteps, steps, step, lane, lanes };
}

/** What publishes a release's files or switches a cask or feed to them. */
export const PUBLISHES =
  /gh release (create|upload)|publish-release-asset\.sh|publish-(?:tap|feeds)\.sh live|publish-downloads\.ts|git push/;
/** What puts a file on a place, as opposed to switching a cask or feed to it. */
export const UPLOADS = /gh release (create|upload)|publish-release-asset\.sh|publish-downloads\.ts/;
export const PUBLICATION_TOKEN =
  /secrets\.(GITHUB_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|HOMEBREW_TAP_TOKEN|OLD_TAP_TOKEN)/;

/**
 * A read of a secret whose name starts with one of `names`, in a workflow's
 * text: by name under any signing team's prefix, or through the index
 * release.yml builds from the prefix of the team that signs the source
 * (scripts/release-signing-team.ts).
 */
export function secretRead(names: string): RegExp {
  const prefixes = Object.values(SIGNING_TEAMS)
    .map((team) => team.secrets)
    .join("|");
  return new RegExp(`secrets(?:\\.(?:${prefixes})|\\[format\\('\\{0\\})(?:${names})`);
}

/** The resolve job's outputs naming the team that signs and the prefix of its secrets. */
export function signingOutputs(team: string): Record<string, string> {
  const known = SIGNING_TEAMS[team];
  if (!known) throw new Error(`The workflow keeps no signing material for team ${team}.`);
  return { team_id: team, sign_identity: known.identity, signing_secrets: known.secrets };
}

/** The arguments verify.yml's journeys step gives Playwright in `lane`, with
 * a stand-in pnpm that only records them. */
export function journeysRun(
  lane: string,
  { cores, hosted = false, part = "" }: { cores?: string; hosted?: boolean; part?: string },
): string {
  const verify = loadYamlFile(".github/workflows/verify.yml") as {
    jobs: Record<string, { steps?: { id?: string; run?: string }[] }>;
  };
  const run = verify.jobs.lane?.steps?.find((step) => step.id === "e2e")?.run ?? "";
  const dir = scratchDir("infinitary-job-cores-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "pnpm.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n');
  chmodSync(join(bin, "pnpm"), 0o755);
  const { RUNNER_UP_CORES: _unset, ...env } = hostEnv();
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", run], {
    cwd: root,
    env: {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      COMMAND_LOG: log,
      INFINITARY_E2E_TAG: "",
      LANE: lane,
      PART: part,
      RUNNER_KIND: hosted ? "github-hosted" : "self-hosted",
      ...(cores === undefined ? {} : { RUNNER_UP_CORES: cores }),
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(log, "utf8").trim();
}
