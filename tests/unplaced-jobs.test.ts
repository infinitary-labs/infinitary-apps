import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { judge, NEVER_PLACED, neverPlaced } from "../scripts/unplaced-jobs.mjs";
import { githubScript, loadYamlFile, root, workflowValue } from "./helpers/releaseWorkflows";

// GitHub's own Macs run the batch's native tests and parallel journeys, and
// GitHub at times cancels one of their jobs without ever placing it on a
// runner, which holds the batch on a check that ran no test. unplaced-jobs.yml
// reruns such a run's failed jobs on its own, and only when nothing else
// failed (docs/testing.md, "A job GitHub never placed").

type Job = {
  id: number;
  run_id: number;
  run_attempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  runner_id: number | null;
  runner_name: string | null;
  steps: unknown[];
};
type Run = {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string;
  event: string;
  path: string;
  head_branch: string;
  head_sha: string;
  head_repository: { full_name: string };
  repository: { full_name: string };
};
type Fixture = { run: Run; jobs: Job[]; annotations: Record<string, string[]> };

// Each batch run's first attempt as GitHub recorded it: the run, every job
// (each placed job's steps cut to its first), and the annotations on each job
// that neither passed nor skipped.
const fixture = (pull: number): Fixture =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/unplaced-jobs/batch-pull-${pull}.json`, import.meta.url),
      "utf8",
    ),
  ) as Fixture;
// Batch #91 (run 45583608556): GitHub never placed its Mac group 4/4, and every other job passed.
const batch91 = fixture(91);
// Batch #61 (run 45362891764): GitHub never placed its Mac group 1/4, and a Linux journey group failed.
const batch61 = fixture(61);
// Batch #105 (run 45727530725): its release notes check failed, and a newer version cancelled the rest.
const batch105 = fixture(105);

const project = { owner: "infinitary-labs", repo: "infinitary-apps" };
const UNPLACED_91 = 139100151348;

/** The same run at a later attempt that ended the same way, as GitHub copies its jobs into it. */
const atAttempt = (given: Fixture, attempt: number): Fixture => ({
  ...given,
  run: { ...given.run, run_attempt: attempt },
  jobs: given.jobs.map((job) => ({ ...job, run_attempt: attempt })),
});

/** GitHub's API in memory: one run's jobs and annotations, the run now, open pull requests and reruns. */
function gitHub(
  given: Fixture,
  {
    now = { ...given.run } as Partial<Run>,
    pulls = [{ number: 0, head: { sha: given.run.head_sha } }] as {
      number: number;
      head: { sha: string };
    }[],
    refuse = null as null | { after: Partial<Run> },
  } = {},
) {
  const annotationsRead: number[] = [];
  const reruns: unknown[] = [];
  const pullsAsked: unknown[] = [];
  let current = now;
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRunAttempt: async ({
          run_id,
          attempt_number,
        }: {
          run_id: number;
          attempt_number: number;
        }) => ({
          data:
            run_id === given.run.id
              ? given.jobs.filter((job) => job.run_attempt === attempt_number)
              : [],
        }),
        getWorkflowRun: async ({ run_id }: { run_id: number }) => ({
          data: run_id === given.run.id ? current : undefined,
        }),
        reRunWorkflowFailedJobs: async (params: unknown) => {
          if (refuse) {
            current = { ...current, ...refuse.after };
            throw Object.assign(new Error("This workflow is already running"), { status: 403 });
          }
          reruns.push(params);
          return { data: {} };
        },
      },
      checks: {
        listAnnotations: async ({ check_run_id }: { check_run_id: number }) => {
          annotationsRead.push(check_run_id);
          return {
            data: (given.annotations[String(check_run_id)] ?? []).map((message) => ({ message })),
          };
        },
      },
      pulls: {
        list: async (params: unknown) => {
          pullsAsked.push(params);
          return { data: pulls };
        },
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  return { github, annotationsRead, reruns, pullsAsked };
}

function core() {
  const summary: string[] = [];
  const notices: string[] = [];
  return {
    summary: {
      text: summary,
      addRaw(text: string) {
        summary.push(text);
        return this;
      },
      write: async () => undefined,
    },
    notices,
    notice: (text: string) => notices.push(text),
    info: () => undefined,
  };
}

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};
type WorkflowJob = {
  if: string;
  name: string;
  "runs-on": string;
  permissions: Record<string, string>;
  steps: Step[];
};
const workflow = loadYamlFile(".github/workflows/unplaced-jobs.yml") as {
  on: { workflow_run: { workflows: string[]; types: string[] } } & Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, WorkflowJob>;
};
const job = Object.values(workflow.jobs)[0] as WorkflowJob;
const scriptStep = job.steps.find((step) => step.uses?.startsWith("actions/github-script@"));

/** The workflow's own script step, run as GitHub runs it after a run ends or by hand. */
async function runWorkflow(
  api: ReturnType<typeof gitHub>,
  {
    run = undefined as Run | undefined,
    dry = undefined as { run: string; attempt?: string } | undefined,
  } = {},
) {
  const reported = core();
  const context = {
    repo: project,
    eventName: dry ? "workflow_dispatch" : "workflow_run",
    payload: dry ? { inputs: dry } : { action: "completed", workflow_run: run },
  };
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: root,
    RUN: dry?.run ?? "",
    ATTEMPT: dry?.attempt ?? "",
  };
  await githubScript(String(scriptStep?.with?.script), [
    "github",
    "context",
    "core",
    "process",
    "require",
  ])(api.github, context, reported, { ...process, env }, createRequire(import.meta.url));
  return reported;
}

describe("a batch run's jobs GitHub never placed on a runner", () => {
  it("reruns batch #91's failed jobs once, on the same machines, when its one job that did not pass was never placed", async () => {
    const api = gitHub(batch91);
    const reported = await runWorkflow(api, { run: batch91.run });
    expect(api.reruns).toEqual([{ ...project, run_id: 45583608556 }]);
    // Only the job with no runner and no step has its annotations read.
    expect(api.annotationsRead).toEqual([UNPLACED_91]);
    expect(api.pullsAsked).toEqual([
      {
        ...project,
        head: "infinitary-labs:infinitary-batch/423da1bf",
        state: "open",
        per_page: 100,
      },
    ]);
    expect(reported.notices).toHaveLength(1);
    expect(reported.notices[0]).toContain(
      `- Merge batch · Parallel journeys (Mac; group 4/4) (job ${UNPLACED_91})`,
    );
    expect(reported.notices[0]).toContain("as attempt 2");
    expect(reported.summary.text).toEqual([`${reported.notices[0]}\n`]);
  });

  it("leaves batch #61 to its repair, since a Linux journey group failed beside the job GitHub never placed", async () => {
    const api = gitHub(batch61);
    const verdict = await judge({ github: api.github, ...project, run: batch61.run, attempt: 1 });
    expect(verdict.act).toBe("none");
    expect(verdict.reason).toBe("others");
    expect(verdict.unplaced.map((each) => each.id)).toEqual([138337748781]);
    expect(verdict.words).toContain(
      "- Merge batch · App journeys (Linux; parallel group 1/6) (job 138337749629)",
    );
    await runWorkflow(api, { run: batch61.run });
    expect(api.reruns).toEqual([]);
  });

  it("leaves batch #105 to its repair: its release notes check failed, and a newer version cancelled the jobs that were waiting", async () => {
    const api = gitHub(batch105);
    const verdict = await judge({ github: api.github, ...project, run: batch105.run, attempt: 1 });
    // Jobs cancelled before they had a runner carry GitHub's words for a newer version, never for no runner.
    const waiting = batch105.jobs.filter(
      (each) => each.conclusion === "cancelled" && !each.runner_id && each.steps.length === 0,
    );
    expect(waiting.length).toBeGreaterThan(0);
    expect(verdict).toMatchObject({ act: "none", reason: "ended", unplaced: [] });
    await runWorkflow(api, { run: batch105.run });
    expect(api.reruns).toEqual([]);
  });

  it("reruns no more once the run is at its third attempt", async () => {
    const third = atAttempt(batch91, 3);
    const api = gitHub(third);
    const verdict = await judge({ github: api.github, ...project, run: third.run, attempt: 3 });
    expect(verdict).toMatchObject({ act: "none", reason: "limit" });
    expect(verdict.words).toContain("attempt 3");
    await runWorkflow(api, { run: third.run });
    expect(api.reruns).toEqual([]);
    // A second attempt that ended the same way still asks for the third.
    const second = gitHub(atAttempt(batch91, 2));
    await runWorkflow(second, { run: atAttempt(batch91, 2).run });
    expect(second.reruns).toEqual([{ ...project, run_id: 45583608556 }]);
  });

  it("never doubles a rerun someone asked for first", async () => {
    const api = gitHub(batch91, { now: { ...batch91.run, run_attempt: 2, status: "queued" } });
    const reported = await runWorkflow(api, { run: batch91.run });
    expect(api.reruns).toEqual([]);
    expect(reported.summary.text[0]).toContain("The run has run again since (attempt 2, queued)");
  });

  it("takes GitHub's refusal as the rerun that came first, and fails on a refusal of a run that has not run again", async () => {
    const first = gitHub(batch91, { refuse: { after: { run_attempt: 2, status: "in_progress" } } });
    await expect(runWorkflow(first, { run: batch91.run })).resolves.toBeDefined();
    const refused = gitHub(batch91, { refuse: { after: {} } });
    await expect(runWorkflow(refused, { run: batch91.run })).rejects.toThrow("already running");
  });

  it("reruns nothing once the batch's pull request is closed or holds another version", async () => {
    for (const pulls of [[], [{ number: 91, head: { sha: "f".repeat(40) } }]]) {
      const api = gitHub(batch91, { pulls });
      const reported = await runWorkflow(api, { run: batch91.run });
      expect(api.reruns).toEqual([]);
      expect(reported.summary.text[0]).toContain("no longer open at this version");
    }
  });

  it("reads no job of a run that is not a batch pull request's own", async () => {
    for (const run of [
      { ...batch91.run, head_repository: { full_name: "octo-contributor/infinitary-apps" } },
      { ...batch91.run, head_branch: "inf/some-change" },
      { ...batch91.run, path: ".github/workflows/main.yml", event: "push" },
    ]) {
      const api = gitHub({ ...batch91, run });
      const verdict = await judge({ github: api.github, ...project, run, attempt: 1 });
      expect(verdict).toMatchObject({ act: "none", reason: "not-batch" });
      expect(api.annotationsRead).toEqual([]);
    }
  });

  it("reruns nothing in a dry run by hand, and says what it reads of the named attempt", async () => {
    // Batch #91's run as it stands now: attempt 2 passed.
    const api = gitHub(batch91, { now: { ...batch91.run, run_attempt: 2, conclusion: "success" } });
    const reported = await runWorkflow(api, { dry: { run: "45583608556", attempt: "1" } });
    expect(api.reruns).toEqual([]);
    expect(reported.notices).toEqual([]);
    const [summary = ""] = reported.summary.text;
    expect(summary.startsWith("Dry run, which reruns nothing. Run 45583608556, attempt 1:")).toBe(
      true,
    );
    expect(summary).toContain(`(job ${UNPLACED_91})`);
    expect(summary).toContain("The run has run again since (attempt 2, completed)");
  });

  it("counts a job as never placed only by GitHub's own record of it", () => {
    const unplaced = batch91.jobs.find((each) => each.id === UNPLACED_91) as Job;
    const words = batch91.annotations[String(UNPLACED_91)] ?? [];
    expect(words.some((message) => message.startsWith(NEVER_PLACED))).toBe(true);
    expect(neverPlaced(unplaced, words)).toBe(true);
    // Another job that ran, or the same job with a runner, a step or other words, is not.
    expect(
      neverPlaced(
        { ...unplaced, runner_id: 1000043336, runner_name: "GitHub Actions 1000043336" },
        words,
      ),
    ).toBe(false);
    expect(neverPlaced({ ...unplaced, steps: [{ name: "Set up job" }] }, words)).toBe(false);
    expect(
      neverPlaced(unplaced, [
        "Canceling since a higher priority waiting request for batch-refs/pull/105/merge exists",
      ]),
    ).toBe(false);
    expect(neverPlaced({ ...unplaced, status: "queued" }, words)).toBe(false);
  });
});

describe("unplaced-jobs.yml", () => {
  const text = readFileSync(
    new URL("../.github/workflows/unplaced-jobs.yml", import.meta.url),
    "utf8",
  );

  it("starts when a batch pull request's check ends, or by hand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["batch"], types: ["completed"] });
    // workflow_run matches a workflow by its name: line, not its file.
    expect(
      (loadYamlFile(".github/workflows/batch-pull-request.yml") as { name: string }).name,
    ).toBe("batch");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("runs only for a batch pull request's own run that did not pass, or by hand", () => {
    const ended = (run: Record<string, unknown>) => ({
      github: {
        event_name: "workflow_run",
        repository: "infinitary-labs/infinitary-apps",
        event: {
          workflow_run: {
            conclusion: "failure",
            event: "pull_request",
            head_branch: "infinitary-batch/423da1bf",
            head_repository: { full_name: "infinitary-labs/infinitary-apps" },
            ...run,
          },
        },
      },
    });
    expect(workflowValue(job.if, ended({}))).toBe(true);
    expect(workflowValue(job.if, ended({ conclusion: "cancelled" }))).toBe(true);
    expect(workflowValue(job.if, ended({ conclusion: "success" }))).toBe(false);
    expect(
      workflowValue(
        job.if,
        ended({ head_repository: { full_name: "octo-contributor/infinitary-apps" } }),
      ),
    ).toBe(false);
    expect(workflowValue(job.if, ended({ head_branch: "inf/some-change" }))).toBe(false);
    expect(workflowValue(job.if, ended({ event: "push" }))).toBe(false);
    expect(workflowValue(job.if, { github: { event_name: "workflow_dispatch" } })).toBe(true);
  });

  it("checks out only its scripts from the default branch, on GitHub's machines", () => {
    expect(Object.values(workflow.jobs).map((each) => each["runs-on"])).toEqual(["ubuntu-24.04"]);
    const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with?.["persist-credentials"]).toBe(false);
    expect(String(checkouts[0]?.with?.["sparse-checkout"]).trim().split("\n").toSorted()).toEqual([
      "scripts/batch-pull.mjs",
      "scripts/unplaced-jobs.mjs",
    ]);
    expect(job.steps.filter((step) => step.run)).toEqual([]);
  });

  it("holds only the rerun, check and pull request reads it needs, and no secret", () => {
    expect(job.permissions).toEqual({
      contents: "read",
      actions: "write",
      checks: "read",
      "pull-requests": "read",
    });
    expect(text).not.toMatch(/secrets\./);
    expect(String(scriptStep?.with?.script)).not.toContain("${{");
  });
});
