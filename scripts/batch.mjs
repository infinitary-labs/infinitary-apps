/** Main's check sorting a push against the swept batch (docs/testing.md,
 * "The swept batch").
 *
 * A batch is one pull request from a branch of this repository whose name
 * starts with infinitary-batch/, one commit per change, merged in one push
 * (docs/forge.md, "Batches of your own"). batch-pull-request.yml runs the
 * swept batch on its version, and scripts/batch-pull.mjs reads that run.
 * This module reads it for main.yml's first job: a push whose files are
 * exactly a passed batch's needs no check run again, whether the batch
 * passed outright or on its confirm (the captain's pick on INF-3052,
 * "Nothing more: the batch's run and its recheck together passed every
 * test"), unless the batch changed a file its own run reads. Main's
 * own full check runs only for files no batch built.
 *
 * A push that merged an outside contributor's pull request is left to the
 * next batch (INF-6982, the captain: "make outside PRs not trigger this at
 * all, and simply ride my next alpha cut from my batches"): main's check
 * stops itself with no alpha, and the next batch, combined on top of main,
 * checks the change and its alpha ships it. That holds only while the commit
 * before it is accounted for, so a batch whose own main run the queue
 * dropped still gets a full check and an alpha.
 */
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { BATCH_PULL_RUN, isBatchPull, isBatchPullRun, sortBatchPull } from "./batch-pull.mjs";
import { splitLevel } from "./ci-job-names.mjs";

/**
 * Every file under .github/ in the checkout at `root`, path to text, as
 * sortBatchPull reads the check files of the pushed version.
 */
export async function readCheckFiles(root) {
  const files = new Map();
  for (const entry of await readdir(posix.join(root, ".github"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = posix.relative(root, posix.join(entry.parentPath ?? entry.path, entry.name));
    files.set(path, await readFile(posix.join(root, path), "utf8"));
  }
  return files;
}

/** The pull request a commit merged, or undefined when it merged none. */
async function mergedPull(github, repo, sha) {
  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    ...repo,
    commit_sha: sha,
  });
  return pulls.find((candidate) => candidate.merge_commit_sha === sha);
}

/**
 * What the job main.yml's run shows when it left its push to the next batch
 * starts with, after its trigger: `Main push · Left to the next batch (pull
 * request N)`.
 */
export const LEFT_TO_NEXT_BATCH = "Left to the next batch (pull request ";

/** Whether a main run's jobs, by their names, show it left its push to the next batch. */
export const leftToNextBatch = (jobs) =>
  jobs.some((job) => (splitLevel(job.name)?.purpose ?? "").startsWith(LEFT_TO_NEXT_BATCH));

/**
 * Whether `pull` came from another copy of the project, or from one since
 * deleted, into `repository` itself: an outside contributor's pull request,
 * as contributors.yml and scripts/failed-checks.mjs tell it.
 */
export const isOutsidePull = (pull, repository) =>
  pull.head?.repo?.full_name !== repository && pull.base?.repo?.full_name === repository;

// A run ended success or failure checked its version; a cancelled run checked
// nothing unless it was itself left to the next batch. A run the queue
// dropped for a newer push, or one that cancelled itself while it waited for
// an alpha, ends cancelled too, and the version it held then rides this
// push's full check.
const CHECKED = new Set(["success", "failure"]);

/** Whether main's newest push run at the commit before `sha` checked it or left it to the next batch. */
async function parentAccounted(github, repo, sha) {
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: sha });
  const parent = commit.parents?.[0]?.sha;
  if (!parent) return false;
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: "main.yml",
    head_sha: parent,
    event: "push",
    exclude_pull_requests: true,
    per_page: 20,
  });
  // GitHub lists runs newest first.
  const run = (data.workflow_runs ?? []).find((each) => each.head_sha === parent);
  if (!run || run.status !== "completed") return false;
  if (CHECKED.has(run.conclusion)) return true;
  if (run.conclusion !== "cancelled") return false;
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  return leftToNextBatch(jobs);
}

/** A merged batch pull request's sort: its own runs on its version, their latest jobs, and the files it changed. */
async function readBatchPull(github, repo, pull, tree, checkFiles) {
  const repository = `${repo.owner}/${repo.repo}`;
  const { data: whole } = await github.rest.pulls.get({ ...repo, pull_number: pull.number });
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo,
    pull_number: pull.number,
    per_page: 100,
  });
  const listed = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: BATCH_PULL_RUN.split("/").pop(),
    head_sha: pull.head.sha,
    event: "pull_request",
    per_page: 100,
  });
  const runs = [];
  for (const run of listed) {
    if (!isBatchPullRun(run, repository) || run.head_sha !== pull.head.sha) continue;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...repo,
      run_id: run.id,
      filter: "latest",
      per_page: 100,
    });
    runs.push({ id: run.id, jobs });
  }
  return sortBatchPull({ tree, runs, files, total: whole.changed_files, checkFiles });
}

/**
 * main.yml's sort: reads the pull request the pushed commit merged and, for
 * a batch pull request, its own run and the files it changed, against the
 * pushed version's `checkFiles` (readCheckFiles). A push that merged an
 * outside pull request on an accounted commit is left to the next batch; any
 * other push gets the full check.
 */
export async function readMainPush(github, repo, { sha, tree, checkFiles }) {
  const repository = `${repo.owner}/${repo.repo}`;
  const pull = await mergedPull(github, repo, sha);
  if (pull && isBatchPull(pull, repository)) return readBatchPull(github, repo, pull, tree, checkFiles);
  if (pull && isOutsidePull(pull, repository) && (await parentAccounted(github, repo, sha)))
    return { kind: "outside", pull: pull.number };
  return { kind: "full" };
}
