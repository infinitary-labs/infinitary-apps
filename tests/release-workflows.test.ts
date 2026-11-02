import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
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
import { journeyArguments } from "../scripts/journey-runs.ts";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import { presentationCommitMessage } from "../src/core/forge";
import { hostEnv } from "../src/core/hostEnv";
import { releaseSource } from "../src/core/update/releaseSource";
import { compareSemver, isAlphaVersion } from "../src/core/update/semver";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  publicTagFor,
} from "../src/core/update/updateChannels";
import vitestConfig from "../vitest.config";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";
import { standInGh } from "./helpers/standInGh";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/**
 * The release-contract test (docs/architecture.md, in the
 * style of pi-launcher's check-release-contract.py and baby-menu's
 * release-config.test.ts): the packaging, signing, and release files ARE
 * the shipping contract, so their invariants are asserted from the real
 * files. A failed check here is the gate working.
 */

const root = join(__dirname, "..");

const read = (path: string) => readFileSync(join(root, path), "utf8");

/** INF-2259: execute the real dispatch shell, recording only its expensive command. */
function recordedWorkflowCall(command: string, environment: Record<string, string>): string[] {
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
const VERIFY_E2E_RUN =
  'cores="$(node scripts/job-cores.ts)"\npnpm exec playwright test --workers=$(( cores > 1 ? cores / 2 : 1 )) $ONLY\n';

describe("local packaging identity (electron-builder.dev.yml)", () => {
  // INF-2267: keep these smoke-workflow assertions separate from the native bundle checks.
  it("checks the dev bundle's git the way the release gate does", () => {
    // The package smoke checks the dev bundle's git the way the release gate does.
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-bundled-git.sh "dist/mac-universal/Infinitary Dev.app"',
    );
  });

  it("checks the dev bundle's separate data folder in the package smoke", () => {
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-user-data-dir.sh "dist/mac-universal/Infinitary Dev.app" infinitary-dev',
    );
  });

  /**
   * The app runs work for another Mac with no window (docs/helper.md):
   * scripts/check-helper.sh starts the built app as `<app> work` on the dev
   * bundle in verify.yml and on the signed app in release.yml, and both say
   * how it went.
   */
  it("starts the built app to run work, on the dev bundle and on the signed app", () => {
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-helper.sh "dist/mac-universal/Infinitary Dev.app"',
    );
    // Each workflow's summary names the stage by its step id.
    expect(read(".github/workflows/verify.yml")).toContain(`helper=\${{ steps.helper.outcome }}`);
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('scripts/check-helper.sh "dist/mac-universal/$APP_NAME"');
    expect(release).toContain(`work-mode=\${{ steps.work-mode.outcome }}`);
  });

  /**
   * electron-builder refuses to sign pull-request builds unless told
   * otherwise, so without the flag the smoke job would build a fuse-flipped
   * app and never re-sign it - the one step that has to work, and the step
   * this overlay exists for.
   */
  it("makes the macOS package smoke really sign, then check what it signed", () => {
    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("--config electron-builder.dev.yml");
    expect(verify).toContain('CSC_FOR_PULL_REQUEST: "true"');
    expect(verify).toContain("pnpm codesign:verify");
  });

  /**
   * Captain decision B (2026-09-15, scout fm3000-ci-release-only-s1): the
   * full macOS work is paid for at release time and on demand, never per PR,
   * and never on a schedule. ci.yml is the Linux jobs alone. Decision B was
   * reversed for pull requests in part on 2026-10-08 (FI3-1305) and again by
   * INF-2139, and for main by INF-2146's approved plan (direction B): main.yml
   * is the one workflow that starts the full check on a push, tested below.
   */
  it("keeps the full macOS work out of PR CI and off any schedule", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/macos|MAC_RUNNER|test:e2e|electron-builder/);

    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("workflow_call:");
    expect(verify).toContain("workflow_dispatch:");
    expect(verify).not.toMatch(/^\s*(schedule|pull_request|push):/m);
    expect(verify).toContain("pnpm exec playwright test");
    expect(verify).toContain("pnpm replay:gate");
    expect(verify).toContain("vars.MAC_RUNNER || 'macos-15'");
  });

  /**
   * INF-2146, the captain's approved plan (direction B, trigger "push", phone
   * "every-run"): every push to main runs the full check with every journey
   * on the Mac and the whole phone check, and runs queue instead of
   * cancelling, so GitHub keeps one running and at most one waiting run.
   */
  it("runs the full check and the whole phone check on every push to main, queued and never cancelled", () => {
    type Call = {
      uses?: string;
      with?: Record<string, unknown>;
      "runs-on"?: string;
      steps?: Step[];
    };
    const main = loadYamlFile(".github/workflows/main.yml") as {
      on: Record<string, { branches?: string[] }>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<string, Call>;
    };
    expect(main.on).toEqual({ push: { branches: ["main"] } });
    // One group for every run, so a newer push waits instead of starting beside it.
    expect(main.concurrency.group).not.toContain("${{");
    expect(main.concurrency["cancel-in-progress"]).toBe(false);
    // Each job only calls a check, so the run is exactly those checks.
    expect(Object.values(main.jobs).every((job) => job.uses && !job.steps && !job["runs-on"])).toBe(
      true,
    );
    const calls = Object.values(main.jobs).map((job) => job.uses);
    expect(calls.sort()).toEqual([
      "./.github/workflows/phone.yml",
      "./.github/workflows/verify.yml",
    ]);
    const verify = Object.values(main.jobs).find((job) => job.uses?.endsWith("verify.yml"));
    // The pushed version, with every journey on the Mac and the full lanes.
    expect(verify?.with).toMatchObject({
      ref: "${{ github.sha }}",
      all_journeys: true,
      profile: "stable",
    });
    expect(verify?.with).not.toHaveProperty("installer_only");

    // The phone check takes the call with no inputs and runs every part of both devices.
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string; steps: Step[] }>;
    };
    expect(Object.keys(phone.on)).toContain("workflow_call");
    expect(
      Object.values(main.jobs).find((job) => job.uses?.endsWith("phone.yml"))?.with,
    ).toBeUndefined();
    const pushed = { github: { event_name: "push", ref: "refs/heads/main" }, inputs: {}, vars: {} };
    // Main moved selection into the native job; the same no-input push must still run all parts.
    const native = phone.jobs["native-phone"];
    expect(workflowValue(native?.if ?? "", pushed)).toBe(true);
    const scope = native?.steps.find((step) => step.id === "scope");
    const selection = {
      ...pushed,
      steps: { select: { outputs: {} }, "request-select": { outputs: {} } },
    };
    expect(workflowString(scope?.env?.GATE ?? "", selection)).toBe("true");
    const chosen = {
      ...selection,
      steps: { ...selection.steps, scope: { outputs: { gate: "true" } }, start: { outputs: {} } },
    };
    const gate = native?.steps.find((step) => step.id === "both");
    expect(workflowValue(gate?.if ?? "", chosen)).toBe(true);
    expect(workflowString(gate?.env?.PHONE_PARTS ?? "", chosen)).toBe("");
    expect(workflowString(gate?.env?.INFINITARY_PHONE_STOP_EARLY ?? "", chosen)).toBe("0");
  });

  it("runs the named journeys only on request, never on a pull request, on the Mac mini", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, { "runs-on": string; steps: Step[]; with?: Record<string, string> }>;
    };
    // INF-2139 (captain: "let's pull journeys and phone checks off PRs now").
    expect(Object.keys(journeys.on)).toEqual(["workflow_dispatch"]);
    const job = journeys.jobs["affected-journeys"];
    // INF-2259: queued Linux proof keeps the chooser's exact source, not a
    // mutable branch that may advance before the job receives a runner.
    const head = "6073f484509752eb55ee1b1c85c38b82b4909cc3";
    expect(
      workflowValue(journeys.jobs["linux-overflow"]?.with?.ref ?? "", {
        github: { sha: head, ref: "refs/heads/main" },
      }),
    ).toBe(head);
    // INF-869: run the virtual side on an isolated label without changing shared vars.
    const runner = (requested: string, configured: string) =>
      workflowValue(job?.["runs-on"] ?? "", {
        inputs: { mac_runner: requested },
        vars: { MAC_RUNNER: configured },
      });
    expect(runner("", "mini-mac-any")).toBe("mini-mac-any");
    expect(runner("", "")).toBe("macos-15");
    expect(runner("mini-mac-inf906-019d7865-virtual", "mini-mac-any")).toBe(
      "mini-mac-inf906-019d7865-virtual",
    );
    const runs = (job?.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
    // The choice comes from the diff, and the suite is never started whole.
    const choices = (journeys.jobs["choose-journeys"]?.steps ?? []).flatMap((step) =>
      step.run ? [step.run] : [],
    );
    expect(choices.some((run) => run.includes("scripts/affected-journeys.ts"))).toBe(true);
    expect(runs.join("\n")).not.toMatch(/test:e2e|e2e-alone|replay:gate|electron-builder/);
    // INF-2259 routes the same explicit selection through its round owner.
    expect(
      runs.some((run) =>
        /journey-runs\.ts --base "\$BASE" --files "\$FILES" .* -- \$ONLY/.test(run),
      ),
    ).toBe(true);
    expect(journeyArguments(["tests/e2e/devices.spec.ts"], ["--grep", MAC_ONLY_TAG])).toEqual([
      "exec",
      "playwright",
      "test",
      "--no-deps",
      "--retries",
      "0",
      "--max-failures",
      "1",
      "--grep",
      MAC_ONLY_TAG,
      "tests/e2e/devices.spec.ts",
    ]);
  });

  /**
   * The captain's principle of 2026-10-28 (INF-1763, docs/principles.md): a
   * test runs on the Mac only when it needs a Mac. A pull request's Mac job,
   * a request for journeys and a requested full check run only the tests
   * tagged MAC_ONLY_TAG, since Linux runs every other one; the nightly check
   * and every alpha run every journey there, and a request can ask for every
   * named journey.
   */
  it("runs on the Mac only the tests that need a Mac, except in an alpha or when asked for all", () => {
    type Job = { if?: string; steps: Step[] };
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
      jobs: Record<string, Job>;
    };
    expect(journeys.on.workflow_dispatch.inputs.mac_all?.default).toBe(false);
    const mac = journeys.jobs["affected-journeys"]?.steps.find((step) => step.id === "e2e");
    const only = (inputs: Record<string, unknown>) =>
      workflowString(mac?.env?.ONLY ?? "", { inputs });
    // A pull request has no inputs; a request names its files and may ask for all.
    expect(only({})).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(only({ files: "window-wash", mac_all: false })).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(only({ files: "window-wash", mac_all: true })).toBe("");
    const commands = (mac?.run ?? "").split("\n").filter((line) => /journey-runs\.ts/.test(line));
    expect(commands).not.toHaveLength(0);
    for (const command of commands) expect(command).toMatch(/--files "\$FILES" .* -- \$ONLY$/);
    const selected = ["tests/e2e/window-wash.spec.ts"];
    expect(journeyArguments(selected, only({ mac_all: false }).split(" ")).slice(-3)).toEqual([
      "--grep",
      MAC_ONLY_TAG,
      ...selected,
    ]);
    expect(journeyArguments(selected, [])).toEqual(
      expect.arrayContaining(["--no-deps", ...selected]),
    );
    // The chooser puts every chosen file on the Mac only when the request asks.
    const select = journeys.jobs["choose-journeys"]?.steps.find((step) => step.id === "select");
    expect(select?.run).toContain("scripts/journey-budget.ts");
    expect(select?.run).toContain("$EVERY");
    const every = (inputs: Record<string, unknown>) =>
      workflowString(select?.env?.EVERY ?? "", { inputs });
    expect([every({}), every({ mac_all: false }), every({ mac_all: true })]).toEqual([
      "",
      "",
      "--every-on-mac",
    ]);

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      on: Record<
        "workflow_call" | "workflow_dispatch",
        { inputs: Record<string, { default?: unknown }> }
      >;
      jobs: { lane: Job };
    };
    // An alpha calls verify with no say; a request runs only the tagged tests unless it asks.
    expect(verify.on.workflow_call.inputs.all_journeys?.default).toBe(true);
    expect(verify.on.workflow_dispatch.inputs.all_journeys?.default).toBe(false);
    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { verify: { with?: Record<string, unknown> } };
    };
    expect(release.jobs.verify.with ?? {}).not.toHaveProperty("all_journeys");
    const steps = verify.jobs.lane.steps;
    const e2e = steps.find((step) => step.id === "e2e");
    expect(e2e?.run).toBe(VERIFY_E2E_RUN);
    const verifyOnly = (all_journeys: boolean) =>
      workflowString(e2e?.env?.ONLY ?? "", { inputs: { all_journeys } });
    expect(verifyOnly(false)).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(verifyOnly(true)).toBe("");
    // Only a run of every journey supplies the chooser's journey times.
    const kept = steps.find((step) => step.name === "Keep the e2e result");
    const keptAs = (all_journeys: boolean) =>
      workflowString(String(kept?.with?.name ?? ""), { inputs: { all_journeys } });
    expect(keptAs(true)).toBe("e2e-results");
    expect(keptAs(false)).not.toBe("e2e-results");
  });

  /**
   * Linux runs every test it can (INF-1763): a test that skips on Linux
   * without MAC_ONLY_TAG runs on no pull request's Mac either, so every
   * Linux journey job refuses one, whether its journeys passed or failed.
   */
  it("refuses a test that skipped on Linux without the Mac tag in every Linux journey job", () => {
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    const steps = source.jobs["source-desktop"].steps;
    const journeys = steps.findIndex((step) => step.env?.PLAYWRIGHT_JSON_OUTPUT_FILE);
    const result = steps[journeys]?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE;
    const refuse = steps.find((step) => step.run?.startsWith("node scripts/untagged-skips.ts"));
    expect(refuse?.run).toBe(`node scripts/untagged-skips.ts ${result}`);
    expect(steps.indexOf(refuse as Step)).toBeGreaterThan(journeys);
    const runs = (os: string, lane: string, status: Partial<Record<"failure", boolean>> = {}) =>
      workflowValue(
        refuse?.if ?? "",
        { runner: { os }, matrix: { lane } },
        {
          success: !status.failure,
          failure: Boolean(status.failure),
          always: true,
          cancelled: false,
        },
      );
    for (const lane of ["parallel", "desktop"]) {
      expect(runs("Linux", lane)).toBe(true);
      expect(runs("Linux", lane, { failure: true })).toBe(true);
      expect(runs("macOS", lane)).toBe(false);
    }
    // The run-alone pass refuses an untagged skip itself (scripts/e2e-alone.ts).
    expect(runs("Linux", "alone")).toBe(false);
  });

  /**
   * INF-800: a computer in CI mode sends its heavy checks through CI, so the
   * journeys a branch names and the replay gate alone each run on request.
   * Neither runs on a pull request it did not already, or on a schedule.
   */
  it("runs named journeys and the replay gate alone on request", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
      jobs: Record<string, { if?: string; steps?: Step[] }>;
    };
    expect(journeys.on.workflow_dispatch.inputs.files?.required).toBe(true);
    const select = journeys.jobs["choose-journeys"]?.steps?.find((step) => step.id === "select");
    expect(select?.run).toContain('scripts/affected-journeys.ts --named "$NAMED"');
    expect(select?.env).toMatchObject({ NAMED: "${{ inputs.files }}" });
    // The pull request's starter coverage does not ride along with a request.
    for (const event of ["pull_request", "workflow_dispatch"])
      expect(
        workflowValue(journeys.jobs["linux-source"]?.if ?? "", { github: { event_name: event } }),
      ).toBe(event === "pull_request");

    const replay = loadYamlFile(".github/workflows/replay.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, { "runs-on": string; steps: Step[] }>;
    };
    expect(Object.keys(replay.on)).toEqual(["workflow_dispatch"]);
    const gate = replay.jobs["replay-gate"];
    expect(gate?.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm replay:gate",
    ]);
  });

  /**
   * INF-941: on 2026-10-22 another task's request for journeys on main
   * (run 39867018455) cancelled INF-933's request (run 39865801314) in the
   * shared group journeys-refs/heads/main, before keyboard-routing ran. A
   * newer push to a pull request still replaces its older run, as PR #341's
   * run 39862278380 replaced 39861114356 that day.
   */
  it("lets a newer push replace its pull request's journeys, and no request cancel another", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    const group = (event_name: string, ref: string, run_id: string) =>
      workflowString(journeys.concurrency.group, { github: { event_name, ref, run_id } });
    expect(journeys.concurrency["cancel-in-progress"]).toBe(true);
    expect(group("pull_request", "refs/pull/341/merge", "39861114356")).toBe(
      group("pull_request", "refs/pull/341/merge", "39862278380"),
    );
    const requests = [
      group("workflow_dispatch", "refs/heads/main", "39865801314"),
      group("workflow_dispatch", "refs/heads/main", "39867018455"),
    ];
    expect(new Set(requests).size).toBe(2);
    // Nor does a request share a group with a pull request's push.
    expect(requests).not.toContain(group("pull_request", "refs/pull/341/merge", "39862278380"));
  });

  /**
   * INF-850: on 2026-10-22 GitHub answered no verify.yml run to a search by
   * result while its plain list held passing ones, and every pull request's
   * chooser failed. INF-1443: on 2026-10-26 the plain list answered 502
   * while GitHub worked out each run's pull requests, and answered every run
   * without them. INF-1578: on 2026-10-27 a passing installer-only run
   * supplied no e2e-results. The step's own script runs against each day's
   * answers and the artifact metadata, including across run-list pages.
   */
  it.each(["2026-10-22", "2026-10-26", "2026-10-27"])(
    "finds the newest passing verify run with journey times in the plain list read on %s",
    async (day) => {
      const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
        jobs: Record<string, { steps: Step[] }>;
      };
      const script = journeys.jobs["choose-journeys"]?.steps.find(
        (step) => step.id === "timing-run",
      )?.with?.script;
      expect(typeof script).toBe("string");
      type Run = { id: number; conclusion: string | null; html_url: string };
      const readings = JSON.parse(read(`tests/fixtures/verify-runs/${day}.json`)) as {
        filtered?: Record<string, { total_count: number; workflow_runs: Run[] }>;
        withPullRequests?: { status: number; data: { message: string } };
        runs: Run[];
      };
      type Artifact = { id: number; name: string; expired: boolean };
      const artifacts = JSON.parse(read("tests/fixtures/verify-runs/timing-artifacts.json")) as {
        runs: Record<string, Artifact[]>;
      };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const execute = new AsyncFunction("core", "github", "context", script);
      const choose = async (
        runs: Run[],
        options: { pageSize?: number; expired?: boolean; artifactError?: Error } = {},
      ) => {
        const outputs: Record<string, string> = {};
        const summaries: string[] = [];
        const summary = {
          addRaw: (text: string) => {
            summaries.push(text);
            return summary;
          },
          write: async () => {},
        };
        // GitHub as it answered: a filtered query its recorded answer, the plain list by page,
        // and its recorded failure when asked to work out each run's pull requests.
        // Leaving the pull requests out filters no run.
        const listWorkflowRuns = async ({
          owner,
          repo,
          workflow_id,
          per_page = 30,
          page = 1,
          exclude_pull_requests = false,
          ...filters
        }: Record<string, string | number | boolean>) => {
          expect({ owner, repo, workflow_id }).toEqual({
            owner: "example",
            repo: "project",
            workflow_id: "verify.yml",
          });
          const query = Object.entries(filters).map(([key, value]) => `${key}=${value}`);
          if (query.length > 0) {
            const answer = readings.filtered?.[query.join("&")];
            if (!answer) throw new Error(`No recorded answer for ${query.join("&")}`);
            return { data: answer };
          }
          const failure = readings.withPullRequests;
          if (failure && exclude_pull_requests !== true) {
            throw Object.assign(new Error(failure.data.message), failure);
          }
          const from = (Number(page) - 1) * Number(per_page);
          const workflow_runs = runs.slice(from, from + Number(per_page));
          return { data: { total_count: runs.length, workflow_runs } };
        };
        const listWorkflowRunArtifacts = vi.fn(async (parameters: Record<string, unknown>) => {
          expect(parameters).toMatchObject({ owner: "example", repo: "project" });
          const runId = Number(parameters.run_id);
          expect(runs.find((run) => run.id === runId)?.conclusion).toBe("success");
          if (options.artifactError) throw options.artifactError;
          const recorded = artifacts.runs[String(runId)];
          if (!recorded) throw new Error(`No recorded artifacts for ${runId}`);
          return recorded
            .filter((artifact) => !parameters.name || artifact.name === parameters.name)
            .map((artifact) => ({
              ...artifact,
              expired: options.expired ?? artifact.expired,
            }));
        });
        // Octokit's pagination hands each page's runs over as the page's data.
        // A smaller page replays the same readings across a page boundary.
        const iterator = async function* (
          method: typeof listWorkflowRuns,
          parameters: Record<string, string | number | boolean>,
        ) {
          for (let page = 1; ; page++) {
            const { data } = await method({
              ...parameters,
              per_page: options.pageSize ?? parameters.per_page ?? 30,
              page,
            });
            if (data.workflow_runs.length === 0) return;
            yield { data: data.workflow_runs };
          }
        };
        const paginate = Object.assign(
          async (method: typeof listWorkflowRunArtifacts, parameters: Record<string, unknown>) =>
            method(parameters),
          { iterator },
        );
        await execute(
          { setOutput: (name: string, value: string) => (outputs[name] = value), summary },
          { rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts } }, paginate },
          { repo: { owner: "example", repo: "project" } },
        );
        return { outputs, summaries };
      };

      // Newer runs failed, are still going, or passed without journey times.
      const passing = readings.runs.find(
        (run) =>
          run.conclusion === "success" &&
          artifacts.runs[String(run.id)]?.some((artifact) => artifact.name === "e2e-results"),
      );
      expect(readings.runs.indexOf(passing as Run)).toBeGreaterThan(0);
      for (const pageSize of [undefined, 1]) {
        const found = await choose(readings.runs, { pageSize });
        expect(found.outputs.id).toBe(passing?.id);
        expect(found.summaries.join("")).toContain(passing?.html_url);
      }

      // INF-2259: missing optional history no longer blocks explicit selections.
      // It still supplies no invented run identifier or downloadable timings.
      expect(
        (await choose(readings.runs.filter((run) => run.conclusion !== "success"))).outputs,
      ).toEqual({});
      const throughPassing = readings.runs.slice(0, readings.runs.indexOf(passing as Run) + 1);
      expect((await choose(throughPassing, { expired: true })).outputs).toEqual({});
      // An unreadable artifact list is not evidence that the run has no artifact.
      await expect(
        choose(readings.runs, { artifactError: new Error("Artifact API unavailable") }),
      ).rejects.toThrow("Artifact API unavailable");
      if (day === "2026-10-27") {
        expect((await choose(readings.runs.slice(0, -1))).outputs).toEqual({});
      }
    },
  );

  /**
   * Captain: "ok move it too but as a separate task" extends INF-2224
   * to probes: retain the real PR gates, move all full sweeps to main.
   * Exercise the actual job condition with GitHub's expression evaluator,
   * including a release's own notes pull request, rather than looking for a
   * string. No upstream jobs: the implicit success() condition is true here.
   */
  it.each([
    ["requested full sweep", "workflow_dispatch", "", "refs/heads/fm/task-ci-contract"],
    ["ordinary proposal", "pull_request", "fm/task-ci-contract", "refs/pull/42/merge"],
    ["release notes and record", "pull_request", "fm/task-release-alpha", "refs/pull/471/merge"],
  ])("runs the real Linux gate for %s", (_name, eventName, headRef, ref) => {
    const ci = loadYamlFile(".github/workflows/ci.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, CiJob>;
    };
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
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.needs, id).toBeUndefined();
      const expression = (job.if ?? "true").replace(/^\$\{\{\s*|\s*\}\}$/g, "");
      const ast = new Parser(new Lexer(expression).lex().tokens, ["github"], []).parse();
      const eligible = new Evaluator(ast, new data.Dictionary({ key: "github", value: github }));
      const fullSweep = id === "unit-tests" || id === "integration-tests" || id === "probe-tests";
      expect(eligible.evaluate().coerceString(), id).toBe(
        fullSweep && eventName === "pull_request" ? "false" : "true",
      );
      // A no-op success would not solve the problem: keep the real gate and
      // fail on any gate step's failure, without introducing step-level skips.
      // INI-9's plan: every job runs where LINUX_RUNNER sends it, the
      // placement service's shell-pc-linux places, and back on GitHub's
      // hosted Linux when the variable is unset.
      expect(workflowString(job["runs-on"], { vars: {} }), id).toBe("ubuntu-latest");
      expect(workflowString(job["runs-on"], { vars: { LINUX_RUNNER: "shell-pc-linux" } }), id).toBe(
        "shell-pc-linux",
      );
      expect(job["continue-on-error"], id).toBeFalsy();
      expect(
        job.steps.every(
          (step) =>
            !step["continue-on-error"] &&
            (step.uses === "./.github/actions/linux-startup" || !step.if),
        ),
        id,
      ).toBe(true);
    }
    // Every machine installs from the lockfile before it runs anything, and
    // the jobs together run each check once; the tests are the next case's.
    for (const { name, runs } of ciJobs())
      expect(runs[0], name).toBe("pnpm install --frozen-lockfile");
    const checks = ciJobs()
      .flatMap(({ runs }) => runs.slice(1))
      .filter((run) => !run.startsWith("pnpm test"));
    expect(checks.toSorted()).toEqual([
      "pnpm build",
      "pnpm check",
      "pnpm lint:adherence",
      "pnpm typecheck",
    ]);
  });

  // Captain's small consolidation trial: startup still runs after an unrelated
  // failure, and its two fixture results remain visible without hiding failures.
  it("keeps PR startup fixtures and reporting eligible after earlier failures", () => {
    const ci = loadYamlFile(".github/workflows/ci.yml") as { jobs: Record<string, CiJob> };
    const startup = ci.jobs["typecheck-lint-build"]?.steps.find(
      (step) => step.uses === "./.github/actions/linux-startup",
    );
    expect(startup).toBeDefined();
    const action = loadYamlFile(".github/actions/linux-startup/action.yml") as {
      runs: { steps: CiJob["steps"] };
    };
    const fixtures = action.runs.steps;
    expect(fixtures).toHaveLength(3);
    for (const failed of [false, true]) {
      for (const cancelled of [false, true]) {
        const status = { success: !failed && !cancelled, failure: failed, always: true, cancelled };
        for (const event of ["pull_request", "push", "workflow_dispatch"]) {
          for (const checkout of ["success", "failure", "skipped"]) {
            expect(
              workflowValue(
                startup?.if ?? "false",
                { github: { event_name: event }, steps: { checkout: { outcome: checkout } } },
                status,
              ),
            ).toBe(!cancelled && event === "pull_request" && checkout === "success");
          }
        }
        for (const fixture of fixtures) {
          expect(workflowValue(fixture.if ?? "false", {}, status)).toBe(!cancelled);
          expect(fixture["continue-on-error"]).toBeFalsy();
        }
      }
    }
  });

  // DOP-66 fix 1: the rebuilt shell PC image owns the pnpm store;
  // hosted runners still need setup-node's cache. Evaluate the real inputs.
  it.each([
    ["hosted Linux", {}, "pnpm"],
    ["shell PC", { LINUX_RUNNER: "shell-pc-linux" }, ""],
  ])("selects the pnpm cache for %s", (_name, vars, expected) => {
    const ci = loadYamlFile(".github/workflows/ci.yml") as { jobs: Record<string, CiJob> };
    for (const [id, job] of Object.entries(ci.jobs)) {
      const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setup, id).toBeDefined();
      expect(workflowString(setup?.with?.cache ?? "", { vars }), id).toBe(expected);
    }
  });

  /**
   * FI3-1204 / INF-2224: main runs full sweeps on several machines at once, and
   * split it must still run every test: each vitest project in exactly one
   * job, or in shards of one count that together cover it. The captain
   * explicitly includes every probe, not just affected files.
   */
  it("runs every vitest project once across ci.yml's sweep jobs, a sharded one in shards that cover it", () => {
    const projects = (vitestConfig.test?.projects ?? []).map((project) => {
      const name =
        typeof project === "object" && "test" in project ? project.test?.name : undefined;
      if (typeof name !== "string") throw new Error("every vitest project is named");
      return name;
    });
    expect(projects).toEqual(
      expect.arrayContaining(["pure", "unit", "unit-isolated", "integration", "probe"]),
    );
    const shardsOf = new Map<string, string[]>();
    for (const { name, runs } of ciJobs()) {
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
    expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
    expect(shardsOf.get("probe")).toEqual(["whole"]);
    for (const [project, shards] of shardsOf) {
      const whole = shards.length === 1 && shards[0] === "whole";
      const cover = shards.map((_, index) => `${index + 1}/${shards.length}`);
      expect(whole || shards.toSorted().join() === cover.toSorted().join(), project).toBe(true);
    }
  });

  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number>;
    "continue-on-error"?: boolean;
  };

  /**
   * Whether Actions runs a step in a lane (the mac lane unless named) once
   * the earlier steps ended with these outcomes: its condition through
   * GitHub's own evaluator, with the status functions the job's state gives,
   * and a condition naming none of them runs only on success().
   */
  const stepRuns = (
    step: Step | undefined,
    outcomes: Record<string, string>,
    lane: "mac" | "linux-checks" = "mac",
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
      ["steps", "matrix"],
      functions,
    ).parse();
    const steps = new data.Dictionary(
      ...Object.entries(outcomes).map(([id, outcome]) => ({
        key: id,
        value: new data.Dictionary({ key: "outcome", value: new data.StringData(outcome) }),
      })),
    );
    const matrix = new data.Dictionary({ key: "lane", value: new data.StringData(lane) });
    const context = new data.Dictionary(
      { key: "steps", value: steps },
      { key: "matrix", value: matrix },
    );
    const evaluator = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f])));
    return evaluator.evaluate().coerceString() === "true";
  };

  /**
   * Runs verify's Summarize step as Actions would (bash -e, the stages'
   * outcomes filled in) in a checked-out workspace holding the files `write`
   * names, by their path in the working copy.
   */
  const summarizeRun = (
    summarize: Step | undefined,
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
    expect(reporters.map(([name]) => name)).toEqual([process.env.CI ? "dot" : "list", "json"]);
    // Each local run keeps its JSON result beside its result directories
    // (tests/e2e/runEvidence.ts); verify names the fixed path it keeps.
    const json = reporters.find(([name]) => name === "json")?.[1] as { outputFile?: string };
    expect(json?.outputFile ?? "").not.toBe("");

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
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
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.path === `Application Support/firstmate/${path}`,
      );
    const kept = upload(result);
    const failures = upload("test-results/");
    const demos = upload("test-results/runs/*/*/demo/");
    const runsAfter = (step: Step | undefined, e2eOutcome: string) =>
      stepRuns(step, { e2e: e2eOutcome });
    const outcomes = ["success", "failure", "skipped"];
    expect(outcomes.map((outcome) => runsAfter(kept, outcome))).toEqual([true, true, false]);
    expect(outcomes.map((outcome) => runsAfter(failures, outcome))).toEqual([false, true, false]);
    // A requested demo is kept whether the suite passed or failed.
    expect(outcomes.map((outcome) => runsAfter(demos, outcome))).toEqual([true, true, false]);
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
    // Nothing verify runs holds a secret: release.yml passes it none.
    expect(JSON.stringify(verify)).not.toContain("secrets.");
    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { verify: Record<string, unknown> };
    };
    expect(release.jobs.verify.secrets).toBeUndefined();

    const summarize = steps.find((step) => step.name === "Summarize");
    expect(summarize).toMatchObject({
      if: "always() && matrix.lane == 'mac'",
      "continue-on-error": true,
    });
    expect(summarize?.run).toContain(result);
    // Every stage the job names is reported, by its own outcome, in the job's order.
    const stages = summarize?.env?.STAGES ?? "";
    const reported = [...stages.matchAll(/([\w-]+)=\$\{\{ steps\.([\w-]+)\.outcome \}\}/g)];
    expect(reported.map(([, name, id]) => (name === id ? id : `${name}!=${id}`))).toEqual(
      steps.flatMap((step) => (step.id ? [step.id] : [])),
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
      { install: "success", unit: "success", e2e: "failure" },
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
    const early = summarizeRun(summarize, { install: "success", unit: "failure" });
    expect(early.summary).toContain("First failed stage: **unit**.");
    expect(early.summary).toContain("No e2e result: the suite did not run to its end.");
  });

  /**
   * INF-663 (the captain asked whether the full check discovers every
   * failure or only the first): each stage waits only on the stages it
   * needs, so a red unit test no longer skips the e2e suite, the client
   * check, the replay gate or the package smoke. The job still ends red on
   * any failure, so release.yml still refuses to sign ("signs only after
   * full verification", below).
   */
  it("runs each stage when its own inputs passed, whatever else failed, and still ends red", () => {
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const stage = (id: string) => steps.find((step) => step.id === id);
    const ids = steps.flatMap((step) => (step.id ? [step.id] : []));
    const needs: Record<string, string[]> = {
      unit: ["install"],
      build: ["install"],
      recorder: ["install"],
      e2e: ["build", "recorder"],
      "claude-client": ["install"],
      replay: ["install"],
      "dev-signing": ["install"],
      package: ["build", "dev-signing"],
      codesign: ["package"],
      "data-folder": ["package"],
      "bundled-git": ["package"],
      helper: ["package"],
    };
    const upstream = (id: string): string[] =>
      (needs[id] ?? []).flatMap((input) => [input, ...upstream(input)]);
    for (const [id, inputs] of Object.entries(needs)) {
      // Every earlier stage it does not stand on failed: it still runs.
      const earlier = ids.slice(0, ids.indexOf(id));
      const unrelatedRed = Object.fromEntries(
        earlier.map((other) => [other, upstream(id).includes(other) ? "success" : "failure"]),
      );
      expect(stepRuns(stage(id), unrelatedRed), `${id} after unrelated failures`).toBe(true);
      // Any input red or skipped: it does not.
      for (const input of inputs)
        for (const outcome of ["failure", "skipped"])
          expect(
            stepRuns(stage(id), { ...unrelatedRed, [input]: outcome }),
            `${id} after ${input} ${outcome}`,
          ).toBe(false);
    }

    // The failure INF-663 read on main (release run 39337627117): a red unit
    // stage skipped every later stage. Now each one runs.
    const unitRed = Object.fromEntries(
      ids.map((id) => [id, id === "unit" ? "failure" : "success"]),
    );
    const later = ids.slice(ids.indexOf("unit") + 1).filter((id) => id !== "perf");
    expect(later.filter((id) => !stepRuns(stage(id), unitRed))).toEqual([]);

    // The linux-checks lane the same way: a red check skips none of the others.
    const linux = steps.filter(
      (step) => step.run?.startsWith("pnpm ") && step.if?.includes("linux-checks"),
    );
    expect(linux.map((step) => step.run)).toEqual([
      "pnpm typecheck",
      "pnpm check",
      "pnpm lint:adherence",
      "pnpm test",
    ]);
    for (const step of [...linux, stage("build")]) {
      const afterRed = { install: "success", "an earlier check": "failure" };
      expect(stepRuns(step, afterRed, "linux-checks"), step?.run).toBe(true);
      expect(stepRuns(step, { install: "failure" }, "linux-checks"), step?.run).toBe(false);
    }

    // A red stage still fails the job: only the summary, a report, may not.
    expect(
      steps.filter((step) => step["continue-on-error"]).map((step) => step.name ?? step.id),
    ).toEqual(["Summarize"]);
  });

  /**
   * INF-2255 (the captain chose "Build separately" on "Keep main's full
   * coverage and separate signing proof"): where a check runs and whether it
   * proves real signing are separate. No journey route signs, whatever it
   * selects; the full check's signing proof runs after every stage that
   * launches the dev Electron, stops none of them when it fails, and still
   * ends the lane red.
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
    // Every stage that launches the dev Electron runs before anything signs it.
    for (const launches of ["e2e", "perf"])
      expect(ids.indexOf(launches), launches).toBeLessThan(ids.indexOf("dev-signing"));
    // A red signing stage stops no journey stage, and skips the signed package's checks.
    const stage = (id: string) => steps.find((step) => step.id === id);
    const signingRed = Object.fromEntries(
      ids.map((id) => [id, id === "dev-signing" ? "failure" : "success"]),
    );
    expect(stepRuns(stage("e2e"), signingRed)).toBe(true);
    expect(stepRuns(stage("package"), signingRed)).toBe(false);
    // And it still ends the lane red: no signing stage may pass a failure.
    for (const id of ["dev-signing", "package", "codesign"])
      expect(stage(id)?.["continue-on-error"], id).toBeUndefined();
  });

  /**
   * The run-alone pass (docs/testing.md "Each test owns its prerequisites"):
   * each later Mac-only test of an edited spec file that shares one app runs
   * by itself on the Mac (INF-873: the rest run alone on Linux). INF-2340
   * (captain's route "alone-at-author") moved it from main's full check to
   * journeys.yml's proof of edited journeys: the Mac job hands the run-alone
   * pass the same tag as its rounds and keeps its result, and the full
   * check's mac lane no longer runs it.
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
        step.uses === "actions/upload-artifact@v4" &&
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
    const mac = verify.jobs.lane;
    expect(mac.defaults.run["working-directory"]).toBe("Application Support/firstmate");
    // The default working directory does not exist yet, so the action is
    // fetched on its own and the assertion starts before the real checkout -
    // on the mac lane, the only one on a Mac.
    expect(mac.steps[0]).toMatchObject({ if: "matrix.lane == 'mac'" });
    expect(mac.steps[1]).toMatchObject({ if: "matrix.lane == 'mac'" });
    expect(mac.steps[0]?.uses).toBe("actions/checkout@v4");
    expect(mac.steps[0]?.with?.["sparse-checkout"]).toBe(".github/actions/keep-mac-awake");
    expect(mac.steps[1]?.uses).toBe(actionRef);
    expect(mac.steps[2]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { path: "Application Support/firstmate" },
    });
    const awakeAt = (steps: Step[]) => steps.findIndex((step) => step.uses === actionRef);
    expect(awakeAt(mac.steps)).toBeLessThan(
      mac.steps.findIndex((step) => step.run?.includes("pnpm test")),
    );

    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { release: { steps: Step[] } };
    };
    const signing = release.jobs.release.steps;
    expect(signing[0]?.uses).toBe("actions/checkout@v4");
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

describe("signed release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("enforces the pinned identity", () => {
    expect(workflow).toContain('SIGN_IDENTITY: "Developer ID Application: Kun Chen (9T2J7MNUP9)"');
    expect(workflow).toContain("TEAM_ID: 9T2J7MNUP9");
  });

  it("resolves the documented signing and publication credentials through the workflow's expressions", () => {
    // Revised INF-643: independent credentials preserve both publication destinations.
    const names = [
      "MAC_DEVELOPER_ID_CERT_P12",
      "MAC_DEVELOPER_ID_CERT_PASSWORD",
      "APP_STORE_CONNECT_KEY_ID",
      "APP_STORE_CONNECT_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY",
      "R2_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "HOMEBREW_TAP_TOKEN",
      "OLD_TAP_TOKEN",
    ];
    const secrets = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
    const parsed = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<string, { steps?: { id?: string; env?: Record<string, string> }[] }>;
    };
    const expressions = Object.values(parsed.jobs)
      .flatMap((job) => (job.steps ?? []).flatMap((step) => Object.values(step.env ?? {})))
      .filter((value) => /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(value));
    expect(
      new Set(expressions.map((expression) => workflowValue(expression, { secrets }))),
    ).toEqual(new Set(Object.values(secrets)));
    // Storage credentials belong only to the upload/switch recipients, never rehearsal or public fetch-back,
    // all in the publication job since INF-1716.
    const publication = (id: string) => {
      const found = parsed.jobs.publish?.steps?.find((step) => step.id === id);
      if (!found) throw new Error(`release.yml's publication job has no step "${id}"`);
      return found;
    };
    for (const id of ["public", "feeds"]) {
      const environment = publication(id).env;
      for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        expect(workflowValue(environment?.[name] ?? "", { secrets })).toBe(secrets[name]);
      }
    }
    for (const id of ["feed-rehearsal", "public-fetch-back"]) {
      const environment = publication(id).env ?? {};
      expect(Object.keys(environment)).not.toContain("R2_ENDPOINT");
      expect(Object.keys(environment)).not.toContain("R2_ACCESS_KEY_ID");
      expect(Object.keys(environment)).not.toContain("R2_SECRET_ACCESS_KEY");
    }
  });

  it("runs every gate: verify, launch, notarize, staple, re-download", () => {
    expect(workflow).toContain("scripts/verify-app.sh");
    expect(workflow).toContain("--signed --gatekeeper");
    expect(workflow).toContain("scripts/check-app-launch.sh");
    expect(workflow).toContain("xcrun notarytool submit");
    expect(workflow).toContain("xcrun stapler staple");
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("shasum -a 256 -c");
  });

  it("takes the umami config from repository variables, not secrets", () => {
    expect(workflow).toContain("vars.INFINITARY_UMAMI_HOST");
    expect(workflow).toContain("vars.INFINITARY_UMAMI_WEBSITE_ID");
    expect(workflow).not.toContain("secrets.INFINITARY_UMAMI");
  });
});

type CiJob = {
  name?: string;
  if?: string;
  needs?: unknown;
  "runs-on": string;
  "continue-on-error"?: boolean;
  strategy?: { matrix: Record<string, unknown[]> };
  steps: Array<{
    run?: string;
    uses?: string;
    with?: Record<string, string>;
    if?: string;
    "continue-on-error"?: boolean;
  }>;
};

/**
 * The PR gate's machines: one per ci.yml job and matrix entry, each with
 * its name and its steps' commands interpolated as GitHub Actions does.
 */
