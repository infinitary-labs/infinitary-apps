/** INF-2259: reuse only a complete successful rolling-main run for its exact
 * source. This grants no substitute for release-specific package/update gates.
 * The caller reads the run and its latest job executions from GitHub, not artifacts.
 */
import { legacyJobName } from "./ci-job-names.mjs";

// Main runs no phone check (INF-2492), so every job of the run is the
// desktop app's and the run itself must have succeeded. The phone's own gates
// run in ios-release.yml before TestFlight, and the release's phone job still
// waits for a TestFlight build.
//
// Main runs no old journey set either (INF-2480, the captain: "old set at the
// release check only, from the first piece on"): its full check is the Linux
// checks and the Mac lanes with only the tests that need a Mac, so what an
// alpha reuses from it is those owners, and the alpha runs every journey
// itself (release.yml's verify call with part journeys). A swept batch runs
// every journey on the alpha source's files, so an alpha it proves reuses
// them too and runs no lane (the captain on INF-2508: "Keep every journey in
// the batch, and let an alpha reuse them").

// Jobs read by the names they had before the trigger-first rename
// (scripts/ci-job-names.mjs), so a run from before or after it reads alike.
const legacy = (jobs) => jobs.map((job) => ({ ...job, name: legacyJobName(job.name) }));

const green = (job) => job.status === "completed" && job.conclusion === "success";
const skipped = (job) => job.status === "completed" && job.conclusion === "skipped";

/** Whether numbered parts make one complete set: each of 1 to its total once. */
const completeSet = (parts) => {
  const total = parts[0]?.total;
  return total > 0 && parts.length === total &&
    new Set(parts.map((part) => part?.index)).size === total &&
    parts.every((part) => part && part.total === total && part.index >= 1 && part.index <= total);
};

/** Whether `jobs` hold every Linux journey of a full suite under verify.yml
 * called as job `prefix`, each job passed: the parallel and desktop shards,
 * each lane a complete numbered set (`journeys (<lane> <n>/<total>)`).
 * INF-2340: the run-alone pass is not part of it, and any other journey job
 * must still be green. */
export function everyLinuxJourney(jobs, prefix = "verify / ") {
  const journeys = jobs.filter((job) => job.name.startsWith(`${prefix}linux-e2e / `));
  return journeys.length > 0 && journeys.every(green) && ["parallel", "desktop"].every((lane) =>
    completeSet(journeys.filter((job) => job.name.includes(`(${lane} `)).map((job) => {
      const match = / (\d+)\/(\d+)\)$/.exec(job.name);
      return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
    })));
}

// verify.yml's Linux checks since INF-2646: its typecheck, lints and build in
// one job, and every vitest project in test groups on machines of their own,
// each group a complete numbered set (`<group> (Linux; group <n>/<total>)`) or
// one job (`<group> (Linux)`). A run from before then ran them all in its one
// `linux-checks` job.
const LINUX_CODE = "Code checks and build (Linux)";
const LINUX_TEST_GROUPS = ["Unit tests", "Integration tests", "Environment checks", "Browser tests"];

/** The test group a job of verify.yml, called as job `prefix`, belongs to, with its part, or null. */
function linuxTestPart(name, prefix) {
  for (const group of LINUX_TEST_GROUPS) {
    if (name === `${prefix}${group} (Linux)`) return { group, index: 1, total: 1 };
    const match = / \(Linux; group (\d+)\/(\d+)\)$/.exec(name);
    if (match && name === `${prefix}${group}${match[0]}`)
      return { group, index: Number(match[1]), total: Number(match[2]) };
  }
  return null;
}

/** Whether a job of verify.yml, called as job `prefix`, is one of its Linux checks. */
const linuxCheck = (name, prefix) =>
  name === `${prefix}linux-checks` || name === `${prefix}${LINUX_CODE}` || linuxTestPart(name, prefix) !== null;

/** Whether `jobs` hold verify.yml's Linux checks, called as job `prefix`, each
 * passed: the code checks and build and every test group's complete set, or
 * the one `linux-checks` job of a run from before INF-2646. */
