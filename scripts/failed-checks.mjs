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
 * - a version whose every failed check also fails on main gets a comment
 *   saying so and no label, and its mark says it waits on main, which the
 *   intake round reads to offer a rerun once main passes
 *   (docs/outside-intake.md, "Once main passes");
 * - it adds a line saying main is failing too whenever main's newest run
 *   has a failed job, since main runs none of ci's or docs-site's own jobs
 *   and so cannot leave those out by name;
 * - the first comment of a version that names a check labels the pull
 *   request "waiting on author", and its mark records that this note put
 *   the label on;
 * - when a later run of the same version passes, such as a maintainer's
 *   rerun, it reads the version again: once nothing it names is left for
 *   the pull request to fix, it edits the comment to say so and, if this
 *   note put the label on and both required checks pass, takes the label
 *   off and puts the pull request back in triage, as the author's own push
 *   does (scripts/intake-labels.mjs); a later failure at that version puts
 *   the label back.
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
import { NEEDS_TRIAGE, removeLabel, requiredStates, WAITING } from "./intake-labels.mjs";

/** The workflows whose runs on an outside pull request this reads, by their `name:`. */
export const WORKFLOWS = Object.freeze(["ci", "contributors", "docs-site"]);
/** The account the workflow's token writes as, the only author of the note. */
const BOT = "github-actions[bot]";
const FAILED = new Set(["failure", "timed_out"]);
// The mark records whether this note put the label on, so a passing rerun
// never takes off a label a maintainer's reply added, and whom the version
// waits on: "author" while it names a check, "main" while every check that
// fails also fails on main, "none" once nothing fails. The intake round reads
// waits=main to bring the pull request back once main passes.
const markOf = (sha) => `<!-- failed-checks sha=${sha} `;
const markFor = (sha, labeled, waits) =>
  `${markOf(sha)}labeled=${labeled ? "yes" : "no"} waits=${waits} -->`;
// A mark written before it said whom the version waits on ends after labeled.
const labeledBy = (body, sha) => body.startsWith(`${markOf(sha)}labeled=yes `);
const waitsOf = (body) =>
  /^<!-- failed-checks sha=[0-9a-f]{40} labeled=(?:yes|no) waits=(author|main|none) -->/.exec(body)?.[1] ??
  (body.includes(CLEARED) ? "none" : "author");

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
export function failedComment({
  server,
  owner,
  repo,
  sha,
  jobs,
  onMain = [],
  mainFailing = false,
  labeled = true,
}) {
  const log = (job) =>
    `${server}/${owner}/${repo}/actions/runs/${Number(job.run_id)}/job/${Number(job.id)}`;
  return [
    markFor(sha, labeled, "author"),
    POSTED,
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
    ...(mainFailing
      ? [
          "",
          "`main`'s newest check has a failed job too right now, so a check named above may not be this pull request's to fix.",
        ]
      : []),
    "",
    "Push a fix to this pull request; its checks run again once a maintainer approves the run, and the label comes off once the required checks pass.",
  ].join("\n");
}

const POSTED =
  "_Posted automatically by this project's GitHub workflow when a check finishes on a pull request._";

const CLEARED = "is left for this pull request to fix.";

/**
 * The note once nothing at that version is left for the pull request to fix:
 * every check that failed passes now, or also fails on main, and then the
 * pull request waits on main rather than its author.
 */
export function clearedComment({ sha, onMain = [], labeled = true }) {
  const version = sha.slice(0, 7);
  if (onMain.length === 0)
    return [markFor(sha, labeled, "none"), POSTED, "", `Nothing this note named on version ${version} ${CLEARED}`].join(
      "\n",
    );
  return [
    markFor(sha, labeled, "main"),
    POSTED,
    "",
    `These checks failed on this pull request's version ${version}, but also fail on \`main\` right now, so they are not this pull request's to fix:`,
    "",
    ...onMain.map((job) => `- ${asCode(job.name)}`),
    "",
    "They need nothing from you: once `main` passes, a maintainer can run them again on this version.",
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
    // A passing run, such as a maintainer's rerun, may clear what an earlier
    // run of the version named.
    if (!FAILED.has(run.conclusion) && run.conclusion !== "success") return run.conclusion ?? "unfinished";
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
  const main = await mainJobs(github, owner, repo);
  const { named, onMain } = leaveOutMain(jobs, main);
  const mainFailing = main.some(failed);
  const server = context.serverUrl ?? "https://github.com";

  if (dryRun) {
    const body =
      named.length > 0
        ? failedComment({ server, owner, repo, sha, jobs: named, onMain, mainFailing })
        : onMain.length > 0
          ? clearedComment({ sha, onMain, labeled: false })
          : "Nothing to name: no check failed.";
    core.summary.addRaw(`Dry run on #${pull.number}; nothing was written.\n\n${body}\n`);
    await core.summary.write();
    if (named.length > 0) return `would name ${named.length}`;
    return onMain.length > 0 ? "would say every failed check also fails on main" : "would name none";
  }
  const comment = (
    await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pull.number,
      per_page: 100,
    })
  ).find((each) => each.user?.login === BOT && each.body?.startsWith(markOf(sha)));
  const write = async (body) => {
    if (comment?.body === body) return false;
    if (comment)
      await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
    else await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body });
    core.summary.addRaw(`#${pull.number}:\n\n${body.slice(body.indexOf("\n") + 1)}\n`);
    await core.summary.write();
    return true;
  };
  const labels = new Set((pull.labels ?? []).map((label) => label.name));

  if (named.length > 0) {
    if (comment) {
      // A failure after a comment that named nothing for the pull request to
      // fix (a clear, or every check also failing on main) puts the label
      // on, so the comment's "labeled waiting on author" holds, and the mark
      // records the note put it on.
      const relabel = waitsOf(comment.body) !== "author" && !labels.has(WAITING);
      const labeled = relabel || labeledBy(comment.body, sha);
      const body = failedComment({ server, owner, repo, sha, jobs: named, onMain, mainFailing, labeled });
      const edited = await write(body);
      if (relabel)
        await github.rest.issues.addLabels({ owner, repo, issue_number: pull.number, labels: [WAITING] });
      return edited ? `named ${named.length} again` : "already named";
    }
    const labeled = !labels.has(WAITING);
    await write(failedComment({ server, owner, repo, sha, jobs: named, onMain, mainFailing, labeled }));
    if (labeled)
      await github.rest.issues.addLabels({ owner, repo, issue_number: pull.number, labels: [WAITING] });
    return `named ${named.length}`;
  }
  if (!comment) {
    if (jobs.length === 0) return "no failed checks";
    await write(clearedComment({ sha, onMain, labeled: false }));
    return "every failed check also fails on main";
  }
  const labeled = labeledBy(comment.body, sha);
  const edited = await write(clearedComment({ sha, onMain, labeled }));
  const states = await requiredStates({ github, owner, repo, sha });
  if (labeled && labels.has(WAITING) && states.every((each) => each === "success")) {
    await removeLabel({ github, owner, repo, number: pull.number, name: WAITING });
    if (!labels.has(NEEDS_TRIAGE))
      await github.rest.issues.addLabels({ owner, repo, issue_number: pull.number, labels: [NEEDS_TRIAGE] });
    return "cleared";
  }
  if (onMain.length > 0) return edited ? "every failed check also fails on main" : "already said";
  return edited ? "now passing" : "already passing";
}
