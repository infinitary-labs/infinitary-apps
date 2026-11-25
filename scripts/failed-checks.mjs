/**
 * The failed-check note (docs/public-ci.md, "Outside contributors"). When a
 * check workflow finishes a run for an outside pull request, this tells its
 * author which checks failed, so the pull request goes back to them before
 * any review starts:
 *
 * - it reads every job of that version's runs of WORKFLOWS and keeps the
 *   failed ones;
 * - it leaves out a job whose check also failed in main's newest finished
 *   run of main.yml, since the contributor did not break it;
 * - it writes one comment per version, naming each failed job with a link to
 *   its log, and edits that comment when a later workflow of the same
 *   version finishes, so a version never gets two;
 * - the first comment of a version labels the pull request "waiting on
 *   author"; the author's next push takes the label off once the required
 *   checks pass (scripts/intake-labels.mjs).
 *
 * Started by hand with a pull request number it is a dry run: it reads the
 * pull request's newest version, writes what it would say to the job
 * summary, and writes nothing on the pull request.
 *
 * The workflow that runs it (failed-checks.yml) starts on workflow_run, so it
 * runs from the default branch, checks out only this project's own scripts,
 * never the pull request's code, and reads job results from GitHub as data.
 * Job names come from the pull request's own workflow files, so the comment
 * writes them only as inert code spans.
 */

import { asCode } from "./check-file-flag.mjs";
import { splitLevel } from "./ci-job-names.mjs";
import { WAITING } from "./intake-labels.mjs";

/** The workflows whose runs on an outside pull request this reads, by their `name:`. */
export const WORKFLOWS = Object.freeze(["ci", "contributors", "docs-site"]);
/** The account the workflow's token writes as, the only author of the note. */
const BOT = "github-actions[bot]";
const FAILED = new Set(["failure", "timed_out"]);
const markFor = (sha) => `<!-- failed-checks sha=${sha} -->`;

/** Whether a job finished failed. */
export const failed = (job) => job.status === "completed" && FAILED.has(job.conclusion);

/**
 * The check a job runs, with what started it taken off: the innermost level
 * of GitHub's full name without its trigger, so the contributor's
 * `Pull request · Contributor's desktop checks / Pull request · Linux journeys`
 * and main's `Main push · Desktop checks / Main push · Linux journeys` are the
 * same check (scripts/ci-job-names.mjs).
 */
export function checkOf(name) {
  const level = String(name).split(" / ").at(-1) ?? "";
  return splitLevel(level)?.purpose ?? level;
}

/** Splits failed jobs into those to name and those whose check also failed on main. */
export function leaveOutMain(jobs, mainJobs) {
  const broken = new Set(mainJobs.filter(failed).map((job) => checkOf(job.name)));
  return {
    named: jobs.filter((job) => !broken.has(checkOf(job.name))),
    onMain: jobs.filter((job) => broken.has(checkOf(job.name))),
  };
}

/**
 * The note for one version. Each job's log link is built from GitHub's
 * numeric ids alone, never from text the pull request chose.
 */
export function failedComment({ server, owner, repo, sha, jobs, onMain = [] }) {
  const log = (job) =>
    `${server}/${owner}/${repo}/actions/runs/${Number(job.run_id)}/job/${Number(job.id)}`;
  return [
    markFor(sha),
    "_Posted automatically by this project's GitHub workflow when a check finishes on a pull request._",
    "",
    `These checks failed on this pull request's version ${sha.slice(0, 7)}, so it is labeled \`${WAITING}\`:`,
    "",
    ...jobs.map((job) => `- ${asCode(job.name)}: [log](${log(job)})`),
    ...(onMain.length > 0
      ? [
          "",
          "These checks failed too, but also fail on `main` right now, so they are not this pull request's to fix:",
          "",
          ...onMain.map((job) => `- ${asCode(job.name)}`),
        ]
      : []),
    "",
    "Push a fix to this pull request; its checks run again once a maintainer approves the run, and the label comes off once the required checks pass.",
  ].join("\n");
}

