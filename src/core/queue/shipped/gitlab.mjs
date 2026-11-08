/**
 * The shipped queue's GitLab part (docs/forge.md in Infinitary, "The
 * shipped queue on GitLab"): it runs the host-neutral rules in rules.mjs
 * in GitLab CI, through GitLab's REST API. It reads open merge requests,
 * the infinitary/queue commit status on each version, the queue's own
 * pipelines and their jobs' logs, and writes statuses, the pause's issue
 * and the queue's next pipeline. Its jobs write with the project access
 * token Infinitary stores in the project's CI settings, which only the
 * queue's own jobs receive; it pushes and merges nothing: each approver's
 * Infinitary merges its own passed changes.
 *
 * Two GitLab facts shape it:
 * - GitLab keeps one unfinished commit status per name and person, and
 *   refuses to set one that is waiting to waiting again, while the queue's
 *   waiting, in-batch and paused states are all still waiting. So the part
 *   writes those three as finished `skipped` statuses carrying the queue's
 *   words, each one a new status, and reads `skipped` back as waiting: the
 *   words, not GitLab's state, say which. A passed change is `success` and
 *   one sent back `failed`.
 * - A new project on gitlab.com refuses pipeline variables, so nothing tells
 *   a pipeline it is the queue's but how it started: the queue's jobs run
 *   only in a pipeline the API started on the default branch. A resume or a
 *   send-back runs in Infinitary with the person's own sign-in (`answer`),
 *   and then starts such a pipeline.
 *
 * The rules name changes `#N`; GitLab names a merge request `!N`, so every
 * word this part writes names them its way (`named`).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
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

/** The queue's job that runs the batch's checks as a child pipeline. */
export const CHECKS_JOB = "infinitary-queue-checks";
/** The CI variable holding the project access token the queue's jobs write with. */
export const TOKEN_VARIABLE = "INFINITARY_QUEUE_TOKEN";
/** The environment the queue's jobs name, the one scope the token's variable reaches. */
export const QUEUE_ENVIRONMENT = "infinitary-queue";
/** The child pipeline the form job writes for the checks job to run. */
export const BATCH_PIPELINE_FILE = "infinitary-batch.yml";
/** The form job's outputs, which the verdict job reads. */
export const OUTPUT_FILE = "infinitary-queue.env";

/** A pipeline's states once it has ended: a run in any other state still owns its changes. */
const ENDED = new Set(["success", "failed", "canceled", "skipped", "manual"]);