export function linuxChecksPassed(jobs, prefix = "verify / ") {
  const passed = (name) => jobs.some((job) => job.name === name && green(job));
  if (passed(`${prefix}linux-checks`)) return true;
  const parts = jobs.flatMap((job) => {
    const part = linuxTestPart(job.name, prefix);
    return part ? [{ ...part, job }] : [];
  });
  return passed(`${prefix}${LINUX_CODE}`) && LINUX_TEST_GROUPS.every((group) => {
    const own = parts.filter((part) => part.group === group);
    return own.every((part) => green(part.job)) && completeSet(own);
  });
}

// verify.yml's Mac lanes since INF-2779 (the captain's approved three-job
// split): its native tests, replay and package, its parallel journeys and its
// desktop journeys, each a job of its own. A run from before then ran them all
// in its one `mac` job, whose name the trigger-first rename reads back.
const MAC_NATIVE = "Native tests, replay and package (Mac)";
const MAC_JOURNEYS = ["Parallel journeys (Mac)", "Desktop journeys (Mac)"];

/** Whether `jobs` hold verify.yml's Mac lanes, called as job `prefix`, each
 * passed: `names`, or the one `mac` job of a run from before INF-2779. */
function macPassed(jobs, prefix, names = [MAC_NATIVE, ...MAC_JOURNEYS]) {
  const passed = (name) => jobs.some((job) => job.name === name && green(job));
  return passed(`${prefix}mac`) || names.every((name) => passed(`${prefix}${name}`));
}

/** The checks an alpha reuses from verify.yml, called as job `prefix`: its
 * Linux checks and its Mac lanes passed, and every job of the run completed. */
function checksPassed(jobs, prefix) {
  // All jobs of the successful run must be completed; an optional lane may
  // skip, but no full-check owner may be skipped or merely absent.
  return linuxChecksPassed(jobs, prefix) && macPassed(jobs, prefix) &&
    jobs.every((job) => job.status === "completed" && ["success", "skipped"].includes(job.conclusion));
}

