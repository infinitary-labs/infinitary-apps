import { createRequire } from "node:module";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  afterMergeShouldRun,
  PATH_READING_STEP,
  relevantFiles,
} from "../scripts/after-merge-paths.mjs";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows";

// Captain F6/F7: the queue's one signal reaches all after-merge workflows,
// with the same path selections as their existing push triggers. These are
// actual project paths read by those filters; no account or workflow is started.
const files = [
  "docs/forge.md",
  "docs/contract.json",
  "primitives/changes.md",
  "ios/Infinitary/Infinitary/InfinitaryApp.swift",
  "release-notes/changes/queue-owned-merges.json",
  "src/core/orchestrator/changeMerge.ts",
  "resources/runbooks/naming/runbook.json",
  "scripts/after-merge-paths.mjs",
  "tests/helpers/promptBudget.ts",
  "packaging/alpha-notice.txt",
  "scripts/publish-tap.sh",
  "src/shared/userDataFolders.ts",
];
const base = "ef9353fd2caf356facbfbf73687be612a3183140";
const head = "4841adb101c98fbf58452488a826862eddf360d4";
const repo = { owner: "example", repo: "project" };
const context = {
  eventName: "repository_dispatch",
  repo,
  sha: head,
  runId: 503,
  payload: { client_payload: { base } },
};
type Workflow = {
  on: {
    push: { paths?: string[]; "paths-ignore"?: string[] };
    repository_dispatch: { types: string[] };
  };
  jobs: Record<
    string,
    { if?: string; steps?: { id?: string; if?: string; with?: { script?: string } }[] }
  >;
};
const workflow = (name: string) => loadYamlFile(`.github/workflows/${name}.yml`) as Workflow;

function pushRuns(name: string, changed: string[]): boolean {
  const push = workflow(name).on.push;
  const matches = (file: string, patterns: string[]) =>
    patterns.reduce(
      (yes, pattern) =>
        pattern.startsWith("!")
          ? posix.matchesGlob(file, pattern.slice(1))
            ? false
            : yes
          : posix.matchesGlob(file, pattern) || yes,
      false,
    );
  return push.paths
    ? changed.some((file) => matches(file, push.paths ?? []))
    : !changed.every((file) => matches(file, push["paths-ignore"] ?? []));
}

function pastReading() {
  return {
    listWorkflowRuns: async () => ({
      data: {
        workflow_runs: [{ id: 501, status: "completed", conclusion: "success", head_sha: base }],
      },
    }),
    listJobsForWorkflowRun: async () => ({
      data: { jobs: [{ steps: [{ name: PATH_READING_STEP, conclusion: "success" }] }] },
    }),
  };
}

describe("after-merge path selection", () => {
  it.each(["main", "prompt-budget", "republish-casks"] as const)(
    "keeps %s's existing push selection and listens for the shared signal",
    (name) => {
      expect(workflow(name).on.repository_dispatch.types).toContain("infinitary-after-merge");
      const exactPaths = workflow(name).on.push.paths?.filter((path) => !path.includes("*")) ?? [];
      for (const file of [...files, ...exactPaths])
        expect(relevantFiles(name, [file]), file).toBe(pushRuns(name, [file]));
      expect(relevantFiles(name, files)).toBe(pushRuns(name, files));
    },
  );

  it("compares the real source range, preserves renamed paths and runs conservatively without complete paths", async () => {
    const calls: unknown[] = [];
    const github = {
      rest: {
        actions: pastReading(),
        repos: {
          compareCommits: async (input: unknown) => {
            calls.push(input);
            return { data: { status: "ahead", files: [{ filename: "docs/forge.md" }] } };
          },
        },
      },
    };
    expect(await afterMergeShouldRun(github, context, "main")).toBe(false);
    expect(calls).toEqual([{ ...repo, base, head, per_page: 100 }]);
    github.rest.repos.compareCommits = async () => ({
      data: {
        status: "ahead",
        files: [
          { filename: "docs/forge.md", previous_filename: "src/core/orchestrator/changeMerge.ts" },
        ],
      },
    });
    expect(await afterMergeShouldRun(github, context, "main")).toBe(true);
    expect(await afterMergeShouldRun(github, { ...context, payload: {} }, "main")).toBe(true);
    github.rest.repos.compareCommits = async () => ({
      data: { status: "behind", files: [{ filename: "docs/forge.md" }] },
    });
    expect(await afterMergeShouldRun(github, context, "main")).toBe(true);
    github.rest.repos.compareCommits = async () => {
      throw new Error("Comparison unavailable");
    };
    expect(await afterMergeShouldRun(github, context, "main")).toBe(true);
    expect(
      await afterMergeShouldRun(github, { ...context, eventName: "workflow_dispatch" }, "main"),
    ).toBe(true);
  });

  it("runs main's actual sort script for ignored-only changes without starting checks or an alpha", async () => {
    const main = workflow("main");
    const script = main.jobs.sort?.steps?.find((step) => step.id === "sort")?.with?.script;
    if (!script) throw new Error("main has no sort script");
    const cancelled: number[] = [];
    const outputs: Record<string, string> = {};
    const github = {
      rest: {
        repos: {
          compareCommits: async () => ({
            data: {
              status: "ahead",
              files: [
                { filename: "docs/forge.md" },
                { filename: "release-notes/changes/queue-owned-merges.json" },
              ],
            },
          }),
        },
        actions: {
          ...pastReading(),
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
          },
        },
      },
    };
    const core = {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      notice: () => {},
    };
    const execute = compileFunction(
      `return (async () => {\n${script}\n})()`,
      ["github", "context", "core", "process", "require"],
      { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    );
    await execute(
      github,
      context,
      core,
      { env: { GITHUB_WORKSPACE: fileURLToPath(new URL("../", import.meta.url)) } },
      createRequire(import.meta.url),
    );
    expect(outputs.kind).toBe("ignored");
    expect(cancelled).toEqual([context.runId]);
    const needs = { sort: { result: "success", outputs }, "alpha-wait": { result: "success" } };
    for (const id of ["verify", "startup", "covered"])
      expect(
        workflowValue(
          main.jobs[id]?.if ?? "",
          { needs },
          { success: true, cancelled: false, always: true, failure: false },
        ),
        id,
      ).toBe(false);
  });

  it.each(["prompt-budget", "republish-casks"])(
    "keeps %s's expensive and writing steps out of an irrelevant signal run",
    (name) => {
      const jobs = workflow(name).jobs;
      const job = jobs[name === "prompt-budget" ? "prompt-budget" : "republish"];
      const steps = job?.steps ?? [];
      const selected = steps.findIndex((step) => step.id === "paths");
      expect(selected).toBeGreaterThan(-1);
      for (const step of steps.slice(selected + 1))
        expect(
          workflowValue(
            step.if ?? "",
            { steps: { paths: { outputs: { run: "false" } } }, inputs: { dry_run: false } },
            { success: true, always: true, cancelled: false, failure: false },
          ),
          step.id,
        ).toBe(false);
    },
  );
});

