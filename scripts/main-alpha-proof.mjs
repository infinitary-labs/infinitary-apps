/** INF-2259: reuse only a complete successful rolling-main run for its exact
 * source. This grants no substitute for release-specific package/update gates.
 * The caller reads the run and its latest job executions from GitHub, not artifacts.
 */
// The phone waiver (INF-2340's no-phone-gate route, the captain's pick: "Cut
// alphas without the phone check until PR #862 and PR #865 land"): until
// INF-2101 and INF-2305 merge, a failed phone call on main does not stop the
// cut. Its jobs still run and still turn main's run red, so the run may have
// concluded failure, but only when every other job passed. Restoring the gate
// (INF-2352) deletes this prefix and the failure conclusion below.
const WAIVED_PREFIX = "phone / ";

export function verifyMainEvidence(run, jobs, repository, source) {
  if (run.path !== ".github/workflows/main.yml" || run.event !== "push" ||
      run.head_branch !== "main" || run.head_repository?.full_name !== repository ||
      run.repository?.full_name !== repository || run.head_sha !== source ||
      run.status !== "completed" || !["success", "failure"].includes(run.conclusion))
    throw new Error("Alpha reuse needs a successful rolling-main push for this exact source.");
  const green = (job) => job.status === "completed" && job.conclusion === "success";
  const passed = (name) => jobs.some((job) => job.name === name && green(job));
  const journeys = jobs.filter((job) => job.name.startsWith("verify / linux-e2e / "));
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
      jobs.some((job) => job.status !== "completed" ||
        (!job.name.startsWith(WAIVED_PREFIX) && !["success", "skipped"].includes(job.conclusion))))
    throw new Error("The rolling-main run did not complete every full-check owner successfully.");
  if (jobs.some((job) => job.run_id !== run.id || (!Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > run.run_attempt) ||
      job.head_sha !== source))
    throw new Error("Rolling-main jobs must belong to this source and a completed attempt of this run.");
  return { source, runId: run.id, attempt: run.run_attempt, url: run.html_url };
}
