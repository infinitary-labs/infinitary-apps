/** The swept batch before main (INF-2430 piece 3, docs/testing.md "The swept batch").
 *
 * The batch's whole state is one commit status, infinitary/queue, on each
 * approved pull request's current version. The app writes it pending when
 * the captain's merge click approves that version; batch.yml writes the rest
 * with its own credential, which starts no other workflow:
 *
 *   pending "In batch run N"                 the change is in batch run N
 *   pending "Paused after batch run N; …"    batch run N failed: the queue waits for a fix
 *   success "Passed batch run N; tree T"     the change may merge
 *   failure "<reason>"                       the change goes back to its pull request
 *
 * Any other pending description is the app's approval mark: the change waits
 * for the next batch. Nothing here reads a person's words; every rule reads
 * these typed states, GitHub's run and job readings, and git trees.
 *
 * A red sweep fixes forward (the captain: "whenever we meet a failure, we
 * pause the sweeps until a fix arrives, then we rerun the sweep with
 * everything queued + the fix"): it pauses every change in it, blames none
 * and reruns nothing, and no batch forms until the fix arrives - an approved
 * pull request its repair labeled FIX_LABEL - or a by-hand resume or
 * send-back turns the paused changes back to waiting and starts the next
 * sweep.
 */

export const QUEUE = "infinitary/queue";
export const WAITING = "Waiting for the batch check";
/** The branch every batch composes onto; a change stacked on another branch waits until it targets this one. */
export const MAIN = "main";
/**
 * The label a paused batch's repair puts on its fix's pull request
 * (docs/testing.md, "A paused batch's repair"): once the fix is approved, it
 * ends the pause, and the next batch sweeps the paused changes with it.
 */
export const FIX_LABEL = "fixes-batch";
const IN_BATCH = /^In batch run (\d+)$/;
const PAUSED = /^Paused after batch run (\d+)(?:;|$)/;
// A pass written before the fix-forward queue may still say "after a rerun".
const PASSED = /^Passed batch run (\d+)(?: after a rerun)?; tree ([0-9a-f]{40})$/;

export const inBatch = (runId) => `In batch run ${runId}`;
export const passed = (runId, tree) => `Passed batch run ${runId}; tree ${tree}`;

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
  const pause = PAUSED.exec(base.description);
  const green = PASSED.exec(base.description);
  if (latest.state === "pending" && batch) return { ...base, kind: "in-batch", run: Number(batch[1]) };
  if (latest.state === "pending" && pause) return { ...base, kind: "paused", run: Number(pause[1]) };
  if (latest.state === "pending") return { ...base, kind: "waiting" };
  if (latest.state === "success" && green)
    return { ...base, kind: "passed", run: Number(green[1]), tree: green[2] };
  return { ...base, kind: "failed" };
}

/**
 * A batch run owns its changes while it runs. A run that ended without
 * writing its verdict, such as one whose compose or verdict job failed,
 * owns nothing, so its changes join the next batch.
 */
export function ownsChanges(run) {
  return Boolean(run) && run.status !== "completed";
}

/**
 * What a batch run does now, from every open pull request's queue state and
 * the readings of the batch runs those states name. A batch forms only after
 * the last green batch has fully merged, while no failed batch has paused the
 * queue and no run owns a change. A pause ends once a fix arrives: a change
 * its repair labeled FIX_LABEL, approved after the paused run started. The
 * batch then takes the paused changes back with `resume`, which tells the
 * caller to write them waiting again first. It takes only changes that
 * target main: a change stacked on another branch waits until its base
 * merges and GitHub points it at main.
 */
