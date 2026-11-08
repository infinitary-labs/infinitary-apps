/**
 * The shipped queue's GitHub part (docs/forge.md, "The shipped queue"): it
 * runs the host-neutral rules in rules.mjs inside GitHub Actions, through
 * actions/github-script's client. It reads open pull requests, the
 * infinitary/queue commit status on each version, the queue's own runs and
 * their jobs' logs, and writes statuses, the pause's issue and the queue's
 * next start. It runs with the workflow's own credential, so its writes
 * start no other workflow, and it pushes and merges nothing: each approver's
 * Infinitary merges its own passed changes.
 */
import {
  CONFIRM_JOB,
  confirmPlan,
  conflictsWithMain,
  FIX_LABEL,
  failedTestFiles,
  formBatch,
  headList,
  inBatch,
  PAUSE_LABEL,
  pauseIssue,
  pauseWrites,
  QUEUE,
  readComposition,
  readQueueState,
  resume,
  sendBack,
  verdict,
  WAITING,
} from "./rules.mjs";

/** The queue's workflow file, which its next start names. */
export const WORKFLOW = "infinitary-queue.yml";

const defaultBranch = (context) => context.payload.repository?.default_branch ?? "main";
const runUrl = (context) =>
  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

/** The queue statuses on one version, newest first, in the rules' shape. */
async function queueStatuses(github, repo, ref) {
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    ...repo,
    ref,
    per_page: 100,
  });
  return statuses
    .filter((status) => status.context === QUEUE)
    .map((status) => ({
      state: status.state,
      description: status.description ?? "",
      url: status.target_url ?? "",
      createdAt: status.created_at,
    }));
}

const queueAt = async (github, repo, ref) => readQueueState(await queueStatuses(github, repo, ref));

/** Every open pull request with its version, the branch it targets, whether it is a declared fix, and its queue state. */
export async function readOpenQueue(github, repo) {
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    per_page: 100,
  });
  return Promise.all(
    pulls.map(async (pull) => ({
      number: pull.number,
      head: pull.head.sha,
      base: pull.base.ref,
      fix: (pull.labels ?? []).some((label) => label.name === FIX_LABEL),
      queue: await queueAt(github, repo, pull.head.sha),
    })),
  );
}

/** The queue runs that changes in a batch name, one reading each. */
async function readRuns(github, repo, entries) {
  const ids = [
    ...new Set(
      entries.flatMap((entry) => (entry.queue?.kind === "in-batch" ? [entry.queue.run] : [])),
    ),
  ];
  const runs = new Map();
  for (const id of ids)
    runs.set(id, (await github.rest.actions.getWorkflowRun({ ...repo, run_id: id })).data);
  return runs;
}

/**
 * Each change of a batch run as its verdict reads it: the pull request's
 * current version and the queue state there while it is open, and `swept`,
 * the swept version's state, when it was pushed again since.
 */
async function readCurrent(github, repo, members) {
  const current = new Map();
  for (const member of members) {
    const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: member.number });
    const head = pull.head.sha;
    if (pull.state !== "open") current.set(member.number, { head, queue: null });
    else if (head === member.head)
      current.set(member.number, { head, queue: await queueAt(github, repo, head) });
    else
      current.set(member.number, {
        head,
        queue: await queueAt(github, repo, head),
        swept: await queueAt(github, repo, member.head),
      });
  }
  return current;
}

function writeStatus(github, repo, write) {
  return github.rest.repos.createCommitStatus({
    ...repo,
    sha: write.head,
    state: write.state,
    context: QUEUE,
    description: write.description,
    target_url: write.url,
  });
}

/**
 * Close the pause's open issue, if there is one, saying what ended it. A
 * project that cannot list its issues (Issues turned off) has none to
 * close: its pause is held by the statuses alone, so the answer goes on.
 */
async function closePause(github, repo, words) {
  let issues;
  try {
    issues = await github.paginate(github.rest.issues.listForRepo, {
      ...repo,
      state: "open",
      labels: PAUSE_LABEL,
      per_page: 100,
    });
  } catch {
    return;
  }
  for (const issue of issues) {
    await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body: words });
    await github.rest.issues.update({ ...repo, issue_number: issue.number, state: "closed" });
  }
}