function ciJobs(): { name: string; runs: string[] }[] {
  const ci = loadYamlFile(".github/workflows/ci.yml") as { jobs: Record<string, CiJob> };
  return Object.entries(ci.jobs).flatMap(([id, job]) => {
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
        name: workflowString(job.name ?? id, contexts),
        runs: job.steps.flatMap((step) => (step.run ? [workflowString(step.run, contexts)] : [])),
      };
    });
  });
}

/**
 * The release's one source commit and its names (docs/alpha.md "The signed
 * channel workflow"), by running the resolve job's own script on stand-in
 * clones: an alpha releases its reviewed candidate, a stable promotes a
 * published alpha's own commit, and both are numbered from the newest
 * stable tag.
 */
describe("resolving a release", () => {
  const script = join(root, "scripts", "resolve-release.sh");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const release = loadYamlFile(".github/workflows/release.yml") as { env: Record<string, string> };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=resolve", "-c", "user.email=resolve@localhost", ...args],
      { cwd, env: gitEnv, encoding: "utf8" },
    ).trim();

  /**
   * A stand-in clone on main: stable v0.1.25, a fix, alpha v0.1.26-alpha.12
   * on it, another fix and alpha v0.1.26-alpha.13, and a last commit nothing
   * was built from. origin/main is main's head, as the resolve job's full
   * checkout has it.
   */
  function fixture() {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      return git(clone, "rev-parse", "HEAD");
    };
    commit("chore: first", { "src.txt": "0", "release-notes/changes/first.json": "{}" });
    git(clone, "tag", "v0.1.25");
    commit("fix: one", { "src.txt": "1" });
    git(clone, "tag", "v0.1.26-alpha.12");
    commit("chore: two");
    const alpha13 = commit("fix: three", { "src.txt": "3" });
    git(clone, "tag", "v0.1.26-alpha.13");
    const head = commit("fix: after the alpha", { "src.txt": "4" });
    git(clone, "update-ref", "refs/remotes/origin/main", head);
    return { clone, commit, alpha13, head };
  }

  it("keeps a promoted source's download destination when main selects a different host", () => {
    // INF-640: an updater and the publication it reads must use the same selected destination.
    const f = fixture();
    const configuration = read("packaging/release-source.json");
    const source = f.commit("feat: select the download host", {
      "packaging/release-source.json": configuration,
    });
    f.commit("chore: select a different future host", {
      "packaging/release-source.json": JSON.stringify({
        ...JSON.parse(configuration),
        downloadBase: "https://future-downloads.example/",
      }),
    });
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { resolve: { steps: { id?: string; run?: string }[] } };
    };
    const body = workflow.jobs.resolve.steps.find((step) => step.id === "destination")?.run;
    if (!body) throw new Error("The source destination reader is missing");
    const output = join(scratchDir("inf-release-source-output-"), "output");
    const result = spawnSync("bash", ["-c", body], {
      cwd: f.clone,
      encoding: "utf8",
      env: { ...gitEnv, SOURCE_COMMIT: source, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `repository=${JSON.parse(configuration).repository}\ndownload_base=${JSON.parse(configuration).downloadBase}\n`,
    );
  });

  /** Runs the resolver in a clone, returning its outputs. */
  function resolve(clone: string, env: Record<string, string>) {
    const output = join(scratchDir("infinitary-release-resolve-output-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", [script], {
      cwd: clone,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...gitEnv,
        TAP_REPO: release.env.TAP_REPO ?? "",
        TAP_TAG_PREFIX: release.env.TAP_TAG_PREFIX ?? "",
        OLD_TAP_REPO: release.env.OLD_TAP_REPO ?? "",
        OLD_TAP_TAG_PREFIX: release.env.OLD_TAP_TAG_PREFIX ?? "",
        GITHUB_OUTPUT: output,
        CHANNEL: "alpha",
        DRY_RUN: "false",
        REF: "refs/heads/main",
        RUN_NUMBER: "7",
        CANDIDATE: "",
        PROMOTE: "",
        HIGHLIGHTS: "",
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status: result.status, stderr: result.stderr, outputs };
  }

  /** The names a version's release carries, as the update reader builds them. */
  const publicNames = (version: string, commit: string) => {
    const target = buildUpdateTarget({
      version,
      assetName: `Infinitary-${version}-universal.zip`,
      sha256: CASK_SHA256,
      sourceCommit: commit,
    });
    return {
      zip_name: `Infinitary-${version}-universal.zip`,
      release_url: target.releaseUrl,
      download_url: target.downloadUrl,
      public_tag: target.releaseUrl.slice(target.releaseUrl.lastIndexOf("/") + 1),
    };
  };

  /**
   * The names the old-cask switch would publish the same version under, as
   * an installed Firstmate 3000's reader builds them (FI3-1780 step 10).
   */
  const oldNames = (version: string) => ({
    old_public_tag: publicTagFor(version, FIRSTMATE_TAP),
    old_download_url: buildDownloadUrl(
      version,
      `Infinitary-${version}-universal.zip`,
      FIRSTMATE_TAP,
    ),
  });

  const refusedWith = (result: ReturnType<typeof resolve>, reason: RegExp) => {
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(reason);
    expect(result.outputs).toEqual({});
  };

  it("releases the reviewed candidate: main's own commit or a notes-only commit off it, never a code change", () => {
    const { clone, commit, head } = fixture();
    // A main commit.
    const onMain = resolve(clone, { CANDIDATE: head });
    expect(onMain.status, onMain.stderr).toBe(0);
    expect(onMain.outputs.source_commit).toBe(head);
    // The release crewmate's review, committed on its own branch, while main moves on.
    git(clone, "checkout", "-q", "-b", "fm/release-review");
    const review = commit("docs(release-notes): review the next alpha", {
      "release-notes/changes/first.json": '{"reviewed": true}',
      "release-notes/releases/0.1.26-alpha.13.json": "{}",
    });
    git(clone, "checkout", "-q", "main");
    const moved = commit("feat: merged during the review", { "src.txt": "5" });
    git(clone, "update-ref", "refs/remotes/origin/main", moved);
    const notesOnly = resolve(clone, { CANDIDATE: review });
    expect(notesOnly.status, notesOnly.stderr).toBe(0);
    expect(notesOnly.outputs).toMatchObject({ source_commit: review, version: "0.1.26-alpha.7" });
    // A candidate that changes code is refused, and so is anything but a pushed commit id.
    git(clone, "checkout", "-q", "-b", "fm/sneaky", review);
    const code = commit("docs(release-notes): review, and a fix", { "src.txt": "6" });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: code }),
      /changes more than release notes since main's [0-9a-f]{40} \(src\.txt\)/,
    );
    git(clone, "checkout", "-q", "fm/sneaky");
    const wide = commit("chore: and much more", {
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`${name}.txt`, name])),
    });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: wide }),
      /\(a\.txt b\.txt c\.txt d\.txt e\.txt and 1 more\)/,
    );
    refusedWith(resolve(clone, { CANDIDATE: review.slice(0, 12) }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "fm/release-review" }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "f".repeat(40) }), /on no branch of the repository/);
    // A live alpha needs one; a rehearsal may build the checked-out commit.
    refusedWith(resolve(clone, {}), /a live alpha releases a candidate/);
    expect(resolve(clone, { DRY_RUN: "true" }).outputs.source_commit).toBe(moved);
  });

  it("numbers an alpha from the newest stable tag and the run, the next minor after a breaking change", () => {
    const { clone, commit, head } = fixture();
    const alpha = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "312" });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toEqual({
      channel: "alpha",
      dry_run: "false",
      source_commit: head,
      version: "0.1.26-alpha.312",
      bundle_version: "0.1.26",
      tag_name: "v0.1.26-alpha.312",
      ...publicNames("0.1.26-alpha.312", head),
      cask_token: CASK_TOKENS.alpha,
      old_cask: "false",
      ...oldNames("0.1.26-alpha.312"),
      prerelease: "true",
      promoted_from: "",
      highlights: "",
    });
    expect(alpha.outputs.public_tag).toBe("infinitary-alpha-v0.1.26-alpha.312");
    expect(isAlphaVersion(alpha.outputs.version as string)).toBe(true);
    // Later runs sort later: alpha.10 is newer than alpha.9.
    const ninth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "9" });
    const tenth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "10" });
    expect(
      compareSemver(tenth.outputs.version as string, ninth.outputs.version as string),
    ).toBeGreaterThan(0);
    // Only bare stable tags number a release.
    git(clone, "tag", "v9.9.9-beta.1");
    git(clone, "tag", "infinitary-v9.0.0");
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.26-alpha.7");
    // A newer stable moves the line; a breaking change since it takes the next minor.
    git(clone, "tag", "v0.1.26", head);
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.27-alpha.7");
    const breaking = commit("feat(cards)!: drop the old card shape", { "src.txt": "7" });
    git(clone, "update-ref", "refs/remotes/origin/main", breaking);
    expect(resolve(clone, { CANDIDATE: breaking }).outputs.version).toBe("0.2.0-alpha.7");
    // INF-228 F2: the actual squash-summary owner keeps the release reader's footer reachable.
    const footer = commit(
      `fix: x\n\n${presentationCommitMessage({
        whatChanged: ["Move saved data to the new folder."],
        projectText: "BREAKING CHANGE: saved data moves",
      })}`,
      { "src.txt": "8" },
    );
    git(clone, "tag", "v0.2.0", breaking);
    git(clone, "update-ref", "refs/remotes/origin/main", footer);
    expect(resolve(clone, { CANDIDATE: footer }).outputs.version).toBe("0.3.0-alpha.7");
    // A rehearsal may run from any branch; a live alpha comes from main.
    expect(
      resolve(clone, { DRY_RUN: "true", REF: "refs/heads/fm/x", RUN_NUMBER: "8" }).outputs.version,
    ).toBe("0.3.0-alpha.8");
    for (const [env, reason] of [
      [{ CANDIDATE: footer, REF: "refs/heads/fm/x" }, /a live alpha is requested from main/],
      [{ CANDIDATE: footer, PROMOTE: "0.1.26-alpha.13" }, /promote is for stable/],
      [{ CANDIDATE: footer, HIGHLIGHTS: "lead-change" }, /highlights are for stable/],
      [{ CANDIDATE: footer, RUN_NUMBER: "0" }, /not a positive whole number/],
      [{ CHANNEL: "beta" }, /neither stable nor alpha/],
    ] as const) {
      refusedWith(resolve(clone, env), reason);
    }
  });

  // The old-cask switch (FI3-1780 step 10; steps 13 and 14 list a channel):
  // only a channel the workflow commit's switch file lists also publishes
  // under Firstmate 3000's cask.
  it("switches Firstmate 3000's cask only for a channel the switch file lists", () => {
    const { clone, head } = fixture();
    expect(resolve(clone, { CANDIDATE: head }).outputs.old_cask).toBe("false");
    mkdirSync(join(clone, "packaging"), { recursive: true });
    writeFileSync(
      join(clone, "packaging", "old-cask-switch.json"),
      JSON.stringify({ schemaVersion: 1, channels: ["alpha"] }),
    );
    const alpha = resolve(clone, { CANDIDATE: head });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toMatchObject({ old_cask: "true", ...oldNames("0.1.26-alpha.7") });
    expect(alpha.outputs.old_public_tag).toBe("firstmate-3000-alpha-v0.1.26-alpha.7");
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs.old_cask).toBe("false");
    // The repository's own switch file lists alpha (step 13, INF-35) and
    // stable (step 14, INF-36): both of Firstmate 3000's casks move to Infinitary.
    expect(
      JSON.parse(readFileSync(join(root, "packaging", "old-cask-switch.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, channels: ["alpha", "stable"] });
  });

  it("promotes a published alpha newer than the latest stable on the alpha's own commit, with the captain's picks and no pull request", () => {
    const HIGHLIGHTS = "lead-change, second-change,third-change";
    for (const alpha of ["0.1.26-alpha.13", "0.1.26-alpha.12"]) {
      const { clone } = fixture();
      const commit = git(clone, "rev-parse", `v${alpha}^{commit}`);
      const promoted = resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS });
      expect(promoted.status, promoted.stderr).toBe(0);
      expect(promoted.outputs).toEqual({
        channel: "stable",
        dry_run: "false",
        source_commit: commit,
        version: "0.1.26",
        bundle_version: "0.1.26",
        tag_name: "v0.1.26",
        ...publicNames("0.1.26", commit),
        cask_token: CASK_TOKENS.stable,
        old_cask: "false",
        ...oldNames("0.1.26"),
        prerelease: "false",
        promoted_from: alpha,
        highlights: "lead-change,second-change,third-change",
      });
      expect(promoted.outputs.public_tag).toBe("infinitary-v0.1.26");
      // The release tags that same commit; promoting it again retries the
      // same promotion, and any other alpha of that version is refused.
      git(clone, "tag", "v0.1.26", commit);
      expect(
        resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS }).outputs.source_commit,
      ).toBe(commit);
      const other = alpha.endsWith(".13") ? "0.1.26-alpha.12" : "0.1.26-alpha.13";
      refusedWith(
        resolve(clone, { CHANNEL: "stable", PROMOTE: other, HIGHLIGHTS }),
        /already released/,
      );
    }
    // A stable rehearsal may build the checked-out commit as the next stable,
    // and keep the alpha reviews' ranks.
    const { clone, head } = fixture();
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs).toMatchObject({
      source_commit: head,
      version: "0.1.26",
      promoted_from: "",
      highlights: "",
    });
  });

  it.each([
    [{ REF: "refs/heads/fm/x" }, /a promotion is requested from main/],
    [{ PROMOTE: "0.1.26" }, /not an alpha version/],
    [{ PROMOTE: "0.1.26-alpha.99" }, /is not published/],
    [{ PREPARE: "newer-stable" }, /not newer than the latest stable, 0\.1\.27/],
    [{ PREPARE: "no-feat-fix" }, /nothing to release/],
    [{ PROMOTE: "" }, /a stable promotes a published alpha/],
    [{ CANDIDATE: "c".repeat(40) }, /candidate is for alpha/],
    [{ HIGHLIGHTS: "" }, /a stable ships the highlights the captain picked on its card/],
    [{ HIGHLIGHTS: "lead-change,Second" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,three-c,four-d" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,one-a" }, /name a change twice/],
  ])("refuses the stable promotion %j", (env, reason) => {
    const { clone, commit } = fixture();
    const { PREPARE, ...rest } = {
      HIGHLIGHTS: "lead-change,second-change,third-change",
      ...env,
    } as Record<string, string>;
    let promote = "0.1.26-alpha.13";
    if (PREPARE === "newer-stable") {
      git(clone, "tag", "v0.1.27");
    } else if (PREPARE === "no-feat-fix") {
      git(clone, "tag", "-f", "v0.1.25");
      commit("chore: x");
      git(clone, "tag", "v0.1.26-alpha.14");
      promote = "0.1.26-alpha.14";
    }
    refusedWith(resolve(clone, { CHANNEL: "stable", PROMOTE: promote, ...rest }), reason);
  });

  /**
   * Step 7 of the Infinitary rename (FI3-1780's plan): a repository that
   * starts again from one parentless commit has no tag to number from, so it
   * numbers from the record of past releases, above every version either
   * channel published, until it tags a stable of its own.
   */
  it("numbers a fresh history above every version its record of past releases names", () => {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      const head = git(clone, "rev-parse", "HEAD");
      git(clone, "update-ref", "refs/remotes/origin/main", head);
      return head;
    };
    const archive = (stable: string, alpha: string) =>
      JSON.stringify({ schema: 1, repository: "owner/archived", stable, alpha, releases: {} });
    const root = commit("chore: initialize from the archived tree", {
      "src.txt": "0",
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    expect(git(clone, "rev-list", "--count", "--all")).toBe("1");
    // Run numbers start again in a new repository, and still sort above the archive.
    const first = resolve(clone, { CANDIDATE: root, RUN_NUMBER: "1" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({ source_commit: root, version: "0.4.2-alpha.1" });
    // An alpha the archived history cut past its last stable lifts the line too.
    commit("chore: an alpha past the stable", {
      "release-notes/archive.json": archive("0.4.1", "0.4.2-alpha.80"),
    });
    const past = commit("fix: something");
    expect(resolve(clone, { CANDIDATE: past, RUN_NUMBER: "2" }).outputs.version).toBe(
      "0.4.3-alpha.2",
    );
    // A breaking change anywhere in this history takes the next minor.
    const breaking = commit("feat(cards)!: a new card shape");
    expect(resolve(clone, { CANDIDATE: breaking, RUN_NUMBER: "3" }).outputs.version).toBe(
      "0.5.0-alpha.3",
    );
    // A stable promotes past the archived stable, with no tag of it here.
    git(clone, "tag", "v0.5.0-alpha.3", breaking);
    const promoted = resolve(clone, {
      CHANNEL: "stable",
      PROMOTE: "0.5.0-alpha.3",
      HIGHLIGHTS: "lead-change",
    });
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(promoted.outputs).toMatchObject({ source_commit: breaking, version: "0.5.0" });
    // Once this history tags its own stable, it numbers from that.
    git(clone, "tag", "v0.5.0", breaking);
    const after = commit("fix: after the first stable");
    expect(resolve(clone, { CANDIDATE: after, RUN_NUMBER: "4" }).outputs.version).toBe(
      "0.5.1-alpha.4",
    );
    // A version at or below an archived one is refused, whatever tag says otherwise.
    git(clone, "tag", "-d", "v0.5.0");
    git(clone, "tag", "-d", "v0.5.0-alpha.3");
    const stray = commit("chore: back to the archived line", {
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    git(clone, "tag", "v0.4.0", stray);
    const low = commit("fix: numbered from a stray old tag");
    refusedWith(
      resolve(clone, { CANDIDATE: low, RUN_NUMBER: "5" }),
      /0\.4\.1-alpha\.5 is not newer than 0\.4\.1, which the archived history already published/,
    );
  });

  it("opens no pull request: no release proposal workflow, its configuration or its branch script remains", () => {
    for (const retired of [
      ".github/workflows/release-please.yml",
      "release-please-config.json",
      ".release-please-manifest.json",
      "scripts/promote-alpha.sh",
    ]) {
      expect(existsSync(join(root, retired)), retired).toBe(false);
    }
    for (const name of [
      "ci.yml",
      "release.yml",
      "mac-installer.yml",
      "mac-update.yml",
      "verify.yml",
    ]) {
      const workflow = loadYamlFile(`.github/workflows/${name}`) as {
        on: Record<string, unknown>;
        permissions?: Record<string, string>;
      };
      expect(workflow.permissions?.["pull-requests"], name).toBeUndefined();
      expect(read(`.github/workflows/${name}`), name).not.toMatch(
        /gh pr create|create-pull-request/,
      );
    }
  });
});

describe("the signed channel workflow", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = {
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
    steps?: Step[];
  };
  type Workflow = {
    on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
    concurrency: { group: string; "cancel-in-progress": string };
    env: Record<string, string>;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const jobOf = (workflow: Workflow, id: string): Job => {
    const job = workflow.jobs[id];
    if (!job) throw new Error(`no job "${id}"`);
    return job;
  };
  // INF-1716: the signing job ends at the checked disk image, and the
  // publication job continues from its handoff; a release's operations are
  // the signing job's steps followed by the publication job's.
  const signingSteps = jobOf(release, "release").steps ?? [];
  const publishSteps = jobOf(release, "publish").steps ?? [];
  const steps = [...signingSteps, ...publishSteps];
  const step = (id: string) => {
    const found = steps.find((candidate) => (candidate.id ?? candidate.name) === id);
    if (!found) throw new Error(`release.yml's signing and publication jobs have no step "${id}"`);
    return found;
  };
  const lane = jobOf(verify, "lane");
  /** The lanes verify runs for a profile, through its own matrix expression. */
  const lanes = (profile?: string) =>
    workflowValue(lane.strategy?.matrix.lane ?? "", { inputs: profile ? { profile } : {} });

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
    expect(runner("linux-checks", "mini-mac-inf621-proof", "mini-mac")).toBe("ubuntu-latest");
  });

  it("runs each profile's lanes as one matrix, so an omitted lane is absent from the run, never skipped", () => {
    expect(Object.keys(verify.jobs)).toEqual(["linux-e2e", "installer", "lane"]);
    expect(verify.jobs["linux-e2e"]).toMatchObject({
      uses: "./.github/workflows/source-journeys.yml",
      with: { ref: "${{ inputs.ref || github.ref }}", suite: "full" },
    });
    expect(lanes("stable")).toEqual(["linux-checks", "mac"]);
    expect(lanes()).toEqual(["linux-checks", "mac"]);
    expect(lanes("alpha")).toEqual(["linux-checks", "mac"]);
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
      "rehearse",
      "release",
      "update",
      "publish",
    ]);
    const runner = (name: string) =>
      workflowValue(lane["runs-on"] ?? "", { matrix: { lane: name }, inputs: {}, vars: {} });
    expect(runner("linux-checks")).toBe("ubuntu-latest");
    expect(runner("mac")).toBe("macos-15");
    // What each lane runs, by its own step conditions on a passing run: the
    // linux-checks lane retains the full main gate, replacing the separate
    // cohort sweeps and changed-test repetitions with the full suite; the
    // Mac lane retains its Mac-only selection.
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
    const mainGate = ciJobs().flatMap(({ runs }) =>
      runs.map((run) => (/^pnpm test(:probes|:repeats)? /.test(run) ? "pnpm test" : run)),
    );
    expect(runsIn("linux-checks").toSorted()).toEqual([...new Set(mainGate)].toSorted());
    expect(runsIn("mac")).toEqual(
      expect.arrayContaining([
        'mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n',
        "pnpm build",
        VERIFY_E2E_RUN,
        "pnpm replay:gate",
      ]),
    );
    expect(runsIn("mac")).not.toContain("pnpm typecheck");
    // The publication's summary names each profile's lanes and what it
    // omits, from the same profiles.
    const summary = step("Summarize the publication").env ?? {};
    for (const required of ["true", "false"]) {
      const context = {
        needs: {
          resolve: { outputs: { verify_required: required, full_verify_required: required } },
        },
      };
      expect(workflowValue(summary.LANES ?? "", context)).toBe(
        required === "true" ? "linux-checks, linux-e2e, mac" : "none",
      );
      expect(workflowValue(summary.OMITTED ?? "", context)).toMatch(
        required === "true" ? /^none$/ : /inherited from the published alpha, not passed/,
      );
    }
  });

  // Captain's accepted INF-1258 mac-unit-only option: all files still run
  // on Linux, and Mac retains every reviewed native/mixed file. Discover via
  // the real runner rather than matching strings in test source. --filesOnly
  // never imports a test or enables the opt-in Keychain probes.
  it("keeps the complete Linux suite and selects only the reviewed Mac files", () => {
    const unit = (lane.steps ?? []).find((candidate) => candidate.id === "unit");
    expect(unit?.run).toBe('mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n');
    const linuxTests = (lane.steps ?? []).filter(
      (candidate) =>
        candidate.run === "pnpm test" &&
        workflowValue(candidate.if ?? "", {
          matrix: { lane: "linux-checks" },
          steps: { install: { outcome: "success" } },
        }) === true,
    );
    expect(linuxTests).toHaveLength(1);
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
    expect(linux.filter(({ file }) => file === "tests/release-workflows.test.ts")).toEqual([
      { file: "tests/release-workflows.test.ts", projectName: "integration" },
    ]);
    expect(mac.some(({ file }) => file === "tests/release-workflows.test.ts")).toBe(false);
    expect(mac).toContainEqual({
      file: "tests/release-contract.test.ts",
      projectName: "integration",
    });
  }, 15_000);

  // INF-2074's sign-early, the captain's checked fix: "Build and sign an
  // alpha while its checks run, and publish only after they pass." The
  // signing job waits for the notes, the phone and the update rehearsal,
  // never for a verify lane or the Linux packages; the update check, the
  // record and publication wait for every check.
  it("records and publishes only after full verification or explicitly inherited verification, never after a failed lane, and signs while the lanes run", () => {
    const signing = jobOf(release, "release");
    const update = jobOf(release, "update");
    const publish = jobOf(release, "publish");
    expect(signing.needs).toEqual(["resolve", "notes", "rehearse", "phone"]);
    for (const required of ["true", "false", ""]) {
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        const needs = {
          resolve: {
            result: "success",
            outputs: { verify_required: required, full_verify_required: required },
          },
          notes: { result: "success" },
          verify: { result },
          linux: { result: "success" },
          rehearse: { result: required === "true" ? "success" : "skipped" },
          phone: { result: "success" },
          release: { result: "success" },
          update: { result: required === "true" ? "success" : "skipped" },
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
        expect(workflowValue(publish.if ?? "", { needs })).toBe(verified);
        // Linux packages that did not pass on clean systems hold the update
        // check and publication, never the signing.
        for (const linux of ["failure", "cancelled", "skipped"]) {
          const held = { needs: { ...needs, linux: { result: linux } } };
          expect(workflowValue(signing.if ?? "", held)).toBe(
            required === "true" || required === "false",
          );
          expect(workflowValue(update.if ?? "", held)).toBe(false);
          expect(workflowValue(publish.if ?? "", held)).toBe(false);
        }
        // INF-1900: a failed update rehearsal stops the release before signing.
        for (const rehearse of ["failure", "cancelled", ""]) {
          for (const job of [signing, update, publish]) {
            expect(
              workflowValue(job.if ?? "", {
                needs: { ...needs, rehearse: { result: rehearse } },
              }),
            ).toBe(false);
          }
        }
        // INF-1649: a release with no phone build that keeps changing things on it never signs.
        for (const phone of ["failure", "cancelled", "skipped"]) {
          for (const job of [signing, update, publish]) {
            expect(
              workflowValue(job.if ?? "", {
                needs: { ...needs, phone: { result: phone } },
              }),
            ).toBe(false);
          }
        }
        // A release whose notes were not checked never signs, whatever else passed.
        for (const notes of ["failure", "cancelled", "skipped"]) {
          for (const job of [signing, update, publish]) {
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

  // INF-1716, the captain's "After the disk-image check": the real Mac signs
  // through the checked disk image, and one existing virtual Mac publishes
  // from the signing job's handoff, only once that job succeeded.
  it("publishes only after the signing job succeeded, in one virtual Mac, from its handoff", () => {
    const publish = jobOf(release, "publish");
    expect(publish.needs).toEqual([
      "resolve",
      "notes",
      "verify",
      "linux",
      "rehearse",
      "phone",
      "release",
      "update",
    ]);
    expect(
      workflowValue(publish["runs-on"] ?? "", {
        needs: { resolve: { outputs: { dry_run: "false" } } },
        vars: {},
      }),
    ).toBe("mini-mac-virtual");
    // Every check passed, or was inherited, as a passing run leaves them.
    const checks = (required: string) => ({
      notes: { result: "success" },
      verify: { result: required === "true" ? "success" : "skipped" },
      linux: { result: "success" },
      rehearse: { result: required === "true" ? "success" : "skipped" },
      phone: { result: "success" },
    });
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const cancelled of [false, true]) {
        // INF-1900: an alpha publishes only after its update check passed on
        // both chips; a stable inherits its alpha's and skips it.
        for (const [required, update, publishes] of [
          ["true", "success", true],
          ["true", "failure", false],
          ["true", "skipped", false],
          ["false", "skipped", true],
          ["false", "success", false],
        ] as const) {
          const needs = {
            resolve: {
              result: "success",
              outputs: { verify_required: required, full_verify_required: required },
            },
            ...checks(required),
            release: { result },
            update: { result: update },
          };
          expect(
            workflowValue(
              publish.if ?? "",
              { needs },
              { success: result === "success", failure: false, always: true, cancelled },
            ),
            `${result}${cancelled ? ", run cancelled" : ""}, verify ${required}, update ${update}`,
          ).toBe(result === "success" && !cancelled && publishes);
        }
      }
    }
    // The update check runs on the signing job's handoff once it and every
    // check succeeded, only where verification is required.
    const update = jobOf(release, "update");
    expect(update.needs).toEqual([
      "resolve",
      "notes",
      "verify",
      "linux",
      "rehearse",
      "phone",
      "release",
    ]);
    for (const required of ["true", "false"]) {
      for (const result of ["success", "failure", "skipped"]) {
        const needs = {
          resolve: {
            result: "success",
            outputs: { verify_required: required, full_verify_required: required },
          },
          ...checks(required),
          release: { result },
        };
        expect(
          workflowValue(
            update.if ?? "",
            { needs },
            { success: result === "success", failure: false, always: true, cancelled: false },
          ),
        ).toBe(required === "true" && result === "success");
      }
    }
    // Its checkout keeps no credential, and it holds only the access its moves need.
    expect(publishSteps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        ref: "${{ needs.resolve.outputs.source_commit }}",
        "persist-credentials": false,
      },
    });
    expect(publish.permissions).toEqual({ contents: "write", actions: "read" });
    // The handoff is stored as is, one artifact per producer attempt, and
    // fetched by the immutable id the signing job recorded.
    const upload = step("handoff-upload");
    expect(upload).toMatchObject({
      uses: "actions/upload-artifact@v4",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        name: "${{ steps.handoff.outputs.name }}",
        "compression-level": 0,
        "if-no-files-found": "error",
      },
    });
    const fetch = publishSteps.find((candidate) => candidate.name === "Fetch the checked files");
    expect(fetch).toMatchObject({
      uses: "actions/download-artifact@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { "artifact-ids": "${{ needs.release.outputs.handoff_id }}" },
    });
    expect(publishSteps.indexOf(fetch as Step)).toBeLessThan(
      publishSteps.indexOf(step("handoff-check")),
    );
    // Nothing that publishes or holds a publication credential comes before the validation.
    const checked = publishSteps.indexOf(step("handoff-check"));
    for (const candidate of publishSteps.slice(0, checked))
      expect(
        PUBLISHES.test(candidate.run ?? "") ||
          PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
        candidate.name,
      ).toBe(false);
    const outputs = jobOf(release, "release").outputs ?? {};
    expect(outputs).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_id: "${{ steps.handoff-upload.outputs.artifact-id }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_name: "${{ steps.handoff.outputs.name }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_manifest: "${{ steps.handoff.outputs.manifest }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      sha256: "${{ steps.handoff.outputs.sha256 }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      direct: "${{ steps.handoff.outputs.direct }}",
    });
    // The signing job keeps its keychain cleanup on every exit, after its handoff.
    const cleanup = signingSteps.at(-1);
    expect(cleanup?.name).toBe("Remove the signing keychain");
    expect(cleanup?.if).toBe("always()");
    expect(signingSteps.indexOf(step("handoff-upload"))).toBeLessThan(signingSteps.length - 1);
  });

  /**
   * The handoff's two ends as Actions runs them: the signing job's step
   * writes the files and manifest, the artifact carries them unchanged, and
   * the publication job's step accepts them or refuses before any effect.
   * Readings from release run 40651382197, alpha 0.6.1-alpha.30, whose
   * Linux files the release's own renderer lays out on the publication side.
   * Where a case reads or writes the record, the release's own steps run
   * against a stand-in `gh` keeping it in a scratch folder.
   */
  describe("the handoff between the signing and publication jobs", () => {
    const version = "0.6.1-alpha.30";
    const source = "2e1588dc71ecc13f6695114b0c852049c4d3fe7c";
    const workflowSha = "28d2fcb16ddcd5bffe26db7587e084d212d253b6";
    const runId = "40651382197";
    const bytes = readFileSync(join(root, "packaging/build/icon.png"));
    const resolveOutputs = (overrides: Record<string, string> = {}) => ({
      channel: "alpha",
      dry_run: "false",
      source_commit: source,
      version,
      tag_name: `v${version}`,
      zip_name: `Infinitary-${version}-universal.zip`,
      old_cask: "true",
      ...overrides,
    });
    // The repository the run records in, as GITHUB_REPOSITORY names it.
    const recordRepository = "infinitary-labs/infinitary";
    const secrets = { GITHUB_TOKEN: "stand-in" };
    const run = (script: string, env: Record<string, string>) =>
      spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
    const outputsOf = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    const jobEnv = (id: string, resolve: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(jobOf(release, id).env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, { needs: { resolve: { outputs: resolve } } }),
        ]),
      );
    const stepEnv = (found: Step, contexts: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(found.env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, contexts),
        ]),
      );

    const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

    /**
     * The signing job's record read, then its handoff step, on a run's files;
     * their outputs and the job's. With a stand-in record the job's own read
     * runs against it; otherwise `adopted` stands for a retry whose record
     * keeps the bytes published first.
     */
    const produce = (options: {
      dryRun?: boolean;
      direct?: boolean;
      adopted?: boolean;
      attempt?: string;
      record?: ReturnType<typeof standInGh>;
    }) => {
      const { dryRun = false, direct = true, adopted = false, attempt = "1", record } = options;
      const temp = scratchDir("infinitary-handoff-signing-");
      const resolve = resolveOutputs({ dry_run: String(dryRun) });
      const env = jobEnv("release", resolve);
      mkdirSync(join(temp, "dist"));
      const distZip = join(temp, "dist", env.ZIP_NAME ?? "");
      writeFileSync(distZip, bytes);
      let read: { outputs: Record<string, string> } = { outputs: {} };
      if (record && !dryRun) {
        const output = join(temp, "recorded-output");
        writeFileSync(output, "");
        const result = run(step("recorded").run ?? "", {
          ...env,
          ...stepEnv(step("recorded"), { secrets }),
          PATH: `${record.bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: recordRepository,
        });
        expect(result.status, result.stderr).toBe(0);
        read = { outputs: outputsOf(output) };
      } else if (adopted) {
        // A retry's record keeps the bytes published first, which differ from its rebuild.
        const published = join(temp, "recorded", env.ZIP_NAME ?? "");
        mkdirSync(dirname(published), { recursive: true });
        writeFileSync(published, Buffer.concat([bytes, Buffer.from("published first")]));
        read = { outputs: { zip: published, sha256: sha(published) } };
      }
      const recorded = read.outputs.zip ?? distZip;
      const builtDmg = dryRun || direct;
      const dmg = join(temp, "dmg", env.DMG_NAME ?? "");
      if (builtDmg) {
        mkdirSync(dirname(dmg));
        writeFileSync(dmg, Buffer.concat([bytes, Buffer.from("disk image")]));
      }
      const steps = {
        recorded: read,
        checksum: { outputs: { sha256: sha(distZip) } },
        dmg: { outputs: builtDmg ? { path: dmg } : {} },
        visibility: { outputs: dryRun ? {} : { direct: String(direct) } },
      };
      const output = join(temp, "output");
      const result = run(step("handoff").run ?? "", {
        ...env,
        ...stepEnv(step("handoff"), {
          steps,
          needs: { resolve: { outputs: resolve } },
          github: { run_id: runId, run_attempt: attempt, sha: workflowSha },
        }),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        dist_zip: distZip,
      });
      expect(result.status, result.stderr).toBe(0);
      const handoff = outputsOf(output);
      const job = Object.fromEntries(
        Object.entries(jobOf(release, "release").outputs ?? {}).map(([name, value]) => [
          name,
          workflowString(value, {
            steps: {
              handoff: { outputs: handoff },
              "handoff-upload": { outputs: { "artifact-id": "4711" } },
            },
          }),
        ]),
      );
      return { temp, handoff, job, resolve, recorded, distZip, dmg };
    };

    /** The artifact as the publication job fetches it, then its validation step. */
    const consume = (
      produced: ReturnType<typeof produce>,
      options: {
        alter?: (download: string) => void;
        resolve?: Record<string, string>;
        job?: Record<string, string>;
        github?: Record<string, string>;
      } = {},
    ) => {
      const temp = scratchDir("infinitary-handoff-publication-");
      const download = join(temp, "handoff-download");
      cpSync(produced.handoff.path ?? "", download, { recursive: true });
      options.alter?.(download);
      const resolve = options.resolve ?? produced.resolve;
      const contexts = {
        needs: {
          resolve: { outputs: resolve },
          release: { outputs: { ...produced.job, ...options.job } },
        },
        github: { run_id: runId, run_attempt: "1", sha: workflowSha, ...options.github },
      };
      const output = join(temp, "output");
      const result = run(step("handoff-check").run ?? "", {
        ...jobEnv("publish", resolve),
        ...stepEnv(step("handoff-check"), contexts),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
      });
      return { temp, result, outputs: existsSync(output) ? outputsOf(output) : {} };
    };
    const accepted = (consumed: ReturnType<typeof consume>) => {
      expect(consumed.result.status, consumed.result.stderr).toBe(0);
      return consumed.outputs;
    };
    const refused = (consumed: ReturnType<typeof consume>, reason: RegExp) => {
      expect(consumed.result.status).not.toBe(0);
      expect(consumed.result.stderr).toMatch(/Refusing the handoff: /);
      expect(consumed.result.stderr).toMatch(reason);
      // Nothing was laid out for publication to read.
      expect(consumed.outputs).toEqual({});
      expect(existsSync(join(consumed.temp, "handoff"))).toBe(false);
    };

    it("hands publication the record's zip and the checked image, byte for byte, and no Linux files", () => {
      const produced = produce({ adopted: true });
      expect(produced.job.handoff_id).toBe("4711");
      expect(produced.job.handoff_name).toBe("release-handoff-1");
      expect(produced.job.direct).toBe("true");
      const outputs = accepted(consume(produced));
      // The previously published zip wins over the retry's rebuild.
      expect(readFileSync(outputs.zip ?? "")).toEqual(readFileSync(produced.recorded));
      expect(produced.job.sha256).toBe(sha(produced.recorded));
      expect(produced.job.sha256).not.toBe(sha(produced.distZip));
      expect(readFileSync(outputs.dmg ?? "")).toEqual(readFileSync(produced.dmg));
      // Only the allowlist travels: no app, workspace or environment. The
      // Linux files reach publication from the linux job, which may still
      // run while the signing job hands off (INF-2074).
      expect(readdirSync(produced.handoff.path ?? "").sort()).toEqual([
        "dmg",
        "manifest.json",
        "zip",
      ]);
      expect(readFileSync(join(produced.handoff.path ?? "", "manifest.json"), "utf8")).not.toMatch(
        /secret|TOKEN|KEY/,
      );
    });

    it("hands no disk image without direct downloads, and a rehearsal's checked zip and image", () => {
      const homebrewOnly = accepted(consume(produce({ direct: false })));
      expect(homebrewOnly.dmg).toBe("");
      const rehearsal = produce({ dryRun: true });
      expect(rehearsal.job.direct).toBe("false");
      expect(accepted(consume(rehearsal)).dmg).toMatch(/mac-universal\.dmg$/);
    });

    it("lets a publication-only rerun reuse an earlier attempt's handoff, and refuses one from a later attempt", () => {
      const produced = produce({ attempt: "1" });
      expect(accepted(consume(produced, { github: { run_attempt: "2" } })).attempt).toBe("1");
      const rerun = produce({ attempt: "3" });
      expect(rerun.job.handoff_name).toBe("release-handoff-3");
      refused(consume(rerun, { github: { run_attempt: "2" } }), /attempt 3 is not of this run/);
      refused(consume(produced, { job: { handoff_name: "release-handoff-2" } }), /not attempt 1's/);
    });

    it.each([
      [
        "an altered zip",
        (dir: string) =>
          writeFileSync(join(dir, "zip", `Infinitary-${version}-universal.zip`), "altered"),
        /zip\/Infinitary-.* is not the file the signing job checked/,
      ],
      [
        "an altered image",
        (dir: string) =>
          writeFileSync(join(dir, "dmg", `Infinitary-${version}-mac-universal.dmg`), "altered"),
        /dmg\/.* is not the file/,
      ],
      [
        "a missing image",
        (dir: string) => rmSync(join(dir, "dmg", `Infinitary-${version}-mac-universal.dmg`)),
        /missing \["dmg\/Infinitary-.*-mac-universal\.dmg"\]/,
      ],
      [
        "an extra file",
        (dir: string) => writeFileSync(join(dir, "zip", "unlisted.zip"), "extra"),
        /extra \["zip\/unlisted\.zip"\]/,
      ],
      [
        "an edited manifest",
        (dir: string) =>
          writeFileSync(
            join(dir, "manifest.json"),
            readFileSync(join(dir, "manifest.json"), "utf8").replace(
              '"channel": "alpha"',
              '"channel": "stable"',
            ),
          ),
        /manifest is not the one the signing job recorded/,
      ],
    ])("refuses %s before any effect", (_name, alter, reason) => {
      refused(consume(produce({}), { alter }), reason);
    });

    it("refuses a handoff from another release, run or workflow revision", () => {
      const produced = produce({});
      refused(
        consume(produced, {
          resolve: resolveOutputs({
            version: "0.6.1-alpha.31",
            zip_name: "Infinitary-0.6.1-alpha.31-universal.zip",
          }),
        }),
        /its version is "0\.6\.1-alpha\.30"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ source_commit: "f".repeat(40) }) }),
        /its source is/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ channel: "stable" }) }),
        /its channel is "alpha", not "stable"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ old_cask: "false" }) }),
        /its oldCask is true, not false/,
      );
      refused(consume(produced, { github: { run_id: "40651382198" } }), /its run is "40651382197"/);
      refused(consume(produced, { github: { sha: "e".repeat(40) } }), /its workflow is/);
      refused(consume(produced, { job: { direct: "false" } }), /its direct is true, not false/);
      refused(consume(produced, { job: { sha256: "0".repeat(64) } }), /its sha256 is/);
      refused(consume(produced, { job: { handoff_manifest: "" } }), /manifest is not the one/);
    });

    /**
     * The publication job's own Linux layout and record, after it accepted
     * the handoff: the linux job's packages, then the record of the zip it
     * was handed and the Linux files beside it.
     */
    const recordAfterChecks = (
      produced: ReturnType<typeof produce>,
      consumed: ReturnType<typeof consume>,
      record: ReturnType<typeof standInGh>,
    ) => {
      const temp = consumed.temp;
      const packages = join(temp, "linux-packages");
      mkdirSync(packages);
      for (const name of [
        `infinitary-${version}-linux-amd64.deb`,
        `infinitary-${version}-linux-x86_64.rpm`,
        `Infinitary-${version}-linux-x86_64.AppImage`,
      ])
        writeFileSync(join(packages, name), bytes);
      const contexts = {
        needs: { resolve: { outputs: produced.resolve }, release: { outputs: produced.job } },
        steps: { "handoff-check": { outputs: accepted(consumed) } },
        secrets,
      };
      const env = {
        ...jobEnv("publish", produced.resolve),
        PATH: `${record.bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_REPOSITORY: recordRepository,
      };
      const linux = run(step("linux-files").run ?? "", {
        ...env,
        ...stepEnv(step("linux-files"), contexts),
        GITHUB_OUTPUT: join(temp, "linux-output"),
      });
      expect(linux.status, linux.stderr).toBe(0);
      const output = join(temp, "record-output");
      writeFileSync(output, "");
      const result = run(step("private").run ?? "", {
        ...env,
        ...stepEnv(step("private"), contexts),
        GITHUB_OUTPUT: output,
      });
      return { result, outputs: outputsOf(output) };
    };
    const tag = `v${version}`;
    const zipName = `Infinitary-${version}-universal.zip`;

    // INF-2074: the signing job reads the record and writes nothing; the
    // publication job, which starts only once every check passed, records.
    it("records the zip it was handed, beside the Linux files, only in the publication job", () => {
      const record = standInGh(source);
      const produced = produce({ record });
      // No release yet: the signing job read nothing and created nothing.
      expect(record.published(recordRepository, tag)).toBeNull();
      expect(record.calls().filter(([verb, sub]) => verb === "release" && sub !== "view")).toEqual(
        [],
      );
      expect(produced.recorded).toBe(produced.distZip);
      const consumed = consume(produced);
      const recorded = recordAfterChecks(produced, consumed, record);
      expect(recorded.result.status, recorded.result.stderr).toBe(0);
      expect(recorded.outputs).toEqual({
        zip: consumed.outputs.zip,
        sha256: sha(produced.distZip),
        state: "uploaded",
      });
      const published = record.published(recordRepository, tag) ?? {};
      expect(published[`${zipName}.sha256`]).toBe(`${produced.job.sha256}  ${zipName}\n`);
      expect(Object.keys(published)).toEqual(
        expect.arrayContaining([
          `infinitary-${version}-linux-amd64.deb`,
          `infinitary-${version}-linux-x86_64.rpm`,
          `Infinitary-${version}-linux-x86_64.AppImage`,
          "SHA256SUMS",
        ]),
      );
    });

    it("hands over and records the zip a retry's record already holds", () => {
      const record = standInGh(source);
      record.seed(recordRepository, tag, source, {
        [zipName]: "published first",
        [`${zipName}.sha256`]: `${createHash("sha256").update("published first").digest("hex")}  ${zipName}\n`,
      });
      const produced = produce({ record });
      expect(readFileSync(produced.recorded, "utf8")).toBe("published first");
      expect(produced.job.sha256).toBe(sha(produced.recorded));
      const recorded = recordAfterChecks(produced, consume(produced), record);
      expect(recorded.result.status, recorded.result.stderr).toBe(0);
      expect(recorded.outputs).toMatchObject({ sha256: produced.job.sha256, state: "identical" });
      expect(record.published(recordRepository, tag)?.[zipName]).toBe("published first");
    });

    it("refuses a record that changed after the signing job read it, before recording anything", () => {
      const record = standInGh(source);
      const produced = produce({ record });
      const consumed = consume(produced);
      // Another run of this version records its own zip while this one is checked.
      const other = `${createHash("sha256").update("another run").digest("hex")}  ${zipName}\n`;
      record.seed(recordRepository, tag, source, {
        [zipName]: "another run",
        [`${zipName}.sha256`]: other,
      });
      const recorded = recordAfterChecks(produced, consumed, record);
      expect(recorded.result.status).not.toBe(0);
      expect(recorded.result.stderr).toMatch(/The record changed since signing/);
      expect(recorded.outputs).toEqual({});
      expect(record.published(recordRepository, tag)).toEqual({
        [zipName]: "another run",
        [`${zipName}.sha256`]: other,
      });
    });

    it("refuses to read a record whose tag names another commit", () => {
      const record = standInGh(source);
      record.seed(recordRepository, tag, "f".repeat(40), { [zipName]: "elsewhere" });
      const temp = scratchDir("infinitary-handoff-signing-");
      const resolve = resolveOutputs();
      const result = run(step("recorded").run ?? "", {
        ...jobEnv("release", resolve),
        ...stepEnv(step("recorded"), { secrets }),
        PATH: `${record.bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: join(temp, "output"),
        GITHUB_REPOSITORY: recordRepository,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/names f{40}, not this release's source/);
    });
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
    // INF-1900: the update check and its rehearsal hold no signing material.
    expect(signing).not.toContain("rehearse");
    expect(signing).not.toContain("update");
  });

  it("inherits the published alpha's run, found by its number, only when both lanes passed in its latest attempt, and refuses the stable otherwise", async () => {
    const script = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "verification",
    )?.with?.script;
    expect(typeof script).toBe("string");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction("core", "exec", "github", "context", "process", script);
    const url = "https://github.com/example/project/actions/runs/123";
    for (const scenario of [
      "alpha",
      "stable rehearsal without promotion",
      "eligible stable",
      "eligible stable from before the update check",
      "failed mac",
      "skipped mac",
      "pending mac",
      "legacy alpha without mac",
      "alpha without installed-update proof",
      "failed Intel proof from before the update check",
      "pending Apple silicon proof",
      "failed alpha run",
      "missing alpha run",
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
      const jobs = [
        "verify / linux-checks",
        "verify / linux-e2e / journeys (1/2)",
        "verify / linux-e2e / journeys (2/2)",
        "verify / mac",
        `${updateCheck} / Apple silicon`,
        ...(legacy ? [`${updateCheck} / Intel`] : []),
      ]
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
            scenario === "failed Intel proof from before the update check" && name.endsWith("Intel")
              ? "failure"
              : name.endsWith("mac") && scenario === "failed mac"
                ? "failure"
                : name.endsWith("mac") && scenario === "skipped mac"
                  ? "skipped"
                  : "success",
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
          rest: { actions: { listWorkflowRuns: listRuns, listJobsForWorkflowRun: listJobs } },
          paginate: async (method: symbol, parameters: Record<string, unknown>) => {
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
                  head_sha: "c".repeat(40),
                  run_number: 13,
                  status: "completed",
                  conclusion: scenario === "failed alpha run" ? "failure" : "success",
                  html_url: url,
                },
              ];
            }
            expect(parameters.filter).toBe("latest");
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
          },
        },
      );
      const inherited = scenario.startsWith("eligible stable");
      const refused =
        !inherited && !["alpha", "stable rehearsal without promotion"].includes(scenario);
      expect(outputs.required, scenario).toBe(inherited ? "false" : "true");
      expect(outputs.alpha_run, scenario).toBe(inherited ? url : "");
      expect(summaries.length, scenario).toBe(inherited ? 1 : 0);
      if (inherited) expect(summaries[0]).toContain("omitted, not passed here");
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

  it("verifies, packages and publishes one source commit, signs while both lanes run, and starts at the build", () => {
    const resolve = jobOf(release, "resolve");
    // The resolver runs from the workflow's own commit, with every branch and
    // tag, and reads the candidate or the promoted alpha from git.
    expect(resolve.steps?.[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0, "persist-credentials": false },
    });
    expect(resolve.steps?.[0]?.with?.ref).toBeUndefined();
    expect(resolve.steps?.find((candidate) => candidate.id === "resolve")?.run).toBe(
      "scripts/resolve-release.sh",
    );
    // The resolver reads the promoted alpha's run.
    expect(release.permissions.actions).toBe("read");
    const call = jobOf(release, "verify");
    const signing = jobOf(release, "release");
    expect(JSON.stringify(resolve)).not.toContain("secrets.");
    expect(call).toMatchObject({
      needs: ["resolve", "notes"],
      uses: "./.github/workflows/verify.yml",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        ref: "${{ needs.resolve.outputs.source_commit }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        profile: "${{ needs.resolve.outputs.channel }}",
      },
    });
    // Nothing verify runs holds a secret.
    expect(call.secrets).toBeUndefined();
    expect(signing.needs).toEqual(["resolve", "notes", "rehearse", "phone"]);
    expect(jobOf(release, "publish").needs).toEqual(expect.arrayContaining(["verify", "linux"]));
    expect(steps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ needs.resolve.outputs.source_commit }}" },
    });
    // Both profiles run the hosted Linux checks, which publication waits for.
    for (const profile of ["stable", "alpha"]) expect(lanes(profile)).toContain("linux-checks");
    // The signing job repeats none of the checks the lanes beside it run:
    // after the install, and the live alpha's read of the tap, it builds.
    const commands = steps.flatMap((candidate) => (candidate.run ? [candidate] : []));
    for (const candidate of commands)
      expect(candidate.run, candidate.name).not.toMatch(
        /\bpnpm (typecheck|check|lint:adherence|test)\b/,
      );
    const afterInstall = commands
      .slice(
        commands.findIndex((candidate) => candidate.run === "pnpm install --frozen-lockfile") + 1,
      )
      .filter((candidate) => !["visibility", "capability"].includes(candidate.id ?? ""));
    expect(afterInstall[0]?.id).toBe("build");
    expect(afterInstall[0]?.run).toBe("pnpm build");
    const firstSecret = steps.findIndex((candidate) =>
      /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)/.test(JSON.stringify(candidate)),
    );
    expect(steps[firstSecret]?.name).toBe("Restore App Store Connect API key");
    expect(steps.indexOf(step("build"))).toBeLessThan(firstSecret);
    // Apple signing material stays in the signing job; publication holds none.
    expect(JSON.stringify(jobOf(release, "publish"))).not.toMatch(
      /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)|CSC_KEYCHAIN|keychain/,
    );
  });

  it("checks the release notes before anything verifies or signs, and packages exactly that catalog", () => {
    const notes = jobOf(release, "notes");
    const noteSteps = notes.steps ?? [];
    // Declarations only, with no secret and no install: node's type stripping.
    expect(JSON.stringify(notes)).not.toContain("secrets.");
    expect(notes.needs).toBe("resolve");
    expect(noteSteps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });
    const check = noteSteps.find(
      (candidate) => candidate.name === "Check the notes cover this release",
    );
    // INF-2259 preserves reviewed manual candidates and stable promotion,
    // while the exact-main route uses the workflow's current notes tooling.
    const input = release.on.workflow_dispatch?.inputs?.candidate;
    expect(input).toMatchObject({ type: "string", required: false });
    const source = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: hostEnv(),
      encoding: "utf8",
    }).trim();
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    const readings = JSON.parse(read("tests/fixtures/verify-runs/2026-10-27.json")) as {
      runs: { conclusion: string; html_url: string }[];
    };
    const proofUrl = readings.runs.find((run) => run.conclusion === "success")!.html_url;
    for (const mode of ["reviewed", "verified-main", "promoted"] as const) {
      const promoted = mode === "promoted";
      const channel = promoted ? "stable" : "alpha";
      const releaseVersion = promoted ? version.split("-")[0]! : version;
      const from = promoted ? publicTagFor(version)! : "";
      const context = {
        needs: {
          resolve: {
            outputs: {
              channel,
              dry_run: "false",
              source_commit: source,
              version: releaseVersion,
              promoted_from: from,
              main_run: mode === "verified-main" ? proofUrl : "",
            },
          },
        },
        inputs: { candidate: mode === "reviewed" ? source : "" },
      };
      const env = Object.fromEntries(
        Object.entries(check!.env!).map(([name, value]) => [name, workflowString(value, context)]),
      );
      expect(env.CANDIDATE).toBe(promoted ? "" : source);
      expect(recordedWorkflowCall(check!.run!, env)).toEqual([
        "node",
        mode === "reviewed"
          ? "scripts/release-notes.ts"
          : ".release-tooling/scripts/release-notes.ts",
        "check",
        "--source",
        source,
        "--channel",
        channel,
        "--version",
        releaseVersion,
        ...(promoted ? ["--promoted-from", from] : [`--${mode}`, source]),
        "--repo",
        ".",
      ]);
    }
    // Neither verification nor signing starts without it.
    expect(jobOf(release, "verify").needs).toContain("notes");
    expect(jobOf(release, "release").needs).toContain("notes");
    // The signing job packages the notes job's catalog and verifies the
    // packaged copy's identity before notarizing, signing-gate checks or launch.
    const order = steps.map((candidate) => candidate.id ?? candidate.name);
    const place = order.indexOf("Place the release notes catalog");
    expect(place).toBeGreaterThan(order.indexOf("build"));
    expect(place).toBeLessThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeGreaterThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeLessThan(order.indexOf("signed-app"));
    expect(step("packaged-notes").run).toContain("verify-package");
    expect(step("packaged-notes").run).toContain("Contents/Resources/release-notes.json");
    // The hero pictures travel with the catalog: generated into one folder,
    // kept as one artifact, and placed where electron-builder ships them.
    const generate = noteSteps.find(
      (candidate) => candidate.name === "Generate the offline catalog",
    );
    expect(generate?.run).toContain('--out "$RUNNER_TEMP/release-notes/release-notes.json"');
    const keep = noteSteps.find((candidate) => candidate.name === "Keep the catalog for packaging");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(keep?.with?.path).toBe("${{ runner.temp }}/release-notes/");
    const placed = steps.find((candidate) => candidate.name === "Place the release notes catalog");
    expect(placed?.run).toContain("packaging/generated/release-notes.json");
    expect(placed?.run).toContain("packaging/generated/release-notes/pictures");
  });

  it("writes a stable's picked highlights with the workflow's own tooling, after the alpha's catalog and before it is kept", () => {
    const input = release.on.workflow_dispatch?.inputs?.highlights;
    expect(input).toMatchObject({ type: "string", required: false });
    const resolveStep = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "resolve",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(resolveStep?.env?.HIGHLIGHTS).toBe("${{ inputs.highlights }}");
    const noteSteps = jobOf(release, "notes").steps ?? [];
    const order = noteSteps.map((candidate) => candidate.name);
    const tooling = noteSteps.find(
      (candidate) => candidate.name === "Check out the workflow's own notes tooling",
    );
    const write = noteSteps.find((candidate) => candidate.name === "Write the picked highlights");
    // The promoted alpha's commit may predate the pick, so it comes from the
    // workflow's own commit, beside the source checkout.
    expect(tooling).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ github.sha }}", path: ".release-tooling" },
    });
    expect(write?.run).toContain(
      'node .release-tooling/scripts/release-notes.ts stable-highlights --repo . --catalog "$CATALOG" --picks "$HIGHLIGHTS"',
    );
    // The alpha's own check then proves its app reads the result.
    expect(write?.run).toMatch(
      /\nnode scripts\/release-notes\.ts verify-package --catalog "\$CATALOG"/,
    );
    expect(order.indexOf("Write the picked highlights")).toBeGreaterThan(
      order.indexOf("Generate the offline catalog"),
    );
    expect(order.indexOf("Write the picked highlights")).toBeLessThan(
      order.indexOf("Keep the catalog for packaging"),
    );
    // Both run only for picks; without them the catalog is the alpha's as generated.
    for (const step of [tooling, write])
      for (const [highlights, runs] of [
        ["lead-change,second-change,third-change", true],
        ["", false],
      ] as const)
        expect(
          workflowValue(step?.if ?? "", { needs: { resolve: { outputs: { highlights } } } }),
        ).toBe(runs);
  });

  it("never cancels a real release, and gives a rehearsal its own group", () => {
    const group = (inputs: Record<string, unknown>, runId: string) =>
      workflowString(release.concurrency.group, {
        inputs,
        github: { ref_name: "main", run_id: runId },
      });
    const cancels = (inputs: Record<string, unknown>) =>
      workflowValue(release.concurrency["cancel-in-progress"], { inputs });
    // Real releases: a stable promotion and an alpha's candidate, both requested from main.
    const candidate = "c".repeat(40);
    for (const [inputs, runId] of [
      [{ channel: "stable", promote: "1.2.3-alpha.13", dry_run: false }, "101"],
      [{ channel: "alpha", candidate, dry_run: false }, "102"],
    ] as const) {
      expect(group(inputs, runId)).toBe(`release-${runId}`);
      expect(cancels(inputs)).toBe(false);
    }
    // Rehearsals: one group per channel and what it builds, a newer one replacing an older.
    expect(group({ channel: "alpha", dry_run: true }, "103")).toBe("release-dry-run-alpha-main");
    expect(group({ channel: "alpha", candidate, dry_run: true }, "104")).toBe(
      `release-dry-run-alpha-${candidate}`,
    );
    expect(group({ channel: "stable", promote: "1.2.3-alpha.13", dry_run: true }, "105")).toBe(
      "release-dry-run-stable-1.2.3-alpha.13",
    );
    expect(cancels({ channel: "alpha", dry_run: true })).toBe(true);
    // Verify inside a release belongs to that run; on demand, a newer verify
    // of the same ref and profile replaces an older one.
    const verifyGroup = (workflow: string, inputs: Record<string, unknown>) =>
      workflowString(verify.concurrency.group, {
        github: { workflow, ref: "refs/heads/main", run_id: "77" },
        inputs,
      });
    const verifyCancels = (workflow: string) =>
      workflowValue(verify.concurrency["cancel-in-progress"], { github: { workflow } });
    expect(verifyGroup("release", { ref: "c".repeat(40), profile: "alpha" })).toBe("verify-77");
    expect(verifyCancels("release")).toBe(false);
    expect(verifyGroup("verify", { profile: "alpha" })).toBe("verify-refs/heads/main-alpha");
    expect(verifyCancels("verify")).toBe(true);
  });

  // INF-2259 preserves manual defaults and adds optional exact-main recovery.
  it("retains manual release inputs beside the successful-main trigger", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_run", "workflow_dispatch"]);
    expect(Object.keys(release.on.workflow_dispatch?.inputs ?? {})).toEqual([
      "channel",
      "candidate",
      "verified_main_run",
      "promote",
      "highlights",
      "dry_run",
    ]);
    for (const input of ["candidate", "verified_main_run", "promote", "highlights"])
      expect(release.on.workflow_dispatch?.inputs?.[input]).toMatchObject({
        type: "string",
        required: false,
      });
    expect(release.on.workflow_dispatch?.inputs?.channel).toMatchObject({
      type: "choice",
      options: ["stable", "alpha"],
      default: "stable",
    });
    expect(release.on.workflow_dispatch?.inputs?.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(verify.on.workflow_call?.inputs?.profile?.default).toBe("stable");
    expect(verify.on.workflow_dispatch?.inputs?.profile).toMatchObject({ default: "stable" });
  });

  const PUBLISHES =
    /gh release (create|upload)|publish-release-asset\.sh|publish-(?:tap|feeds)\.sh live|publish-downloads\.ts|git push/;
  const PUBLICATION_TOKEN =
    /secrets\.(GITHUB_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|HOMEBREW_TAP_TOKEN|OLD_TAP_TOKEN)/;
  /**
   * The steps of a passing run of a channel, live or rehearsed, in order:
   * the signing job's, then the publication job's when it starts after them.
   */
  const ranSteps = (channel: string, dryRun: boolean, oldCask = false, direct = true) => {
    const needs = {
      resolve: {
        result: "success",
        outputs: {
          channel,
          dry_run: String(dryRun),
          old_cask: String(oldCask),
          release_repository: releaseSource.repository,
          verify_required: "true",
        },
      },
      notes: { result: "success" },
      verify: { result: "success" },
      linux: { result: "success" },
      rehearse: { result: "success" },
      phone: { result: "success" },
      // The signing job hands on what its visibility step chose.
      release: { result: "success", outputs: { direct: String(dryRun ? false : direct) } },
      update: { result: "success" },
    };
    const ran = (jobSteps: Step[]) =>
      jobSteps.filter(
        (candidate) =>
          candidate.if === undefined ||
          workflowValue(candidate.if, {
            needs,
            github: { repository: releaseSource.repository },
            steps: Object.fromEntries(
              jobSteps.flatMap((each) =>
                each.id
                  ? [[each.id, { outcome: "success", outputs: { direct: String(direct) } }]]
                  : [],
              ),
            ),
          }) === true,
      );
    const publishes = workflowValue(jobOf(release, "publish").if ?? "", { needs }) === true;
    return [...ran(signingSteps), ...(publishes ? ran(publishSteps) : [])];
  };

  it.each(["stable", "alpha"])("rehearses %s's whole profile and publishes nothing", (channel) => {
    const ran = ranSteps(channel, true);
    for (const candidate of ran) {
      expect(candidate.run ?? "", candidate.name).not.toMatch(PUBLISHES);
      if (candidate.id !== "feed-rehearsal")
        expect(JSON.stringify(candidate.env ?? {}), candidate.name).not.toMatch(PUBLICATION_TOKEN);
    }
    expect(ran.map((candidate) => candidate.id ?? candidate.name)).toEqual(
      expect.arrayContaining([
        "build",
        "package",
        "signed-app",
        "launch",
        "data-folder",
        "notarize",
        "zip",
        "checksum",
        "dmg",
        "handoff",
        "handoff-upload",
        "handoff-check",
        "tap-rehearsal",
        "old-tap-rehearsal",
        "feed-rehearsal",
        "Keep the rehearsed release metadata",
        "Summarize",
        "Summarize the publication",
      ]),
    );
    // A rehearsal's feeds are written from the checked image it handed over.
    expect(step("feed-rehearsal").run).toContain(
      'DIST_ZIP="${{ steps.handoff-check.outputs.zip }}" DIST_DMG="${{ steps.handoff-check.outputs.dmg }}"',
    );
    // The feed rehearsal may read a not-yet-public repository, but cannot publish.
    expect(step("feed-rehearsal").run).toContain("scripts/publish-feeds.sh rehearsal");
    // electron-builder never publishes on its own either.
    expect(step("package").run).toContain("--publish never");
  });

  it.each(["stable", "alpha"])(
    "publishes %s through both Homebrew and direct feeds only after their downloads verify",
    (channel) => {
      // INF-1613: exercise both configured storage and the approved Homebrew/Linux-only fallback.
      for (const direct of [false, true]) {
        const ran = ranSteps(channel, false, false, direct).map(
          (candidate) => candidate.id ?? candidate.name,
        );
        const publication = [
          "private",
          ...(direct ? ["recorded-dmg"] : []),
          "private-fetch-back",
          ...(direct ? ["public", "public-fetch-back", "feeds"] : []),
        ];
        expect(
          ran.filter((id) =>
            [
              "private",
              "recorded-dmg",
              "private-fetch-back",
              "public",
              "public-fetch-back",
              "feeds",
            ].includes(id ?? ""),
          ),
        ).toEqual(publication);
        expect(ran.indexOf("visibility")).toBeLessThan(ran.indexOf("developer_id_cert"));
        // INF-2074: the signing job reads the record before its image and
        // records nothing; the publication job records after every check.
        expect(ran.indexOf("recorded")).toBeGreaterThan(ran.indexOf("checksum"));
        expect(ran.indexOf("private")).toBeGreaterThan(ran.indexOf("linux-files"));
        if (direct) {
          expect(ran.indexOf("dmg")).toBeGreaterThan(ran.indexOf("recorded"));
          expect(ran.indexOf("dmg")).toBeLessThan(ran.indexOf("recorded-dmg"));
        } else {
          expect(ran).not.toContain("dmg");
        }
        expect(ran).not.toContain("feed-rehearsal");
        expect(ran).toEqual(
          expect.arrayContaining(["homebrew-public", "homebrew-fetch-back", "tap"]),
        );
        // The signing job ends after the image and its handoff; publication
        // starts by validating that handoff, before any effect.
        expect(ran.indexOf("handoff")).toBeGreaterThan(ran.indexOf(direct ? "dmg" : "recorded"));
        expect(ran.indexOf("handoff-check")).toBeGreaterThan(ran.indexOf("handoff-upload"));
        expect(ran.indexOf("handoff-check")).toBeLessThan(ran.indexOf("private"));
        expect(ran.indexOf("homebrew-fetch-back")).toBeGreaterThan(ran.indexOf("homebrew-public"));
        expect(ran.indexOf("tap")).toBeGreaterThan(ran.indexOf("homebrew-fetch-back"));
        expect(ran).not.toContain("tap-rehearsal");
      }
      expect(JSON.stringify(step("public-fetch-back").env)).not.toContain("secrets.");
      // Publication reads the validated handoff's zip, the record's own (INF-1716).
      expect(step("public").env?.DIST_ZIP).toBe("${{ steps.handoff-check.outputs.zip }}");
      expect(step("public").env?.DIST_DMG).toBe("${{ steps.recorded-dmg.outputs.zip }}");
      for (const id of ["private-fetch-back", "public-fetch-back"])
        expect(step(id).env?.ARTIFACT_SHA256).toBe("${{ needs.release.outputs.sha256 }}");
      expect(
        steps
          .filter(
            (candidate) =>
              PUBLISHES.test(candidate.run ?? "") ||
              PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
          )
          .map((candidate) => candidate.id),
      ).toEqual([
        "visibility",
        "recorded",
        "private",
        "recorded-dmg",
        "private-fetch-back",
        "public",
        "homebrew-public",
        "tap",
        "old-public",
        "old-tap",
        "feeds",
      ]);
    },
  );

  it.each(["stable", "alpha"])(
    "keeps %s old-cask publication gated by explicit channel activation",
    (channel) => {
      // Revised INF-643: retain both paths, including the already-activated old-cask bridge.
      const inactive = ranSteps(channel, false, false).map((step) => step.id);
      const active = ranSteps(channel, false, true).map((step) => step.id);
      for (const id of ["old-public", "old-public-fetch-back", "old-tap"]) {
        expect(inactive).not.toContain(id);
        expect(active).toContain(id);
      }
      expect(active.indexOf("old-public-fetch-back")).toBeGreaterThan(active.indexOf("old-public"));
      expect(active.indexOf("old-tap")).toBeGreaterThan(active.indexOf("old-public-fetch-back"));
      for (const id of ["homebrew-fetch-back", "old-public-fetch-back"])
        expect(JSON.stringify(step(id).env)).not.toContain("secrets.");
      expect(step("tap").env?.DOWNLOAD_URL).toBe("${{ needs.resolve.outputs.download_url }}");
      expect(step("old-tap").env?.DOWNLOAD_URL).toBe(
        "${{ needs.resolve.outputs.old_download_url }}",
      );
    },
  );

  it("packages the logical version as the app's metadata and its numeric core as both bundle fields", () => {
    const packaging = step("package").run ?? "";
    expect(packaging).toContain('-c.extraMetadata.version="$VERSION"');
    expect(packaging).toContain('-c.mac.bundleShortVersion="$BUNDLE_VERSION"');
    expect(packaging).toContain('-c.mac.bundleVersion="$BUNDLE_VERSION"');
    // Every launch gate holds the app to the logical version: the gate reads
    // both fields as its numeric core and asks the running app for the rest.
    const launches = steps.flatMap((candidate) =>
      [...(candidate.run ?? "").matchAll(/scripts\/check-app-launch\.sh "[^"]+" "([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const launchStages = [
      "launch",
      "zip",
      "private-fetch-back",
      "public-fetch-back",
      "homebrew-fetch-back",
    ];
    expect(launches).toEqual(launchStages.map(() => "$VERSION"));
    for (const id of launchStages) expect(step(id).run).toContain("scripts/check-app-launch.sh");
  });

  it("launches the app only through the workflow's own launch gate, after packaging", () => {
    // INF-1768: a stable checks out an older alpha's commit, whose scripts
    // call the gate beside them, so a repair to the gate reaches that
    // release only when the workflow puts its own copy there first.
    const gate = ["scripts/check-app-launch.sh", "scripts/app-runtime-version.mjs"];
    const launches = (candidate: Step) =>
      /(^|\s)scripts\/(check-app-launch|verify-mac-dmg)\.sh /m.test(candidate.run ?? "");
    for (const [job, jobSteps] of [
      ["release", signingSteps],
      ["publish", publishSteps],
    ] as const) {
      const fetched = jobSteps.findIndex(
        (candidate) => candidate.with?.path === ".release-tooling",
      );
      expect(jobSteps[fetched]?.uses, job).toBe("actions/checkout@v4");
      expect(jobSteps[fetched]?.with?.ref, job).toBe("${{ github.sha }}");
      expect(String(jobSteps[fetched]?.with?.["sparse-checkout"]).trim().split("\n"), job).toEqual(
        gate,
      );
      const placed = jobSteps.findIndex(
        (candidate) =>
          candidate.run ===
          `cp ${gate.map((file) => `.release-tooling/${file}`).join(" ")} scripts/`,
      );
      expect(placed, job).toBeGreaterThan(fetched);
      // Both run in every profile, before the job's first launch.
      expect([jobSteps[fetched]?.if, jobSteps[placed]?.if], job).toEqual([undefined, undefined]);
      expect(jobSteps.findIndex(launches), job).toBeGreaterThan(placed);
    }
    // The app it launches is the source's, packaged before the gate moves in.
    expect(signingSteps.findIndex((candidate) => candidate.id === "launch-gate")).toBeGreaterThan(
      signingSteps.findIndex((candidate) => candidate.id === "package"),
    );
  });
});

/** A valid checksum: the generator refuses anything but 64 lowercase hex digits. */
const CASK_SHA256 = "ab".repeat(32);

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
 * release_check, release_sign and release_light kinds (INF-2112). Each keeps
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
    release_check: "mini-mac-release-any",
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
    return {
      verify: workflowValue(verifyLane?.["runs-on"] ?? "", {
        matrix: { lane: "mac" },
        inputs: { mac_runner: passed("verify", "mac_runner") },
        vars,
      }),
      rehearse: updateIn("rehearse"),
      sign: workflowValue(release.release?.["runs-on"] ?? "", { needs, vars }),
      update: updateIn("update"),
      publish: workflowValue(release.publish?.["runs-on"] ?? "", { needs, vars }),
    };
  };

  it("sends a publishing run's Mac jobs to the release queues of their place kind", () => {
    expect(placed("false", { ...ordinary, ...queues })).toEqual({
      verify: "mini-mac-release-any",
      rehearse: "mini-mac-release-virtual",
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
      rehearse: "mini-mac-virtual",
      sign: "mini-mac-real",
      update: "mini-mac-virtual",
      publish: "mini-mac-virtual",
    });
  });

  it("keeps today's routing while the release kinds are unset", () => {
    const today = {
      verify: "mini-mac-any",
      rehearse: "mini-mac-virtual",
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
        check: "mini-mac-check",
        sign: "mini-mac-sign",
        light: "mini-mac-light",
      }),
    };
    const ordinaryKinds = {
      verify: "mini-mac-check",
      rehearse: "mini-mac-light",
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
    steps?: { id?: string; run?: string }[];
  };
  const jobs = (file: string) =>
    (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
  const queues = {
    check: "q-check",
    journeys: "q-journeys",
    phone: "q-phone",
    testflight: "q-testflight",
    build: "q-build",
    sign: "q-sign",
    light: "q-light",
    release_check: "q-release-check",
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
    ["verify.yml", "lane", { matrix: { lane: "mac" }, inputs: {} }, "check", "mini-mac-any"],
    ["journeys.yml", "affected-journeys", { inputs: {} }, "journeys", "mini-mac-any"],
    ["phone.yml", "native-phone", { inputs: {} }, "phone", "mini-mac-virtual"],
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
        const [key, values] = Object.entries(job.strategy?.matrix ?? {})[0] ?? [];
        const listed =
          typeof values === "string" && values.includes("${{")
            ? workflowValue(values, { inputs: {} })
            : values;
        const entries =
          key && Array.isArray(listed) ? listed.map((value) => ({ [key]: value })) : [{}];
        for (const matrix of entries) {
          const runner = (vars: Record<string, string>) =>
            workflowString(job["runs-on"] ?? "", {
              vars,
              matrix,
              inputs: {},
              needs: publishing(true),
            });
          const before = runner(today);
          if (typeof before !== "string" || !/^(mini-mac|macos-15$)/.test(before)) continue;
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
    const run = jobs("verify.yml").lane?.steps?.find((step) => step.id === "e2e")?.run ?? "";
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
          ONLY: "",
          ...(cores === undefined ? {} : { RUNNER_UP_CORES: cores }),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(log, "utf8").trim();
    };
    expect(workers("12")).toBe("exec playwright test --workers=6");
    expect(workers("1")).toBe("exec playwright test --workers=1");
    // No size named: half this machine, as `--workers=50%` gave.
    expect(workers()).toBe(
      `exec playwright test --workers=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
    );
    expect(workers("not a number")).toBe(
      `exec playwright test --workers=${Math.max(1, Math.floor(availableParallelism() / 2))}`,
    );
  });
});

/**
 * INF-1720's approved plan: every Linux job of every workflow runs where the
 * repository variable LINUX_RUNNER sends it, the PC's shell-pc-linux places,
 * as ci.yml's already did, and on GitHub's hosted Ubuntu when it is unset.
 * The package check's Ubuntu 26.04 leg takes the PC's 26.04 image's label.
 * DOP-157's approved plan (direction A): the gate jobs - the two that open
 * a pull request's phone and journeys runs and the four Linux jobs that open
 * a release - take the PC's gate label, LINUX_RUNNER plus -gate, whose
 * runners take no other job, so a runner started for one runs one.
 * Each job's runner is evaluated both ways, for every matrix entry.
 */
it("sends every Linux job to LINUX_RUNNER, and hosted Ubuntu when it is unset", () => {
  const gate = [
    "phone.yml:cancel-replaced",
    "journeys.yml:choose-journeys",
    "release.yml:resolve",
    "release.yml:notes",
    "release.yml:phone",
    "ios-release.yml:resolve",
  ];
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
      const lanes = typeof matrix.lane === "string" ? evaluate(matrix.lane, { inputs: {} }) : [];
      const entries: object[] = include.length
        ? include
        : Array.isArray(lanes) && lanes.length
          ? lanes.map((lane) => ({ lane }))
          : [{}];
      for (const entry of entries) {
        const runner = (vars: Record<string, string>) =>
          evaluate(job["runs-on"] ?? "", { vars, matrix: entry, inputs: {}, needs: {} });
        const hosted = runner({});
        if (typeof hosted !== "string" || !hosted.startsWith("ubuntu-")) continue;
        const name = `${file}:${id} ${JSON.stringify(entry)}`;
        linux.push(name);
        if (gate.includes(`${file}:${id}`)) expect(hosted, name).toBe("ubuntu-latest");
        expect(runner({ LINUX_RUNNER: "shell-pc-linux" }), name).toBe(
          gate.includes(`${file}:${id}`)
            ? "shell-pc-linux-gate"
            : hosted === "ubuntu-26.04"
              ? "shell-pc-linux-2604"
              : "shell-pc-linux",
        );
        // INF-2111: the release's own Linux label reaches a job only through a
        // publishing release's call ("a release's Linux label" below).
        expect(
          runner({
            LINUX_RUNNER: "shell-pc-linux",
            RELEASE_LINUX_RUNNER: "shell-pc-linux-release",
          }),
          name,
        ).toBe(runner({ LINUX_RUNNER: "shell-pc-linux" }));
      }
    }
  }
  // The jobs the plan named, so a job the check could not read is not missed.
  for (const job of [
    "ci.yml:unit-tests",
    "journeys.yml:choose-journeys",
    "source-journeys.yml:source-desktop",
    "verify.yml:lane",
    "phone.yml:cancel-replaced",
    "replay.yml:replay-gate",
    "linux-startup.yml:runtime-facts",
    "linux-packages.yml:build",
    "linux-packages.yml:check",
    "release.yml:notes",
    "ios-release.yml:availability",
    ...gate,
  ])
    expect(
      linux.some((name) => name.startsWith(`${job} `)),
      job,
    ).toBe(true);
});

