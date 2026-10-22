import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Api,
  cancelOlderRuns,
  type Job,
  type PhoneRun,
  pullRequestRun,
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

function github(pulls = readings.pulls): Api & { cancelled: string[] } {
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
      const answer = runs ?? (jobs ? readings.jobs[jobs] : pull ? pulls[pull] : undefined);
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

// INF-895 (found by INF-891): PR #184 merged at 8:46 AM on 2026-10-22, its head unmoved, and its
// phone run 439 still started a 28-minute device gate at 11:45 AM while PR #285's run 433 waited
// in the same one-at-a-time phone line. GitHub's answers for those pull requests, trimmed.
const closings = JSON.parse(readFileSync("tests/fixtures/phone-runs/2026-10-22.json", "utf8")) as {
  runs: Record<
    string,
    { id: number; run_number: number; head_branch: string; head_sha: string; pull: number }
  >;
  pulls: Record<string, unknown>;
};
const closingRun = (id: string): PhoneRun => {
  const reading = closings.runs[id];
  if (!reading) throw new Error(`No reading of run ${id}`);
  return run(reading.id, reading.run_number, reading.pull, reading.head_branch, reading.head_sha);
};

describe("a phone run whose pull request merged or closed", () => {
  it("cancels its own run before the device gate once its pull request merged", async () => {
    const api = github(closings.pulls);
    const stop = await stopIfReplaced(api, closingRun("39807451798"));
    expect(stop).toMatchObject({ replaced: true });
    expect(stop.line).toContain("#184 merged");
    expect(api.cancelled).toEqual(["39807451798"]);
  });
  it("cancels its own run before the device gate once its pull request closed without merging", async () => {
    const api = github(closings.pulls);
    const stop = await stopIfReplaced(api, closingRun("39319253914"));
    expect(stop).toMatchObject({ replaced: true });
    expect(stop.line).toContain("#162 closed without merging");
    expect(api.cancelled).toEqual(["39319253914"]);
  });
  it("still starts the device gate of an open pull request at its latest version", async () => {
    const api = github(closings.pulls);
    expect(await stopIfReplaced(api, closingRun("39805546269"))).toMatchObject({ replaced: false });
    expect(api.cancelled).toEqual([]);
  });
});

// INF-663 (captain: "add a nightly phone check" on main): a run started on request has no
// pull request, so nothing replaces it and its device gates run.
describe("a phone run started on request", () => {
  const env = (name: string) =>
    ({
      GITHUB_WORKFLOW_REF: "infinitary-labs/infinitary/.github/workflows/phone.yml@refs/heads/main",
      GITHUB_REPOSITORY: "infinitary-labs/infinitary",
      GITHUB_RUN_ID: "39202032038",
      GITHUB_RUN_NUMBER: "147",
    })[name] ?? "";
  it("is no pull request's run", () => {
    const dispatch = {
      inputs: {},
      ref: "refs/heads/main",
      workflow: ".github/workflows/phone.yml",
    };
    expect(pullRequestRun(dispatch, env)).toBeUndefined();
  });
  it("still reads a pull request's run from its event", () => {
    const event = {
      pull_request: { number: 135, head: { ref: run147.branch, sha: run147.headSha } },
    };
    expect(pullRequestRun(event, env)).toEqual(run147);
  });
});
