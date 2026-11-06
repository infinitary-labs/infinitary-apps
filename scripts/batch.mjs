/** The swept batch before main (INF-2430 piece 3, docs/testing.md "The swept batch").
 *
 * The batch's whole state is one commit status, infinitary/queue, on each
 * approved pull request's current version. The app writes it pending when
 * the captain's merge click approves that version; batch.yml writes the rest
 * with its own credential, which starts no other workflow:
 *
 *   pending "In batch run N"                 the change is in batch run N
 *   success "Passed batch run N; tree T"     the change may merge
 *   failure "<reason>"                       the change goes back to its pull request
 *
 * Any other pending description is the app's approval mark: the change waits
 * for the next batch. Nothing here reads a person's words; every rule reads
 * these typed states, GitHub's run and job readings, and git trees.
 */

export const QUEUE = "infinitary/queue";
export const WAITING = "Waiting for the batch check";
const IN_BATCH = /^In batch run (\d+)$/;
const PASSED = /^Passed batch run (\d+)(?: after a rerun)?; tree ([0-9a-f]{40})$/;

export const inBatch = (runId) => `In batch run ${runId}`;
export const passed = (runId, tree, rerun) =>
  `Passed batch run ${runId}${rerun ? " after a rerun" : ""}; tree ${tree}`;

/**
 * The change's queue state from its version's statuses, newest first as
 * GitHub lists them. `since` is when the newest unbroken stretch of pending
 * statuses began: the app's approval mark, which orders the batch.
 */
export function readQueueStatus(statuses) {
  const queue = statuses.filter((status) => status.context === QUEUE);
  const [latest] = queue;
  if (!latest) return null;
  let since = latest.created_at;
  if (latest.state === "pending")
    for (const status of queue) {
      if (status.state !== "pending") break;
      since = status.created_at;
    }
  const base = {
    state: latest.state,
    description: latest.description ?? "",
    url: latest.target_url ?? "",
    since,
  };
  const batch = IN_BATCH.exec(base.description);
  const green = PASSED.exec(base.description);
  if (latest.state === "pending" && batch) return { ...base, kind: "in-batch", run: Number(batch[1]) };
  if (latest.state === "pending") return { ...base, kind: "waiting" };
  if (latest.state === "success" && green)
    return { ...base, kind: "passed", run: Number(green[1]), tree: green[2] };
  return { ...base, kind: "failed" };
}

/** The name batch.yml gives a merge batch's verdict job, which carries the tree it swept. */
const VERDICT_JOB = /^Merge batch · Batch verdict \(tree [0-9a-f]{40}\)$/;

const firstAttemptFailed = (run) =>
  run.status === "completed" && run.conclusion === "failure" && run.run_attempt === 1;

/**
 * A batch run still owns its changes while it runs, and after its first
 * attempt failed only while that attempt's verdict job passed: the verdict
 * asked for the one rerun, which has not yet started. A first attempt whose
 * verdict failed, or never ran because an earlier job failed, asked for no
 * rerun, so it owns nothing. Neither does a run whose last attempt ended
 * without writing its verdict. Changes a run does not own join the next batch.
 */
export function ownsChanges(run) {
  if (!run) return false;
  if (run.status !== "completed") return true;
  return firstAttemptFailed(run) && run.verdict?.conclusion === "success";
}

/**
 * What a batch run does now, from every open pull request's queue state and
 * the readings of the batch runs those states name. A batch forms only after
 * the last green batch has fully merged and no run owns a change.
 */
export function formBatch(entries, runs) {
  const queued = entries.filter((entry) => entry.queue);
  const merging = queued.filter((entry) => entry.queue.kind === "passed");
  if (merging.length)
    return {
      action: "wait",
      reason: `A green batch is still merging: ${merging.map((entry) => `#${entry.number}`).join(", ")}.`,
      members: [],
    };
  const owned = queued.filter(
    (entry) => entry.queue.kind === "in-batch" && ownsChanges(runs.get(entry.queue.run)),
  );
  if (owned.length)
    return {
      action: "wait",
      reason: `Batch run ${owned[0].queue.run} is sweeping or waiting for its rerun.`,
      members: [],
    };
  const members = queued
    .filter((entry) => entry.queue.kind === "waiting" || entry.queue.kind === "in-batch")
    .sort((a, b) => a.queue.since.localeCompare(b.queue.since) || a.number - b.number)
    .map((entry) => ({ number: entry.number, head: entry.head }));
  if (!members.length) return { action: "none", reason: "No approved change is waiting.", members };
  return { action: "sweep", reason: `${members.length} approved changes are waiting.`, members };
}