/**
 * INF-2111, the captain's first speed-up on the alpha of 2026-10-31: "Give
 * release and nightly jobs first claim on the Linux PC's 5 places, ahead of
 * pull requests and lab runs." A publishing release's Linux jobs ask for a
 * release-only label, RELEASE_LINUX_RUNNER, through the workflows it calls,
 * and its Ubuntu 26.04 package check for that label with -2604. The gate
 * jobs keep the gate label; a dry run, a request and an unset variable keep
 * LINUX_RUNNER (docs/testing.md, "A release's Linux label").
 */
describe("a release's Linux label", () => {
  type Job = {
    "runs-on"?: string;
    with?: Record<string, string>;
    strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  };
  type Workflow = {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    jobs: Record<string, Job>;
  };
  const workflow = (file: string) => loadYamlFile(`.github/workflows/${file}`) as Workflow;
  const release = workflow("release.yml").jobs;
  const verify = workflow("verify.yml").jobs;
  const journeys = workflow("source-journeys.yml").jobs["source-desktop"];
  const packages = workflow("linux-packages.yml").jobs;
  const availability = workflow("ios-release.yml").jobs.availability;
  const runsOn = (job: Job | undefined, contexts: Record<string, unknown>) =>
    workflowValue(job?.["runs-on"] ?? "", contexts);
  const pc = { LINUX_RUNNER: "shell-pc-linux" };
  const labels = { ...pc, RELEASE_LINUX_RUNNER: "shell-pc-linux-release" };
  /** Each package check named by its system, on `label`, or `twin` for the Ubuntu 26.04 leg. */
  const everyCheck = (label: string, twin: string) =>
    (packages.check?.strategy?.matrix?.include ?? []).map(
      (matrix) =>
        `${matrix.system} ${matrix.image ?? matrix.runner}: ${matrix.runner === "ubuntu-26.04" ? twin : label}`,
    );

  /** Where each of a release run's Linux jobs starts, through its callers' inputs. */
  const placed = (dryRun: "true" | "false", vars: Record<string, string>) => {
    const needs = { resolve: { outputs: { dry_run: dryRun } } };
    const passed = (id: string, input: string) =>
      workflowValue(release[id]?.with?.[input] ?? "", { needs, vars });
    const linuxRunner = passed("verify", "linux_runner");
    const runner = passed("linux", "runner");
    const journeyRunner = workflowValue(verify["linux-e2e"]?.with?.runner ?? "", {
      inputs: { linux_runner: linuxRunner },
    });
    return {
      checks: runsOn(verify.lane, {
        matrix: { lane: "linux-checks" },
        inputs: { linux_runner: linuxRunner },
        vars,
      }),
      journeys: runsOn(journeys, { inputs: { runner: journeyRunner }, vars }),
      build: runsOn(packages.build, { inputs: { runner }, vars }),
      packages: (packages.check?.strategy?.matrix?.include ?? []).map(
        (matrix) =>
          `${matrix.system} ${matrix.image ?? matrix.runner}: ${runsOn(packages.check, { matrix, inputs: { runner }, vars })}`,
      ),
      gate: ["resolve", "notes", "phone"].map((id) => runsOn(release[id], { vars })),
    };
  };
  const upload = (mode: string, vars: Record<string, string>) =>
    runsOn(availability, { needs: { resolve: { outputs: { mode } } }, vars });
  const today = {
    checks: "shell-pc-linux",
    journeys: "shell-pc-linux",
    build: "shell-pc-linux",
    packages: everyCheck("shell-pc-linux", "shell-pc-linux-2604"),
    gate: ["shell-pc-linux-gate", "shell-pc-linux-gate", "shell-pc-linux-gate"],
  };

  it("sends a publishing release's Linux jobs to the release's own label", () => {
    expect(placed("false", labels)).toEqual({
      checks: "shell-pc-linux-release",
      journeys: "shell-pc-linux-release",
      build: "shell-pc-linux-release",
      packages: everyCheck("shell-pc-linux-release", "shell-pc-linux-release-2604"),
      gate: today.gate,
    });
    expect(upload("release", labels)).toBe("shell-pc-linux-release");
    expect(upload("status", labels)).toBe("shell-pc-linux");
  });

  it("keeps a dry run on LINUX_RUNNER, so a rehearsal never takes a release's place", () => {
    expect(placed("true", labels)).toEqual(today);
  });

  it("keeps today's labels while the variable is unset", () => {
    expect(placed("false", pc)).toEqual(today);
    expect(placed("true", pc)).toEqual(today);
    expect(upload("release", pc)).toBe("shell-pc-linux");
    expect(placed("false", {})).toEqual({
      checks: "ubuntu-latest",
      journeys: "ubuntu-24.04",
      build: "ubuntu-24.04",
      packages: everyCheck("ubuntu-24.04", "ubuntu-26.04"),
      gate: ["ubuntu-latest", "ubuntu-latest", "ubuntu-latest"],
    });
    expect(upload("release", {})).toBe("ubuntu-latest");
  });

  it("lets only a publishing release's calls pass the label on, never a request", () => {
    const passing: string[] = [];
    for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
      name.endsWith(".yml"),
    )) {
      for (const [id, job] of Object.entries(workflow(file).jobs)) {
        for (const value of [job.with?.runner, job.with?.linux_runner]) {
          if (!value?.includes("${{")) continue;
          const contexts = {
            vars: labels,
            needs: { resolve: { outputs: { dry_run: "false" } } },
            inputs: { linux_runner: labels.RELEASE_LINUX_RUNNER },
          };
          if (workflowValue(value, contexts) === labels.RELEASE_LINUX_RUNNER)
            passing.push(`${file}:${id}`);
        }
      }
    }
    expect(passing.sort()).toEqual([
      "release.yml:linux",
      "release.yml:verify",
      "verify.yml:linux-e2e",
    ]);
    // A request names no Linux label of its own.
    expect(workflow("verify.yml").on.workflow_dispatch?.inputs).not.toHaveProperty("linux_runner");
    expect(workflow("linux-packages.yml").on.workflow_dispatch?.inputs).not.toHaveProperty(
      "runner",
    );
    expect(workflow("source-journeys.yml").on.workflow_dispatch?.inputs).not.toHaveProperty(
      "runner",
    );
  });
});

