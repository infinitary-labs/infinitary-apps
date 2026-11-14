/** What a failed batch pull request's confirm runs again (docs/testing.md,
 * "A batch pull request"; the captain's pick on INF-3012, "A only: the
 * confirm step").
 *
 * batch-checks.yml's failures job reads each failed job's log for the test
 * files it names as failed, and its confirm job runs those files three
 * rounds on the same version (scripts/batch-confirm.ts). A failed job whose
 * log names no test file failed for something no rerun of a test answers, so
 * nothing runs again and the batch's check stays failed.
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
 * The failures job: the outputs `jobs` (the failed jobs' names, one a line)
 * and `files` (the failed test files, separated by spaces), both empty when
 * nothing runs again.
 */
export async function failures({ github, context, core }) {
  const plan = confirmPlan(await readFailedJobs(github, context.repo, context.runId));
  core.notice(
    plan
      ? `The failed test files run three more rounds on the same version for ${plan.jobs.split("\n").join(", ")} (${plan.files}).`
      : "A failed job's log named no failed test file, so nothing runs again and the batch's check stays failed.",
  );
  core.setOutput("jobs", plan?.jobs ?? "");
  core.setOutput("files", plan?.files ?? "");
}