/** The `<number>:<version>` list batch-compose.sh takes, in batch order. */
export const headList = (members) => members.map((member) => `${member.number}:${member.head}`).join(" ");

/**
 * Parses batch-compose.sh's compose output: the tree, and which changes
 * merged, which conflict with main alone, and which conflict only with an
 * earlier change of this batch (they wait for the next one).
 */
export function readComposition(output, members) {
  const lines = output.trim().split("\n");
  const said = (word) =>
    lines.filter((line) => line.startsWith(`${word} `)).map((line) => Number(line.split(" ")[1]));
  const pick = (numbers) => members.filter((member) => numbers.includes(member.number));
  const tree = lines.find((line) => line.startsWith("tree "))?.split(" ")[1] ?? "";
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error("The batch composition reported no tree.");
  return {
    tree,
    merged: pick(said("merged")),
    conflictsMain: pick(said("conflict-main")),
    conflictsBatch: pick(said("conflict-batch")),
  };
}

/**
 * The verdict a batch run writes once its sweep ends. Only changes still in
 * this run at the same version are written: one sent back by hand, or
 * pushed again, keeps what it has. A first failed attempt writes nothing and
 * asks for its one rerun of the failed jobs; a second failure sends the
 * batch's last change back with the failed job's link, and the rest wait for
 * the next batch, which this run starts.
 */
export function verdict({ runId, runUrl, attempt, swept, tree, members, current, failedJob }) {
  const still = members.filter((member) => {
    const queue = current.get(member.number);
    return (
      queue?.head === member.head && queue.queue?.kind === "in-batch" && queue.queue.run === runId
    );
  });
  if (!still.length) return { writes: [], next: "sweep", summary: "No change is still in this batch." };
  if (swept === "success")
    return {
      writes: still.map((member) => ({
        ...member,
        state: "success",
        description: passed(runId, tree, attempt > 1),
        url: runUrl,
      })),
      next: null,
      summary:
        attempt > 1
          ? "The batch passed on its rerun. The jobs that failed first still need an owner who fixes their cause."
          : "The batch passed.",
    };
  if (attempt === 1)
    return {
      writes: [],
      next: "rerun",
      summary: "The sweep failed, so its failed jobs run once more.",
    };
  const last = still.at(-1);
  const job = failedJob ? `${failedJob.name} failed twice` : "The sweep failed twice";
  return {
    writes: [
      {
        ...last,
        state: "failure",
        description: `${job} in batch run ${runId}, the last change in it.`.slice(0, 140),
        url: failedJob?.html_url || runUrl,
      },
      ...still
        .slice(0, -1)
        .map((member) => ({ ...member, state: "pending", description: WAITING, url: runUrl })),
    ],
    next: "sweep",
    summary: `The sweep failed twice, so #${last.number}, the batch's last change, goes back to its pull request.`,
  };
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
export async function readOpenQueue(github, repo) {
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  return Promise.all(
    pulls.map(async (pull) => ({
      number: pull.number,
      head: pull.head.sha,
      queue: readQueueStatus(await statusesOf(github, repo, pull.head.sha)),
    })),
  );
}

/**
 * The batch runs the queue states name, read once each. A run whose first
 * attempt failed also carries that attempt's verdict job, or null when it
 * has none: read from attempt 1 itself, so a rerun that starts meanwhile
 * does not hide it.
 */
export async function readRuns(github, repo, entries) {
  const ids = [...new Set(entries.flatMap((entry) => (entry.queue?.run ? [entry.queue.run] : [])))];
  const runs = new Map();
  for (const id of ids) {
    const { data } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: id });
    if (!firstAttemptFailed(data)) {
      runs.set(id, data);
      continue;
    }
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
      ...repo,
      run_id: id,
      attempt_number: 1,
      per_page: 100,
    });
    runs.set(id, { ...data, verdict: jobs.find((job) => VERDICT_JOB.test(job.name)) ?? null });
  }
  return runs;
}

export function writeStatus(github, repo, write) {
  return github.rest.repos.createCommitStatus({
    ...repo,
    sha: write.head,
    state: write.state,
    context: QUEUE,
    description: write.description,
    target_url: write.url,
  });
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
  return sortMainPush({ tree, queue, open: await readOpenQueue(github, repo) });
}