describe("the cask republication workflow", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
  };
  const workflow = loadYamlFile(".github/workflows/republish-casks.yml") as {
    on: {
      push?: { branches: string[]; paths: string[] };
      pull_request?: unknown;
      workflow_dispatch?: { inputs: Record<string, Record<string, unknown>> };
    };
    permissions: Record<string, string>;
    concurrency: Record<string, unknown>;
    jobs: Record<string, { if: string; "runs-on": string; steps: Step[] }>;
  };
  const job = workflow.jobs.republish as { if: string; "runs-on": string; steps: Step[] };
  /** The steps a passing run on `ref` with `inputs` takes, in order; null when the job does not start. */
  const ranSteps = (
    ref: string,
    inputs: Record<string, unknown>,
    repository = "infinitary-labs/infinitary",
  ): Step[] | null => {
    const contexts = { github: { ref, repository }, inputs };
    if (workflowValue(job.if, contexts) !== true) return null;
    const outcomes: Record<string, { outcome: string }> = {};
    const ran: Step[] = [];
    for (const candidate of job.steps) {
      const runs =
        candidate.if === undefined ||
        workflowValue(candidate.if, { ...contexts, steps: outcomes }) === true;
      if (candidate.id) outcomes[candidate.id] = { outcome: runs ? "success" : "skipped" };
      if (runs) ran.push(candidate);
    }
    return ran;
  };
  const names = (steps: Step[] | null) => (steps ?? []).map((each) => each.id ?? each.name);
  const PUSHES = /publish-tap\.sh (live|republish)\b(?!-)|git push/;
  const TOKEN = /secrets\./;

  it("runs when what the casks are written from reaches main, and on demand, never on a pull request", () => {
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/republish-casks.yml",
        "packaging/alpha-notice.txt",
        "scripts/publish-tap.sh",
        "scripts/tap-publication.ts",
        "src/core/update/tapPublication.ts",
        "src/core/update/updateChannels.ts",
      ]),
    );
    for (const path of workflow.on.push?.paths ?? []) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(workflow.on.workflow_dispatch?.inputs.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "republish-casks", "cancel-in-progress": false });
  });

  // INF-621: a cask proof may use the disposable image, but the override
  // must never move a publishing job away from its normal runner.
  it("allows an isolated runner only for a dry run", () => {
    expect(workflow.on.workflow_dispatch?.inputs.mac_runner).toMatchObject({
      type: "string",
      required: false,
    });
    const runner = (inputs: Record<string, unknown>, vars: Record<string, string>) =>
      workflowValue(job["runs-on"], { inputs, vars });
    expect(
      runner({ dry_run: true, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac-inf621-proof");
    expect(
      runner({ dry_run: false, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac");
    expect(runner({}, { MAC_RUNNER: "mini-mac" })).toBe("mini-mac");
    expect(runner({ dry_run: true }, {})).toBe("macos-15");
  });

  it("republishes only from main, with the tap token in one step, and a dry run anywhere pushes nothing", () => {
    // A push to main carries no inputs; a live run on demand says dry_run false.
    for (const inputs of [{}, { dry_run: false }]) {
      const ran = ranSteps("refs/heads/main", inputs);
      expect(names(ran)).toContain("tap");
      expect(names(ran)).not.toContain("tap-rehearsal");
      expect(
        names((ran ?? []).filter((each) => TOKEN.test(JSON.stringify(each.env ?? {})))),
      ).toEqual(["tap"]);
      expect((ran ?? []).find((each) => each.id === "tap")?.run).toMatch(
        /scripts\/publish-tap\.sh republish \|/,
      );
    }
    for (const ref of ["refs/heads/main", "refs/heads/a-branch"]) {
      const ran = ranSteps(ref, { dry_run: true });
      expect(names(ran)).toEqual(
        expect.arrayContaining(["tap-rehearsal", "Keep the rehearsed casks", "Summarize"]),
      );
      expect(names(ran)).not.toContain("tap");
      for (const each of ran ?? []) {
        expect(each.run ?? "", each.name).not.toMatch(PUSHES);
        expect(JSON.stringify(each.env ?? {}), each.name).not.toMatch(TOKEN);
      }
    }
    // Any other ref may only rehearse: a live run there does not start.
    expect(ranSteps("refs/heads/a-branch", { dry_run: false })).toBeNull();
    expect(ranSteps("refs/heads/a-branch", {})).toBeNull();
    // Nor does a push to the Firstmate 3000 repository's main, before it is
    // archived (FI3-1780 step 11): only Infinitary's own repository writes
    // Infinitary's tap, and Firstmate 3000's casks move only with a release.
    expect(ranSteps("refs/heads/main", {}, "kunchenguid/firstmate-3000")).toBeNull();
    expect(
      names(ranSteps("refs/heads/main", { dry_run: true }, "kunchenguid/firstmate-3000")),
    ).toContain("tap-rehearsal");
  });
});

// Captain's "Prepare reuse": selecting old copies must skip the signing job,
// not skip either installed-check job or silently select a fresh build.
it("selects only the complete installed checks for reuse, without a signing job", () => {
  type Job = {
    if?: string;
    with?: Record<string, string>;
    steps?: { id?: string; if?: string; run?: string; uses?: string }[];
  };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: Record<string, Job>;
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, Job> };
  const selected = (job: Job | undefined, contexts: Record<string, unknown>) => {
    if (!job) throw new Error("The verification job is missing");
    return Boolean(workflowValue(job.if ?? "${{ true }}", contexts));
  };
  for (const reuse of ["", "reviewed declaration"]) {
    const inputs = { reuse };
    expect(selected(installer.jobs.build, { inputs })).toBe(!reuse);
    expect(
      selected(installer.jobs.installed, {
        inputs,
        needs: { build: { result: reuse ? "skipped" : "success" } },
      }),
    ).toBe(true);
    expect(
      selected(installer.jobs.installed, { inputs, needs: { build: { result: "failure" } } }),
    ).toBe(false);
    const steps = installer.jobs.installed?.steps ?? [];
    expect(selected(steps.find((step) => step.id === "reuse") as Job, { inputs })).toBe(
      Boolean(reuse),
    );
    expect(
      selected(steps.find((step) => step.uses === "actions/download-artifact@v4") as Job, {
        inputs,
      }),
    ).toBe(!reuse);
  }
  for (const installer_only of [false, true]) {
    const reused = {
      inputs: { installer_only, installer_reuse: "reviewed declaration", ref: "reviewed source" },
    };
    for (const name of ["lane", "linux-e2e"])
      expect(selected(verify.jobs[name], reused)).toBe(false);
    expect(selected(verify.jobs.installer, reused)).toBe(true);
    expect(workflowValue(verify.jobs.installer?.with?.reuse ?? "", reused)).toBe(
      reused.inputs.installer_reuse,
    );
  }
});

// DOP-42 supplies the virtual-only label for INF-643's approved signed rerun.
// INF-818 owns any later move of Intel. A real-Mac setting cannot redirect these.
it("keeps installer verification on the selected disposable runners", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: {
      build: { "runs-on": string };
      installed: {
        name: string;
        "runs-on": string;
        strategy: { matrix: { chip: string } };
      };
    };
  };
  const vars = { MAC_RUNNER: "mini-mac-real", REAL_MAC_RUNNER: "mini-mac-real" };
  expect(workflowString(jobs.build["runs-on"], { vars })).toBe("mini-mac-virtual");
  const chips = workflowValue(jobs.installed.strategy.matrix.chip, {
    inputs: { chip: "both" },
  }) as string[];
  const assigned = chips.map((chip) => ({
    chip,
    runner: workflowString(jobs.installed["runs-on"], { vars, matrix: { chip } }),
  }));
  // The check names PR readings and diagnoses are keyed to.
  expect(chips.map((chip) => workflowString(jobs.installed.name, { matrix: { chip } }))).toEqual([
    "Apple silicon",
    "Intel",
  ]);
  expect(assigned).toEqual([
    { chip: "arm64", runner: "mini-mac-virtual" },
    { chip: "x64", runner: "macos-15-intel" },
  ]);
});

// INF-1900 direction D: the release's update check runs in a disposable
// Apple silicon Mac, rehearsing before signing and updating after it. The
// captain: Intel is a best-effort side effect, with no hosted Mac runs. The
// promotion gate reads its job by this name.
it("runs the update check on Apple silicon only, rehearsing before signing and updating from the handoff", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-update.yml") as {
    jobs: Record<string, { name: string; "runs-on": string; strategy?: unknown }>;
  };
  expect(
    Object.values(jobs).map((job) => [
      job.name,
      workflowValue(job["runs-on"], { inputs: {}, vars: {} }),
      job.strategy,
    ]),
  ).toEqual([["Apple silicon", "mini-mac-virtual", undefined]]);
  const release = loadYamlFile(".github/workflows/release.yml") as {
    jobs: Record<
      "rehearse" | "update",
      { name: string; uses?: string; secrets?: unknown; with?: Record<string, string> }
    >;
  };
  const { rehearse, update } = release.jobs;
  for (const job of [rehearse, update]) {
    expect(job.uses).toBe("./.github/workflows/mac-update.yml");
    expect(job.secrets).toBeUndefined();
  }
  expect(rehearse.with?.handoff_id).toBeUndefined();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.handoff_id).toBe("${{ needs.release.outputs.handoff_id }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.zip_sha256).toBe("${{ needs.release.outputs.sha256 }}");
  expect(update.name).toBe("Update from the last published alpha");
});

