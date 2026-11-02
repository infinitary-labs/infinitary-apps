/** INF-2259: reuse only a complete successful rolling-main run for its exact
 * source. This grants no substitute for release-specific package/update gates.
 * The caller reads the run and its latest job executions from GitHub, not artifacts.
 */
export function verifyMainEvidence(run, jobs, repository, source) {
  if (run.path !== ".github/workflows/main.yml" || run.event !== "push" ||
      run.head_branch !== "main" || run.head_repository?.full_name !== repository ||
      run.repository?.full_name !== repository || run.head_sha !== source ||
      run.status !== "completed" || run.conclusion !== "success")
    throw new Error("Alpha reuse needs a successful rolling-main push for this exact source.");
  const green = (job) => job.status === "completed" && job.conclusion === "success";
  const passed = (name) => jobs.some((job) => job.name === name && green(job));
  const journeys = jobs.filter((job) => job.name.startsWith("verify / linux-e2e / "));
  const completeJourneys = ["parallel", "desktop", "run alone"].every((lane) => {
    const shards = journeys.filter((job) => job.name.includes(`(${lane} `)).map((job) => {
      const match = / (\d+)\/(\d+)\)$/.exec(job.name);
      return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
    });
    const total = shards[0]?.total;
    return total > 0 && shards.length === total &&
      new Set(shards.map((shard) => shard?.index)).size === total &&
      shards.every((shard) => shard && shard.total === total && shard.index >= 1 && shard.index <= total);
  });
  // Full source coverage includes parallel, desktop and fresh-state shards.
  // All jobs of the successful run must be completed; an optional lane may skip,
  // but none of these full-check owners may be skipped or merely absent.
  if (!passed("verify / linux-checks") || !passed("verify / mac") ||
      !passed("phone / native-phone") || !journeys.length || !journeys.every(green) ||
      !completeJourneys ||
      jobs.some((job) => job.status !== "completed" ||
        !["success", "skipped"].includes(job.conclusion)))
    throw new Error("The rolling-main run did not complete every full-check owner successfully.");
  if (jobs.some((job) => job.run_id !== run.id || (!Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1 || job.run_attempt > run.run_attempt) ||
      job.head_sha !== source))
    throw new Error("Rolling-main jobs must belong to this source and a completed attempt of this run.");
  return { source, runId: run.id, attempt: run.run_attempt, url: run.html_url };
}
