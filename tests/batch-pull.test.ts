import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { readCheckFiles, readMainPush } from "../scripts/batch.mjs";
import {
  confirmPlan,
  failedTestFiles,
  failures,
  groupConfirms,
  groupFailure,
  laterPlan,
} from "../scripts/batch-failures.mjs";
import {
  BATCH_BRANCH,
  BATCH_PULL_CHECKS,
  BATCH_PULL_CONFIRM,
  BATCH_PULL_GROUP_CONFIRM,
  BATCH_PULL_RUN,
  batchPullTree,
  batchRunCheckFiles,
  sortBatchPull,
} from "../scripts/batch-pull.mjs";
import { verifyBatchEvidence } from "../scripts/main-alpha-proof.mjs";
import { runJobNames, type Scenario } from "./helpers/ciJobNames";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-3759's approved plan, pieces 2 and 3 (the captain: "Approve and build",
// "all seven answers as proposed"): a pull request whose branch starts with
// infinitary-batch/ and comes from this repository itself runs the swept
// batch and ends in the job that names the tree, and main's sort and the
// alpha's proof accept that run, reusing it only when the batch changed no
// file its own check is made of (docs/testing.md, "A batch pull request").
// What the batch's checks run is held in tests/batch.test.ts.
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
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
};
const workflow = (file: string) =>
  loadYamlFile(`.github/workflows/${file}`) as {
    on: Record<string, { inputs?: Record<string, unknown>; branches?: string[] } | null>;
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
    "linux-tests": { result: "success" },
    failures: { result: "skipped" },
    "confirm-later": { result: "skipped" },
  },
};
const FAILED_JOB =
  "Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)";
// The file a batch run's sweep named as failed, in its job's own log line.
const FAILED_FILE = "src/core/freeze/freezeRecorder.integration.test.ts";
const FAILED_LOG = `2026-11-07T19:12:44.0000000Z  FAIL  |integration| ${FAILED_FILE} > writes the record\n`;
/**
 * A batch whose sweep failed in one Linux test group, whose own confirm took
 * it and passed, and where no other job failed.
 */