// INF-1539: the captain approved "Add logging and recheck once" for Apple silicon
// alone. A one-chip recheck must drop the other Mac from the run, and a release
// (which passes no chip) must still check both.
it("runs only the requested Mac type's installed checks", () => {
  type Matrix = { chip: string };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    on: { workflow_call: { inputs: { chip: { default: string } } } };
    jobs: { installed: { strategy: { matrix: Matrix } } };
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as {
    jobs: { installer: { with: Record<string, string> } };
  };
  const matrix = installer.jobs.installed.strategy.matrix;
  const chipsFor = (dispatched: string | undefined) => {
    const chip = workflowString(verify.jobs.installer.with.chip ?? "", {
      inputs: { installer_chip: dispatched },
    });
    // A matrix include entry would add an excluded chip back, so the chip list itself is chosen.
    expect(matrix).not.toHaveProperty("include");
    return workflowValue(matrix.chip, { inputs: { chip } }) as string[];
  };
  expect(installer.on.workflow_call.inputs.chip.default).toBe("both");
  expect(chipsFor(undefined)).toEqual(["arm64", "x64"]);
  expect(chipsFor("both")).toEqual(["arm64", "x64"]);
  expect(chipsFor("arm64")).toEqual(["arm64"]);
  expect(chipsFor("x64")).toEqual(["x64"]);
});

