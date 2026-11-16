/** What a failed batch pull request's confirm runs again (docs/testing.md,
 * "The swept batch"; the captain's pick on INF-3012, "A only: the confirm
 * step").
 *
 * batch-checks.yml's first-failure job reads the run until a check's job
 * fails, then reads each failed job's log for the test files it names as
 * failed, and its confirm job runs those files three rounds on the same
 * version (scripts/batch-confirm.ts) while the other checks run on
 * (INF-4382: the confirm no longer waits for the sweep to end). Once every
 * check ended, its failures job reads the jobs that failed after that, and
 * its later confirm runs their files. A failed job whose log names no test
 * file failed for something no rerun of a test answers, so nothing runs
 * again and the batch's check stays failed.
 */
import { BATCH_PULL_CHECKS, BATCH_PULL_CONFIRM } from "./batch-pull.mjs";

// A test file's path as the runners print it, from the project's root. The
// files go to the confirm as one list separated by spaces, so a path with
// other characters is named nowhere rather than split.
const TEST_FILE = /(?:^|\s)((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=[\s:[]|$)/;
// Vitest's line naming the test file an unhandled error came from: such an
// error fails the run even when every test passed, and prints no FAIL line.
const UNHANDLED_IN = /^\s*This error originated in "((?:[\w.@-]+\/)*[\w.@-]+)" test file\./;
// A job log's timestamp before each line, and a terminal's colors.
const LOG_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's color codes start with ESC
const COLORS = /\u001b\[[0-9;]*m/g;

/**
 * The test files a failed job's log names as failed, in the order it names
 * them: Vitest's FAIL lines, the tests listed under Playwright's closing
 * "N failed" line, and the test file Vitest says an unhandled error
 * originated in.
 */
export function failedTestFiles(log) {
  const files = [];
  let inFailedList = false;
  for (const raw of log.split("\n")) {
    const line = raw.replace(LOG_PREFIX, "").replace(COLORS, "").trimEnd();
    if (/^\s*\d+ failed$/.test(line)) {
      inFailedList = true;
      continue;
    }
    const listed = inFailedList && /^\s{4}\S/.test(line);
    inFailedList = listed;
    const file =
      listed || /^\s*FAIL\s/.test(line) ? TEST_FILE.exec(line)?.[1] : UNHANDLED_IN.exec(line)?.[1];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

const FAILED = ["failure", "timed_out", "cancelled"];

/**
 * Whether `job` is one of the checks': a job of a workflow the batch's
 * checks call (the sweep, the critical path, the startup fixtures), named
 * one level deeper than the checks' own jobs, such as the watch or the
 * confirm.
 */
export const isCheckJob = (job) =>
  job.name.startsWith(BATCH_PULL_CHECKS) && job.name.slice(BATCH_PULL_CHECKS.length).includes(" / ");

/**
 * What one reading of the run's jobs says of the checks: `failed` once a
 * check's job ended failed, `passed` once every check's job ended and none
 * failed, and `running` otherwise, before the called workflows have
 * listed a job. A called workflow lists a job once the jobs it needs
 * ended, so a reading in that moment could find every listed job ended:
 * the first-failure job then ends early, and the failures job confirms
 * every failed job once the checks end, as it did before INF-4382.
 */
export function checksState(jobs) {
  const checks = jobs.filter(isCheckJob);
  if (checks.some((job) => job.status === "completed" && FAILED.includes(job.conclusion))) return "failed";
  if (checks.length && checks.every((job) => job.status === "completed")) return "passed";
  return "running";
}

/**
 * The confirm's plan from each failed job of the checks with the test files
 * its log named: the failed jobs' names without the checks' lead, one a
 * line, and the failed files, separated by spaces; or null when there is
 * nothing a confirm could answer.
 */
export function confirmPlan(failedJobs) {
  if (!failedJobs.length) return null;
  if (failedJobs.some((job) => !job.name.startsWith(BATCH_PULL_CHECKS) || !job.files.length)) return null;
  return {
    jobs: [...new Set(failedJobs.map((job) => job.name.slice(BATCH_PULL_CHECKS.length)))].join("\n"),
    files: [...new Set(failedJobs.flatMap((job) => job.files))].join(" "),
  };
}

/** The run's failed jobs outside the confirm, each with the test files its log names. */
export async function readFailedJobs(github, repo, run) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run,
    per_page: 100,
  });
  const failed = [];
  for (const job of jobs) {
    if (!FAILED.includes(job.conclusion) || job.name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_CONFIRM}`))
      continue;
    let files = [];
    try {
      const { data: log } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: job.id });
      files = failedTestFiles(typeof log === "string" ? log : Buffer.from(log).toString("utf8"));
    } catch {
      // A log GitHub cannot give names no file.
    }
    failed.push({ name: job.name, files });
  }
  return failed;
}

/**
 * What is left to confirm once every check ended, from the run's failed
 * jobs and the jobs the first confirm already took (`confirmed`, names
 * without the checks' lead): `nothing` when the first confirm took every
 * failed job, `confirm` with the plan for the jobs that failed after it,
 * and `unanswerable` when one of those named no test file, or when no
 * failed job could be read at all.
 */
export function laterPlan(failedJobs, confirmed) {
  const taken = new Set(confirmed);
  const rest = failedJobs.filter((job) => !taken.has(job.name.slice(BATCH_PULL_CHECKS.length)));
  if (failedJobs.length && !rest.length) return { left: "nothing" };
  const plan = confirmPlan(rest);
  return plan ? { left: "confirm", ...plan } : { left: "unanswerable" };
}

const say = (plan) =>
  `The failed test files run three more rounds on the same version for ${plan.jobs.split("\n").join(", ")} (${plan.files}).`;
const UNANSWERABLE =
  "A failed job's log named no failed test file, so nothing runs again and the batch's check stays failed.";

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The first-failure job: reads the run's latest jobs every half minute
 * until a check's job fails or every check's job ended, and writes the
 * output `found`: `confirm` with `jobs` and `files` (confirmPlan's, from
 * the jobs failed at that reading), `unanswerable` when one of them named
 * no test file, or `none` when every check ended without a failure. A
 * reading GitHub refuses is read again.
 */
export async function firstFailure({ github, context, core, everySeconds = 30 }) {
  for (;;) {
    let state = "running";
    try {
      state = checksState(
        await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          ...context.repo,
          run_id: context.runId,
          filter: "latest",
          per_page: 100,
        }),
      );
    } catch (error) {
      core.warning(`The run's jobs could not be read, so this job reads them again: ${error.message}`);
    }
    if (state === "passed") {
      core.notice("Every check ended without a failure, so nothing is confirmed.");
      core.setOutput("found", "none");
      core.setOutput("jobs", "");
      core.setOutput("files", "");
      return;
    }
    if (state === "failed") {
      const plan = confirmPlan(await readFailedJobs(github, context.repo, context.runId));
      core.notice(plan ? `${say(plan)} The other checks run on.` : UNANSWERABLE);
      core.setOutput("found", plan ? "confirm" : "unanswerable");
      core.setOutput("jobs", plan?.jobs ?? "");
      core.setOutput("files", plan?.files ?? "");
      return;
    }
    await wait(everySeconds);
  }
}

/**
 * The failures job, once every check ended: the output `left` (laterPlan's),
 * with `jobs` (the failed jobs' names, one a line) and `files` (the failed
 * test files, separated by spaces) for the later confirm, both empty when
 * nothing more runs. `confirmed` is the first-failure job's `jobs` output.
 */
export async function failures({ github, context, core, confirmed = "" }) {
  const plan = laterPlan(
    await readFailedJobs(github, context.repo, context.runId),
    confirmed.split("\n").filter(Boolean),
  );
  core.notice(
    plan.left === "confirm"
      ? say(plan)
      : plan.left === "nothing"
        ? "Every failed job's test files are already being confirmed, so nothing more runs."
        : UNANSWERABLE,
  );
  core.setOutput("left", plan.left);
  core.setOutput("jobs", plan.jobs ?? "");
  core.setOutput("files", plan.files ?? "");
}
