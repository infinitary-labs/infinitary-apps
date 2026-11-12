/** A batch pull request's run (docs/testing.md, "A batch pull request").
 *
 * A batch of your own is one pull request from a branch of this repository
 * whose name starts with infinitary-batch/, one commit per change.
 * batch-pull-request.yml runs the swept batch on its version, and its last
 * job names the tree it passed. This module holds what the readers of that
 * run share: main's sort (scripts/batch.mjs), the alpha's proof
 * (scripts/main-alpha-proof.mjs) and the run's own failure reader
 * (scripts/batch-failures.mjs).
 */

/** What a batch's branch starts with. */
export const BATCH_BRANCH = "infinitary-batch/";

/** The workflow a batch pull request starts, as GitHub names a run's file. */
export const BATCH_PULL_RUN = ".github/workflows/batch-pull-request.yml";

/** What every job of the batch's checks starts with: the one job that calls batch-checks.yml. */
export const BATCH_PULL_CHECKS = "Merge batch · Batch checks / ";

/** What each confirm job's own name starts with, under the checks. */
export const BATCH_PULL_CONFIRM = "Merge batch · Confirm failed tests (";

/** Whether `pull` is a batch pull request of `repository` itself, never a fork's branch of that name. */
export const isBatchPull = (pull, repository) =>
  (pull.head?.ref ?? "").startsWith(BATCH_BRANCH) &&
  pull.head.repo?.full_name === repository &&
  pull.base?.repo?.full_name === repository;

/**
 * Whether `run` is a batch pull request's own run in `repository`: started by
 * a pull request from a batch branch of the repository itself.
 */
export const isBatchPullRun = (run, repository) =>
  run.path === BATCH_PULL_RUN &&
  run.event === "pull_request" &&
  (run.head_branch ?? "").startsWith(BATCH_BRANCH) &&
  run.head_repository?.full_name === repository &&
  run.repository?.full_name === repository;

// The checks' last job (batch-checks.yml) names the tree the batch's version
// holds and the main version the batch left main at.
const PASSED_JOB = /^Merge batch · Batch passed \(tree ([0-9a-f]{40,64}); base ([0-9a-f]{40,64})\)$/;

/** The tree a batch pull request's run passed, from its jobs, or null when its last job did not pass. */
export function batchPullTree(jobs) {
  for (const job of jobs) {
    if (!job.name.startsWith(BATCH_PULL_CHECKS) || job.status !== "completed" || job.conclusion !== "success")
      continue;
    const match = PASSED_JOB.exec(job.name.slice(BATCH_PULL_CHECKS.length));
    if (match) return match[1];
  }
  return null;
}

// Where the workflows and the actions they run live. A pull request's run
// reads them from the pull request's own version, so a batch that changes one
// chose its own check.
const CHECK_FILES = ".github/";

/**
 * Whether a batch changed a file its own check is made of, from the files
 * its pull request changed as GitHub lists them and the count GitHub gives
 * for all of them. A list GitHub cut short may hide one, so it counts as
 * changed.
 */
export function changedCheckFile(files, total) {
  if (files.length < total) return true;
  return files.some((file) =>
    [file.filename, file.previous_filename].some((path) => path?.startsWith(CHECK_FILES)),
  );
}

/**
 * How main's check treats a push that merged a batch pull request, from the
 * pushed files' `tree`, the pull request's runs newest first, each with its
 * latest jobs, and its changed `files` with their `total`:
 * - covered: a run passed on exactly these files and the batch changed no
 *   check file, so nothing runs again;
 * - full otherwise: main moved under the batch, no run passed, or the batch
 *   changed a file its own check is made of.
 */
export function sortBatchPull({ tree, runs, files, total }) {
  if (changedCheckFile(files, total)) return { kind: "full" };
  const run = runs.find((candidate) => batchPullTree(candidate.jobs) === tree);
  return run ? { kind: "covered", run: run.id } : { kind: "full" };
}
