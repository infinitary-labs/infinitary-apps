import { describe, expect, it } from "vitest";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows.ts";

type Job = { if?: string; strategy?: { matrix?: { shard?: number[] } } };
const jobs = loadYamlFile(".github/workflows/ci.yml").jobs as Record<string, Job>;
const selected = (event: string) =>
  Object.entries(jobs)
    .filter(
      ([, job]) =>
        job.if === undefined || workflowValue(job.if, { github: { event_name: event } }) === true,
    )
    .map(([name]) => name)
    .sort();

// The captain's INF-2273 ruling supersedes INF-2203's CI repeat shards:
// edited unit files get ordinary coverage plus two more locally, so PR CI
// must not duplicate that work. Local round counts belong to unit-repeats.test.ts.
describe("PR CI leaves edited-unit rounds to local proof", () => {
  it("selects only the retained baseline jobs for a pull request", () => {
    // INF-2234's independently approved main change also keeps probe sweeps off PRs.
    // DOP-251's plan moves the Linux startup fixtures into a pull request job
    // of their own beside the baseline; neither runs a unit cohort.
    expect(selected("pull_request")).toEqual(["linux-startup", "typecheck-lint-build"]);
  });

  it.each(["push", "workflow_dispatch"])(
    "preserves full ordinary cohorts on %s, without repeat jobs",
    (event) => {
      expect(selected(event)).toEqual([
        "integration-tests",
        "probe-tests",
        "typecheck-lint-build",
        "unit-tests",
      ]);
      expect(jobs["integration-tests"]?.strategy?.matrix?.shard).toEqual([1, 2]);
    },
  );
});
