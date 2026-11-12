import { describe, expect, it } from "vitest";
import { readMainPush } from "../scripts/batch.mjs";
import { confirmPlan, failures } from "../scripts/batch-failures.mjs";
import {
  BATCH_BRANCH,
  BATCH_PULL_CHECKS,
  BATCH_PULL_RUN,
  batchPullTree,
  sortBatchPull,
} from "../scripts/batch-pull.mjs";
import { verifyBatchEvidence } from "../scripts/main-alpha-proof.mjs";
import { runJobNames, type Scenario } from "./helpers/ciJobNames";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-3759's approved plan, piece 2 (the captain: "Approve and build", "all
// seven answers as proposed"): a pull request whose branch starts with
// infinitary-batch/ and comes from this repository itself runs the swept
// batch and ends in the job that names the tree, and main's sort and the
// alpha's proof accept that run, reusing it only when the batch changed no
// file its own check is made of (docs/testing.md, "A batch pull request").
// The readings are the rehearsal batch pull request's own: its number, its
// branch, its version and tree, the main version it left main at and its run.
const REPOSITORY = "infinitary-labs/infinitary";
const repo = { owner: "infinitary-labs", repo: "infinitary" };
const rehearsal = {
  number: 1547,
  branch: "infinitary-batch/rehearsal",
  head: "12838aded2b76867210c8e5b58cbdc45c69794c8",
  tree: "51fe1f7d6b371abdc587474670e53ee77a356b1c",
  base: "b011e1b54cbf6f2c59bf2fd7d73fe4033ddf4d93",
  run: 43_114_604_084,
};