/** Start the queue again, so the next batch forms from what the queue reads then. */
function startForm(github, context) {
  return github.rest.actions.createWorkflowDispatch({
    ...context.repo,
    workflow_id: WORKFLOW,
    ref: defaultBranch(context),
    inputs: { action: "form" },
  });
}

const FAILED = ["failure", "timed_out", "cancelled"];
const inConfirm = (name) => name === CONFIRM_JOB || name.startsWith(`${CONFIRM_JOB} / `);

/**
 * The batch run's failed jobs, its confirm's aside, each with the test
 * files its log names as failed. A log GitHub cannot give names none.
 */
async function readFailedJobs(github, repo, run) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run,
    per_page: 100,
  });
  const failed = [];
  for (const job of jobs) {
    if (!FAILED.includes(job.conclusion) || inConfirm(job.name)) continue;
    let files = [];
    try {
      const { data: log } = await github.rest.actions.downloadJobLogsForWorkflowRun({
        ...repo,
        job_id: job.id,
      });
      files = failedTestFiles(typeof log === "string" ? log : Buffer.from(log).toString("utf8"));
    } catch {
      // A log GitHub cannot give names no file.
    }
    failed.push({ name: job.name, url: job.html_url ?? "", files });
  }
  return failed;
}

/** Each failed test file, with the batch's changes whose diffs touch it. */
async function touchingChanges(github, repo, failedJobs, members) {
  const files = [...new Set(failedJobs.flatMap((job) => job.files))];
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
    touchedBy: members
      .filter((member) => changed.get(member.number).has(file))
      .map((member) => member.number),
  }));
}

/**
 * The form job: read every open change and decide the next batch. When an
 * approved fix ends a pause, the paused changes wait again and the pause's
 * issue closes before the batch composes. Its outputs are the members and
 * their `<number>:<version>` list for the compose step.
 */
export async function form({ github, context, core }) {
  const repo = context.repo;
  const entries = await readOpenQueue(github, repo);
  const plan = formBatch(entries, await readRuns(github, repo, entries), defaultBranch(context));
  core.notice(plan.reason);
  if (plan.resumes.length) {
    for (const member of plan.resumes)
      await writeStatus(github, repo, {
        ...member,
        state: "pending",
        description: WAITING,
        url: runUrl(context),
      });
    const fixes = entries.filter((entry) => entry.fix && entry.queue?.kind === "waiting");
    await closePause(
      github,
      repo,
      `${fixes.map((entry) => `#${entry.number}`).join(", ")} was approved as the fix, so the pause ended and [batch run ${context.runId}](${runUrl(context)}) takes every paused and waiting change.`,
    );
  }
  core.setOutput("members", JSON.stringify(plan.members));
  core.setOutput("heads", headList(plan.members));
}

/**
 * After the compose step: a change that conflicts with the default branch
 * alone goes back to be brought up to date, one that conflicts only with
 * an earlier change here waits for the next batch, and the rest are in this
 * run. Its outputs name what the checks compose, the default branch's
 * version they compose onto (fetched after `form` read the queue, never
 * the job's own checkout) and the batch's tree.
 */
export async function mark({ github, context, core, output, members }) {
  const repo = context.repo;
  const composed = readComposition(output, members);
  core.notice(`The batch composes onto ${defaultBranch(context)} at ${composed.base}.`);
  for (const member of composed.conflictsMain)
    await writeStatus(github, repo, conflictsWithMain(member, runUrl(context)));
  for (const member of composed.merged)
    await writeStatus(github, repo, {
      ...member,
      state: "pending",
      description: inBatch(context.runId),
      url: runUrl(context),
    });
  for (const member of composed.conflictsBatch)
    core.notice(
      `#${member.number} conflicts only with an earlier change here, so it waits for the next batch.`,
    );
  core.setOutput("run", composed.merged.length ? "true" : "false");
  core.setOutput("members", JSON.stringify(composed.merged));
  core.setOutput("heads", headList(composed.merged));
  core.setOutput("base", composed.base);
  core.setOutput("tree", composed.tree);
}

