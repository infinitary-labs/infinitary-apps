/** INF-2259: reuse only a complete successful rolling-main run for its exact
 * source. This grants no substitute for release-specific package/update gates.
 * The caller reads the run and its latest job executions from GitHub, not artifacts.
 */
// Main runs no phone check (INF-2492), so every job of the run is the
// desktop app's and the run itself must have succeeded. The phone's own gates
// run in ios-release.yml before TestFlight, and the release's phone job still
// waits for a TestFlight build.
const green = (job) => job.status === "completed" && job.conclusion === "success";

/** Every full-check owner of verify.yml, called as job `prefix`, passed and none is absent. */
function fullCheckPassed(jobs, prefix) {
  const passed = (name) => jobs.some((job) => job.name === name && green(job));
  const journeys = jobs.filter((job) => job.name.startsWith(`${prefix}linux-e2e / `));
  // INF-2340: the run-alone pass left main's full check for the proof of
  // edited journeys, so full coverage is the parallel and desktop shards; any
  // other journey job a run holds must still be green.
  const completeJourneys = ["parallel", "desktop"].every((lane) => {
    const shards = journeys.filter((job) => job.name.includes(`(${lane} `)).map((job) => {
      const match = / (\d+)\/(\d+)\)$/.exec(job.name);
      return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
    });
    const total = shards[0]?.total;
    return total > 0 && shards.length === total &&
      new Set(shards.map((shard) => shard?.index)).size === total &&
      shards.every((shard) => shard && shard.total === total && shard.index >= 1 && shard.index <= total);
  });
  // Full source coverage is every parallel and desktop shard.
  // All jobs of the successful run must be completed; an optional lane may skip,
  // but none of these full-check owners may be skipped or merely absent.
  return passed(`${prefix}linux-checks`) && passed(`${prefix}mac`) &&
    journeys.length > 0 && journeys.every(green) && completeJourneys &&
    jobs.every((job) => job.status === "completed" && ["success", "skipped"].includes(job.conclusion));
}

export function verifyMainEvidence(run, jobs, repository, source) {
  checkMainRun(run, jobs, repository, source);
  if (!fullCheckPassed(jobs, "verify / "))
    throw new Error("The rolling-main run did not complete every full-check owner successfully.");
  return { source, runId: run.id, attempt: run.run_attempt, url: run.html_url };
}

function checkMainRun(run, jobs, repository, source) {
  if (run.path !== ".github/workflows/main.yml" || run.event !== "push" ||
      run.head_branch !== "main" || run.head_repository?.full_name !== repository ||
      run.repository?.full_name !== repository || run.head_sha !== source ||
      run.status !== "completed" || run.conclusion !== "success")
    throw new Error("Alpha reuse needs a successful rolling-main push for this exact source.");
  if (jobs.some((job) => job.run_id !== run.id || (!Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > run.run_attempt) ||
      job.head_sha !== source))
    throw new Error("Rolling-main jobs must belong to this source and a completed attempt of this run.");
}

// The swept batch (INF-2430 piece 3, docs/testing.md "The swept batch"): a
// main push whose files are exactly a green batch's skips main's full check,
// and main.yml names the batch run in a job of its own. The batch run's
// verdict job names the tree it swept, and its sweep job is verify.yml.
const COVERED = /^covered by batch (\d+)$/;

/** The batch run a covered main run names, or null for a full check. */
export function coveringBatch(jobs) {
  const job = jobs.find((candidate) => COVERED.test(candidate.name) && green(candidate));
  return job ? Number(COVERED.exec(job.name)[1]) : null;
}

/** A covered main push: every job passed or skipped, and it names its batch. */
export function verifyCoveredMain(run, jobs, repository, source) {
  checkMainRun(run, jobs, repository, source);
  if (coveringBatch(jobs) === null || jobs.some((job) => job.status !== "completed" ||
      !["success", "skipped"].includes(job.conclusion)))
    throw new Error("The covered main run did not pass every job it ran.");
  return coveringBatch(jobs);
}

/** The batch run's full check passed on exactly `tree`, the alpha source's files. */
export function verifyBatchEvidence(run, jobs, repository, tree) {
  if (run.path !== ".github/workflows/batch.yml" || run.head_branch !== "main" ||
      run.head_repository?.full_name !== repository || run.repository?.full_name !== repository ||
      run.status !== "completed" || run.conclusion !== "success")
    throw new Error("A covered main push needs a successful batch run.");
  if (jobs.some((job) => job.run_id !== run.id || !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 || job.run_attempt > run.run_attempt))
    throw new Error("Batch jobs must belong to a completed attempt of this run.");
  if (!jobs.some((job) => job.name === `verdict (tree ${tree})` && green(job)))
    throw new Error("The batch run swept other files than the alpha source.");
  if (!fullCheckPassed(jobs, "sweep / "))
    throw new Error("The batch run did not complete every full-check owner successfully.");
  return { runId: run.id, attempt: run.run_attempt, url: run.html_url };
}

/**
 * The alpha's proof for a completed main run, read from GitHub: the run's
 * own full check, or the batch run a covered run names.
 */
export async function proveMain(github, repo, run, source) {
  const repository = `${repo.owner}/${repo.repo}`;
  const jobsOf = (run_id) => github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo, run_id, filter: "latest", per_page: 100,
  });
  const jobs = await jobsOf(run.id);
  if (coveringBatch(jobs) === null) return verifyMainEvidence(run, jobs, repository, source);
  const batchId = verifyCoveredMain(run, jobs, repository, source);
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: source });
  const { data: batch } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: batchId });
  const proof = verifyBatchEvidence(batch, await jobsOf(batch.id), repository, commit.tree.sha);
  return { source, runId: run.id, attempt: run.run_attempt, url: proof.url };
}