const confirmedRun: Scenario = {
  github: pullRequest(rehearsal.branch),
  needs: {
    batch: read,
    sweep: { result: "failure" },
    "critical-path": { result: "success" },
    startup: { result: "success" },
    "linux-tests": { result: "failure" },
    failures: {
      result: "success",
      outputs: { left: "nothing", jobs: "", files: "", grouped: "passed" },
    },
    "confirm-later": { result: "skipped" },
  },
};
/** The full name of the confirm a Linux test group's job of the checks has beside it. */
const groupConfirmOf = (job: string) =>
  `${BATCH_PULL_CHECKS}${BATCH_PULL_GROUP_CONFIRM}${job.slice(job.lastIndexOf(" · ") + " · ".length)}`;

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

  // The captain's pick on INF-3759, "the pushed branch": a change's check is
  // the run the push of its own branch started, so a batch pull request,
  // whose changes each ran that check already, runs the batch's checks alone.
  it("leaves the change's own check to each change's pushed branch", () => {
    const ci = workflow("ci.yml");
    const change = (github: Record<string, unknown>) =>
      workflowValue(String(ci.jobs["typecheck-lint-build"]?.if), { github });
    // Every pull request runs one of the two: the batch's checks or the
    // change's check, a fork's batch-named branch the change's.
    for (const pull of [
      pullRequest(rehearsal.branch),
      pullRequest(rehearsal.branch, "someone/infinitary"),
      pullRequest("fm/task-573def9c"),
      pullRequest("batch/infinitary-batch/x"),
      pullRequest(rehearsal.branch, REPOSITORY, "release"),
    ])
      expect(
        change(pull),
        `${pull.head_ref} from ${pull.event.pull_request.head.repo.full_name}`,
      ).toBe(!starts(pull));
    expect(change(pullRequest(rehearsal.branch))).toBe(false);
    // A task's branch starts the change's check at each push, named by the
    // naming runbook's words or fm/task-<id> from before. The push of
    // the batch's own branch starts nothing, so the batch's checks are the
    // one run its pull request started.
    const pushStarts = (branch: string) =>
      ci.on.push!.branches!.some((pattern) => posix.matchesGlob(branch, pattern));
    expect(pushStarts("fm/task-573def9c")).toBe(true);
    expect(pushStarts("inf/branch-names-runbook-573d")).toBe(true);
    expect(pushStarts(rehearsal.branch)).toBe(false);
    expect(pushStarts("main")).toBe(false);
    expect(
      change({ event_name: "push", ref: "refs/heads/fm/task-573def9c", repository: REPOSITORY }),
    ).toBe(true);
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
  const verify = workflow("verify.yml");
  const inputs = { trigger: "Merge batch", head: rehearsal.head };

  it("runs every check on the batch's own version", () => {
    for (const id of ["sweep", "critical-path", "startup"]) {
      const call = checks.jobs[id]!.with!;
      expect(workflowString(String(call.ref), { inputs }), id).toBe(rehearsal.head);
      expect(workflowString(String(call.trigger), { inputs }), id).toBe("Merge batch");
    }
    // Each confirm runs the failed files on that version too: the later
    // one, and each test group's own in the sweep, on the version the
    // batch passes the sweep.
    const ref = workflowString(String(checks.jobs.sweep!.with!.ref), { inputs });
    for (const [job, contexts] of [
      [checks.jobs["confirm-later"]!, { inputs }],
      [
        verify.jobs["linux-tests-confirm"]!,
        { inputs: { ref }, github: { ref: "refs/heads/main" } },
      ],
    ] as const) {
      const checkouts = (job.steps ?? []).filter((step) => step.uses === "actions/checkout@v4");
      expect(checkouts.length).toBeGreaterThan(0);
      for (const step of checkouts)
        expect(workflowString(String(step.with?.ref), contexts)).toBe(rehearsal.head);
    }
  });

  it("confirms on the platform whose job failed once the checks ended", () => {
    const platforms = (jobs: string) =>
      workflowValue(
        String(
          (checks.jobs["confirm-later"] as { strategy: { matrix: { platform: string } } }).strategy
            .matrix.platform,
        ),
        { needs: { failures: { outputs: { jobs } } } },
      );
    const mac = "Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)";
    expect(platforms(FAILED_JOB)).toEqual(["linux"]);
    expect(platforms(mac)).toEqual(["mac"]);
    expect(platforms(`${mac}\n${FAILED_JOB}`)).toEqual(["linux", "mac"]);
  });

  it("names the tree in its last job once every check passed, or once every failed job's files passed their confirm", () => {
    const last = checks.jobs.passed!;
    const ends = (needs: Scenario["needs"], cancelled = false) =>
      workflowValue(
        String(last.if),
        { needs },
        { success: true, failure: false, always: true, cancelled },
      );
    expect(ends(passedRun.needs)).toBe(true);
    expect(ends(confirmedRun.needs)).toBe(true);
    const outputs = (left: string, grouped = "passed") => ({
      result: "success",
      outputs: { left, jobs: left === "confirm" ? "later" : "", files: "", grouped },
    });
    // Another job failed too, and the later confirm passed on it.
    expect(
      ends({
        ...confirmedRun.needs,
        failures: outputs("confirm"),
        "confirm-later": { result: "success" },
      }),
    ).toBe(true);
    // A test group's failed confirm, a later failure left unconfirmed or
    // no confirm answers, a failures job that could not read the run, and
    // a cancelled run name no tree.
    expect(ends({ ...confirmedRun.needs, failures: outputs("nothing", "failed") })).toBe(false);
    for (const later of ["failure", "skipped"])
      expect(
        ends({
          ...confirmedRun.needs,
          failures: outputs("confirm"),
          "confirm-later": { result: later },
        }),
      ).toBe(false);
    expect(ends({ ...confirmedRun.needs, failures: outputs("unanswerable") })).toBe(false);
    expect(ends({ ...confirmedRun.needs, failures: { result: "failure", outputs: {} } })).toBe(
      false,
    );
    expect(ends(passedRun.needs, true)).toBe(false);
    expect(runJobNames("batch-pull-request.yml", passedRun).at(-1)).toBe(PASSED);
    expect(runJobNames("batch-pull-request.yml", confirmedRun)).toEqual(
      expect.arrayContaining([
        groupConfirmOf(FAILED_JOB),
        `${BATCH_PULL_CHECKS}Merge batch · Read the failures`,
        PASSED,
      ]),
    );
    // The failures are read only after a failed check.
    const reads = (needs: Scenario["needs"]) =>
      workflowValue(String(checks.jobs.failures!.if), { needs });
    expect(reads(passedRun.needs)).toBe(false);
    expect(reads(confirmedRun.needs)).toBe(true);
  });

  // INF-4382, without a job that waits beside the checks: each Linux test
  // group's confirm starts in the sweep once the test groups ended with a
  // failure, while the journeys and the Mac lanes run on, and only the
  // swept batch asks for it.
  it("confirms each Linux test group beside the checks once the test groups ended, and cancels nothing", () => {
    expect(Object.keys(checks.jobs)).not.toContain("first-failure");
    expect(checks.jobs.sweep!.with!.confirm).toBe(true);
    const own = verify.jobs["linux-tests-confirm"]! as Job & {
      strategy: { matrix: { group: string[] } };
    };
    expect(own.needs).toBe("linux-tests");
    const confirms = (confirm: boolean | null, result: string, cancelled = false) =>
      workflowValue(
        String(own.if),
        { inputs: { confirm }, needs: { "linux-tests": { result } } },
        { success: true, failure: false, always: true, cancelled },
      );
    expect(confirms(true, "failure")).toBe(true);
    expect(confirms(true, "success")).toBe(false);
    expect(confirms(true, "failure", true)).toBe(false);
    // Main's check and a release's call verify.yml without it.
    expect(confirms(false, "failure")).toBe(false);
    expect(Boolean(confirms(null, "failure"))).toBe(false);
    // One confirm for each test group, by the name linux-tests gives it.
    const groupNames = runJobNames("batch-pull-request.yml", confirmedRun)
      .filter((name) => / \(Linux(; group \d+\/\d+)?\)$/.test(name))
      .filter((name) =>
        /^Merge batch · Batch checks \/ Merge batch · Desktop checks \/ Merge batch · (Unit|Integration|Environment|Browser) /.test(
          name,
        ),
      );
    expect(groupNames).toHaveLength(8);
    expect(own.strategy.matrix.group.map((group) => groupConfirmOf(` · ${group}`))).toEqual(
      groupNames.map(groupConfirmOf),
    );
    for (const id of ["sweep", "critical-path", "startup"])
      expect(checks.jobs[id]!.needs, id).toBe("batch");
    expect(checks.jobs.failures!.needs).toEqual(["sweep", "critical-path", "startup"]);
    const later = (left: string) =>
      workflowValue(String(checks.jobs["confirm-later"]!.if), {
        needs: { failures: { outputs: { left } } },
      });
    expect(["confirm", "nothing", "unanswerable", ""].map(later)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    // Each confirm runs the same rounds, keeping a failed round's evidence under a name of its own.
    for (const job of [checks.jobs["confirm-later"]!, own])
      expect(job.steps!.at(-1)!.uses).toBe(
        "./Application Support/firstmate/.github/actions/batch-confirm",
      );
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

  // Each log is a failed job's own closing lines: Vitest's FAIL line,
  // Playwright's list under its "N failed" line, and the line Vitest prints
  // for an unhandled error, which fails a run whose every test passed and
  // prints no FAIL line, colors and all.
  it("reads the failed test files from a job's log as each runner names them", () => {
    expect(failedTestFiles(FAILED_LOG)).toEqual([FAILED_FILE]);
    expect(
      failedTestFiles(
        "2026-11-07T19:20:01.0000000Z   1 failed\n2026-11-07T19:20:01.0000000Z     [application] › knowledge-references.spec.ts:41:3 › opens a saved reference\n",
      ),
    ).toEqual(["knowledge-references.spec.ts"]);
    expect(
      failedTestFiles(
        [
          "2026-11-08T08:05:33.8316852Z  \u001b[32m✓\u001b[39m \u001b[30m\u001b[45m integration \u001b[49m\u001b[39m tests/replay-gate-catches-lint.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 5615\u001b[2mms\u001b[22m\u001b[39m",
          "2026-11-08T08:05:48.8700969Z Vitest caught 1 unhandled error during the test run.",
          '2026-11-08T08:05:48.8766094Z \u001b[31mThis error originated in "\u001b[1mtests/phone-scene-projection.test.ts\u001b[22m" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.\u001b[39m',
          "2026-11-08T08:05:48.9690171Z ##[error]Process completed with exit code 1.",
        ].join("\n"),
      ),
    ).toEqual(["tests/phone-scene-projection.test.ts"]);
    // The files go to the confirm as one list separated by spaces, so a path
    // with a space is named nowhere rather than split, and an unhandled
    // error Vitest ties to no test file names none.
    expect(
      failedTestFiles(
        '2026-11-08T08:05:48.8766094Z This error originated in "tests/my file.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.\n',
      ),
    ).toEqual([]);
    expect(
      failedTestFiles(
        "2026-11-08T08:05:48.8700969Z Vitest caught 1 unhandled error during the test run.\n2026-11-08T08:05:48.8764393Z Error: setup failed\n",
      ),
    ).toEqual([]);
  });

  it("leaves to the later confirm only the jobs no test group's confirm took", () => {
    const later = `${BATCH_PULL_CHECKS}Merge batch · Desktop checks / Merge batch · Desktop journeys (Mac)`;
    const files = ["tests/e2e/knowledge-references.spec.ts"];
    expect(laterPlan([{ name: failed, files: [FAILED_FILE] }], [FAILED_JOB])).toEqual({
      left: "nothing",
    });
    expect(
      laterPlan(
        [
          { name: failed, files: [FAILED_FILE] },
          { name: later, files },
        ],
        [FAILED_JOB],
      ),
    ).toEqual({ left: "confirm", jobs: later.slice(BATCH_PULL_CHECKS.length), files: files[0] });
    // Nothing confirmed beside the groups: every failed job is the later confirm's.
    expect(laterPlan([{ name: failed, files: [FAILED_FILE] }], [])).toEqual({
      left: "confirm",
      jobs: FAILED_JOB,
      files: FAILED_FILE,
    });
    // A later job named no test file, or no failed job could be read.
    expect(laterPlan([{ name: later, files: [] }], [FAILED_JOB])).toEqual({ left: "unanswerable" });
    expect(laterPlan([], [])).toEqual({ left: "unanswerable" });
  });

  it("reads the run's failed jobs and their logs, leaving the confirms' own jobs out", async () => {
    const jobs = jobsOf(confirmedRun, [failed]);
    const confirm = jobs.find((job) => job.name === groupConfirmOf(FAILED_JOB))!;
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
    const read = () =>
      failures({
        github,
        context: { repo, runId: rehearsal.run },
        core: {
          notice: () => {},
          setOutput: (name: string, value: string) => outputs.set(name, value),
        },
      });
    await read();
    expect(asked).toEqual([jobs.find((job) => job.name === failed)!.id]);
    // The group's confirm took its failed job, and failed.
    expect(Object.fromEntries(outputs)).toEqual({
      left: "nothing",
      jobs: "",
      files: "",
      grouped: "failed",
    });
    confirm.conclusion = "success";
    await read();
    expect(Object.fromEntries(outputs)).toEqual({
      left: "nothing",
      jobs: "",
      files: "",
      grouped: "passed",
    });
    // A group whose confirm never ran leaves its failed job to the later confirm.
    confirm.conclusion = "skipped";
    await read();
    expect(Object.fromEntries(outputs)).toEqual({
      left: "confirm",
      jobs: FAILED_JOB,
      files: FAILED_FILE,
      grouped: "passed",
    });
  });
});

const playwrightLog = (file: string) =>
  `2026-11-15T02:26:50.0000000Z   1 failed\n2026-11-15T02:26:50.0000000Z     [desktop] › ${file}:12:3 › the journey\n`;
/** A GitHub client that lists `jobs` and gives each job's log from `logs`, by name; null is a log GitHub cannot give. */
const githubOf = (
  jobs: { id: number; name: string }[],
  logs: Record<string, string | null>,
  asked: string[] = [],
) => ({
  rest: {
    actions: {
      listJobsForWorkflowRun: "jobs",
      downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => {
        const name = jobs.find((job) => job.id === job_id)!.name;
        asked.push(name);
        const log = logs[name];
        if (log === null || log === undefined) throw new Error("Not Found");
        return { data: log };
      },
    },
  },
  paginate: async () => jobs,
});
/** Runs `script` with a core that keeps its outputs, and answers them. */
async function outputsOf(script: (core: unknown) => Promise<void>) {
  const outputs = new Map<string, string>();
  await script({
    notice: () => {},
    setOutput: (name: string, value: string) => outputs.set(name, value),
  });
  return Object.fromEntries(outputs);
}

describe("a Linux test group's own confirm", () => {
  const failed = `${BATCH_PULL_CHECKS}${FAILED_JOB}`;
  const group = FAILED_JOB.slice(FAILED_JOB.lastIndexOf(" · ") + " · ".length);
  const mac = `${BATCH_PULL_CHECKS}Merge batch · Desktop checks / Merge batch · Desktop journeys (Mac)`;

  it("reads only its own group's failed job's log, and confirms the files it names", async () => {
    const jobs = jobsOf(confirmedRun, [failed, mac]);
    const asked: string[] = [];
    const github = githubOf(
      jobs,
      { [failed]: FAILED_LOG, [mac]: playwrightLog("now-collapse.spec.ts") },
      asked,
    );
    const context = { repo, runId: rehearsal.run };
    expect(await outputsOf((core) => groupFailure({ github, context, core, group }))).toEqual({
      found: "confirm",
      files: FAILED_FILE,
    });
    expect(asked).toEqual([failed]);
    // Another group, which did not fail, confirms nothing and reads no log.
    expect(
      await outputsOf((core) =>
        groupFailure({ github, context, core, group: "Unit tests (Linux; group 1/3)" }),
      ),
    ).toEqual({ found: "none", files: "" });
    expect(asked).toEqual([failed]);
    // Its log named no test file, or GitHub could not give it.
    for (const log of [
      "2026-11-08T08:05:48.9690171Z ##[error]Process completed with exit code 1.\n",
      null,
    ])
      expect(
        await outputsOf((core) =>
          groupFailure({ github: githubOf(jobs, { [failed]: log }), context, core, group }),
        ),
      ).toEqual({ found: "unanswerable", files: "" });
  });

  it("leaves every failed job outside the test groups to the later confirm", () => {
    const jobs = jobsOf(confirmedRun, [failed, mac]);
    const failedJobs = [
      { name: failed, files: [FAILED_FILE] },
      { name: mac, files: ["now-collapse.spec.ts"] },
    ];
    const { confirmed, grouped } = groupConfirms(failedJobs, jobs);
    expect({ confirmed, grouped }).toEqual({ confirmed: [FAILED_JOB], grouped: "passed" });
    expect(laterPlan(failedJobs, confirmed)).toEqual({
      left: "confirm",
      jobs: mac.slice(BATCH_PULL_CHECKS.length),
      files: "now-collapse.spec.ts",
    });
  });
});

// The check files of this repository's own version, as main's sort reads
// them from its checkout of the pushed version.
const checkFiles = await readCheckFiles(".");

describe("main's check sorting a push that merged a batch pull request", () => {
  const passed = { id: rehearsal.run, jobs: jobsOf(passedRun) };
  const files = [{ filename: "src/core/session/tools.ts" }, { filename: "docs/testing.md" }];
  const sorted = (input: Partial<Parameters<typeof sortBatchPull>[0]>) =>
    sortBatchPull({
      tree: rehearsal.tree,
      runs: [passed],
      files,
      total: files.length,
      checkFiles,
      ...input,
    });

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
      // A file of an action the run uses, which a step runs by its path.
      { filename: ".github/actions/electron-download/zips.mjs" },
      // A file removed from the folder of an action the run uses.
      { filename: ".github/actions/linux-desktop/setup.sh" },
      // A check file the run reads under a new name is a changed check file.
      {
        filename: ".github/workflows/verify.yml",
        previous_filename: ".github/workflows/full-check.yml",
      },
    ])
      expect(sorted({ files: [...files, changed], total: 3 }), changed.filename).toEqual({
        kind: "full",
      });
    // A list GitHub cut short may hide one.
    expect(sorted({ total: 3001 })).toEqual({ kind: "full" });
  });

  // INF-4347's fix the captain started: "Check main again only for check
  // files the batch did not run, so the alpha does not re-run every journey."
  it("reuses the run of a batch whose changed check files that run never reads", () => {
    for (const changed of [
      { filename: ".github/workflows/release.yml" },
      { filename: ".github/workflows/main.yml" },
      { filename: ".github/workflows/ci.yml" },
      { filename: ".github/workflows/journeys.yml" },
      { filename: ".github/actions/linux-packages/action.yml" },
      // A check file moved out of its folder is one the run could not read.
      { filename: "docs/old-check.yml", previous_filename: ".github/workflows/old-check.yml" },
    ])
      expect(sorted({ files: [...files, changed], total: 3 }), changed.filename).toEqual({
        kind: "covered",
        run: rehearsal.run,
      });
  });

  it("reads the check files the batch's run reaches through its workflows and actions", () => {
    const read = batchRunCheckFiles(checkFiles);
    // The batch's workflow, what it calls, and what that calls in turn.
    for (const path of [
      BATCH_PULL_RUN,
      ".github/workflows/batch-checks.yml",
      ".github/workflows/verify.yml",
      ".github/workflows/source-journeys.yml",
      ".github/workflows/linux-startup.yml",
      // Used from a checkout in another folder: ./Application Support/firstmate/.github/actions/pnpm.
      ".github/actions/pnpm/action.yml",
      // A whole action's folder, the file a step runs included.
      ".github/actions/electron-download/zips.mjs",
    ])
      expect(read, path).toContain(path);
    for (const path of [".github/workflows/release.yml", ".github/workflows/main.yml"])
      expect(read, path).not.toContain(path);
    // A file a comment names is not read.
    const named = new Map(checkFiles);
    const checks = ".github/workflows/batch-checks.yml";
    named.set(
      checks,
      `# The alpha's own check is .github/workflows/release.yml.\n${checkFiles.get(checks)}`,
    );
    expect(batchRunCheckFiles(named)).not.toContain(".github/workflows/release.yml");
    named.set(
      checks,
      `${checkFiles.get(checks)}\n      - run: cat .github/workflows/release.yml\n`,
    );
    expect(batchRunCheckFiles(named)).toContain(".github/workflows/release.yml");
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
    const push = { sha: merge, tree: rehearsal.tree, checkFiles };
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "covered", run: rehearsal.run });
    expect(await readMainPush(github, repo, { ...push, tree: "d".repeat(40) })).toEqual({
      kind: "full",
    });
    // A fork's branch of that name is no batch, so it has no run to reuse.
    from = "someone/infinitary";
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "full" });
    // A commit that merged no pull request is checked in full.
    expect(await readMainPush(github, repo, { ...push, sha: rehearsal.base })).toEqual({
      kind: "full",
    });
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
    const confirm = jobs.find((job) => job.name === groupConfirmOf(FAILED_JOB))!;
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

