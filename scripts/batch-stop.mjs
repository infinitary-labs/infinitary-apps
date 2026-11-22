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
 *
 * An alpha cut, rehearsals included, stops at its first failed job (INF-6038,
 * the captain's approved plan; docs/alpha.md, "Failed alpha checks"): a
 * failed cut can never publish, yet its journeys, signing, Linux packages,
 * Windows installer and signed installer check ran on to the slowest one's
 * end. release.yml's watch reads the run with the cut's rule (`cut` below),
 * its stop jobs enter each job's own group the same way, and the watch then
 * fails itself naming the failed job, so GitHub's Re-run failed jobs re-runs
 * the watch beside the jobs it re-runs. The cut retries nothing before it
 * stops (the captain's direction to fix a flaky test's cause rather than
 * rely on re-runs).
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
 * The merge batch's rule: it stops when the code checks failed, or a confirm
 * failed again on the test files it named, and ends once its last check job
 * is among the ended ones (`runState`). It reads a failed confirm's log once;
 * a log GitHub cannot give yet is read again.
 */
export const batch = {
  async stop(jobs, { github, context, core, read }) {
    if (codeChecksState(jobs) === "failed") {
      return {
        kind: "code-checks",
        failed: codeChecksFailure(jobs),
        notice: "The code checks failed, so the stop jobs cancel the rest of this batch.",
      };
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
        return {
          kind: "confirm",
          failed: `${lastPart(job.name)} failed again on ${files.join(" ")}`,
          notice: "A confirm failed again on the test files it named, so the stop jobs cancel the rest of this batch.",
        };
      }
      core.notice(`${lastPart(job.name)} failed before it ran a test file, so the batch runs on.`);
    }
    return null;
  },
  state: runState,
  none: "Every check ended with no failed code checks and no confirm that failed again, so nothing stops this batch.",
};

/** What a cut's stop job's name holds (release.yml's `stop`). */
export const STOP_CUT = " · Stop the cut (";

/**
 * How a cut's upload job's name ends, a publishing run's and a rehearsal's
 * (release.yml's `upload`). It starts only once every job before it passed,
 * so a reading that lists it ends the watch, and its failure, or the
 * publication's after it, is never the watch's to stop: nothing runs beside
 * them.
 */
export const UPLOAD = [" · Upload every download", " · Preview uploads; upload nothing"];

const watched = (job) =>
  !job.name.endsWith(WATCH) && !job.name.includes(STOP_CUT) && !UPLOAD.some((end) => job.name.endsWith(end));

/**
 * The cut's failed jobs in one reading, the first to end first, by their
 * last name part: every job of the run but the watch, its stops and the
 * upload whose conclusion is a failure or a timeout. A cancelled or skipped
 * job is no failure of its own.
 */
export function cutFailures(jobs) {
  return jobs
    .filter((job) => watched(job) && job.status === "completed" && FAILED.includes(job.conclusion))
    .sort((a, b) => String(a.completed_at ?? "").localeCompare(String(b.completed_at ?? "")))
    .map((job) => lastPart(job.name));
}

/**
 * Whether one reading of a cut shows every job before the upload ended:
 * `ended` once the upload job is listed, `quiet` while every listed job but
 * the watch and its stops ended and a job that waits on them may still be
 * created, `running` otherwise.
 */
export function cutState(jobs) {
  if (jobs.some((job) => UPLOAD.some((end) => job.name.endsWith(end)))) return "ended";
  return jobs.filter(watched).every((job) => job.status === "completed") ? "quiet" : "running";
}

/**
 * An alpha cut's rule, a rehearsal's too: it stops at the first job that
 * failed or timed out, whatever job it is, and ends once the upload job is
 * listed. The output `failed` names the failed jobs.
 */
export const cut = {
  async stop(jobs) {
    const failed = cutFailures(jobs);
    if (!failed.length) return null;
    return {
      kind: "failed",
      failed: failed.join(", "),
      notice: `${failed[0]} failed, so the stop jobs cancel the rest of this cut.`,
    };
  },
  state: cutState,
  none: "Every job before the upload ended with none failed, so nothing stops this cut.",
};

/**
 * The watch job: reads the run's latest jobs every half minute until its
 * rule says every other job ended, and writes the output `stop`: the kind of
 * stop the rule found (the batch's `code-checks` or `confirm`, the cut's
 * `failed`), or `none`; on a stop, the output `failed` says what failed in
 * words. A job is created only once the jobs it needs end, so a run without
 * the job that marks its end ends the watch only when two readings in a row
 * find nothing else running. A reading GitHub refuses is read again; the
 * batch's watch job is continue-on-error, and the cut's watch step is, so a
 * watch that never ends fails neither.
 */
export async function watch({ github, context, core, everySeconds = 30, rule = batch }) {
  let quiet = 0;
  const read = new Set();
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
      const found = await rule.stop(jobs, { github, context, core, read });
      if (found) {
        core.notice(found.notice);
        core.setOutput("stop", found.kind);
        core.setOutput("failed", found.failed);
        return;
      }
      const state = rule.state(jobs);
      quiet = state === "quiet" ? quiet + 1 : 0;
      if (state === "ended" || quiet >= 2) {
        core.notice(rule.none);
        core.setOutput("stop", "none");
        return;
      }
    }
    await wait(everySeconds);
  }
}
