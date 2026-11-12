/** What a failed batch pull request's confirm runs again (docs/testing.md,
 * "A batch pull request"; the captain's pick on INF-3012, "A only: the
 * confirm step").
 *
 * batch-checks.yml's failures job reads each failed job's log for the test
 * files it names as failed, with the shipped queue's own reader, and its
 * confirm job runs those files three rounds on the same version
 * (scripts/batch-confirm.ts). A failed job whose log names no test file
 * failed for something no rerun of a test answers, so nothing runs again and
 * the batch's check stays failed.
 */
import { failedTestFiles } from "../.github/infinitary/rules.mjs";
import { BATCH_PULL_CHECKS, BATCH_PULL_CONFIRM } from "./batch-pull.mjs";

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