describe("the private alpha (roadmap 1.2)", () => {
  it("publishes the selected source's finalized downloads and verifies them without a sign-in", () => {
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<
        "release" | "publish",
        { env: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] }
      >;
    };
    const job = workflow.jobs.release;
    const publication = workflow.jobs.publish;
    const context = {
      needs: {
        resolve: {
          outputs: {
            release_repository: releaseSource.repository,
            tag_name: "v1.2.3",
            zip_name: "Infinitary-1.2.3-universal.zip",
          },
        },
      },
    };
    expect(workflowValue(job.env.PUBLIC_TAG ?? "", context)).toBe("v1.2.3");
    expect(workflowValue(job.env.RELEASE_REPOSITORY ?? "", context)).toBe(releaseSource.repository);
    // The publication job publishes under the same names (INF-1716).
    expect(publication.env).toEqual(job.env);
    const publicRead = publication.steps.find((step) => step.id === "public-fetch-back");
    expect(Object.keys(publicRead?.env ?? {})).toEqual(["ARTIFACT_SHA256"]);
  });
});

describe("the Linux packages", () => {
  // INF-2163's retention change, which the captain started: a passing
  // journey run keeps only its result file and demos, and a failed phone
  // check keeps its result bundles 1 day, a recording run 3.
  it("keeps a passing journey run's result and demos, and a failed phone check's bundles 1 day", () => {
    type Step = { if?: string; uses?: string; with?: Record<string, unknown> };
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    const uploads = source.jobs["source-desktop"].steps.filter((step) =>
      String(step.with?.name ?? "").startsWith("source-desktop-"),
    );
    const kept = (outcome: string) =>
      uploads
        .filter((step) => workflowValue(step.if ?? "", { steps: { journeys: { outcome } } }))
        .map((step) => String(step.with?.path).trim().split("\n"));
    expect(kept("success")).toEqual([
      [
        "Application Support/firstmate/playwright-report/source-results.json",
        "Application Support/firstmate/test-results/runs/*/*/demo/",
      ],
    ]);
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      expect(kept(outcome)).toHaveLength(1);
      expect(kept(outcome)[0]).toContain("Application Support/firstmate/test-results/");
    }
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    const bundles = Object.values(phone.jobs)
      .flatMap((job) => job.steps ?? [])
      .find(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact") && step.with?.name === "phone-results",
      );
    const days = (recording: boolean) =>
      workflowValue(String(bundles?.with?.["retention-days"]), { inputs: { recording } });
    expect([days(false), days(true)]).toEqual([1, 3]);
  });

  it("checks each package on a clean copy of its system and keeps the files on the run alone", () => {
    const workflow = loadYamlFile(".github/workflows/linux-packages.yml") as {
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          strategy?: { matrix: { include: Array<Record<string, string>> } };
          steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const text = read(".github/workflows/linux-packages.yml");
    expect(text).not.toMatch(/gh release|softprops|--publish always|publish-release-asset/);
    const upload = workflow.jobs.build?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    // INF-1838: keep the same-run package handoff, not weeks of large binaries.
    // INF-2163's retention change: a pull request's packages 1 day, a release's 3.
    expect(upload?.with?.name).toBe("linux-packages");
    const kept = (event_name: string) =>
      workflowValue(String(upload?.with?.["retention-days"]), { github: { event_name } });
    expect(["pull_request", "workflow_dispatch", "push"].map(kept)).toEqual([1, 3, 3]);
    const systems = (workflow.jobs.check?.strategy?.matrix.include ?? []).map(
      (entry) => `${entry.system} ${entry.image ?? entry.runner}`,
    );
    expect(systems).toEqual([
      "ubuntu-host ubuntu-24.04",
      "ubuntu-host ubuntu-26.04",
      "ubuntu ubuntu:24.04",
      "ubuntu ubuntu:26.04",
      "fedora fedora:latest",
      "arch archlinux:latest",
      "appimage fedora:latest",
      "nix ubuntu-24.04",
    ]);
  });
});

