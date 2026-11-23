import { describe, expect, it } from "vitest";
import { ForgeAllowanceSpent } from "../../forge";
import { conditionalGets } from "./conditionalGets";
import { GitHubForge } from "./githubForge";

/**
 * INF-2149: the fleet spent the sign-in's 5,000-call hourly allowance on
 * the host's own timed reads, most of which found nothing changed. GitHub
 * answers a read sent with the last answer's ETag in `If-None-Match` with a
 * 304 that it does not count against the allowance. These tests run the
 * real GitHub client through `conditionalGets` against a stand-in of
 * GitHub's REST API that tags its answers, honours `If-None-Match`, and
 * counts a call only when it answers in full, as GitHub does.
 */

const RESET = 1_793_498_141;

type Answer = { json: unknown; etag: string };

function standInGitHub(answers: Record<string, Answer>) {
  const state = { charged: 0, remaining: 5_000, spent: false };
  const sent: { path: string; token: string | null; ifNoneMatch: string | null }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const path = `${url.pathname}${url.search}`;
    sent.push({
      path,
      token: headers.get("authorization"),
      ifNoneMatch: headers.get("if-none-match"),
    });
    const limits = () => ({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(state.remaining),
      "x-ratelimit-reset": String(RESET),
    });
    if (state.spent)
      return new Response(
        JSON.stringify({
          message: "API rate limit exceeded for user ID 3233006.",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...limits(),
            "x-ratelimit-remaining": "0",
          },
        },
      );
    const answer = answers[path];
    if (!answer) {
      state.charged += 1;
      state.remaining -= 1;
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8", ...limits() },
      });
    }
    if ((init?.method ?? "GET") === "GET" && headers.get("if-none-match") === answer.etag)
      return new Response(null, { status: 304, headers: { etag: answer.etag, ...limits() } });
    state.charged += 1;
    state.remaining -= 1;
    return new Response(JSON.stringify(answer.json), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: answer.etag,
        ...limits(),
      },
    });
  };
  return { fetcher, state, sent };
}

const REPO = "/repos/kunchenguid/infinitary";
const SHA = "c342747a2d8f3e8b1c6e4f0a9b7d5e3c1a2b4d6f";
const CHANGE = {
  number: 2151,
  url: "https://github.com/kunchenguid/infinitary/pull/2151",
  branch: "fm/task-7d851b8a",
  headSha: SHA,
};

function checkRuns(status: "in_progress" | "completed") {
  return {
    total_count: 2,
    check_runs: [
      {
        name: "typecheck-lint-build",
        status: "completed",
        conclusion: "success",
        check_suite: { id: 41_200_118_501 },
        started_at: "2026-10-31T23:50:12Z",
        completed_at: "2026-10-31T23:56:40Z",
      },
      {
        name: "unit-tests",
        status,
        conclusion: status === "completed" ? "success" : null,
        check_suite: { id: 41_200_118_501 },
        started_at: "2026-10-31T23:50:12Z",
        completed_at: status === "completed" ? "2026-11-01T00:02:09Z" : null,
      },
    ],
  };
}

function answersFor(status: "in_progress" | "completed"): Record<string, Answer> {
  return {
    [`${REPO}/commits/${SHA}/check-runs?per_page=100&page=1`]: {
      json: checkRuns(status),
      etag: `W/"check-runs-${status}"`,
    },
    [`${REPO}/commits/${SHA}/status?per_page=100&page=1`]: {
      json: { state: "pending", statuses: [], total_count: 0 },
      etag: 'W/"status-empty"',
    },
    [`${REPO}/actions/runs?head_sha=${SHA}&per_page=100`]: {
      json: {
        total_count: 1,
        workflow_runs: [
          {
            id: 18_993_001_244,
            name: "ci",
            check_suite_id: 41_200_118_501,
            workflow_id: 99_812_331,
            event: "pull_request",
            run_number: 9_120,
            status: status === "completed" ? "completed" : "in_progress",
            run_started_at: "2026-10-31T23:50:05Z",
          },
        ],
      },
      etag: `W/"runs-${status}"`,
    },
    "/user": { json: { login: "kunchenguid", id: 3_233_006 }, etag: 'W/"user"' },
  };
}

function forgeOver(fetcher: typeof fetch, token = "gho_captain") {
  return new GitHubForge(
    { kind: "github", host: "github.com", owner: "kunchenguid", name: "infinitary", dir: "/r" },
    { token: async () => token, apiBaseUrl: "https://api.github.com", fetch: fetcher },
  );
}

describe("conditional GitHub reads (INF-2149)", () => {
  it("reads unchanged checks again for none of the hourly allowance, with the same result", async () => {
    const github = standInGitHub(answersFor("in_progress"));
    const reads = conditionalGets(github.fetcher as typeof fetch);
    const first = await forgeOver(reads).checks(CHANGE);
    const afterFirst = github.state.charged;
    expect(afterFirst).toBe(3);
    // The app builds a new client per call; the kept answers outlive it.
    const second = await forgeOver(reads).checks(CHANGE);
    expect(second).toEqual(first);
    expect(github.state.charged).toBe(afterFirst);
    expect(github.sent.slice(3).every((request) => request.ifNoneMatch !== null)).toBe(true);
    const plain = standInGitHub(answersFor("in_progress"));
    await forgeOver(plain.fetcher as typeof fetch).checks(CHANGE);
    await forgeOver(plain.fetcher as typeof fetch).checks(CHANGE);
    expect(plain.state.charged).toBe(6);
  });

  it("reads a changed answer in full, never the kept one", async () => {
    const answers = answersFor("in_progress");
    const github = standInGitHub(answers);
    const reads = conditionalGets(github.fetcher as typeof fetch);
    const running = await forgeOver(reads).checks(CHANGE);
    expect(running.items.find((check) => check.name === "unit-tests")?.state).toBe("pending");
    Object.assign(answers, answersFor("completed"));
    const finished = await forgeOver(reads).checks(CHANGE);
    expect(finished.items.find((check) => check.name === "unit-tests")?.state).toBe("success");
  });

  it("answers the gateway's read with the kept body and the 304's fresh allowance", async () => {
    const github = standInGitHub(answersFor("in_progress"));
    const reads = conditionalGets(github.fetcher as typeof fetch);
    const forge = forgeOver(reads);
    const first = await forge.api.call("GET", "/user");
    github.state.remaining = 4_321;
    const again = await forge.api.call("GET", "/user");
    expect(again).toMatchObject({
      status: 200,
      body: first.body,
      rateLimit: { remaining: 4_321 },
    });
    expect(github.state.charged).toBe(1);
  });

  it("never lends one sign-in's kept answer to another", async () => {
    const github = standInGitHub(answersFor("in_progress"));
    const reads = conditionalGets(github.fetcher as typeof fetch);
    await forgeOver(reads, "gho_captain").api.call("GET", "/user");
    await forgeOver(reads, "gho_other").api.call("GET", "/user");
    expect(github.sent.map((request) => request.ifNoneMatch)).toEqual([null, null]);
    expect(github.state.charged).toBe(2);
  });

  it("names a spent allowance with GitHub's reset time", async () => {
    const github = standInGitHub(answersFor("in_progress"));
    github.state.spent = true;
    const caught = await forgeOver(conditionalGets(github.fetcher as typeof fetch))
      .checks(CHANGE)
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ForgeAllowanceSpent);
    expect(caught).toMatchObject({
      failure: "permission",
      resetAt: RESET * 1000,
      message: expect.stringContaining("the hourly allowance is spent"),
    });
  });
});
