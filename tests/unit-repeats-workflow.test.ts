import { describe, expect, it } from "vitest";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows.ts";

type Job = { if?: string; strategy?: { matrix?: { shard?: number[] } } };
const jobs = loadYamlFile(".github/workflows/ci.yml").jobs as Record<string, Job>;
// A request runs the sweeps only when it sets ci.yml's `sweep` input. The
// code checks count one part of the tests a change reaches, so the later
// parts' job starts nothing (release-workflows-pr-checks.test.ts holds a
// wider change's, INF-5493).
const needs = { "code-checks": { outputs: { "reach-parts": "" } } };
const selected = (event: string, sweep = event !== "pull_request") =>
  Object.entries(jobs)
    .filter(
      ([, job]) =>
        job.if === undefined ||
        workflowValue(job.if, { github: { event_name: event }, inputs: { sweep }, needs }) === true,
    )
    .map(([name]) => name)
    .sort();

// The captain's INF-2273 ruling supersedes INF-2203's CI repeat shards:
// edited unit files get ordinary coverage plus two more locally, so PR CI
// adds no repeat job; its build check runs each edited file once (INF-3690's
// gap 3). Round counts and that selection belong to unit-repeats.test.ts.
describe("PR CI leaves edited-unit rounds to local proof", () => {
  it("selects only the retained baseline jobs for a pull request", () => {
    // INF-2234's independently approved main change also keeps probe sweeps off PRs.
    // INF-2915's plan leaves one pull request job: the startup fixtures leave
    // the pull request and the critical path runs inside the build check;
    // it runs no unit cohort.
    // INF-5577's review split that job into three side by side.
    expect(selected("pull_request")).toEqual(["build", "code-checks", "reached-tests"]);
  });

  it("selects only the code and build jobs for a request that does not ask for the sweep", () => {
    expect(selected("workflow_dispatch", false)).toEqual(["build", "code-checks"]);
  });

  it.each([
    ["push", ["reached-tests"]],
    ["workflow_dispatch", []],
  ])("preserves full ordinary cohorts on %s, without repeat jobs", (event, reached) => {
    expect(selected(event)).toEqual(
      ["build", "code-checks", "integration-tests", "probe-tests", ...reached, "unit-tests"].sort(),
    );
    expect(jobs["integration-tests"]?.strategy?.matrix?.shard).toEqual([1, 2]);
  });
});