export function formBatch(entries, runs) {
  const queued = entries.filter((entry) => entry.queue && entry.base === MAIN);
  const merging = queued.filter((entry) => entry.queue.kind === "passed");
  if (merging.length)
    return {
      action: "wait",
      reason: `A green batch is still merging: ${merging.map((entry) => `#${entry.number}`).join(", ")}.`,
      members: [],
    };
  const paused = queued.filter((entry) => entry.queue.kind === "paused");
  // A fix ends the pause only when approved after the paused run started: one
  // approved before it was in that batch or could not compose there, so it
  // would only start the same sweep again.
  const started = Math.max(
    ...paused.map((entry) => Date.parse(runs.get(entry.queue.run)?.created_at ?? "") || 0),
  );
  const fixes = queued.filter(
    (entry) => entry.queue.kind === "waiting" && entry.fix && Date.parse(entry.queue.since) > started,
  );
  if (paused.length && !fixes.length)
    return {
      action: "wait",
      reason: `Batch run ${paused[0].queue.run} failed, so the queue is paused until a fix labeled ${FIX_LABEL} is approved, or a resume or a send-back by hand.`,
      members: [],
    };
  const owned = queued.filter(
    (entry) => entry.queue.kind === "in-batch" && ownsChanges(runs.get(entry.queue.run)),
  );
  if (owned.length)
    return {
      action: "wait",
      reason: `Batch run ${owned[0].queue.run} is sweeping.`,
      members: [],
    };
  const members = queued
    .filter((entry) => ["waiting", "in-batch", "paused"].includes(entry.queue.kind))
    .sort((a, b) => a.queue.since.localeCompare(b.queue.since) || a.number - b.number)
    .map((entry) => ({ number: entry.number, head: entry.head }));
  if (!members.length) return { action: "none", reason: "No approved change is waiting.", members };
  if (paused.length)
    return {
      action: "sweep",
      resume: true,
      reason: `Fix ${fixes.map((entry) => `#${entry.number}`).join(", ")} is approved, so the changes batch run ${paused[0].queue.run} paused sweep again with it: ${members.length} approved changes.`,
      members,
    };
  return { action: "sweep", reason: `${members.length} approved changes are waiting.`, members };
}

/**
 * The writes that end a pause: every paused change but `except` (the one a
 * send-back names) waits again, keeping its place in approval order, and the
 * caller starts the next batch.
 */
export function resume(entries, { url, except }) {
  return entries
    .filter((entry) => entry.queue?.kind === "paused" && entry.number !== except)
    .map((entry) => ({ number: entry.number, head: entry.head, state: "pending", description: WAITING, url }));
}

/** The `<number>:<version>` list batch-compose.sh takes, in batch order. */
export const headList = (members) => members.map((member) => `${member.number}:${member.head}`).join(" ");

/**
 * The compose job's line for a repair: the commands that compose this batch
 * on any clone, as every sweep job does, from main's version it composed onto.
 */
export const composeLocally = ({ base, tree, members }) =>
  `git checkout --detach ${base} && scripts/batch-compose.sh apply ${tree} ${headList(members)}`;

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
 * pushed again, keeps what it has. A green sweep passes them. A failed sweep
 * that a change was sent back from by hand takes that send-back as its
 * answer, even when the change's author pushed a new version after it: the
 * rest wait for the next batch, which this run starts without the change
 * sent back. Any other failed sweep pauses every change in it, with the
 * failed job's link: it reruns nothing and blames no change. The pause names
 * the first test file the failed jobs' logs report and which changes of the
 * batch touch it (readFailedFiles), as evidence for whoever writes the fix.
 * It starts one more run, which only reads the queue: a fix approved while
 * this sweep ran ends the pause there at once, and otherwise nothing forms.
 */
export function verdict({ runId, runUrl, swept, tree, members, current, failedJob, failedFiles = [] }) {
  // The member's queue state now, while it still names the version this run swept.
  const queueOf = (member) => {
    const now = current.get(member.number);
    return now?.head === member.head ? now.queue : null;
  };
  const still = members.filter((member) => {
    const queue = queueOf(member);
    return queue?.kind === "in-batch" && queue.run === runId;
  });
  if (!still.length) return { writes: [], next: "sweep", summary: "No change is still in this batch." };
  if (swept === "success")
    return {
      writes: still.map((member) => ({
        ...member,
        state: "success",
        description: passed(runId, tree),
        url: runUrl,
      })),
      next: null,
      summary: "The batch passed.",
    };
  // Each member was in this run when it composed, so one whose swept version
  // failed since was sent back by hand while it swept, whether or not its
  // author pushed a new version after that (readCurrent's `swept`).
  const sentBack = members.filter((member) => {
    const now = current.get(member.number);
    return (now?.head === member.head ? now.queue : now?.swept)?.kind === "failed";
  });
  if (sentBack.length) {
    const named = sentBack.map((member) => `#${member.number}`).join(", ");
    return {
      writes: still.map((member) => ({ ...member, state: "pending", description: WAITING, url: runUrl })),
      next: "sweep",
      summary: `The sweep failed and ${named} went back by hand, so the rest wait for a new sweep without ${sentBack.length > 1 ? "them" : "it"}.`,
    };
  }
  const description = pauseReason(runId, failedJob, failedFiles);
  return {
    writes: still.map((member) => ({
      ...member,
      state: "pending",
      description,
      url: failedJob?.html_url || runUrl,
    })),
    next: "sweep",
    summary:
      `The sweep failed, so the queue is paused: these changes and every new approval wait until a fix labeled ${FIX_LABEL} is approved, or a resume or a send-back by hand starts the next sweep.` +
      (failedFiles.length
        ? ` Failed test files: ${failedFiles.map((failed) => `${failed.file} (${touchedBy(failed)})`).join(", ")}.`
        : ""),
  };
}