/**
 * After red batch checks: what the confirm runs again on the same batch,
 * as the outputs `jobs` (the failed jobs' names, one a line) and `files`
 * (the failed test files, separated by spaces). Both are empty when a
 * failed job's log named no test file, and then nothing runs again.
 */
export async function failures({ github, context, core }) {
  const plan = confirmPlan(await readFailedJobs(github, context.repo, context.runId));
  core.notice(
    plan
      ? `The batch checks run once more on the same batch for ${plan.jobs.split("\n").join(", ")} (${plan.files}).`
      : "A failed job's log named no failed test file, so nothing runs again and the batch pauses.",
  );
  core.setOutput("jobs", plan?.jobs ?? "");
  core.setOutput("files", plan?.files ?? "");
}

/**
 * The verdict job: green passes every change still in this run, and so
 * does a red batch whose confirm passed (`confirm`, that job's result);
 * otherwise it pauses them behind one new issue that names the failed
 * checks, the failed test files and the paused changes, and blames no
 * change.
 */
export async function decide({ github, context, core, result, members, tree, confirm = "" }) {
  const repo = context.repo;
  const run = context.runId;
  const current = await readCurrent(github, repo, members);
  let failed = [];
  let failedFiles = [];
  if (result !== "success") {
    const failedJobs = await readFailedJobs(github, repo, run);
    failed = failedJobs.map((job) => ({ name: job.name, url: job.url }));
    failedFiles = await touchingChanges(github, repo, failedJobs, members);
  }
  const decided = verdict({
    run,
    runUrl: runUrl(context),
    result,
    tree,
    members,
    current,
    failed,
    failedFiles,
    confirm,
  });
  for (const write of decided.writes) await writeStatus(github, repo, write);
  if (decided.pause) {
    // The paused statuses are the pause itself: they go first, linked to
    // the run, so a failed issue (Issues turned off) still holds the batch.
    for (const write of pauseWrites(decided.pause, runUrl(context)))
      await writeStatus(github, repo, write);
    const issue = pauseIssue(decided.pause, runUrl(context));
    const { data: opened } = await github.rest.issues.create({
      ...repo,
      ...issue,
      labels: [PAUSE_LABEL],
    });
    for (const write of pauseWrites(decided.pause, opened.html_url))
      await writeStatus(github, repo, write);
  }
  if (decided.next === "form") await startForm(github, context);
  await core.summary.addHeading("Batch verdict").addRaw(decided.summary).write();
}

/**
 * A by-hand answer to a pause, from any teammate's Infinitary or the
 * workflow's own page: `resume` turns every paused change back to waiting,
 * and `send-back` fails the named change with the reason first. Both need
 * a reason, close the pause's issue with it and start the next batch.
 */
export async function answer({ github, context, core, action, number, reason }) {
  if (!reason?.trim()) throw new Error("Say why the queue may go on.");
  const repo = context.repo;
  const url = runUrl(context);
  const entries = await readOpenQueue(github, repo);
  let except;
  if (action === "send-back") {
    const wanted = Number(number);
    let entry = entries.find((candidate) => candidate.number === wanted);
    if (!entry) {
      const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: wanted });
      entry = { number: pull.number, head: pull.head.sha };
    }
    await writeStatus(github, repo, sendBack(entry, { reason, url }));
    except = entry.number;
  } else if (action !== "resume") throw new Error(`Unknown answer: ${action}.`);
  const writes = resume(entries, { url, except });
  for (const write of writes) await writeStatus(github, repo, write);
  const what = action === "send-back" ? `#${except} was sent back` : "The queue was resumed";
  await closePause(github, repo, `${what} by hand: ${reason.trim()}`);
  await startForm(github, context);
  core.notice(`${what}; ${writes.length} paused changes wait again.`);
}