export function verifyMainEvidence(run, named, repository, source) {
  const jobs = legacy(named);
  checkMainRun(run, jobs, repository, source);
  if (!checksPassed(jobs, "verify / "))
    throw new Error("The rolling-main run did not complete every full-check owner successfully.");
  // A main run from before INF-2480 also ran every journey, on Linux and with
  // every journey on the Mac; only such a run vouches for the journeys of an
  // alpha that ran none itself.
  return { source, runId: run.id, attempt: run.run_attempt, url: run.html_url, journeys: everyLinuxJourney(jobs) };
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
// main push whose files are exactly a passed batch's skips main's full check,
// and main.yml names the batch run in a job of its own. The batch run is the
// shipped queue's (infinitary-queue.yml), whose batch checks job calls this
// repository's infinitary-batch-checks.yml: its last job names the tree its
// sweep and critical path built, and its sweep is verify.yml, read as
// `verify` like main's own. A batch run from before the shipped queue
// (batch.yml) named the tree in its verdict job and called verify.yml as
// `sweep`.
//
// A batch that passed on its confirm passes too (the captain's pick on
// INF-3052, "Nothing more: the batch's run and its recheck together passed
// every test"): the queue confirms only when every failed job of its checks
// named the test files that failed, and the confirm ran each of them again,
// three rounds, and passed. Its run ends failed, since its checks failed,
// and the tree is named by the confirm's own last job.
const COVERED = /^covered by batch (\d+)$/;
const QUEUE_RUN = ".github/workflows/infinitary-queue.yml";
const OLD_BATCH_RUN = ".github/workflows/batch.yml";
// The shipped queue names its own jobs; this repository's batch checks run
// under its `Batch checks` job, and run again under `Batch confirm`.
const BATCH_CHECKS = "Batch checks / ";
const BATCH_CONFIRM = "Batch confirm / ";

/** The batch run a covered main run names, or null for a full check. */
export function coveringBatch(named) {
  const jobs = legacy(named);
  const job = jobs.find((candidate) => COVERED.test(candidate.name) && green(candidate));
  return job ? Number(COVERED.exec(job.name)[1]) : null;
}

/** A covered main push: every job passed or skipped, and it names its batch. */
export function verifyCoveredMain(run, named, repository, source) {
  const jobs = legacy(named);
  checkMainRun(run, jobs, repository, source);
  if (coveringBatch(jobs) === null || jobs.some((job) => job.status !== "completed" ||
      !["success", "skipped"].includes(job.conclusion)))
    throw new Error("The covered main run did not pass every job it ran.");
  return coveringBatch(jobs);
}

/** The jobs under `lead`, named without it and read by their legacy names. */
const under = (jobs, lead) => legacy(jobs.filter((job) => job.name.startsWith(lead))
  .map((job) => ({ ...job, name: job.name.slice(lead.length) })));

/** Whether `jobs` hold the batch checks' last job, passed, naming `tree` (and, since INF-3052, the base). */
const passedOn = (jobs, tree) => jobs.some((job) => green(job) &&
  (job.name === `Batch passed (tree ${tree})` || job.name.startsWith(`Batch passed (tree ${tree}; base `)));

/** The batch run's full check passed on exactly `tree`, the alpha source's files. */
export function verifyBatchEvidence(run, named, repository, tree) {
  if (![QUEUE_RUN, OLD_BATCH_RUN].includes(run.path) || run.head_branch !== "main" ||
      run.head_repository?.full_name !== repository || run.repository?.full_name !== repository ||
      run.status !== "completed")
    throw new Error("A covered main push needs a successful batch run.");
  if (named.some((job) => job.run_id !== run.id || !Number.isSafeInteger(job.run_attempt) ||
      job.run_attempt < 1 || job.run_attempt > run.run_attempt))
    throw new Error("Batch jobs must belong to a completed attempt of this run.");
  const shipped = run.path === QUEUE_RUN;
  const confirmed = shipped && passedOn(under(named, BATCH_CONFIRM), tree);
  if (run.conclusion !== "success" && !confirmed)
    throw new Error("A covered main push needs a successful batch run.");
  let jobs = shipped ? under(named, BATCH_CHECKS) : legacy(named);
  if (shipped ? !confirmed && !passedOn(jobs, tree) : !jobs.some((job) => job.name === `verdict (tree ${tree})` && green(job)))
    throw new Error("The batch run swept other files than the alpha source.");
  // The confirm ran every failed job's failed files again and passed.
  if (confirmed)
    jobs = jobs.map((job) => job.status === "completed" && job.conclusion === "failure" ? { ...job, conclusion: "success" } : job);
  if (!checksPassed(jobs, "verify / "))
    throw new Error("The batch run did not complete every full-check owner successfully.");
  return { runId: run.id, attempt: run.run_attempt, url: run.html_url, journeys: everyLinuxJourney(jobs, "verify / ") };
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
  return { source, runId: run.id, attempt: run.run_attempt, url: proof.url, journeys: proof.journeys };
}

/** What a published alpha's release run proved itself, from its latest job
 * executions, for a stable that promotes it:
 * - "all": the Linux checks (linuxChecksPassed), every Linux journey shard
 *   and every Mac lane passed in it;
 * - "journeys": it ran only the journey part, with no Linux checks job, and
 *   every Linux journey shard and both Mac journey jobs passed (an alpha that
 *   reused main's checks, INF-2480);
 * - "none": its verify call skipped, so it ran no lane (an automatic alpha
 *   that reused every lane, from its swept batch or a main run from before
 *   INF-2480); GitHub lists a skipped call as one job named `verify`, or,
 *   after the trigger-first rename, under its unevaluated name, which no
 *   lane reads, so no lane job is listed;
 * - null: a lane failed, is pending, skipped or partial, and the alpha is refused.
 * Jobs are read by their names from before the rename (scripts/ci-job-names.mjs). */
export function alphaVerification(named) {
  const jobs = legacy(named);
  const lanes = jobs.filter((job) => job.name === "verify" || job.name.startsWith("verify / "));
  if (lanes.every(skipped)) return "none";
  const shards = lanes.filter((job) => job.name.startsWith("verify / linux-e2e / "));
  const linux = shards.length > 0 && shards.every(green);
  if (linuxChecksPassed(lanes) && linux && macPassed(lanes, "verify / ")) return "all";
  if (!lanes.some((job) => linuxCheck(job.name, "verify / ")) && everyLinuxJourney(lanes) &&
      macPassed(lanes, "verify / ", MAC_JOURNEYS) && lanes.every((job) => green(job) || skipped(job)))
    return "journeys";
  return null;
}