// INF-658's approved plan: execute the actual Linux journey command, not a
// source-text pin. Disposable command stand-ins record the selected interface.
describe("budgeted pull-request journey workflow (INF-658)", () => {
  type Job = {
    name: string;
    strategy: { matrix: { lane: string; shard: string; include?: string } };
    steps: {
      name?: string;
      run?: string;
      if?: string;
      uses?: string;
      with?: Record<string, string>;
    }[];
  };
  const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
    jobs: Record<string, Job>;
  };
  const job = source.jobs["source-desktop"];
  // INF-1417: preserve the ordinary eight jobs and split fresh-state checks four ways.
  // INF-2340 (captain's route "alone-at-author"): the full suite on main and
  // in an alpha adds no fresh-state jobs; only a request for them does.
  it("splits starters into disjoint lanes, the full suite eight ways and a requested fresh-state pass four", () => {
    const lanes = (suite: string, lane = "parallel") =>
      workflowValue(job?.strategy.matrix.lane ?? "", { inputs: { suite, lane } });
    const shards = (suite: string) =>
      workflowValue(job?.strategy.matrix.shard ?? "", { inputs: { suite } });
    expect(job?.strategy.matrix.include).toBeUndefined();
    expect(lanes("starter")).toEqual(["parallel", "desktop"]);
    expect(shards("starter")).toEqual([1]);
    expect(lanes("full")).toEqual(["parallel", "desktop"]);
    expect(shards("full")).toEqual([1, 2, 3, 4]);
    expect(lanes("alone")).toEqual(["alone"]);
    expect(shards("alone")).toEqual([1, 2, 3, 4]);
    expect(lanes("affected", "desktop")).toEqual(["desktop"]);
    // A release's stable promotion reads every `verify / linux-e2e / …` job by name.
    const name = (suite: string, lane: string, shard: number) =>
      workflowString(job?.name ?? "", { inputs: { suite }, matrix: { lane, shard } });
    for (const shard of shards("alone") as number[]) {
      expect(name("alone", "alone", shard)).toBe(`journeys (run alone ${shard}/4)`);
    }
    expect(name("full", "desktop", 2)).toBe("journeys (desktop 2/4)");
  });
  it.each(["parallel", "desktop"])(
    "runs the %s starter and overflow files through their lane",
    (lane) => {
      const dir = scratchDir("infinitary-journey-placement-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        pnpm: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n',
        node: '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      expect(command).toBeDefined();
      for (const suite of ["starter", "affected"]) {
        const log = join(dir, `${suite}.log`);
        const files =
          lane === "desktop"
            ? "tests/e2e/keyboard-routing.spec.ts"
            : "tests/e2e/task-browser.spec.ts";
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
          env: {
            ...hostEnv(),
            PATH: `${bin}:${hostEnv().PATH}`,
            COMMAND_LOG: log,
            GITHUB_ENV: join(dir, `${suite}-env`),
            REPEAT_BASE: "origin/main",
            RUNNER_OS: "Linux",
            SUITE: suite,
            LANE: lane,
            FILES: files,
            SCREEN: "2560x1600x24",
            SHARD: "1",
          },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const call = readFileSync(log, "utf8");
        expect(call.includes("--project=desktop")).toBe(lane === "desktop");
        expect(call.includes("--project=application")).toBe(lane === "parallel");
        // INF-2340: the affected files' rounds end with their run-alone pass.
        if (suite === "affected")
          expect(call.trim()).toBe(
            `node scripts/journey-runs.ts --base origin/main --files ${files} --alone-out playwright-report/alone -- ${lane === "desktop" ? "--project=desktop" : "--project=renderer --project=application"}`,
          );
        else {
          expect(call).toContain("exec playwright test --no-deps");
          expect(call).toContain("tests/e2e/devices.spec.ts");
          expect(call).toContain("tests/e2e/source-start.spec.ts");
        }
      }
    },
  );
  // INF-1417: execute each fresh-state share's real shell entry point, both in
  // full verification and the hosted-only proof request, preserving result retention.
  // INF-2340: only the requested pass runs every spec file alone.
  it.each([1, 2, 3, 4].map((shard) => ({ suite: "alone", shard })))(
    "runs fresh-state share $shard in $suite and keeps its distinct result",
    ({ suite, shard }) => {
      const dir = scratchDir("infinitary-journey-alone-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        node: '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
        pnpm: '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      const log = join(dir, "alone.log");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
        env: {
          ...hostEnv(),
          PATH: `${bin}:${hostEnv().PATH}`,
          COMMAND_LOG: log,
          GITHUB_ENV: join(dir, "github-env"),
          RUNNER_OS: "Linux",
          SUITE: suite,
          LANE: "alone",
          SCREEN: "2560x1600x24",
          SHARD: String(shard),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const [, selected, out] =
        /^node scripts\/e2e-alone\.ts --shard (\S+) --out (\S+)$/.exec(
          readFileSync(log, "utf8").trim(),
        ) ?? [];
      expect(selected).toBe(`${shard}/4`);
      expect(out, "the job runs the pass alone, over every spec file").toBeTruthy();
      // Kept on the requested pass's jobs and an affected job's, never a full suite's.
      const onAlone = (step: { if?: string } | undefined) =>
        workflowValue(step?.if ?? "", { inputs: { suite }, matrix: { lane: "alone" } }) === true &&
        workflowValue(step?.if ?? "", {
          inputs: { suite: "affected" },
          matrix: { lane: "desktop" },
        }) === true &&
        workflowValue(step?.if ?? "", {
          inputs: { suite: "full" },
          matrix: { lane: "desktop" },
        }) === false;
      const kept = job?.steps.find(
        (step) =>
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.path === `Application Support/firstmate/${out}/`,
      );
      expect(
        workflowString(kept?.with?.name ?? "", {
          inputs: { suite },
          matrix: { lane: "alone", shard },
        }),
      ).toBe(`e2e-alone-${shard}`);
      expect(
        workflowString(kept?.with?.name ?? "", {
          inputs: { suite: "affected", "artifact-suffix": "overflow-0" },
          matrix: { lane: "desktop", shard: 1 },
        }),
      ).toBe("e2e-alone-overflow-0-desktop");
      expect(onAlone(kept)).toBe(true);
      const summarize = job?.steps.find((step) => step.run?.includes("--summarize"));
      expect(summarize?.run).toContain(
        `node scripts/e2e-alone.ts --summarize ${out} | tee -a "$GITHUB_STEP_SUMMARY"`,
      );
      expect(onAlone(summarize)).toBe(true);
    },
  );
});

// INF-2259 retains virtual-phone delegation after adding full-selection accounting.
// Execute its shell instead of pinning a line number in the unit routing contract.
it.each(["in-turn", "together"])(
  "delegates both devices to the fixed virtual phone clone in %s",
  (mode) => {
    const phone = loadYamlFile(".github/workflows/phone.yml") as {
      jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
    };
    const command = phone.jobs["native-phone"]!.steps.find((step) => step.id === "both")!.run!;
    expect(
      recordedWorkflowCall(command, {
        PHONE_VIRTUAL_MAC: mode,
        PHONE_PARTS: "",
        PHONE_FULL: "true",
        PHONE_REPEAT_PARTS: "",
      }),
    ).toEqual(["scripts/virtual-mac/phone.sh", "gate", "iphone", "ipad"]);
  },
);

// INF-1613's submitted unblock answer: absent storage never stops tap releases;
// partial configuration is an error, not an accidental silent installer opt-out.
it("selects Homebrew/Linux-only before storage setup and refuses partial R2 configuration", () => {
  const workflow = loadYamlFile(".github/workflows/release.yml") as {
    jobs: { release: { steps: { id?: string; run?: string }[] } };
  };
  const command = workflow.jobs.release.steps.find((step) => step.id === "visibility")?.run;
  if (!command) throw new Error("Missing download activation command");
  for (const configuration of ["absent", "complete", "partial"]) {
    const folder = scratchDir("infinitary-r2-activation-");
    const output = join(folder, "output");
    const result = spawnSync("bash", ["-e", "-c", command], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        R2_ENDPOINT: configuration === "absent" ? "" : "https://account.r2.cloudflarestorage.com",
        R2_BUCKET: configuration === "absent" ? "" : "installers",
        HAS_ACCESS_KEY: configuration === "absent" ? "false" : "true",
        HAS_SECRET_KEY: configuration === "complete" ? "true" : "false",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(folder, "summary"),
      },
    });
    if (configuration === "partial") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Incomplete download storage configuration");
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`direct=${configuration === "complete"}\n`);
    }
  }
});
