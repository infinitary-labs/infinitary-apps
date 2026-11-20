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
 */
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { BATCH_PULL_RUN, isBatchPull, isBatchPullRun, sortBatchPull } from "./batch-pull.mjs";

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
 * pushed version's `checkFiles` (readCheckFiles). A push that merged any
 * other pull request, or none, gets the full check.
 */
export async function readMainPush(github, repo, { sha, tree, checkFiles }) {
  const pull = await mergedPull(github, repo, sha);
  if (pull && isBatchPull(pull, `${repo.owner}/${repo.repo}`))
    return readBatchPull(github, repo, pull, tree, checkFiles);
  return { kind: "full" };
}
