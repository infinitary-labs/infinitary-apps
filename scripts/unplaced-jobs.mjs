/**
 * A merge batch's jobs GitHub never placed on a runner (docs/testing.md, "A
 * job GitHub never placed").
 *
 * GitHub's own Macs run the batch's native tests and parallel journeys (the
 * `native` kind, docs/testing.md "Each Mac job's kind and size"). When GitHub
 * has no Mac to give one of them, it cancels the job after a wait of up to
 * about twenty minutes, with no runner, no step, and an annotation of its own
 * that begins NEVER_PLACED. No test ran, so the batch's confirm has no test
 * file to run again, and the batch holds on a check that judged nothing.
 *
 * When a batch pull request's run ends (unplaced-jobs.yml, on workflow_run),
 * this reads the attempt that ended. When every job of it that neither
 * passed nor skipped is one GitHub never placed, it asks GitHub to rerun the
 * run's failed jobs: those jobs on the same machines, and the jobs after
 * them, so the batch's checks decide as they would have. GitHub keeps every
 * job that passed, and the app's reading of the batch ends its hold once the
 * checks run again (docs/forge.md, "A held batch"). Any other job that ended -
 * a failed test, a check cancelled by a newer version of the batch or by the
 * batch's own stop - reruns nothing, and the batch's repair reads the run as
 * before: a rerun answers none of those.
 *
 * It asks only while the run's attempt is below LAST_ATTEMPT, only while the
 * batch's pull request is open at the run's version, and never once the run
 * is running again or has a newer attempt, so a repair's own rerun is never
 * doubled. Main's check, an alpha cut and an outside pull request are never
 * read here: a main check is never retried (the captain's direction), and an
 * outside run waits for a maintainer's approval.
 *
 * Started by hand with a run's id, it is a dry run: it reads that run's
 * newest attempt, or the attempt named, writes what it would do to the job
 * summary, and reruns nothing.
 */

import { isBatchPullRun } from "./batch-pull.mjs";

/** How GitHub's own annotation on a job no hosted runner took begins. */
export const NEVER_PLACED = "The job was not acquired by Runner of type hosted";

/** The run's last attempt, at which nothing more is asked, so a run reruns itself at most twice. */
export const LAST_ATTEMPT = 3;

const PASSED = new Set(["success", "skipped"]);

/** A job's own name, the innermost level of GitHub's full name. */
const own = (job) => String(job.name).split(" / ").at(-1);

const listed = (jobs) => jobs.map((job) => `- ${own(job)} (job ${Number(job.id)})`).join("\n");

/**
 * Whether GitHub's record of `job` says it never placed it on a runner: it
 * ended with no runner and no step, and the annotations on its check
 * (`messages`) carry GitHub's own words for a job no hosted runner took.
 */
export function neverPlaced(job, messages) {
  return (
    job.status === "completed" &&
    !job.runner_id &&
    !job.runner_name &&
    (job.steps ?? []).length === 0 &&
    messages.some((message) => String(message).startsWith(NEVER_PLACED))
  );
}

/**
 * The run's jobs of `attempt` that neither passed nor skipped, split into
 * those GitHub never placed and the rest. Annotations are read only for a
 * job that ended with no runner and no step, the only kind that can be one.
 */
export async function unplacedJobs({ github, owner, repo, runId, attempt }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    owner,
    repo,
    run_id: runId,
    attempt_number: attempt,
    per_page: 100,
  });
  const ended = jobs.filter((job) => !(job.status === "completed" && PASSED.has(job.conclusion)));
  const unplaced = [];
  const others = [];
  for (const job of ended) {
    const bare = job.status === "completed" && !job.runner_id && (job.steps ?? []).length === 0;
    const messages = bare
      ? (
          await github.paginate(github.rest.checks.listAnnotations, {
            owner,
            repo,
            check_run_id: job.id,
            per_page: 100,
          })
        ).map((annotation) => annotation.message)
      : [];
    (neverPlaced(job, messages) ? unplaced : others).push(job);
  }
  return { unplaced, others };
}

