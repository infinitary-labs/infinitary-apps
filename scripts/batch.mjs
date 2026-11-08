/** Main's check sorting a push against the swept batch (docs/testing.md,
 * "The swept batch").
 *
 * The shipped queue (.github/workflows/infinitary-queue.yml, generated from
 * src/core/queue/shipped/; docs/forge.md, "The shipped queue") writes each
 * approved change's state as the commit status infinitary/queue. A change
 * whose batch passed reads "Passed batch run N; tree T", and the app merges
 * it. This module reads that state, with the queue's own rules, for
 * main.yml's first job: a push whose files are exactly a green batch's needs
 * no check run again, unless the batch passed only on its confirm, which ran
 * the failed files again and not the whole check: then main's full check
 * runs, and the alpha follows it.
 */
import { CONFIRM_JOB, QUEUE, readQueueState } from "../.github/infinitary/rules.mjs";

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

/**
 * How main's check treats a push (main.yml's first job): covered when its
 * files are exactly a green batch's, so nothing runs again; landing while
 * that batch's other changes are still open and green, so the run ends at
 * once; full otherwise, a merge outside the queue included.
 */
export function sortMainPush({ tree, queue, open }) {
  if (queue?.kind !== "passed") return { kind: "full" };
  if (queue.tree === tree) return { kind: "covered", run: queue.run };
  if (open.some((entry) => entry.queue?.kind === "passed" && entry.queue.run === queue.run))
    return { kind: "landing", run: queue.run };
  return { kind: "full" };
}

const statusesOf = (github, repo, ref) =>
  github.paginate(github.rest.repos.listCommitStatusesForRef, { ...repo, ref, per_page: 100 });

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

/** Whether a batch run passed on its confirm: its confirm's jobs ran. */
async function confirmed(github, repo, run) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run,
    per_page: 100,
  });
  return jobs.some(
    (job) =>
      (job.name === CONFIRM_JOB || job.name.startsWith(`${CONFIRM_JOB} / `)) &&
      job.conclusion !== "skipped",
  );
}

/** main.yml's sort: reads the pushed commit's pull request and its queue state. */
export async function readMainPush(github, repo, { sha, tree }) {
  const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    ...repo,
    commit_sha: sha,
  });
  const pull = pulls.find((candidate) => candidate.merge_commit_sha === sha);
  if (!pull) return { kind: "full" };
  const queue = readQueueStatus(await statusesOf(github, repo, pull.head.sha));
  if (queue?.kind !== "passed") return { kind: "full" };
  const sorted = sortMainPush({ tree, queue, open: await readOpenQueue(github, repo) });
  if (sorted.kind === "covered" && (await confirmed(github, repo, queue.run))) return { kind: "full" };
  return sorted;
}
