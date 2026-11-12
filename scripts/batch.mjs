/** Main's check sorting a push against the swept batch (docs/testing.md,
 * "The swept batch").
 *
 * The shipped queue (.github/workflows/infinitary-queue.yml, generated from
 * src/core/queue/shipped/; docs/forge.md, "The shipped queue") writes each
 * approved change's state as the commit status infinitary/queue. A change
 * whose batch passed reads "Passed batch run N; tree T", and the updated
 * queue merges it itself (older queues leave that merge to the app). This module reads that state, with the queue's own rules, for
 * main.yml's first job: a push whose files are exactly a passed batch's
 * needs no check run again, whether the batch passed in its own run or on
 * its confirm (the captain's pick on INF-3052, "Nothing more: the batch's
 * run and its recheck together passed every test"). Main's own full check
 * runs only for files no batch built.
 *
 * A batch pull request (docs/testing.md, "A batch pull request") is sorted
 * the same way from its own run, which batch-pull-request.yml starts and
 * scripts/batch-pull.mjs reads: its files are covered only when the run
 * passed on exactly them and the batch changed no file its own check is made
 * of.
 */
import { QUEUE, readQueueState } from "../.github/infinitary/rules.mjs";
import { BATCH_PULL_RUN, isBatchPull, isBatchPullRun, sortBatchPull } from "./batch-pull.mjs";

/**
 * The change's queue state from its version's statuses, newest first as
 * GitHub lists them, read by the shipped queue's own rules.
 */
export function readQueueStatus(statuses) {
  return readQueueState(
    statuses
      .filter((status) => status.context === QUEUE)
      .map((status) => ({
        state: status.state,
        description: status.description ?? "",
        url: status.target_url ?? "",
        createdAt: status.created_at,
      })),
  );
}

// The batch checks' last job (infinitary-batch-checks.yml), in the batch's
// own run or its confirm, names the tree it passed and the main version it
// composed onto. A batch run from before the base was named has none.
const PASSED_JOB = /Batch passed \(tree ([0-9a-f]{40,64})(?:; base ([0-9a-f]{40,64}))?\)$/;

/** The main version a passed batch run composed onto, from its jobs, or null when no job names it. */
export function batchBase(jobs) {
  for (const job of jobs) {
    const match = PASSED_JOB.exec(job.name);
    if (match?.[2] && job.conclusion === "success") return match[2];
  }
  return null;
}

/**
 * How main's check treats a push (main.yml's first job), from the pushed
 * files' `tree`, its change's `queue` state, main's newest files `main`,
 * the `open` changes' queue states, and `between`: the queue state of each
 * commit main has between the batch's base and the push, or null when the
 * push does not sit on that base, or undefined when the batch named no base.
 * - covered: the files are exactly a passed batch's, so nothing runs again;
 * - landing: main has reached the batch's files with a later push, or can
 *   still reach them, since every commit since the batch's base is one of
 *   its changes and another is still open and passed: the run ends at once,
 *   and the push with the batch's files is covered;
 * - full otherwise: files no batch built, a merge outside the queue included.
 */
export function sortMainPush({ tree, queue, main, open, between }) {
  if (queue?.kind !== "passed") return { kind: "full" };
  if (queue.tree === tree) return { kind: "covered", run: queue.run };
  const landing = { kind: "landing", run: queue.run };
  if (main === queue.tree) return landing;
  const member = (state) => state?.kind === "passed" && state.run === queue.run;
  if (!open.some((entry) => member(entry.queue))) return { kind: "full" };
  if (between === undefined || between?.every(member)) return landing;
  return { kind: "full" };
}

const statusesOf = (github, repo, ref) =>
  github.paginate(github.rest.repos.listCommitStatusesForRef, { ...repo, ref, per_page: 100 });

/** The pull request a commit merged, or undefined when it merged none. */
async function mergedPull(github, repo, sha) {
  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    ...repo,
    commit_sha: sha,
  });
  return pulls.find((candidate) => candidate.merge_commit_sha === sha);
}

/** A commit's queue state: that of the pull request it merged, or null when it merged none. */
async function commitQueue(github, repo, sha) {
  const pull = await mergedPull(github, repo, sha);
  return pull ? readQueueStatus(await statusesOf(github, repo, pull.head.sha)) : null;
}

/** A merged batch pull request's sort: its own runs on its version, their latest jobs, and the files it changed. */
async function readBatchPull(github, repo, pull, tree) {
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
  return sortBatchPull({ tree, runs, files, total: whole.changed_files });
}

/** Every open pull request with its current version and queue state. */
async function readOpenQueue(github, repo) {
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  return Promise.all(
    pulls.map(async (pull) => ({
      number: pull.number,
      head: pull.head.sha,
      queue: readQueueStatus(await statusesOf(github, repo, pull.head.sha)),
    })),
  );
}

/** The queue state of each commit from the batch run's base to the push, or null off that base. */
async function readBetween(github, repo, run, sha) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run,
    per_page: 100,
  });
  const base = batchBase(jobs);
  if (!base) return undefined;
  const { data: compared } = await github.rest.repos.compareCommits({
    ...repo,
    base,
    head: sha,
    per_page: 100,
  });
  if (!["ahead", "identical"].includes(compared.status) || compared.total_commits > compared.commits.length)
    return null;
  return Promise.all(compared.commits.map((commit) => commitQueue(github, repo, commit.sha)));
}

/** main.yml's sort: reads the pushed commit's pull request, its queue state or its own batch run, and main's newest files. */
export async function readMainPush(github, repo, { sha, tree }) {
  const pull = await mergedPull(github, repo, sha);
  if (pull && isBatchPull(pull, `${repo.owner}/${repo.repo}`)) return readBatchPull(github, repo, pull, tree);
  const queue = pull ? readQueueStatus(await statusesOf(github, repo, pull.head.sha)) : null;
  if (queue?.kind !== "passed") return { kind: "full" };
  if (queue.tree === tree) return { kind: "covered", run: queue.run };
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: "main" });
  const main = branch.commit.commit.tree.sha;
  const open = await readOpenQueue(github, repo);
  const between = main === queue.tree ? [] : await readBetween(github, repo, queue.run, sha);
  return sortMainPush({ tree, queue, main, open, between });
}