// R2: a docs-only signal must carry relevant work from a run GitHub replaced.
describe("coverage after a replaced workflow run", () => {
  it.each(["main", "prompt-budget", "republish-casks"] as const)(
    "keeps unprocessed relevant work for %s instead of trusting the latest batch base",
    async (name) => {
      const current = "6dda35604d24524bb1cc0d3bc09500183f33bc3d";
      const relevant =
        name === "republish-casks"
          ? "scripts/publish-tap.sh"
          : "src/core/orchestrator/changeMerge.ts";
      const comparisons: { base: string; head: string }[] = [];
      const jobsRead: number[] = [];
      const github = {
        rest: {
          actions: {
            listWorkflowRuns: async () => ({
              data: {
                workflow_runs: [
                  { id: 502, status: "completed", conclusion: "cancelled", head_sha: head },
                  { id: 501, status: "completed", conclusion: "success", head_sha: base },
                ],
              },
            }),
            listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => {
              jobsRead.push(run_id);
              return {
                data: { jobs: [{ steps: [{ name: PATH_READING_STEP, conclusion: "success" }] }] },
              };
            },
          },
          repos: {
            compareCommits: async (input: { base: string; head: string }) => {
              comparisons.push(input);
              return {
                data: {
                  status: "ahead",
                  files: (input.base === head
                    ? ["docs/forge.md"]
                    : [relevant, "docs/forge.md"]
                  ).map((filename) => ({ filename })),
                },
              };
            },
          },
        },
      };
      expect(
        await afterMergeShouldRun(
          github,
          { ...context, sha: current, payload: { client_payload: { base: head } } },
          name,
        ),
      ).toBe(true);
      expect(comparisons[0]).toMatchObject({ base, head: current });
      expect(jobsRead).toEqual([501]);
    },
  );

  it.each(["main", "prompt-budget", "republish-casks"] as const)(
    "uses %s's last source reading past a newer checkout failure",
    async (name) => {
      const readings: { workflow_id: string; status: string }[] = [];
      const comparisons: { base: string; head: string }[] = [];
      const github = {
        rest: {
          actions: {
            listWorkflowRuns: async (input: { workflow_id: string; status: string }) => {
              readings.push(input);
              return {
                data: {
                  workflow_runs: [
                    { id: 502, status: "completed", conclusion: "failure", head_sha: head },
                    { id: 501, status: "completed", conclusion: "success", head_sha: base },
                  ],
                },
              };
            },
            listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => ({
              data: {
                jobs: [
                  {
                    steps: [
                      {
                        name: run_id === 501 ? PATH_READING_STEP : "Checkout",
                        conclusion: run_id === 501 ? "success" : "failure",
                      },
                    ],
                  },
                ],
              },
            }),
          },
          repos: {
            compareCommits: async (input: { base: string; head: string }) => {
              comparisons.push(input);
              return { data: { status: "ahead", files: [{ filename: "docs/forge.md" }] } };
            },
          },
        },
      };
      expect(await afterMergeShouldRun(github, context, name)).toBe(false);
      expect(readings[0]).toMatchObject({ workflow_id: `${name}.yml`, status: "completed" });
      expect(comparisons[0]).toMatchObject({ base, head: context.sha });
    },
  );

  it("runs conservatively when no completed run has a successful source-reading step", async () => {
    const github = {
      rest: {
        actions: {
          ...pastReading(),
          listJobsForWorkflowRun: async () => ({
            data: { jobs: [{ steps: [{ name: "Checkout", conclusion: "failure" }] }] },
          }),
        },
        repos: {
          compareCommits: async () => {
            throw new Error("An unproved checkpoint must not be compared");
          },
        },
      },
    };
    expect(await afterMergeShouldRun(github, context, "main")).toBe(true);
  });
});
