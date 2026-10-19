import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Api,
  cancelOlderRuns,
  type Job,
  type PhoneRun,
  replacedRunVerdict,
  stopIfReplaced,
} from "../scripts/replaced-phone-runs";

// INF-487: PR #135's current version (run 147) waited behind its own older run 142,
// whose native job held a Mac mini place for hours with no simulator. These are
// GitHub's answers for those runs on 2026-10-19 (INF-486), trimmed to what the script reads.
type Step = {
  name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
};
type Reading = Omit<Job, "steps"> & {
  created_at: string;
  started_at: string;
  completed_at: string | null;
  steps?: Step[];
};
const readings = JSON.parse(readFileSync("tests/fixtures/phone-runs/2026-10-19.json", "utf8")) as {
  runs: Record<string, unknown>;
  jobs: Record<string, { jobs: Reading[] }>;
  pulls: Record<string, unknown>;
};
const run142 = readings.jobs["39198269397"]?.jobs ?? [];

// Run 142's jobs as GitHub reported them at an earlier moment, from their own timestamps.
function asOf(jobs: readonly Reading[], instant: string): Job[] {
  return jobs.flatMap((job) => {
    if (instant < job.created_at) return [];
    if (instant < job.started_at) return [{ ...job, status: "pending", steps: [] }];
    if (job.completed_at !== null && job.completed_at <= instant) return [job];
    const steps = (job.steps ?? []).map((step) => ({
      ...step,
      status:
        step.started_at === null || instant < step.started_at
          ? "pending"
          : step.completed_at !== null && step.completed_at <= instant
            ? "completed"
            : "in_progress",
    }));
    return [{ ...job, status: "in_progress", steps }];
  });
}

function github(): Api & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    get: async (path) => {
      const url = new URL(path, "https://api.github.com");
      const runs =
        /^\/repos\/infinitary-labs\/infinitary\/actions\/workflows\/phone\.yml\/runs$/.test(
          url.pathname,
        ) && url.searchParams.get("event") === "pull_request"
          ? readings.runs[url.searchParams.get("branch") ?? ""]
          : undefined;
      const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname)?.[1];
      const pull = /\/pulls\/(\d+)$/.exec(url.pathname)?.[1];
      const answer = runs ?? (jobs ? readings.jobs[jobs] : pull ? readings.pulls[pull] : undefined);
      if (!answer) throw new Error(`GET ${path} answered 404`);
      return answer;
    },
    post: async (path) => {
      cancelled.push(/\/actions\/runs\/(\d+)\/cancel$/.exec(path)?.[1] ?? path);
      return 202;
    },
  };
}

const run = (
  runId: number,
  runNumber: number,
  pull: number,
  branch: string,
  headSha: string,
): PhoneRun => ({
  repository: "infinitary-labs/infinitary",
  workflow: "phone.yml",
  runId,
  runNumber,
  pull,
  branch,
  headSha,
});
const run147 = run(
  39202032038,
  147,
  135,
  "fm/task-d1ec1847",
  "cca4d624cef32686c634c1c0b8313cce42da50f6",
);
const run151 = run(
  39208139891,
  151,
  141,
  "fm/task-34804b14",
  "0ba54c45f7fd4379f7adac12cccd56e5ffd8f140",
);
const run154 = run(
  39209137713,
  154,
  141,
  "fm/task-34804b14",
  "e0e605e9e8a51239c6874d31f71bfcc894afe0ee",
);

describe("a replaced phone run", () => {
  it.each([
    ["2026-10-19T04:57:04Z", true, "waiting for the Mac mini"],
    ["2026-10-19T06:38:00Z", true, "has not started a device gate"],
    ["2026-10-19T06:50:00Z", false, "Read and recover on iPhone"],
    ["2026-10-19T07:05:00Z", false, "Read and recover on iPad"],
  ])("is cancelled at %s only while no device gate has started (%s)", (instant, cancel, why) => {
    const verdict = replacedRunVerdict(asOf(run142, instant));
    expect(verdict.cancel).toBe(cancel);
    expect(verdict.why).toContain(why);
  });
  it("is cancelled before its chooser has created the native job", () => {
    expect(replacedRunVerdict(asOf(run142, "2026-10-19T04:12:10Z")).cancel).toBe(true);
  });

  it("gives up its Mac mini place when the pull request's newer run starts", async () => {
    const api = github();
    expect(await cancelOlderRuns(api, run154)).toEqual([
      "Cancelled run 151: its native job is waiting for the Mac mini.",
    ]);
    expect(api.cancelled).toEqual(["39208139891"]);
  });
  it("keeps an older run whose device gate already started, and never touches a newer run", async () => {
    const api = github();
    expect(await cancelOlderRuns(api, run147)).toEqual([
      'Kept run 142: "Read and recover on iPad" already started and deletes its own simulator.',
    ]);
    expect(await cancelOlderRuns(api, run151)).toEqual([
      "No older phone run of this pull request is still going.",
    ]);
    expect(api.cancelled).toEqual([]);
  });

  it("cancels its own run between the gates once a newer push replaced its version", async () => {
    const api = github();
    expect(await stopIfReplaced(api, run151)).toMatchObject({ replaced: true });
    expect(api.cancelled).toEqual(["39208139891"]);
    expect(await stopIfReplaced(api, run154)).toMatchObject({ replaced: false });
    expect(api.cancelled).toEqual(["39208139891"]);
  });
});
