import { describe, expect, it, vi } from "vitest";
import { journeyArguments } from "../scripts/journey-runs.ts";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import {
  loadYamlFile,
  read,
  type WorkflowStep as Step,
  VERIFY_E2E_RUN,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** Requested journeys and the Mac-only selection (journeys.yml, source-journeys.yml, replay.yml). */

describe("local packaging identity (electron-builder.dev.yml)", () => {
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
    // The tag reaches every lane, the desktop teardown included (playwright.config.ts).
    const verifyOnly = (all_journeys: boolean) =>
      workflowString(e2e?.env?.INFINITARY_E2E_TAG ?? "", { inputs: { all_journeys } });
    expect(verifyOnly(false)).toBe(MAC_ONLY_TAG);
    expect(verifyOnly(true)).toBe("");
    // Only a run of every journey supplies the chooser's journey times, one
    // result for each Mac journey job (INF-2779), the mac job's share of the
    // parallel lanes included (INF-2987).
    const kept = steps.find((step) => step.name === "Keep the e2e result");
    const keptAs = (all_journeys: boolean, lane: string) =>
      workflowString(String(kept?.with?.name ?? ""), {
        inputs: { all_journeys },
        matrix: { lane },
      });
    for (const lane of ["parallel", "desktop", "mac"]) {
      expect(keptAs(true, lane)).toBe(`e2e-results-${lane}`);
      expect(keptAs(false, lane)).not.toBe(keptAs(true, lane));
    }
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
    const runs = (lane: string, status: Partial<Record<"failure", boolean>> = {}) =>
      workflowValue(
        refuse?.if ?? "",
        { matrix: { lane } },
        {
          success: !status.failure,
          failure: Boolean(status.failure),
          always: true,
          cancelled: false,
        },
      );
    for (const lane of ["parallel", "desktop"]) {
      expect(runs(lane)).toBe(true);
      expect(runs(lane, { failure: true })).toBe(true);
    }
    // The run-alone pass refuses an untagged skip itself (scripts/e2e-alone.ts).
    expect(runs("alone")).toBe(false);
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
   * shared group journeys-refs/heads/main, before keyboard-routing ran. The
   * run's own group is tests/workflow-request-groups.test.ts's (INF-3380),
   * which keeps main's requests apart; no job adds a group of its own.
   */
  it("gives no journey job a group to cancel another request's in", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      jobs: Record<string, { concurrency?: unknown }>;
    };
    for (const [id, job] of Object.entries(journeys.jobs))
      expect(job.concurrency, id).toBeUndefined();
  });

  /**
   * INF-850: on 2026-10-22 GitHub answered no verify.yml run to a search by
   * result while its plain list held passing ones, and every pull request's
   * chooser failed. INF-1443: on 2026-10-26 the plain list answered 502
   * while GitHub worked out each run's pull requests, and answered every run
   * without them. INF-1578: on 2026-10-27 a passing installer-only run
   * supplied no e2e-results. The step's own script runs against each day's
   * answers and the artifact metadata, including across run-list pages.
   * INF-2779: a run since the Mac journeys split in two keeps one result per
   * journey job, and supplies times only with both; INF-2987: one with the
   * mac job's share keeps three, and supplies all three.
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
      const recorded = artifacts.runs[String(passing?.id)] ?? [];
      const results = recorded.find((artifact) => artifact.name === "e2e-results");
      for (const pageSize of [undefined, 1]) {
        const found = await choose(readings.runs, { pageSize });
        expect(found.outputs.id).toBe(passing?.id);
        expect(found.outputs.artifacts).toBe(String(results?.id));
        expect(found.summaries.join("")).toContain(passing?.html_url);
      }

      // The same run as a split check keeps it: each journey job's result, by
      // the name verify.yml gives it, with both downloaded.
      const verify = loadYamlFile(".github/workflows/verify.yml") as {
        jobs: { lane: { steps: Step[] } };
      };
      const keep = verify.jobs.lane.steps.find((step) => step.name === "Keep the e2e result");
      const split = ["parallel", "desktop"].map((lane, index) => ({
        id: Number(results?.id) + index,
        name: workflowString(String(keep?.with?.name ?? ""), {
          inputs: { all_journeys: true },
          matrix: { lane },
        }),
        expired: false,
      }));
      artifacts.runs[String(passing?.id)] = split;
      const both = await choose(readings.runs);
      expect(both.outputs.id).toBe(passing?.id);
      expect(both.outputs.artifacts).toBe(split.map((artifact) => artifact.id).join(","));
      // INF-2987: since the mac job runs a group of the parallel lanes, a run
      // keeps three results, and the chooser downloads all three.
      const three = ["parallel", "desktop", "mac"].map((lane, index) => ({
        id: Number(results?.id) + index,
        name: workflowString(String(keep?.with?.name ?? ""), {
          inputs: { all_journeys: true },
          matrix: { lane },
        }),
        expired: false,
      }));
      artifacts.runs[String(passing?.id)] = three;
      const all = await choose(readings.runs);
      expect(all.outputs.id).toBe(passing?.id);
      expect(all.outputs.artifacts).toBe(three.map((artifact) => artifact.id).join(","));
      // One job's result alone holds half the journeys' times: the chooser passes it by.
      artifacts.runs[String(passing?.id)] = split.slice(0, 1);
      const upToPassing = readings.runs.slice(0, readings.runs.indexOf(passing as Run) + 1);
      expect((await choose(upToPassing)).outputs).toEqual({});
      artifacts.runs[String(passing?.id)] = recorded;

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
});