// The approved replacement of the job that watched each batch run until its
// first failure (INF-4493's spec): each row is one way a batch run ends, with
// the verdict the run gave while that job read the first failure, its last
// job's pass or not, which the alpha's proof follows. The failures job, each
// Linux test group's own confirm and the alpha's proof read the row's jobs
// and logs as GitHub gives them, and the batch's verdict and the proof stay
// what they were.
describe("the batch's verdict and the alpha's proof, as they stood with the first-failure job", () => {
  const SWEEP = "Merge batch · Desktop checks / Merge batch · ";
  const unit = `${SWEEP}${FAILED_JOB.slice(FAILED_JOB.lastIndexOf(" · ") + " · ".length)}`;
  const macJourneys = `${SWEEP}Desktop journeys (Mac)`;
  const macNative = `${SWEEP}Native tests, replay and package (Mac)`;
  const linuxJourney = `${SWEEP}Linux journeys / Merge batch · App journeys (Linux; serial group 3/3)`;
  const codeChecks = `${SWEEP}Code checks and build (Linux)`;
  const noFile = "2026-11-08T08:05:48.9690171Z ##[error]Process completed with exit code 1.\n";
  // A Mac lane whose journey failed and whose package step failed after it:
  // the whole log names the journey's file.
  const mixed = `${playwrightLog("now-collapse.spec.ts")}2026-11-15T02:40:12.0000000Z ##[error]The universal app's package check failed.\n${noFile}`;

  type Row = {
    row: string;
    /** The verdict with the first-failure job: whether the batch's last job passed. */
    verdict: boolean;
    /** Each failed job of the checks (without the checks' lead) and its log; null is a log GitHub cannot give. */
    failed?: Record<string, string | null>;
    /** Jobs the code checks' stop cancelled. */
    cancelled?: string[];
    /** What each confirm's rounds did on the files it ran. */
    rounds?: { group?: string; later?: string };
    runCancelled?: boolean;
  };
  const rows: Row[] = [
    { row: "every check passed", verdict: true },
    {
      row: "a Linux test group failed, and its files passed three rounds",
      verdict: true,
      failed: { [unit]: FAILED_LOG },
      rounds: { group: "success" },
    },
    {
      row: "a Linux test group failed, and its files failed again",
      verdict: false,
      failed: { [unit]: FAILED_LOG },
      rounds: { group: "failure" },
    },
    {
      row: "a Linux test group failed, and its log named no test file",
      verdict: false,
      failed: { [unit]: noFile },
    },
    {
      row: "a Linux test group failed, and GitHub could not give its log",
      verdict: false,
      failed: { [unit]: null },
    },
    {
      row: "a Linux test group and a Mac lane failed, and both passed their rounds",
      verdict: true,
      failed: { [unit]: FAILED_LOG, [macJourneys]: playwrightLog("now-collapse.spec.ts") },
      rounds: { group: "success", later: "success" },
    },
    {
      row: "a Linux test group and a Mac lane failed, and the Mac lane's files failed again",
      verdict: false,
      failed: { [unit]: FAILED_LOG, [macJourneys]: playwrightLog("now-collapse.spec.ts") },
      rounds: { group: "success", later: "failure" },
    },
    {
      row: "a Mac lane failed a journey and its package step, and the journey passed three rounds",
      verdict: true,
      failed: { [macNative]: mixed },
      rounds: { later: "success" },
    },
    {
      row: "a Linux journey failed, and its file passed three rounds",
      verdict: true,
      failed: { [linuxJourney]: playwrightLog("main-thread-freeze.spec.ts") },
      rounds: { later: "success" },
    },
    {
      row: "a Linux journey failed, and its log named no test file",
      verdict: false,
      failed: { [linuxJourney]: noFile },
    },
    {
      row: "the code checks failed, and the stop cancelled the test groups",
      verdict: false,
      failed: { [codeChecks]: noFile },
      cancelled: [unit, macJourneys],
    },
    { row: "the run was cancelled", verdict: false, runCancelled: true },
  ];

  const resultOf = (names: string[], under: string) =>
    names.some((name) => name.startsWith(under)) ? "failure" : "success";

  /** The row's run end to end: its verdict and whether the alpha's proof accepts it. */
  async function replay({ failed = {}, cancelled = [], rounds = {}, runCancelled = false }: Row) {
    const failing = Object.keys(failed);
    const ended = [...failing, ...cancelled];
    const needs: NonNullable<Scenario["needs"]> = {
      batch: read,
      sweep: { result: resultOf(ended, "Merge batch · Desktop checks / ") },
      "critical-path": { result: resultOf(ended, "Merge batch · Critical-path journey / ") },
      startup: { result: resultOf(ended, "Merge batch · Linux startup / ") },
      "linux-tests": {
        result: cancelled.includes(unit)
          ? "cancelled"
          : failing.includes(unit)
            ? "failure"
            : "success",
      },
      "confirm-later": { result: "skipped" },
    };
    const scenario = (): Scenario => ({
      github: pullRequest(rehearsal.branch),
      needs: { ...needs },
    });
    const conclusions = new Map<string, string>([
      ...failing.map((name) => [`${BATCH_PULL_CHECKS}${name}`, "failure"] as const),
      ...cancelled.map((name) => [`${BATCH_PULL_CHECKS}${name}`, "cancelled"] as const),
    ]);
    const logs = Object.fromEntries(
      Object.entries(failed).map(([name, log]) => [`${BATCH_PULL_CHECKS}${name}`, log]),
    );
    const listed = () =>
      runJobNames("batch-pull-request.yml", scenario()).map((name, index) => ({
        id: index + 1,
        name,
        run_id: rehearsal.run,
        run_attempt: 1,
        head_sha: rehearsal.head,
        status: "completed",
        conclusion: conclusions.get(name) ?? "success",
      }));
    for (const name of conclusions.keys())
      expect(
        listed().map((job) => job.name),
        name,
      ).toContain(name);
    // Each test group's own confirm, once the test groups ended.
    for (const job of listed().filter((job) =>
      job.name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_GROUP_CONFIRM}`),
    )) {
      const group = job.name.slice(`${BATCH_PULL_CHECKS}${BATCH_PULL_GROUP_CONFIRM}`.length);
      const { found } = await outputsOf((core) =>
        groupFailure({
          github: githubOf(listed(), logs),
          context: { repo, runId: rehearsal.run },
          core,
          group,
        }),
      );
      conclusions.set(
        job.name,
        found === "none" ? "success" : found === "confirm" ? rounds.group! : "failure",
      );
    }
    // Once every check ended, when one failed.
    let verdict = false;
    if (!runCancelled) {
      if (workflowValue(String(workflow("batch-checks.yml").jobs.failures!.if), { needs })) {
        const outputs = await outputsOf((core) =>
          failures({
            github: githubOf(listed(), logs),
            context: { repo, runId: rehearsal.run },
            core,
          }),
        );
        needs.failures = { result: "success", outputs };
        if (outputs.left === "confirm") needs["confirm-later"] = { result: rounds.later! };
      } else needs.failures = { result: "skipped" };
      verdict = Boolean(
        workflowValue(String(workflow("batch-checks.yml").jobs.passed!.if), { needs }),
      );
    }
    for (const job of listed())
      if (job.name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_CONFIRM}`))
        conclusions.set(job.name, needs["confirm-later"]!.result!);
    const jobs = listed().filter((job) => job.name !== PASSED || verdict);
    const conclusion =
      ended.length || runCancelled ? (runCancelled ? "cancelled" : "failure") : "success";
    let proved = true;
    try {
      verifyBatchEvidence(run(conclusion), jobs, REPOSITORY, rehearsal.tree);
    } catch {
      proved = false;
    }
    return { verdict, proved };
  }

  for (const row of rows)
    it(`gives the same verdict when ${row.row}`, async () => {
      expect(await replay(row)).toEqual({ verdict: row.verdict, proved: row.verdict });
    });
});