const touchedBy = ({ touchedBy: numbers }) =>
  numbers.length
    ? `touched by ${numbers.map((number) => `#${number}`).join(", ")}`
    : "no change here touches it";

/** A paused status's description, at most the 140 characters GitHub keeps. */
function pauseReason(runId, failedJob, failedFiles) {
  const [first] = failedFiles;
  const more = failedFiles.length > 1 ? ` (+${failedFiles.length - 1} more)` : "";
  const what = first
    ? `${first.file}${more} failed; ${touchedBy(first)}`
    : `${failedJob ? failedJob.name : "the sweep"} failed`;
  return `Paused after batch run ${runId}; ${what}`.slice(0, 140);
}

// A test file's path as vitest and Playwright print it, from the project's root.
const TEST_FILE = /(?:^|\s)((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=[\s:\[]|$)/;
// GitHub's timestamp before each log line, and a terminal's colors.
const LOG_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const COLORS = /\u001b\[[0-9;]*m/g;

/**
 * The test files a job's log names as failed, in the order it names them:
 * vitest's FAIL lines, and the tests listed under Playwright's closing
 * "N failed" line (its numbered failure list also holds flaky tests, so it
 * is not read).
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
    if (!listed && !/^\s*FAIL\s/.test(line)) continue;
    const file = TEST_FILE.exec(line)?.[1];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * Each test file the failed jobs' logs name as failed, with the batch's
 * changes whose diffs touch it, in batch order. A log GitHub cannot give
 * adds nothing, so the verdict still writes its statuses.
 */
export async function readFailedFiles(github, repo, failedJobs, members) {
  const files = [];
  for (const job of failedJobs) {
    let log;
    try {
      ({ data: log } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: job.id }));
    } catch {
      continue;
    }
    // GitHub serves the log as text; a client that reads it as bytes gets a buffer.
    const text = typeof log === "string" ? log : Buffer.from(log).toString("utf8");
    for (const file of failedTestFiles(text)) if (!files.includes(file)) files.push(file);
  }
  if (!files.length) return [];
  const changed = new Map();
  for (const member of members) {
    const diff = await github.paginate(github.rest.pulls.listFiles, {
      ...repo,
      pull_number: member.number,
      per_page: 100,
    });
    changed.set(
      member.number,
      new Set(diff.flatMap((entry) => [entry.filename, entry.previous_filename].filter(Boolean))),
    );
  }
  return files.map((file) => ({
    file,
    touchedBy: members.filter((member) => changed.get(member.number).has(file)).map((member) => member.number),
  }));
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

/**
 * Each change of a batch run as its verdict reads it: its pull request's
 * current version, and the queue state there while the pull request is
 * open. A change pushed again since the run swept it also carries `swept`,
 * the queue state the swept version was left with, so a send-back made
 * before that push still answers the sweep.
 */
export async function readCurrent(github, repo, members) {
  const queueAt = async (ref) => readQueueStatus(await statusesOf(github, repo, ref));
  const current = new Map();
  for (const member of members) {
    const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: member.number });
    const head = pull.head.sha;
    if (pull.state !== "open") current.set(member.number, { head, queue: null });
    else if (head === member.head) current.set(member.number, { head, queue: await queueAt(head) });
    else current.set(member.number, { head, queue: await queueAt(head), swept: await queueAt(member.head) });
  }
  return current;
}

/**
 * Every open pull request with its current version, the branch it targets,
 * whether it is a paused batch's fix (FIX_LABEL) and its queue state.
 */
export async function readOpenQueue(github, repo) {
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  return Promise.all(
    pulls.map(async (pull) => ({
      number: pull.number,
      head: pull.head.sha,
      base: pull.base.ref,
      fix: (pull.labels ?? []).some((label) => label.name === FIX_LABEL),
      queue: readQueueStatus(await statusesOf(github, repo, pull.head.sha)),
    })),
  );
}

/** The batch runs that changes in or paused after a batch name, one reading each. */
export async function readRuns(github, repo, entries) {
  const named = (entry) => (["in-batch", "paused"].includes(entry.queue?.kind) ? [entry.queue.run] : []);
  const ids = [...new Set(entries.flatMap(named))];
  const runs = new Map();
  for (const id of ids) runs.set(id, (await github.rest.actions.getWorkflowRun({ ...repo, run_id: id })).data);
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
