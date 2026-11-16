import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { readCheckFiles, readMainPush } from "../scripts/batch.mjs";
import {
  checksState,
  confirmPlan,
  failedTestFiles,
  failures,
  firstFailure,
  isCheckJob,
  laterPlan,
} from "../scripts/batch-failures.mjs";
import {
  BATCH_BRANCH,
  BATCH_PULL_CHECKS,
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
    "first-failure": { result: "success", outputs: { found: "none", jobs: "", files: "" } },
    confirm: { result: "skipped" },
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
 * A batch whose sweep failed in one Linux job, whose confirm took it from the
 * first failure and passed, and where no job failed later.
 */
const confirmedRun: Scenario = {
  github: pullRequest(rehearsal.branch),
  needs: {
    batch: read,
    sweep: { result: "failure" },
    "critical-path": { result: "success" },
    startup: { result: "success" },
    "first-failure": {
      result: "success",
      outputs: { found: "confirm", jobs: FAILED_JOB, files: FAILED_FILE },
    },
    confirm: { result: "success" },
    failures: { result: "success", outputs: { left: "nothing", jobs: "", files: "" } },
    "confirm-later": { result: "skipped" },
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
  const inputs = { trigger: "Merge batch", head: rehearsal.head };

  it("runs every check on the batch's own version", () => {
    for (const id of ["sweep", "critical-path", "startup"]) {
      const call = checks.jobs[id]!.with!;
      expect(workflowString(String(call.ref), { inputs }), id).toBe(rehearsal.head);
      expect(workflowString(String(call.trigger), { inputs }), id).toBe("Merge batch");
    }
    // The confirm runs the failed files on that version too.
    const checkouts = (checks.jobs.confirm!.steps ?? []).filter(
      (step) => step.uses === "actions/checkout@v4",
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts)
      expect(workflowString(String(step.with?.ref), { inputs })).toBe(rehearsal.head);
  });

  it("confirms on the platform whose job failed, from the first failure and after it", () => {
    for (const [id, from] of [
      ["confirm", "first-failure"],
      ["confirm-later", "failures"],
    ] as const) {
      const platforms = (jobs: string) =>
        workflowValue(
          String(
            (checks.jobs[id] as { strategy: { matrix: { platform: string } } }).strategy.matrix
              .platform,
          ),
          { needs: { [from]: { outputs: { jobs } } } },
        );
      const mac = "Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)";
      expect(platforms(FAILED_JOB), id).toEqual(["linux"]);
      expect(platforms(mac), id).toEqual(["mac"]);
      expect(platforms(`${mac}\n${FAILED_JOB}`), id).toEqual(["linux", "mac"]);
    }
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
    // A job failed after the first failure, and the later confirm passed on it.
    const later = {
      ...confirmedRun.needs,
      failures: {
        result: "success",
        outputs: { left: "confirm", jobs: "later", files: FAILED_FILE },
      },
    };
    expect(ends({ ...later, "confirm-later": { result: "success" } })).toBe(true);
    // A first-failure job that could not read the run leaves every failed
    // job to the later confirm.
    const unread = { ...later, "first-failure": { result: "success", outputs: {} } };
    expect(
      ends({ ...unread, confirm: { result: "skipped" }, "confirm-later": { result: "success" } }),
    ).toBe(true);
    // A failed check with no confirm, a failed confirm, a later failure left
    // unconfirmed or no confirm answers, and a cancelled run name no tree.
    expect(ends({ ...confirmedRun.needs, confirm: { result: "skipped" } })).toBe(false);
    expect(ends({ ...confirmedRun.needs, confirm: { result: "failure" } })).toBe(false);
    expect(ends({ ...later, "confirm-later": { result: "failure" } })).toBe(false);
    expect(ends({ ...later, "confirm-later": { result: "skipped" } })).toBe(false);
    expect(
      ends({
        ...confirmedRun.needs,
        failures: { result: "success", outputs: { left: "unanswerable", jobs: "", files: "" } },
      }),
    ).toBe(false);
    expect(
      ends({
        ...confirmedRun.needs,
        "first-failure": {
          result: "success",
          outputs: { found: "unanswerable", jobs: "", files: "" },
        },
        confirm: { result: "skipped" },
        failures: { result: "skipped" },
      }),
    ).toBe(false);
    expect(ends(passedRun.needs, true)).toBe(false);
    expect(runJobNames("batch-pull-request.yml", passedRun).at(-1)).toBe(PASSED);
    expect(runJobNames("batch-pull-request.yml", confirmedRun)).toEqual(
      expect.arrayContaining([
        `${BATCH_PULL_CHECKS}Merge batch · Read the first failures`,
        `${BATCH_PULL_CHECKS}Merge batch · Read the failures`,
        `${BATCH_PULL_CHECKS}Merge batch · Confirm failed tests (Linux)`,
        PASSED,
      ]),
    );
    // The later failures are read only after a failed check, and not after
    // a first failure no confirm answers.
    const reads = (needs: Scenario["needs"]) =>
      workflowValue(String(checks.jobs.failures!.if), { needs });
    expect(reads(passedRun.needs)).toBe(false);
    expect(reads(confirmedRun.needs)).toBe(true);
    expect(
      reads({
        ...confirmedRun.needs,
        "first-failure": { result: "success", outputs: { found: "unanswerable" } },
      }),
    ).toBe(false);
  });

  // INF-4382: the confirm starts from the first failed check, while the
  // other checks run on, and nothing waits on it but the confirm.
  it("starts the confirm from the first failure, beside the checks, and cancels nothing", () => {
    const first = checks.jobs["first-failure"]! as Job & { "continue-on-error"?: boolean };
    expect(first.needs).toBe("batch");
    expect(first["continue-on-error"]).toBe(true);
    expect(checks.jobs.confirm!.needs).toBe("first-failure");
    for (const id of ["sweep", "critical-path", "startup"])
      expect(checks.jobs[id]!.needs, id).toBe("batch");
    const confirms = (found: string) =>
      workflowValue(String(checks.jobs.confirm!.if), {
        needs: { "first-failure": { outputs: { found } } },
      });
    expect(["confirm", "unanswerable", "none", ""].map(confirms)).toEqual([
      true,
      false,
      false,
      false,
    ]);
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
    for (const id of ["confirm", "confirm-later"])
      expect(checks.jobs[id]!.steps!.at(-1)!.uses, id).toBe(
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

  it("leaves to the later confirm only the jobs that failed after the first confirm took its own", () => {
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
    // Nothing confirmed first: every failed job is the later confirm's.
    expect(laterPlan([{ name: failed, files: [FAILED_FILE] }], [])).toEqual({
      left: "confirm",
      jobs: FAILED_JOB,
      files: FAILED_FILE,
    });
    // A later job named no test file, or no failed job could be read.
    expect(laterPlan([{ name: later, files: [] }], [FAILED_JOB])).toEqual({ left: "unanswerable" });
    expect(laterPlan([], [])).toEqual({ left: "unanswerable" });
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
    expect(Object.fromEntries(outputs)).toEqual({
      left: "confirm",
      jobs: FAILED_JOB,
      files: FAILED_FILE,
    });
    await failures({
      github,
      context: { repo, runId: rehearsal.run },
      core: {
        notice: () => {},
        setOutput: (name: string, value: string) => outputs.set(name, value),
      },
      confirmed: FAILED_JOB,
    });
    expect(Object.fromEntries(outputs)).toEqual({ left: "nothing", jobs: "", files: "" });
  });
});

// INF-4382 (the captain: "i thought we send the first failure immediately
// back. in what case do we wait for the whole run to finish?"): the confirm
// starts from the first failed check rather than once every check ended.
// The readings are two batch runs as GitHub listed their jobs once they
// ended: run 43666102541, whose one failed job ended four and a half
// minutes before its last check did, and run 43755363255, whose Mac job
// failed eleven minutes after its first failure. Each failed job's log names
// the file its run's failures job read from it.
type RecordedJob = {
  id: number;
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
};
const recorded = (run: number) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/batch-failures/batch-run-${run}.json`, import.meta.url),
      "utf8",
    ),
  ) as RecordedJob[];
/** The run's jobs as GitHub listed them at `time`: created, then queued, running or ended. */
const readingAt = (jobs: RecordedJob[], time: string) =>
  jobs
    .filter((job) => job.created_at <= time)
    .map((job) => ({
      id: job.id,
      name: job.name,
      status:
        job.completed_at && job.completed_at <= time
          ? "completed"
          : job.started_at <= time
            ? "in_progress"
            : "queued",
      conclusion: job.completed_at && job.completed_at <= time ? job.conclusion : null,
    }));
const later = (time: string, seconds: number) =>
  new Date(Date.parse(time) + seconds * 1000).toISOString().replace(".000Z", "Z");
const playwrightLog = (file: string) =>
  `2026-11-15T02:26:50.0000000Z   1 failed\n2026-11-15T02:26:50.0000000Z     [desktop] › ${file}:12:3 › the journey\n`;

/**
 * The first-failure job on a recorded run: it starts beside the checks and
 * reads the run every half minute of the run's own time. Answers the time
 * of the reading it ended at and its outputs.
 */
async function replayFirstFailure(jobs: RecordedJob[], logs: Record<number, string>) {
  const critical = jobs.find((job) => job.name.includes("Critical-path journey /"))!;
  let time = critical.started_at;
  let read = time;
  const outputs = new Map<string, string>();
  await firstFailure({
    github: {
      rest: {
        actions: {
          listJobsForWorkflowRun: "jobs",
          downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => ({
            data: logs[job_id] ?? "",
          }),
        },
      },
      // The watch's own readings move the clock; the failed jobs' read
      // after the last of them reads the same moment.
      paginate: async (_method: string, parameters: { filter?: string }) => {
        if (parameters.filter !== "latest") return readingAt(jobs, read);
        read = time;
        time = later(time, 30);
        return readingAt(jobs, read);
      },
    },
    context: { repo, runId: 1 },
    core: {
      notice: () => {},
      warning: () => {},
      setOutput: (name: string, value: string) => outputs.set(name, value),
    },
    everySeconds: 0,
  });
  return { read, outputs: Object.fromEntries(outputs) };
}

describe("a batch's confirm from its first failure", () => {
  const checksOf = (jobs: RecordedJob[]) => jobs.filter((job) => isCheckJob(job));
  const failedOf = (jobs: RecordedJob[]) =>
    checksOf(jobs).filter((job) => job.conclusion === "failure");

  it("reads the failure within half a minute of its job ending, before the last check ends", async () => {
    const jobs = recorded(43_666_102_541);
    const [failedJob] = failedOf(jobs);
    const { read, outputs } = await replayFirstFailure(jobs, {
      [failedJob!.id]: playwrightLog("main-thread-freeze.spec.ts"),
    });
    expect(read >= failedJob!.completed_at! && read <= later(failedJob!.completed_at!, 30)).toBe(
      true,
    );
    const lastCheck = checksOf(jobs)
      .map((job) => job.completed_at!)
      .sort()
      .at(-1)!;
    expect(read < lastCheck).toBe(true);
    expect(outputs).toEqual({
      found: "confirm",
      jobs: failedJob!.name.slice(BATCH_PULL_CHECKS.length),
      files: "main-thread-freeze.spec.ts",
    });
  });

  it("leaves a job that failed later to the later confirm", async () => {
    const jobs = recorded(43_755_363_255);
    const failed = failedOf(jobs);
    const linux = failed.find((job) => job.name.includes("(Linux"))!;
    const mac = failed.find((job) => job.name.includes("(Mac)"))!;
    const logs = {
      [linux.id]: playwrightLog("add-project.spec.ts"),
      [mac.id]: playwrightLog("now-collapse.spec.ts"),
    };
    const { read, outputs } = await replayFirstFailure(jobs, logs);
    expect(read < mac.completed_at!).toBe(true);
    expect(outputs.jobs).toBe(linux.name.slice(BATCH_PULL_CHECKS.length));
    // Once every check ended, the Mac job is all the later confirm runs.
    expect(
      laterPlan(
        failed.map((job) => ({ name: job.name, files: failedTestFiles(logs[job.id]!) })),
        outputs.jobs!.split("\n"),
      ),
    ).toEqual({
      left: "confirm",
      jobs: mac.name.slice(BATCH_PULL_CHECKS.length),
      files: "now-collapse.spec.ts",
    });
  });

  it("ends without a confirm once every check ended, never before", async () => {
    const jobs = recorded(43_666_102_541).map((job) => ({
      ...job,
      conclusion: job.conclusion === "failure" ? "success" : job.conclusion,
    }));
    const lastCheck = checksOf(jobs)
      .map((job) => job.completed_at!)
      .sort()
      .at(-1)!;
    const { read, outputs } = await replayFirstFailure(jobs, {});
    expect(read >= lastCheck && read <= later(lastCheck, 30)).toBe(true);
    expect(outputs).toEqual({ found: "none", jobs: "", files: "" });
    // Before the checks' called workflows list their jobs, nothing has ended.
    expect(checksState(readingAt(jobs, jobs[0]!.started_at))).toBe("running");
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
