/** A batch stops at its first code-check failure (docs/testing.md, "The
 * swept batch"; the captain's pick on INF-3925, "Stop a batch at its first
 * code-check failure, in both today's batch checks and the per-person batch
 * checks").
 *
 * The code checks (verify.yml's `Code checks and build (Linux)` job: the
 * typecheck, the lints, the size and generated-file checks and the build)
 * fail a few minutes in, while the journeys run on for half an hour. A
 * rerun of a test answers none of their failures, so a batch whose code
 * checks failed is going to stay failed whatever else passes.
 *
 * batch-checks.yml runs a watch job beside its checks: it reads this run's
 * jobs until the code checks end, and names their outcome. When they failed,
 * a stop job per check enters that check's concurrency group with
 * cancel-in-progress, which cancels the check and every job it called, and
 * passes. One job after the stops, the stopped job, then fails naming the
 * code checks' failed step, so the batch ends failed minutes after the code
 * checks did and its one red line of its own points at the real failure
 * rather than twenty stops. The batch's code holds only a read of the
 * project, and GitHub cancels a single job only through its concurrency
 * group, never through the run's API.
 */

/** How the code checks' job name ends, at every level of a batch run's names. */
export const CODE_CHECKS = " · Code checks and build (Linux)";

/** How the watch job's own name ends. */
export const WATCH = " · Watch the code checks";

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

const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

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

/**
 * The watch job: reads the run's latest jobs every half minute until the
 * code checks end, and writes the output `code_checks`, `failure` when they
 * failed and `success` otherwise, and on a failure the output `failed`, what
 * failed in words (`codeChecksFailure`). A job is created only once the jobs it
 * needs end, so the code checks being absent ends the watch only when two
 * readings in a row find nothing else running. A reading GitHub refuses is
 * read again; the job's continue-on-error keeps a watch that never ends
 * from failing a batch.
 */
export async function watch({ github, context, core, everySeconds = 30 }) {
  let absent = 0;
  for (;;) {
    let state = "running";
    let jobs = [];
    try {
      jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo,
        run_id: context.runId,
        filter: "latest",
        per_page: 100,
      });
      state = codeChecksState(jobs);
    } catch (error) {
      core.warning(`The run's jobs could not be read, so the watch reads them again: ${error.message}`);
    }
    absent = state === "absent" ? absent + 1 : 0;
    if (state === "failed") {
      core.notice("The code checks failed, so the stop jobs cancel the rest of this batch.");
      core.setOutput("code_checks", "failure");
      core.setOutput("failed", codeChecksFailure(jobs));
      return;
    }
    if (state === "passed" || absent >= 2) {
      core.notice(
        state === "passed"
          ? "The code checks passed, so the batch runs on."
          : "This run has no code checks, so nothing stops it.",
      );
      core.setOutput("code_checks", "success");
      return;
    }
    await wait(everySeconds);
  }
}
