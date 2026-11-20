/** A batch stops at its first code-check failure (docs/testing.md, "The
 * swept batch"; the captain's pick on INF-3925, "Stop a batch at its first
 * code-check failure, in both today's batch checks and the per-person batch
 * checks"), and once a confirm fails again on the test files it named (the
 * captain's pick on INF-5113, "Start now: stop at a failed confirm").
 *
 * The code checks (verify.yml's `Code checks and build (Linux)` job: the
 * typecheck, the lints, the size and generated-file checks and the build)
 * fail a few minutes in, while the journeys run on for half an hour. A
 * rerun of a test answers none of their failures, so a batch whose code
 * checks failed is going to stay failed whatever else passes.
 *
 * A confirm runs each failed test file three more rounds on the same version
 * (scripts/batch-confirm.ts). When a round fails, the failure repeats, so the
 * batch holds and its repair sends a change back or fixes forward whatever
 * the checks still running show; a confirm that passed was a flake, and the
 * batch runs on. A confirm that failed before any round ran - a failed job
 * whose log named no test file, as when its test machine dropped out - says
 * nothing about the tests, so it never stops the batch.
 *
 * batch-checks.yml runs a watch job beside its checks: it reads this run's
 * jobs until every other job ended, and names the first stop it finds. On a
 * stop, a stop job per check enters that check's concurrency group with
 * cancel-in-progress, which cancels the check and every job it called, and
 * passes. One job after the stops, the stopped job, then fails naming what
 * failed, so the batch ends failed minutes after it did and its one red line
 * of its own points at the real failure rather than twenty stops. The
 * batch's code holds only a read of the project, and GitHub cancels a single
 * job only through its concurrency group, never through the run's API.
 */

/** How the code checks' job name ends, at every level of a batch run's names. */
export const CODE_CHECKS = " · Code checks and build (Linux)";

/** How the watch job's own name ends. */
export const WATCH = " · Watch for a stop";

/** What a confirm job's name holds, a test group's own and the later one's alike. */
export const CONFIRM = " · Confirm failed ";

/** What the last check job's name holds; only the watch's stops wait on more. */
export const PASSED = " · Batch passed (";

const FAILED = ["failure", "timed_out"];

/**
 * What one reading of the run's jobs says of the code checks: `failed`,
 * `passed` (ended any other way), `running` (queued or in progress, or not
 * created yet while another job still runs), or `absent` when no job but
 * the watch is still going and none is the code checks.
 */
export function codeChecksState(jobs) {
  const checks = jobs.filter((job) => job.name.endsWith(CODE_CHECKS));
  if (checks.some((job) => job.status === "completed" && FAILED.includes(job.conclusion))) return "failed";
  if (checks.length && checks.every((job) => job.status === "completed")) return "passed";
  if (checks.length) return "running";
  const others = jobs.filter((job) => !job.name.endsWith(WATCH));
  return others.every((job) => job.status === "completed") ? "absent" : "running";
}

/**
 * What failed in the code checks, in words the stopped job's error line
 * carries: each failed code-checks job by its last name part, with the steps
 * that failed in it, as one reading of the run's jobs lists them.
 */
export function codeChecksFailure(jobs) {
  const failed = jobs.filter(
    (job) => job.name.endsWith(CODE_CHECKS) && job.status === "completed" && FAILED.includes(job.conclusion),
  );
  return failed
    .map((job) => {
      const name = job.name.split(" · ").at(-1);
      const steps = (job.steps ?? []).filter((step) => FAILED.includes(step.conclusion)).map((step) => `"${step.name}"`);
      return steps.length ? `${name} failed at ${steps.join(", ")}` : `${name} failed`;
    })
    .join("; ");
}

// A job log's timestamp before each line (scripts/batch-failures.mjs).
const LOG_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
// scripts/batch-confirm.ts's `roundLine` and `failedLine`.
const ROUND = /^Confirm round \d+ of \d+: (.+)$/;
const ROUND_FAILED = /^Failed in round \d+ of \d+\.$/;