type Job = {
  if?: string;
  name?: string;
  uses?: string;
  needs?: string | string[];
  with?: Record<string, unknown>;
  steps?: {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
};
const workflow = (file: string) =>
  loadYamlFile(`.github/workflows/${file}`) as {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    jobs: Record<string, Job>;
  };

/** The pull request event as GitHub gives it to the run, for a branch of `from`. */
const pullRequest = (branch: string, from = REPOSITORY, base = "main") => ({
  event_name: "pull_request",
  head_ref: branch,
  base_ref: base,
  repository: REPOSITORY,
  event: {
    pull_request: { head: { sha: rehearsal.head, repo: { full_name: from } } },
    repository: { default_branch: "main" },
  },
});

const read = { result: "success", outputs: { tree: rehearsal.tree, base: rehearsal.base } };
/** A batch whose every check passed, so nothing is confirmed. */
const passedRun: Scenario = {
  github: pullRequest(rehearsal.branch),
  needs: {
    batch: read,
    sweep: { result: "success" },
    "critical-path": { result: "success" },
    startup: { result: "success" },
    confirm: { result: "skipped" },
  },
};
const FAILED_JOB =
  "Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)";
// The file a batch run's sweep named as failed, as the shipped queue's own
// test reads it (src/core/queue/shipped/github.test.ts).
const FAILED_FILE = "src/core/freeze/freezeRecorder.integration.test.ts";
const FAILED_LOG = `2026-11-07T19:12:44.0000000Z  FAIL  |integration| ${FAILED_FILE} > writes the record\n`;
/** A batch whose sweep failed in one Linux job and whose confirm passed. */
const confirmedRun: Scenario = {
  github: pullRequest(rehearsal.branch),
  needs: {
    batch: read,
    sweep: { result: "failure" },
    "critical-path": { result: "success" },
    startup: { result: "success" },
    failures: { result: "success", outputs: { jobs: FAILED_JOB, files: FAILED_FILE } },
    confirm: { result: "success" },
  },
};

const PASSED = `${BATCH_PULL_CHECKS}Merge batch · Batch passed (tree ${rehearsal.tree}; base ${rehearsal.base})`;
/** The run's jobs as GitHub lists them, each passed but `failed`. */
const jobsOf = (scenario: Scenario, failed: string[] = []) =>
  runJobNames("batch-pull-request.yml", scenario).map((name, index) => ({
    id: index + 1,
    name,
    run_id: rehearsal.run,
    run_attempt: 1,
    head_sha: rehearsal.head,
    status: "completed",
    conclusion: failed.includes(name) ? "failure" : "success",
  }));
const run = (conclusion: string) => ({
  id: rehearsal.run,
  run_attempt: 1,
  path: BATCH_PULL_RUN,
  event: "pull_request",
  head_branch: rehearsal.branch,
  head_sha: rehearsal.head,
  status: "completed",
  conclusion,
  head_repository: { full_name: REPOSITORY },
  repository: { full_name: REPOSITORY },
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${rehearsal.run}`,
});

describe("batch-pull-request.yml", () => {
  const file = workflow("batch-pull-request.yml");
  const starts = (github: ReturnType<typeof pullRequest>) =>
    workflowValue(String(file.jobs.checks?.if), { github });

  it("starts the swept batch only for a batch branch of this repository itself", () => {
    expect(BATCH_PULL_RUN).toBe(".github/workflows/batch-pull-request.yml");
    expect(rehearsal.branch.startsWith(BATCH_BRANCH)).toBe(true);
    expect(Object.keys(file.on)).toEqual(["pull_request"]);
    expect(starts(pullRequest(rehearsal.branch))).toBe(true);
    // A fork's branch of that name never reaches this project's own Mac.
    expect(starts(pullRequest(rehearsal.branch, "someone/infinitary"))).toBe(false);
    // Every other pull request starts the file and skips its one job.
    expect(starts(pullRequest("fm/task-573def9c"))).toBe(false);
    expect(starts(pullRequest("batch/infinitary-batch/x"))).toBe(false);
    // A batch is checked against main, which its last job names.
    expect(starts(pullRequest(rehearsal.branch, REPOSITORY, "release"))).toBe(false);
    expect(
      runJobNames("batch-pull-request.yml", { github: pullRequest("fm/task-573def9c") }),
    ).toEqual([]);
  });

  it("checks the pull request's own version, which a later push replaces", () => {
    const checks = file.jobs.checks!;
    expect(checks.uses).toBe("./.github/workflows/batch-checks.yml");
    const github = pullRequest(rehearsal.branch);
    expect(workflowString(String(checks.with?.head), { github })).toBe(rehearsal.head);
    const { concurrency } = file as unknown as {
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    expect(concurrency["cancel-in-progress"]).toBe(true);
    expect(
      workflowString(concurrency.group, { github: { ref: `refs/pull/${rehearsal.number}/merge` } }),
    ).toBe(`batch-refs/pull/${rehearsal.number}/merge`);
  });
});

describe("batch-checks.yml", () => {
  const checks = workflow("batch-checks.yml");
  const queue = workflow("infinitary-batch-checks.yml");
  const inputs = { trigger: "Merge batch", head: rehearsal.head };

  it("runs what the shipped queue's batch runs, on the batch's own version with nothing composed", () => {
    for (const id of ["sweep", "critical-path", "startup"]) {
      const own = checks.jobs[id]!;
      const queued = queue.jobs[id]!;
      expect(own.uses, id).toBe(queued.uses);
      // The queue composes its changes onto main; a batch's branch already holds them.
      const { ref, batch, batch_tree, ...rest } = queued.with!;
      expect([ref, batch, batch_tree].every(Boolean), id).toBe(true);
      const passed = Object.fromEntries(
        Object.entries(own.with!).map(([key, value]) => [
          key,
          typeof value === "string" ? workflowString(value, { inputs, vars: {} }) : value,
        ]),
      );
      const expected = Object.fromEntries(
        Object.entries(rest).map(([key, value]) => [
          key,
          typeof value === "string" ? workflowString(value, { inputs, vars: {} }) : value,
        ]),
      );
      expect(passed, id).toEqual({ ...expected, ref: rehearsal.head });
    }
    // The confirm runs the failed files on that version too, by the same script.
    const steps = (job: Job) => job.steps ?? [];
    const confirm = steps(checks.jobs.confirm!);
    expect(confirm.some((step) => step.name === "Compose the batch")).toBe(false);
    for (const step of confirm.filter((each) => each.uses === "actions/checkout@v4"))
      expect(workflowString(String(step.with?.ref), { inputs })).toBe(rehearsal.head);
    const round = (job: Job) =>
      steps(job).find((step) => step.name === "Run each failed test file three rounds");
    expect(round(checks.jobs.confirm!)?.run).toBe(round(queue.jobs.confirm!)?.run);
  });

  it("confirms on the platform whose job failed", () => {
    const platforms = (jobs: string) =>
      workflowValue(
        String(
          (checks.jobs.confirm as { strategy: { matrix: { platform: string } } }).strategy.matrix
            .platform,
        ),
        {
          needs: { failures: { outputs: { jobs } } },
        },
      );
    const mac = "Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)";
    expect(platforms(FAILED_JOB)).toEqual(["linux"]);
    expect(platforms(mac)).toEqual(["mac"]);
    expect(platforms(`${mac}\n${FAILED_JOB}`)).toEqual(["linux", "mac"]);
  });

  it("names the tree in its last job once every check passed, or once the confirm passed", () => {
    const last = checks.jobs.passed!;
    const ends = (needs: Scenario["needs"], cancelled = false) =>
      workflowValue(
        String(last.if),
        { needs },
        { success: true, failure: false, always: true, cancelled },
      );
    expect(ends(passedRun.needs)).toBe(true);
    expect(ends(confirmedRun.needs)).toBe(true);
    // A failed check with no confirm, a failed confirm, and a cancelled run name no tree.
    expect(ends({ ...confirmedRun.needs, confirm: { result: "skipped" } })).toBe(false);
    expect(ends({ ...confirmedRun.needs, confirm: { result: "failure" } })).toBe(false);
    expect(ends(passedRun.needs, true)).toBe(false);
    expect(runJobNames("batch-pull-request.yml", passedRun).at(-1)).toBe(PASSED);
    expect(runJobNames("batch-pull-request.yml", confirmedRun)).toEqual(
      expect.arrayContaining([
        `${BATCH_PULL_CHECKS}Merge batch · Read the failures`,
        `${BATCH_PULL_CHECKS}Merge batch · Confirm failed tests (Linux)`,
        PASSED,
      ]),
    );
    // The failures are read only after a failed check.
    const reads = (needs: Scenario["needs"]) =>
      workflowValue(String(checks.jobs.failures!.if), { needs });
    expect(reads(passedRun.needs)).toBe(false);
    expect(reads(confirmedRun.needs)).toBe(true);
  });
});

describe("a failed batch pull request's confirm plan", () => {
  const failed = `${BATCH_PULL_CHECKS}${FAILED_JOB}`;

  it("runs each failed job's failed files again, and nothing when a failed job named none", () => {
    expect(confirmPlan([{ name: failed, files: [FAILED_FILE] }])).toEqual({
      jobs: FAILED_JOB,
      files: FAILED_FILE,
    });
    expect(confirmPlan([])).toBe(null);
    // A job that failed for something no rerun of a test answers.
    expect(
      confirmPlan([
        { name: failed, files: [FAILED_FILE] },
        {
          name: `${BATCH_PULL_CHECKS}Merge batch · Linux startup / Merge batch · Automatic startup checks (Linux)`,
          files: [],
        },
      ]),
    ).toBe(null);
  });

  it("reads the run's failed jobs and their logs, leaving the confirm's own jobs out", async () => {
    const jobs = jobsOf(confirmedRun, [failed]);
    const confirm = jobs.find((job) => job.name.includes("Confirm failed tests"))!;
    confirm.conclusion = "failure";
    const asked: number[] = [];
    const outputs = new Map<string, string>();
    const github = {
      rest: {
        actions: {
          listJobsForWorkflowRun: "jobs",
          downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => {
            asked.push(job_id);
            return { data: FAILED_LOG };
          },
        },
      },
      paginate: async (_method: string, parameters: { run_id: number }) => {
        expect(parameters.run_id).toBe(rehearsal.run);
        return jobs;
      },
    };
    await failures({
      github,
      context: { repo, runId: rehearsal.run },
      core: {
        notice: () => {},
        setOutput: (name: string, value: string) => outputs.set(name, value),
      },
    });
    expect(asked).toEqual([jobs.find((job) => job.name === failed)!.id]);
    expect(Object.fromEntries(outputs)).toEqual({ jobs: FAILED_JOB, files: FAILED_FILE });
  });
});

describe("main's check sorting a push that merged a batch pull request", () => {
  const passed = { id: rehearsal.run, jobs: jobsOf(passedRun) };
  const files = [{ filename: "src/core/session/tools.ts" }, { filename: "docs/testing.md" }];
  const sorted = (input: Partial<Parameters<typeof sortBatchPull>[0]>) =>
    sortBatchPull({ tree: rehearsal.tree, runs: [passed], files, total: files.length, ...input });

  it("reads files that are exactly the batch's as covered, whether it passed outright or on its confirm", () => {
    expect(batchPullTree(passed.jobs)).toBe(rehearsal.tree);
    expect(sorted({})).toEqual({ kind: "covered", run: rehearsal.run });
    const confirmed = {
      id: rehearsal.run,
      jobs: jobsOf(confirmedRun, [`${BATCH_PULL_CHECKS}${FAILED_JOB}`]),
    };
    expect(sorted({ runs: [confirmed] })).toEqual({ kind: "covered", run: rehearsal.run });
  });

  it("runs main's own full check for files no batch run passed", () => {
    // Main moved under the batch, so the push holds other files.
    expect(sorted({ tree: "d".repeat(40) })).toEqual({ kind: "full" });
    // A run whose last job did not pass names no tree.
    const failed = { id: rehearsal.run, jobs: jobsOf(passedRun, [PASSED]) };
    expect(batchPullTree(failed.jobs)).toBe(null);
    expect(sorted({ runs: [failed] })).toEqual({ kind: "full" });
    expect(sorted({ runs: [] })).toEqual({ kind: "full" });
    // A job of that name outside the batch's checks is not its last job.
    const outside = [{ ...passed.jobs.at(-1)!, name: PASSED.slice(BATCH_PULL_CHECKS.length) }];
    expect(sorted({ runs: [{ id: rehearsal.run, jobs: outside }] })).toEqual({ kind: "full" });
  });

  it("never reuses the run of a batch that changed a file its own check is made of", () => {
    for (const changed of [
      { filename: ".github/workflows/batch-checks.yml" },
      { filename: ".github/workflows/verify.yml" },
      { filename: ".github/actions/linux-desktop/action.yml" },
      // A check file moved out of its folder is a changed check file.
      { filename: "docs/old-check.yml", previous_filename: ".github/workflows/old-check.yml" },
    ])
      expect(sorted({ files: [...files, changed], total: 3 }), changed.filename).toEqual({
        kind: "full",
      });
    // A list GitHub cut short may hide one.
    expect(sorted({ total: 3001 })).toEqual({ kind: "full" });
  });

  it("reads the merged pull request, its files and its own run from GitHub", async () => {
    const merge = "5d8e2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d";
    let from = REPOSITORY;
    const github = {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => ({
            data:
              commit_sha === merge
                ? [
                    {
                      number: rehearsal.number,
                      merge_commit_sha: merge,
                      head: {
                        ref: rehearsal.branch,
                        sha: rehearsal.head,
                        repo: { full_name: from },
                      },
                      base: { ref: "main", repo: { full_name: REPOSITORY } },
                    },
                  ]
                : [],
          }),
          listCommitStatusesForRef: "statuses",
        },
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            expect(pull_number).toBe(rehearsal.number);
            return { data: { changed_files: files.length } };
          },
          listFiles: "files",
        },
        actions: { listWorkflowRuns: "runs", listJobsForWorkflowRun: "jobs" },
      },
      paginate: async (method: string, parameters: Record<string, unknown>) => {
        if (method === "statuses") return [];
        if (method === "files") return files;
        if (method === "runs") {
          expect(parameters).toMatchObject({
            workflow_id: "batch-pull-request.yml",
            head_sha: rehearsal.head,
            event: "pull_request",
          });
          // A run of another version of the branch is not this version's.
          return [{ ...run("success"), id: 7, head_sha: "e".repeat(40) }, run("success")];
        }
        expect(parameters).toMatchObject({ run_id: rehearsal.run, filter: "latest" });
        return passed.jobs;
      },
    };
    const push = { sha: merge, tree: rehearsal.tree };
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "covered", run: rehearsal.run });
    expect(await readMainPush(github, repo, { ...push, tree: "d".repeat(40) })).toEqual({
      kind: "full",
    });
    // A fork's branch of that name is no batch: it has no queue state and no run to reuse.
    from = "someone/infinitary";
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "full" });
  });
});

describe("the alpha's proof following a covered push to a batch pull request's run", () => {
  const proof = { runId: rehearsal.run, attempt: 1, url: run("success").html_url, journeys: true };

  it("accepts a run that passed every check on exactly the alpha source's files", () => {
    const jobs = jobsOf(passedRun);
    expect(verifyBatchEvidence(run("success"), jobs, REPOSITORY, rehearsal.tree)).toEqual(proof);
    expect(() => verifyBatchEvidence(run("success"), jobs, REPOSITORY, "d".repeat(40))).toThrow(
      "other files",
    );
    // A batch whose checks did not all run proves nothing.
    const short = jobs.filter((job) => !job.name.endsWith("(Mac)"));
    expect(() => verifyBatchEvidence(run("success"), short, REPOSITORY, rehearsal.tree)).toThrow(
      "every full-check owner",
    );
  });

  it("accepts a run that failed a check and passed its confirm, and no other failed run", () => {
    const failed = `${BATCH_PULL_CHECKS}${FAILED_JOB}`;
    const jobs = jobsOf(confirmedRun, [failed]);
    expect(verifyBatchEvidence(run("failure"), jobs, REPOSITORY, rehearsal.tree)).toEqual(proof);
    // The confirm failed, or never ran.
    const confirm = jobs.find((job) => job.name.includes("Confirm failed tests"))!;
    expect(() =>
      verifyBatchEvidence(
        run("failure"),
        jobs.map((job) => (job === confirm ? { ...job, conclusion: "failure" } : job)),
        REPOSITORY,
        rehearsal.tree,
      ),
    ).toThrow("successful batch run");
    expect(() =>
      verifyBatchEvidence(run("failure"), jobsOf(passedRun, [failed]), REPOSITORY, rehearsal.tree),
    ).toThrow("successful batch run");
  });

  it("refuses a run that is not a batch pull request's own", () => {
    const jobs = jobsOf(passedRun);
    for (const other of [
      { head_branch: "fm/task-573def9c" },
      { event: "workflow_dispatch" },
      { head_repository: { full_name: "someone/infinitary" } },
      { status: "in_progress" },
      { path: ".github/workflows/ci.yml" },
    ])
      expect(
        () =>
          verifyBatchEvidence({ ...run("success"), ...other }, jobs, REPOSITORY, rehearsal.tree),
        JSON.stringify(other),
      ).toThrow("successful batch run");
  });
});