/** Words the rules wrote, with each change named the way GitLab names a merge request. */
export const named = (text) => text.replace(/(^|[\s(,:;])#(\d+)\b/g, "$1!$2");

/** A GitLab commit status's state for a rules state (see the header). */
export function gitlabState(state) {
  if (state === "success") return "success";
  if (state === "pending") return "skipped";
  return "failed";
}

/** A rules state for a GitLab commit status's state: `skipped` is the queue's waiting. */
export function rulesState(status) {
  if (status === "success") return "success";
  if (status === "failed") return "failure";
  if (status === "canceled") return "error";
  return "pending";
}

const project = (env) => `/projects/${encodeURIComponent(env.project)}`;

/** The queue statuses on one version, newest first, in the rules' shape. */
async function queueStatuses(api, env, sha) {
  const statuses = await api.list(
    `${project(env)}/repository/commits/${encodeURIComponent(sha)}/statuses?name=${encodeURIComponent(QUEUE)}&all=true&per_page=100`,
  );
  return statuses
    .filter((status) => status.name === QUEUE)
    .sort((a, b) => b.id - a.id)
    .map((status) => ({
      state: rulesState(status.status),
      description: status.description ?? "",
      url: status.target_url ?? "",
      createdAt: status.created_at,
    }));
}

const queueAt = async (api, env, sha) => readQueueState(await queueStatuses(api, env, sha));

/** Every open merge request with its version, the branch it targets, whether it is a declared fix, and its queue state. */
export async function readOpenQueue(api, env) {
  const requests = await api.list(`${project(env)}/merge_requests?state=opened&per_page=100`);
  const open = requests.filter((request) => request.sha);
  return Promise.all(
    open.map(async (request) => ({
      number: request.iid,
      head: request.sha,
      base: request.target_branch,
      fix: (request.labels ?? []).some((label) => (label?.name ?? label) === FIX_LABEL),
      queue: await queueAt(api, env, request.sha),
    })),
  );
}

/** GitLab's Maintainer role, the least that may let a change's code into a batch. */
const MAINTAINER = 40;

/**
 * A held change's waiting words: a Developer opened its stretch, which a
 * later mark lays over without reopening, so only a Maintainer's approval
 * after its last push admits it, and the next click on it starts the queue
 * again.
 */
export const HELD = "Waiting for a Maintainer to approve this version";

/** GitLab's own words on a merge request's system note when someone approves it. */
const APPROVED_NOTE = "approved this merge request";

/**
 * The open changes a batch may take: a change in the queue at all -
 * waiting, in a batch or paused - counts only when a Maintainer opened its
 * stretch there, the first queue status on its version since the last
 * verdict, or approved the merge request at that version. The batch runs on
 * the protected default branch, where every job receives the project's
 * protected variables, and anyone who may push may write a commit status:
 * so no status a Developer wrote, nor a later one laid over it, admits
 * code, and an approval GitLab kept across a push admits only the version
 * it saw. A change left out keeps its status, and the form job says why.
 */
async function admitted(api, env, entries, log) {
  const levels = new Map();
  const level = (id) => {
    if (id === undefined || id === null) return Promise.resolve(0);
    if (!levels.has(id))
      levels.set(
        id,
        api.get(`${project(env)}/members/all/${id}`).then(
          (member) => member?.access_level ?? 0,
          (error) => {
            if (error?.status === 404) return 0;
            throw error;
          },
        ),
      );
    return levels.get(id);
  };
  const opener = async (statuses) => {
    let first;
    for (const status of statuses) {
      if (rulesState(status.status) !== "pending") break;
      first = status;
    }
    return (await level(first?.author?.id)) >= MAINTAINER;
  };
  const approvedAtHead = async (entry) => {
    const pushed = (await api.list(`${project(env)}/merge_requests/${entry.number}/versions`))
      .filter((version) => version.head_commit_sha === entry.head)
      .map((version) => Date.parse(version.created_at))
      .filter(Number.isFinite);
    if (!pushed.length) return false;
    const since = Math.max(...pushed);
    const approvals = await api.get(`${project(env)}/merge_requests/${entry.number}/approvals`);
    const current = new Set((approvals?.approved_by ?? []).map((by) => by?.user?.id));
    const notes = await api.list(
      `${project(env)}/merge_requests/${entry.number}/notes?sort=asc&order_by=created_at&per_page=100`,
    );
    for (const note of notes) {
      if (!note.system || note.body !== APPROVED_NOTE) continue;
      if (!current.has(note.author?.id) || Date.parse(note.created_at) < since) continue;
      if ((await level(note.author.id)) >= MAINTAINER) return true;
    }
    return false;
  };
  const kept = [];
  for (const entry of entries) {
    if (entry.queue?.state !== "pending") {
      kept.push(entry);
      continue;
    }
    const statuses = (
      await api.list(
        `${project(env)}/repository/commits/${encodeURIComponent(entry.head)}/statuses?name=${encodeURIComponent(QUEUE)}&all=true&per_page=100`,
      )
    )
      .filter((status) => status.name === QUEUE)
      .sort((a, b) => b.id - a.id);
    if ((await opener(statuses)) || (await approvedAtHead(entry).catch(() => false))) {
      kept.push(entry);
      continue;
    }
    log(`!${entry.number}: ${HELD}`);
    // The change's own status says why it waits, once: its page and every
    // teammate's Infinitary read it there, not only this job's log.
    if (statuses[0]?.description !== HELD)
      await writeStatus(api, env, {
        head: entry.head,
        state: "pending",
        description: HELD,
        url: env.pipelineUrl,
      });
  }
  return kept;
}

/** The queue pipelines that changes in a batch name, one reading each. */
async function readRuns(api, env, entries) {
  const ids = [
    ...new Set(
      entries.flatMap((entry) => (entry.queue?.kind === "in-batch" ? [entry.queue.run] : [])),
    ),
  ];
  const runs = new Map();
  for (const id of ids) {
    const pipeline = await api.get(`${project(env)}/pipelines/${id}`);
    runs.set(id, {
      id,
      status: ENDED.has(pipeline.status) ? "completed" : "in_progress",
      conclusion: pipeline.status,
    });
  }
  return runs;
}

/**
 * Each change of a batch run as its verdict reads it: the merge request's
 * current version and the queue state there while it is open, and `swept`,
 * the swept version's state, when it was pushed again since.
 */
async function readCurrent(api, env, members) {
  const current = new Map();
  for (const member of members) {
    const request = await api.get(`${project(env)}/merge_requests/${member.number}`);
    const head = request.sha;
    const open = request.state === "opened" || request.state === "locked";
    if (!open) current.set(member.number, { head, queue: null });
    else if (head === member.head)
      current.set(member.number, { head, queue: await queueAt(api, env, head) });
    else
      current.set(member.number, {
        head,
        queue: await queueAt(api, env, head),
        swept: await queueAt(api, env, member.head),
      });
  }
  return current;
}

function writeStatus(api, env, write) {
  return api.send("POST", `${project(env)}/statuses/${encodeURIComponent(write.head)}`, {
    state: gitlabState(write.state),
    name: QUEUE,
    description: named(write.description),
    ...(write.url ? { target_url: write.url } : {}),
  });
}

/**
 * Close the pause's open issue, if there is one, saying what ended it. A
 * project that cannot list its issues (Issues turned off) has none to
 * close: its pause is held by the statuses alone, so the answer goes on.
 */
async function closePause(api, env, words) {
  let issues;
  try {
    issues = await api.list(
      `${project(env)}/issues?state=opened&labels=${encodeURIComponent(PAUSE_LABEL)}&per_page=100`,
    );
  } catch {
    return;
  }
  for (const issue of issues) {
    await api.send("POST", `${project(env)}/issues/${issue.iid}/notes`, { body: named(words) });
    await api.send("PUT", `${project(env)}/issues/${issue.iid}`, { state_event: "close" });
  }
}

/** Start the queue again: a pipeline on the default branch, which the queue's jobs run in. */
export function startForm(api, env) {
  return api.send("POST", `${project(env)}/pipeline`, { ref: env.defaultBranch });
}

/** The changes a batch's `<number>:<version>` list names, in order. */
export function readHeads(heads) {
  return (heads ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const [number, head] = pair.split(":");
      if (!/^\d+$/.test(number ?? "") || !/^[0-9a-f]{40,64}$/.test(head ?? ""))
        throw new Error(`Not a batch member: ${pair}`);
      return { number: Number(number), head };
    });
}

/** The child pipeline that runs the project's batch checks on the composed batch. */
export function batchPipeline({ heads, base, tree }) {
  return [
    "# Written by the Infinitary queue's form job: the project's batch checks on one composed batch.",
    "include:",
    "  - local: .gitlab/infinitary-batch.yml",
    "  - local: .gitlab/infinitary-batch-checks.yml",
    "variables:",
    `  INFINITARY_BATCH: "${heads}"`,
    `  INFINITARY_BASE: "${base}"`,
    `  INFINITARY_TREE: "${tree}"`,
    "",
  ].join("\n");
}

/** The child pipeline when no batch formed: one job that says why, so the checks job has something to run. */
export function noBatchPipeline(reason) {
  return [
    "# Written by the Infinitary queue's form job: no batch formed.",
    "infinitary-no-batch:",
    "  script:",
    // The whole command is one double-quoted YAML string, so a reason with
    // `: ` or ` #` stays words, never a mapping or a comment.
    `    - ${JSON.stringify(`echo ${JSON.stringify(reason.replace(/[^\w .,:;!#()'-]/g, ""))}`)}`,
    "",
  ].join("\n");
}

/**
 * The form job: read every open change and decide the next batch. When an
 * approved fix ends a pause, the paused changes wait again and the pause's
 * issue closes before the batch composes. Then the batch composes
 * (`compose`, the compose step's output for a `<number>:<version>` list): a
 * change that conflicts with the default branch alone goes back to be
 * brought up to date, one that conflicts only with an earlier change here
 * waits for the next batch, and the rest are in this pipeline's run.
 * Answers what the checks compose and the batch's tree; `run` is false when
 * no batch formed.
 */
export async function form({ api, env, log, compose }) {
  const entries = await admitted(api, env, await readOpenQueue(api, env), log);
  const plan = formBatch(entries, await readRuns(api, env, entries), env.defaultBranch);
  log(named(plan.reason));
  if (plan.resumes.length) {
    for (const member of plan.resumes)
      await writeStatus(api, env, {
        ...member,
        state: "pending",
        description: WAITING,
        url: env.pipelineUrl,
      });
    const fixes = entries.filter((entry) => entry.fix && entry.queue?.kind === "waiting");
    await closePause(
      api,
      env,
      `${fixes.map((entry) => `#${entry.number}`).join(", ")} was approved as the fix, so the pause ended and [batch run ${env.pipelineId}](${env.pipelineUrl}) takes every paused and waiting change.`,
    );
  }
  if (!plan.members.length) return { run: false, reason: plan.reason, members: [], tree: "" };
  const composed = readComposition(await compose(plan.members), plan.members);
  for (const member of composed.conflictsMain)
    await writeStatus(api, env, conflictsWithMain(member, env.pipelineUrl));
  for (const member of composed.merged)
    await writeStatus(api, env, {
      ...member,
      state: "pending",
      description: inBatch(env.pipelineId),
      url: env.pipelineUrl,
    });
  for (const member of composed.conflictsBatch)
    log(
      `!${member.number} conflicts only with an earlier change here, so it waits for the next batch.`,
    );
  return {
    run: composed.merged.length > 0,
    reason: composed.merged.length ? plan.reason : "Every change in the batch conflicted.",
    members: composed.merged,
    tree: composed.tree,
  };
}

/** The checks job's child pipeline, from this pipeline's bridges: its id and state, or null when it never started. */
async function checksPipeline(api, env) {
  const bridges = await api.list(
    `${project(env)}/pipelines/${env.pipelineId}/bridges?per_page=100`,
  );
  return bridges.find((bridge) => bridge.name === CHECKS_JOB)?.downstream_pipeline ?? null;
}

/** The files a merge request changes, old and new paths both. */
async function changedFiles(api, env, number) {
  let diffs;
  try {
    diffs = await api.list(`${project(env)}/merge_requests/${number}/diffs?per_page=100`);
  } catch {
    // A server older than the diffs list answers its changes read.
    diffs = (await api.get(`${project(env)}/merge_requests/${number}/changes`)).changes ?? [];
  }
  return new Set(diffs.flatMap((diff) => [diff.new_path, diff.old_path].filter(Boolean)));
}

/**
 * Each test file the failed jobs' logs name as failed, with the batch's
 * changes whose diffs touch it. A log GitLab cannot give adds nothing.
 */
async function readFailedFiles(api, env, failedJobs, members) {
  const files = [];
  for (const job of failedJobs) {
    let log;
    try {
      log = await api.text(`${project(env)}/jobs/${job.id}/trace`);
    } catch {
      continue;
    }
    for (const file of failedTestFiles(log)) if (!files.includes(file)) files.push(file);
  }
  if (!files.length) return [];
  const changed = new Map();
  for (const member of members)
    changed.set(member.number, await changedFiles(api, env, member.number));
  return files.map((file) => ({
    file,
    touchedBy: members
      .filter((member) => changed.get(member.number).has(file))
      .map((member) => member.number),
  }));
}

/**
 * The verdict job: green passes every change still in this run; red
 * pauses them behind one new issue that names the failed checks, the
 * failed test files and the paused changes. It reruns nothing and blames
 * no change.
 */
export async function decide({ api, env, log, members, tree }) {
  const run = env.pipelineId;
  const checks = await checksPipeline(api, env);
  const result = checks?.status === "success" ? "success" : "failure";
  const current = await readCurrent(api, env, members);
  let failed = [];
  let failedFiles = [];
  if (result !== "success") {
    const jobs = checks
      ? await api.list(`${project(env)}/pipelines/${checks.id}/jobs?scope[]=failed&per_page=100`)
      : [];
    const failedJobs = jobs.filter((job) => job.status === "failed" && !job.allow_failure);
    failed = failedJobs.length
      ? failedJobs.map((job) => ({ name: job.name, url: job.web_url ?? "" }))
      : [{ name: CHECKS_JOB, url: checks?.web_url ?? env.pipelineUrl }];
    failedFiles = await readFailedFiles(api, env, failedJobs, members);
  }
  const decided = verdict({
    run,
    runUrl: env.pipelineUrl,
    result,
    tree,
    members,
    current,
    failed,
    failedFiles,
  });
  for (const write of decided.writes) await writeStatus(api, env, write);
  if (decided.pause) {
    // The paused statuses are the pause itself: they go first, linked to
    // the run, so a failed issue (Issues turned off) still holds the batch.
    for (const write of pauseWrites(decided.pause, env.pipelineUrl))
      await writeStatus(api, env, write);
    const issue = pauseIssue(decided.pause, env.pipelineUrl);
    // This part runs no confirm yet, so its issue's opening says only that
    // the batch paused and nothing ran again, never why no confirm ran.
    const [, ...rest] = issue.body.split("\n\n");
    const body = [
      `Batch run ${run} failed, so the queue paused. No change is blamed and nothing runs again.`,
      ...rest,
    ].join("\n\n");
    const opened = await api.send("POST", `${project(env)}/issues`, {
      title: named(issue.title),
      description: named(body),
      labels: PAUSE_LABEL,
    });
    for (const write of pauseWrites(decided.pause, opened.web_url))
      await writeStatus(api, env, write);
  }
  if (decided.next === "form") await startForm(api, env);
  log(named(decided.summary));
  return decided;
}

/**
 * A by-hand answer to a pause, from any teammate's Infinitary with that
 * person's own sign-in: `resume` turns every paused change back to waiting,
 * and `send-back` fails the named change with the reason first. Both need a
 * reason, close the pause's issue with it and start the next batch.
 */
export async function answer({ api, env, log, action, number, reason }) {
  if (!reason?.trim()) throw new Error("Say why the queue may go on.");
  const url = env.pipelineUrl;
  const entries = await readOpenQueue(api, env);
  let except;
  if (action === "send-back") {
    const wanted = Number(number);
    let entry = entries.find((candidate) => candidate.number === wanted);
    if (!entry) {
      const request = await api.get(`${project(env)}/merge_requests/${wanted}`);
      entry = { number: request.iid, head: request.sha };
    }
    await writeStatus(api, env, sendBack(entry, { reason, url }));
    except = entry.number;
  } else if (action !== "resume") throw new Error(`Unknown answer: ${action}.`);
  const writes = resume(entries, { url, except });
  for (const write of writes) await writeStatus(api, env, write);
  const what = action === "send-back" ? `#${except} was sent back` : "The queue was resumed";
  await closePause(api, env, `${what} by hand: ${reason.trim()}`);
  await startForm(api, env);
  log(named(`${what}; ${writes.length} paused changes wait again.`));
}

/**
 * GitLab's REST API as the queue's jobs reach it, with the token the
 * project keeps for the queue. `list` follows GitLab's next-page header.
 */
export function gitlabApi({ url, token, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${url}${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`GitLab answered ${response.status} to ${method} ${path}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };
  return {
    get: async (path) => (await call("GET", path)).json(),
    text: async (path) => (await call("GET", path)).text(),
    send: async (method, path, body) => {
      const response = await call(method, path, body);
      return response.status === 204 ? null : response.json();
    },
    list: async (path) => {
      const rows = [];
      let page = "1";
      while (page) {
        const response = await call("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}`);
        rows.push(...(await response.json()));
        page = response.headers.get("x-next-page") ?? "";
      }
      return rows;
    },
  };
}

/** The queue's pipeline as its CI variables describe it. */
function ciEnv(vars) {
  return {
    project: vars.CI_PROJECT_ID,
    defaultBranch: vars.CI_DEFAULT_BRANCH,
    pipelineId: Number(vars.CI_PIPELINE_ID),
    pipelineUrl: vars.CI_PIPELINE_URL,
  };
}

/** Each member's merge request head, fetched so the compose step can merge it, then the compose step's output. */
function composeInCi(members) {
  for (const member of members)
    try {
      execFileSync(
        "git",
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/merge-requests/${member.number}/head:refs/infinitary/${member.number}`,
        ],
        { stdio: "inherit" },
      );
    } catch {
      // compose.sh fetches the version itself when the ref is not there.
    }
  return execFileSync(
    "bash",
    [".gitlab/infinitary/compose.sh", "compose", ...headList(members).split(" ")],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

/**
 * A queue job's entry point: `form` writes the checks job's child pipeline
 * and the outputs the verdict job reads; `decide` reads them back.
 */
export async function run(command, vars = process.env) {
  const token = vars[TOKEN_VARIABLE];
  if (!token)
    throw new Error(
      `The queue's token is missing: Infinitary stores it as ${TOKEN_VARIABLE} for the ${QUEUE_ENVIRONMENT} environment on a protected default branch. Create it from Infinitary's Settings, Projects.`,
    );
  const api = gitlabApi({ url: vars.CI_API_V4_URL, token });
  const env = ciEnv(vars);
  const log = (text) => console.log(text);
  if (command === "form") {
    const formed = await form({ api, env, log, compose: composeInCi });
    const heads = headList(formed.members);
    writeFileSync(
      BATCH_PIPELINE_FILE,
      formed.run
        ? batchPipeline({ heads, base: vars.CI_COMMIT_SHA, tree: formed.tree })
        : noBatchPipeline(formed.reason),
    );
    writeFileSync(
      OUTPUT_FILE,
      `INFINITARY_QUEUE_RUN=${formed.run}\nINFINITARY_QUEUE_MEMBERS=${heads}\nINFINITARY_QUEUE_TREE=${formed.tree}\n`,
    );
    return;
  }
  if (command === "decide") {
    if (vars.INFINITARY_QUEUE_RUN !== "true") {
      log("No batch ran in this pipeline.");
      return;
    }
    await decide({
      api,
      env,
      log,
      members: readHeads(vars.INFINITARY_QUEUE_MEMBERS),
      tree: vars.INFINITARY_QUEUE_TREE ?? "",
    });
    return;
  }
  throw new Error(`Unknown queue job: ${command}.`);
}

// A queue job runs this file with its command: `node gitlab.mjs form`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