/**
 * The test files a confirm's log says failed again: the files its last round
 * named, when a round failed; an empty list when no round failed, or none ran
 * because the failed job's log named no test file.
 */
export function confirmedAgain(log) {
  let files = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(LOG_PREFIX, "").trimEnd();
    const round = ROUND.exec(line);
    if (round) files = round[1].split(/\s+/).filter(Boolean);
    else if (ROUND_FAILED.test(line) && files.length) return files;
  }
  return [];
}

/** The failed confirm jobs of one reading. */
export const failedConfirms = (jobs) =>
  jobs.filter(
    (job) => job.name.includes(CONFIRM) && job.status === "completed" && FAILED.includes(job.conclusion),
  );

/**
 * Whether one reading of the run's jobs shows every job but the watch ended:
 * `ended` once the last check job is among them, `quiet` while a job that
 * waits on the ended ones may still be created.
 */
export function runState(jobs) {
  const others = jobs.filter((job) => !job.name.endsWith(WATCH));
  if (!others.every((job) => job.status === "completed")) return "running";
  return others.some((job) => job.name.includes(PASSED)) ? "ended" : "quiet";
}

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const lastPart = (name) => name.split(" · ").at(-1);

/**
 * The watch job: reads the run's latest jobs every half minute until every
 * other job ended, and writes the output `stop`: `code-checks` when the code
 * checks failed, `confirm` when a confirm failed again on the test files it
 * named, and `none` otherwise; on a stop, the output `failed` says what failed
 * in words (`codeChecksFailure`, or the confirm and its files). It reads a
 * failed confirm's log once; a log GitHub cannot give yet is read again. A
 * job is created only once the jobs it needs end, so a run without its last
 * check job ends the watch only when two readings in a row find nothing else
 * running. A reading GitHub refuses is read again; the job's
 * continue-on-error keeps a watch that never ends from failing a batch.
 */
export async function watch({ github, context, core, everySeconds = 30 }) {
  let quiet = 0;
  const read = new Set();
  const stop = (kind, failed, notice) => {
    core.notice(notice);
    core.setOutput("stop", kind);
    core.setOutput("failed", failed);
  };
  for (;;) {
    let jobs = null;
    try {
      jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo,
        run_id: context.runId,
        filter: "latest",
        per_page: 100,
      });
    } catch (error) {
      core.warning(`The run's jobs could not be read, so the watch reads them again: ${error.message}`);
    }
    if (jobs) {
      if (codeChecksState(jobs) === "failed") {
        stop(
          "code-checks",
          codeChecksFailure(jobs),
          "The code checks failed, so the stop jobs cancel the rest of this batch.",
        );
        return;
      }
      for (const job of failedConfirms(jobs)) {
        if (read.has(job.id)) continue;
        let log;
        try {
          const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...context.repo, job_id: job.id });
          log = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        } catch (error) {
          core.warning(`The log of ${lastPart(job.name)} could not be read, so the watch reads it again: ${error.message}`);
          continue;
        }
        read.add(job.id);
        const files = confirmedAgain(log);
        if (files.length) {
          stop(
            "confirm",
            `${lastPart(job.name)} failed again on ${files.join(" ")}`,
            "A confirm failed again on the test files it named, so the stop jobs cancel the rest of this batch.",
          );
          return;
        }
        core.notice(`${lastPart(job.name)} failed before it ran a test file, so the batch runs on.`);
      }
      const state = runState(jobs);
      quiet = state === "quiet" ? quiet + 1 : 0;
      if (state === "ended" || quiet >= 2) {
        core.notice("Every check ended with no failed code checks and no confirm that failed again, so nothing stops this batch.");
        core.setOutput("stop", "none");
        return;
      }
    }
    await wait(everySeconds);
  }
}