/**
 * What to do with one attempt of a run that ended: `{ act: "rerun", unplaced,
 * words }` when every job of it that neither passed nor skipped is one GitHub
 * never placed and nothing stops the ask, otherwise `{ act: "none", reason,
 * unplaced, words }`.
 */
export async function judge({ github, owner, repo, run, attempt }) {
  const repository = `${owner}/${repo}`;
  const label = `Run ${Number(run.id)}, attempt ${attempt}`;
  const none = (reason, words, unplaced = []) => ({ act: "none", reason, unplaced, words });
  if (!isBatchPullRun(run, repository))
    return none("not-batch", `${label} is not a batch pull request's own run, so nothing reruns.`);
  const { unplaced, others } = await unplacedJobs({ github, owner, repo, runId: run.id, attempt });
  if (unplaced.length === 0 && others.length === 0)
    return none("passed", `${label} passed every job, so nothing reruns.`);
  if (unplaced.length === 0)
    return none("ended", `${label} has no job GitHub never placed, so nothing reruns; its repair reads it.`);
  const never = `GitHub never placed these jobs on a runner:\n\n${listed(unplaced)}\n\n`;
  if (others.length > 0)
    return none(
      "others",
      `${label}: ${never}These jobs ended another way, which a rerun does not answer, so nothing reruns and the batch's repair reads the run:\n\n${listed(others)}`,
      unplaced,
    );
  if (attempt >= LAST_ATTEMPT)
    return none(
      "limit",
      `${label}: ${never}It is the run's attempt ${attempt}, and a run reruns itself only until attempt ${LAST_ATTEMPT}, so nothing reruns and the batch's repair reads the run.`,
      unplaced,
    );
  const { data: now } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
  if (now.run_attempt !== attempt || now.status !== "completed")
    return none(
      "moved",
      `${label}: ${never}The run has run again since (attempt ${Number(now.run_attempt)}, ${now.status}), so nothing more reruns.`,
      unplaced,
    );
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    head: `${owner}:${run.head_branch}`,
    state: "open",
    per_page: 100,
  });
  if (!pulls.some((pull) => pull.head?.sha === run.head_sha))
    return none(
      "moved",
      `${label}: ${never}The batch's pull request is no longer open at this version, so nothing reruns.`,
      unplaced,
    );
  return {
    act: "rerun",
    unplaced,
    words: `${label}: ${never}Every other job passed or skipped, so this run asked GitHub to rerun its failed jobs on the same machines, as attempt ${attempt + 1}.`,
  };
}

/**
 * The workflow's step: judges the run that ended, or the run a person named
 * for a dry run, writes the verdict to the job summary, and asks GitHub to
 * rerun the run's failed jobs when the verdict says so and it is no dry run.
 * A refused ask while the run has run again since is that rerun, not a failure.
 */
export async function rerunUnplaced({ github, context, core, runId, attempt }) {
  const { owner, repo } = context.repo;
  const dry = Boolean(runId);
  const run = dry
    ? (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(runId) })).data
    : context.payload.workflow_run;
  const which = dry && attempt ? Number(attempt) : run.run_attempt;
  const verdict = await judge({ github, owner, repo, run, attempt: which });
  const words = dry ? `Dry run, which reruns nothing. ${verdict.words}` : verdict.words;
  await core.summary.addRaw(`${words}\n`).write();
  if (verdict.act !== "rerun" || dry) {
    core.info(words);
    return verdict;
  }
  try {
    await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id });
  } catch (error) {
    const { data: now } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
    if (now.run_attempt === which && now.status === "completed") throw error;
    core.info(`GitHub refused the rerun because the run ran again first (attempt ${now.run_attempt}, ${now.status}).`);
    return { ...verdict, act: "none", reason: "moved" };
  }
  core.notice(words);
  return verdict;
}