/** The latest attempt's jobs of each run. */
async function jobsOf(github, owner, repo, runs) {
  const lists = await Promise.all(
    runs.map((run) =>
      github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner,
        repo,
        run_id: run.id,
        filter: "latest",
        per_page: 100,
      }),
    ),
  );
  return lists.flat();
}

/** The failed jobs of one version's runs of WORKFLOWS, newest run of each workflow. */
async function failedJobsAt(github, owner, repo, sha) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    head_sha: sha,
    event: "pull_request",
    per_page: 100,
  });
  // GitHub lists runs newest first; a rerun keeps its run and adds an attempt.
  const newest = new Map();
  for (const run of runs) if (WORKFLOWS.includes(run.name) && !newest.has(run.name)) newest.set(run.name, run);
  return (await jobsOf(github, owner, repo, [...newest.values()])).filter(failed);
}

/** The jobs of main's newest finished run of main.yml; none when main has no finished run. */
async function mainJobs(github, owner, repo) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "main.yml",
    branch: "main",
    status: "completed",
    per_page: 1,
  });
  const run = data.workflow_runs?.[0];
  return run ? jobsOf(github, owner, repo, [run]) : [];
}

/**
 * Runs the note for one event, through actions/github-script's `github`
 * client and `context`. A hand-started run names its pull request in
 * `pullNumber` and writes nothing on it.
 */
export async function noteFailedChecks({ github, context, core, pullNumber }) {
  const { owner, repo } = context.repo;
  const project = `${owner}/${repo}`;
  const dryRun = context.eventName === "workflow_dispatch";
  let pull;
  let sha;
  if (dryRun) {
    const number = Number(pullNumber);
    if (!Number.isInteger(number) || number <= 0) {
      core.setFailed(`No pull request number: ${JSON.stringify(pullNumber ?? null)}`);
      return "no pull request";
    }
    pull = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data;
    sha = pull.head.sha;
  } else {
    const run = context.payload.workflow_run;
    if (run?.event !== "pull_request") return "not a pull request";
    if (run.head_repository?.full_name === project) return "own branch";
    if (!FAILED.has(run.conclusion)) return "passed";
    sha = run.head_sha;
    // GitHub leaves workflow_run.pull_requests empty for a pull request from
    // another copy of the project, so the open pull request at this version
    // is found by its head. None means a newer push replaced this version,
    // or the pull request closed.
    const open = await github.paginate(github.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    pull = open.find((each) => each.head.sha === sha && each.head.repo?.full_name !== project);
    if (!pull) return "no open pull request at this version";
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    core.setFailed(`Not a commit id: ${JSON.stringify(sha)}`);
    return "no version";
  }

  const jobs = await failedJobsAt(github, owner, repo, sha);
  if (jobs.length === 0) return "no failed checks";
  const { named, onMain } = leaveOutMain(jobs, await mainJobs(github, owner, repo));
  if (named.length === 0) {
    const left = onMain.map((job) => `- ${asCode(job.name)}`).join("\n");
    core.summary.addRaw(`#${pull.number}: every failed check also fails on main.\n\n${left}\n`);
    await core.summary.write();
    return "every failed check also fails on main";
  }
  const server = context.serverUrl ?? "https://github.com";
  const body = failedComment({ server, owner, repo, sha, jobs: named, onMain });

  if (dryRun) {
    core.summary.addRaw(`Dry run on #${pull.number}; nothing was written.\n\n${body}\n`);
    await core.summary.write();
    return `would name ${named.length}`;
  }
  const mark = markFor(sha);
  const comment = (
    await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pull.number,
      per_page: 100,
    })
  ).find((each) => each.user?.login === BOT && each.body?.startsWith(mark));
  if (comment?.body === body) return "already named";
  if (comment) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
    return `named ${named.length} again`;
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body });
  if (!(pull.labels ?? []).some((label) => label.name === WAITING))
    await github.rest.issues.addLabels({ owner, repo, issue_number: pull.number, labels: [WAITING] });
  core.summary.addRaw(`#${pull.number}:\n\n${body.slice(mark.length + 1)}\n`);
  await core.summary.write();
  return `named ${named.length}`;
}
