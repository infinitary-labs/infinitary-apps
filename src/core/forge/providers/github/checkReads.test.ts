import { describe, expect, it } from "vitest";
import { stub } from "../../../../../tests/helpers/githubForgeStub";

describe("GitHub pull request check ownership (issue #89)", () => {
  it.each([true, false])(
    "keeps shared-head runs on their own PR (GitHub includes PR links: %s)",
    async (withLinks) => {
      const change = {
        number: 1906,
        url: null,
        branch: "renovate/major-i18n",
        headSha: "feedbeef",
      };
      const original = {
        id: 44058666404,
        name: "CI",
        head_branch: change.branch,
        head_repository: { full_name: "octo/meter" },
        event: "pull_request",
        run_number: 819,
        workflow_id: 386227718,
        check_suite_id: 107973566509,
        status: "completed",
        pull_requests: withLinks ? [{ number: 1906 }] : [],
      };
      const duplicate = {
        ...original,
        id: 44062516965,
        head_branch: "fm/task-alias",
        run_number: 820,
        check_suite_id: 107973566510,
        pull_requests: withLinks ? [{ number: 1948 }] : [],
      };
      const job = (suite: number, conclusion: string) => ({
        name: "Browser invariants",
        status: "completed",
        conclusion,
        check_suite: { id: suite },
      });
      let foreign = duplicate;
      const request = {
        number: change.number,
        head: { sha: change.headSha, ref: change.branch, repo: { full_name: "octo/meter" } },
      };
      let requests = [request];
      const { forge } = await stub({
        "GET /repos/octo/meter/pulls": () => ({ json: requests }),
        "GET /repos/octo/meter/commits/feedbeef/check-runs": () => ({
          json: {
            check_runs: [
              job(original.check_suite_id, "success"),
              job(duplicate.check_suite_id, "failure"),
            ],
          },
        }),
        "GET /repos/octo/meter/commits/feedbeef/status": () => ({ json: { statuses: [] } }),
        "GET /repos/octo/meter/actions/runs": () => ({
          json: { total_count: 2, workflow_runs: [foreign, original] },
        }),
      });
      const read = await forge.checks(change);
      expect({
        complete: read.complete,
        checks: read.items.map(({ state, run }) => [state, run]),
      }).toEqual({ complete: true, checks: [["success", 44058666404]] });
      if (withLinks) {
        // Once the duplicate closes, GitHub can link its run only to the surviving request.
        foreign = { ...duplicate, pull_requests: original.pull_requests };
        expect((await forge.checks(change)).items.map((job) => [job.state, job.run])).toEqual([
          ["success", original.id],
        ]);
      }
      // The same source branch in a different fork can also share this head.
      foreign = {
        ...duplicate,
        head_branch: change.branch,
        head_repository: { full_name: "someone/meter" },
        pull_requests: original.pull_requests,
        status: "queued",
      };
      const withForeignQueued = await forge.checks(change);
      expect(withForeignQueued.items.map((job) => job.run)).toEqual([original.id]);
      console.log("Shared-head fixture", {
        pull: change.number,
        withLinks,
        read,
        withForeignQueued,
      });
      if (!withLinks) {
        requests = [...requests, { ...request, number: 1948 }];
        expect(await forge.checks(change)).toMatchObject({
          complete: false,
          items: [],
          problem: expect.stringContaining("did not identify"),
        });
      }
    },
  );

  it.each([false, true])(
    "disambiguates shared-head PR links unless they name the same source (same source: %s)",
    async (sameSource) => {
      const change = { number: 1906, url: null, branch: "work/selected", headSha: "feedbeef" };
      const shared = [
        { number: 1906, head: { ref: change.branch, repo: { id: 17 } } },
        {
          number: 1948,
          head: { ref: sameSource ? change.branch : "work/alias", repo: { id: 17 } },
        },
      ];
      const first = {
        id: 1,
        check_suite_id: 11,
        workflow_id: 6,
        event: "pull_request",
        run_number: 1,
        status: "completed",
        head_branch: change.branch,
        head_repository: { id: 17, full_name: "octo/meter" },
        pull_requests: shared,
      };
      const second = {
        ...first,
        id: 2,
        check_suite_id: 12,
        run_number: 2,
        head_branch: shared[1]?.head.ref,
      };
      const job = (suite: number, conclusion: string) => ({
        name: "Build",
        status: "completed",
        conclusion,
        check_suite: { id: suite },
      });
      const { forge } = await stub({
        "GET /repos/octo/meter/commits/feedbeef/check-runs": () => ({
          json: { check_runs: [job(11, "success"), job(12, "failure")] },
        }),
        "GET /repos/octo/meter/commits/feedbeef/status": () => ({ json: { statuses: [] } }),
        "GET /repos/octo/meter/actions/runs": () => ({
          json: { total_count: 2, workflow_runs: [second, first] },
        }),
      });
      const read = await forge.checks(change);
      console.log("Shared workflow links", { sameSource, read });
      expect({
        complete: read.complete,
        jobs: read.items.map(({ state, run }) => [state, run]),
      }).toEqual(
        sameSource ? { complete: false, jobs: [] } : { complete: true, jobs: [["success", 1]] },
      );
    },
  );
});
