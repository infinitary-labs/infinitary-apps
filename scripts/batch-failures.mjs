/** What a failed batch pull request's confirm runs again (docs/testing.md,
 * "The swept batch"; the captain's pick on INF-3012, "A only: the confirm
 * step").
 *
 * Each Linux test group of the sweep has a confirm of its own in the sweep
 * (verify.yml's linux-tests-confirm): once the test groups ended, it reads
 * its own group's failed job's log for the test files it names as failed,
 * and runs those files three rounds on the same version
 * (scripts/batch-confirm.ts) while the other checks run on. Once every
 * check ended, batch-checks.yml's failures job reads the other failed jobs,
 * and its later confirm runs their files. A failed job whose log names no
 * test file failed for something no rerun of a test answers, so nothing
 * runs again and the batch's check stays failed.
 */
import { BATCH_PULL_CHECKS, BATCH_PULL_GROUP_CONFIRM, isConfirmJob } from "./batch-pull.mjs";

// A test file's path as the runners print it, from the project's root. The
// files go to the confirm as one list separated by spaces, so a path with
// other characters is named nowhere rather than split.
const TEST_FILE = /(?:^|\s)((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=[\s:[]|$)/;
// Vitest's line naming the test file an unhandled error came from: such an
// error fails the run even when every test passed, and prints no FAIL line.
const UNHANDLED_IN = /^\s*This error originated in "((?:[\w.@-]+\/)*[\w.@-]+)" test file\./;
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

/**
 * The run's failed jobs outside the confirms, each with the test files its
 * log names; `only` picks the jobs read, by default every one.
 */
export async function readFailedJobs(github, repo, run, only = () => true) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run,
    per_page: 100,
  });
  const failed = [];
  for (const job of jobs) {
    if (!FAILED.includes(job.conclusion) || isConfirmJob(job.name) || !only(job)) continue;
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
 * jobs and the jobs a test group's confirm already took (`confirmed`, names
 * without the checks' lead): `nothing` when those took every failed job,
 * `confirm` with the plan for the other failed jobs, and `unanswerable`
 * when one of those named no test file, or when no failed job could be read
 * at all.
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

/** The name of the confirm a test group's job of the checks has beside it, by full names. */
const groupConfirmName = (name) => {
  const at = name.lastIndexOf(" · ");
  return `${name.slice(0, at)} · Confirm failed ${name.slice(at + " · ".length)}`;
};

/**
 * What the test groups' own confirms answered, from the run's failed jobs
 * and every job of the run: `confirmed`, the failed jobs (names without the
 * checks' lead) a group's confirm ran beside, and `grouped`, `passed` when
 * every group confirm that ran passed (or none ran) and `failed` otherwise.
 */
export function groupConfirms(failedJobs, jobs) {
  const ran = jobs.filter(
    (job) =>
      job.name.startsWith(`${BATCH_PULL_CHECKS}${BATCH_PULL_GROUP_CONFIRM}`) &&
      job.status === "completed" &&
      job.conclusion !== "skipped",
  );
  const names = new Set(ran.map((job) => job.name));
  return {
    confirmed: failedJobs
      .filter((job) => names.has(groupConfirmName(job.name)))
      .map((job) => job.name.slice(BATCH_PULL_CHECKS.length)),
    grouped: ran.every((job) => job.conclusion === "success") ? "passed" : "failed",
  };
}

/**
 * A Linux test group's confirm, once the test groups ended: reads the failed
 * job of the checks named `group` (its own name without the trigger, such as
 * `Unit tests (Linux; group 1/3)`) and writes the output `found`: `confirm`
 * with `files` (confirmPlan's), `unanswerable` when its log named no test
 * file, or `none` when the group did not fail.
 */
export async function groupFailure({ github, context, core, group }) {
  const own = (job) => isCheckJob(job) && job.name.endsWith(` · ${group}`);
  const failed = await readFailedJobs(github, context.repo, context.runId, own);
  const plan = confirmPlan(failed);
  const found = !failed.length ? "none" : plan ? "confirm" : "unanswerable";
  core.notice(
    found === "none"
      ? `${group} did not fail, so nothing of it is confirmed.`
      : plan
        ? `${say(plan)} The other checks run on.`
        : UNANSWERABLE,
  );
  core.setOutput("found", found);
  core.setOutput("files", plan?.files ?? "");
}

/**
 * The failures job, once every check ended: the output `left` (laterPlan's
 * for the failed jobs no test group's confirm took), with `jobs` (the
 * failed jobs' names, one a line) and `files` (the failed test files,
 * separated by spaces) for the later confirm, both empty when nothing more
 * runs, and `grouped` (groupConfirms').
 */
export async function failures({ github, context, core }) {
  const failed = await readFailedJobs(github, context.repo, context.runId);
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: context.runId,
    filter: "latest",
    per_page: 100,
  });
  const { confirmed, grouped } = groupConfirms(failed, jobs);
  const plan = laterPlan(failed, confirmed);
  core.notice(
    plan.left === "confirm"
      ? say(plan)
      : plan.left === "nothing"
        ? "Every failed job's test files are already being confirmed, so nothing more runs."
        : UNANSWERABLE,
  );
  if (grouped === "failed") core.notice("A test group's confirm failed, so the batch's check stays failed.");
  core.setOutput("left", plan.left);
  core.setOutput("jobs", plan.jobs ?? "");
  core.setOutput("files", plan.files ?? "");
  core.setOutput("grouped", grouped);
}
