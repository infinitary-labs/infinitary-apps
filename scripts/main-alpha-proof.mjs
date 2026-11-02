/** INF-2259: reuse only a complete successful rolling-main run for its exact
 * source. This grants no substitute for release-specific package/update gates.
 * The caller reads the run and its latest job executions from GitHub, not artifacts.
 */
// An alpha ships the desktop app only, so its proof never reads main's phone
// call (INF-2353, the captain's pick "Drop phone from alpha gate": "alpha is
// the desktop app, right?"). The phone check still runs on main and still turns
// main's run red, so the run may have concluded failure, but only when every
// other job passed. The phone's own gates run in ios-release.yml before
// TestFlight, and the release's phone job still waits for a TestFlight build.
// The prefix is the phone call's job key in main.yml (tests derive it there).
export const PHONE_PREFIX = "phone / ";

export function verifyMainEvidence(run, jobs, repository, source) {
  const desktop = jobs.filter((job) => !job.name.startsWith(PHONE_PREFIX));
  if (run.path !== ".github/workflows/main.yml" || run.event !== "push" ||
      run.head_branch !== "main" || run.head_repository?.full_name !== repository ||
      run.repository?.full_name !== repository || run.head_sha !== source ||
      run.status !== "completed" || !["success", "failure"].includes(run.conclusion))
    throw new Error("Alpha reuse needs a successful rolling-main push for this exact source.");
  const green = (job) => job.status === "completed" && job.conclusion === "success";
  const passed = (name) => desktop.some((job) => job.name === name && green(job));
  const journeys = desktop.filter((job) => job.name.startsWith("verify / linux-e2e / "));
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
  if (!passed("verify / linux-checks") || !passed("verify / mac") ||
      !journeys.length || !journeys.every(green) || !completeJourneys ||
      desktop.some((job) => job.status !== "completed" ||
        !["success", "skipped"].includes(job.conclusion)))
    throw new Error("The rolling-main run did not complete every full-check owner successfully.");
  if (jobs.some((job) => job.run_id !== run.id || (!Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > run.run_attempt) ||
      job.head_sha !== source))
    throw new Error("Rolling-main jobs must belong to this source and a completed attempt of this run.");
  return { source, runId: run.id, attempt: run.run_attempt, url: run.html_url };
}
