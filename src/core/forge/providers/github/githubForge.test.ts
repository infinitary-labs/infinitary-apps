import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readOpenChanges } from "./changes";
import {
  GITHUB_API_URL,
  GitHubForge,
  githubApiBaseFor,
  githubApiBaseUrl,
  githubGraphqlUrl,
} from "./githubForge";

/**
 * The REST GitHub forge against a local stub of GitHub's API (git
 * integration PR 1.1): real HTTP, real headers, the green rule over check
 * runs AND commit statuses, and every failure typed. PR 1.2 binds it to the
 * app's own GitHub sign-in; here the token is the test's.
 */

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: unknown };
type Route = (seen: Seen) => { status?: number; json?: unknown; headers?: Record<string, string> };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stub(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(entry);
      const path = entry.url.split("?")[0];
      const route = routes[`${entry.method} ${path}`];
      const answer = route ? route(entry) : { status: 404, json: { message: "Not Found" } };
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...(answer.headers ?? {}),
      });
      res.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
  const { port } = listening.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/r" },
    { token: async () => "gho_test", apiBaseUrl: base },
  );
  return { seen, forge, base };
}

const PULL = {
  number: 23,
  html_url: "https://github.com/octo/meter/pull/23",
  title: "fix: correct meter",
  body: "Why",
  head: { sha: "feedbeef", ref: "fm/task-1" },
};

describe("GitHubForge", () => {
  it("finds the open change for a branch, with the person's sign-in and GitHub's API headers", async () => {
    const { seen, forge } = await stub({ "GET /repos/octo/meter/pulls": () => ({ json: [PULL] }) });
    const change = await forge.changeFor("fm/task-1");
    expect(change).toEqual({
      number: 23,
      url: "https://github.com/octo/meter/pull/23",
      branch: "fm/task-1",
      headSha: "feedbeef",
      title: "fix: correct meter",
      body: "Why",
    });
    expect(forge.label(change as NonNullable<typeof change>)).toBe("#23");
    const [request] = seen;
    expect(request?.url).toBe(
      "/repos/octo/meter/pulls?head=octo%3Afm%2Ftask-1&state=open&per_page=1",
    );
    expect(request?.headers.authorization).toBe("Bearer gho_test");
    expect(request?.headers.accept).toBe("application/vnd.github+json");
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("answers no change when GitHub lists none", async () => {
    const { forge } = await stub({ "GET /repos/octo/meter/pulls": () => ({ json: [] }) });
    await expect(forge.changeFor("fm/task-1")).resolves.toBeNull();
  });

  it("reads an empty check list as not started once GitHub runs workflows for the change or the project", async () => {
    let versionRuns = 0;
    let projectRuns = 0;
    let pull: Record<string, unknown> = { mergeable: true, mergeable_state: "clean" };
    const { forge } = await stub({
      "GET /repos/octo/meter/commits/feedbeef/check-runs": () => ({ json: { check_runs: [] } }),
      "GET /repos/octo/meter/commits/feedbeef/status": () => ({ json: { statuses: [] } }),
      "GET /repos/octo/meter/actions/runs": (request) => ({
        json: { total_count: request.url.includes("head_sha=") ? versionRuns : projectRuns },
      }),
      "GET /repos/octo/meter/pulls/23": () => ({ json: pull }),
    });
    const change = { number: 23, url: null, branch: "b", headSha: "feedbeef" };
    // A project that has never run a pull request workflow runs no checks: green.
    expect(await forge.checks(change)).toEqual({ overall: "green", items: [] });
    // Earlier pull requests ran workflows, so this one's have not started.
    projectRuns = 4;
    const waiting = await forge.checks(change);
    expect(waiting.overall).toBe("pending");
    expect(waiting.items).toEqual([{ name: "checks have not started yet", state: "pending" }]);
    // A run GitHub already holds for the version says the same.
    projectRuns = 0;
    versionRuns = 1;
    expect((await forge.checks(change)).overall).toBe("pending");
    // A conflicting change gets no checks until it is brought up to date, and says so.
    projectRuns = 4;
    pull = { mergeable: false, mergeable_state: "dirty" };
    const conflicted = await forge.checks(change);
    expect(conflicted.overall).toBe("pending");
    expect(conflicted.items[0]?.name).toContain("brought up to date");
  });

  it("reads check runs and commit statuses together by the one green rule", async () => {
    let runs: { name: string; status: string; conclusion: string | null }[] = [];
    let statuses: { context: string; state: string }[] = [];
    const { forge, seen } = await stub({
      "GET /repos/octo/meter/commits/feedbeef/check-runs": () => ({
        json: { total_count: runs.length, check_runs: runs },
      }),
      "GET /repos/octo/meter/commits/feedbeef/status": () => ({ json: { statuses } }),
    });
    const change = {
      number: 23,
      url: null,
      branch: "b",
      headSha: "feedbeef",
      title: "fix: correct meter",
      body: "Why",
    };
    // Zero of both: green, so a project with no checks can still put work in.
    expect(await forge.checks(change)).toEqual({ overall: "green", items: [] });
    runs = [{ name: "linux-checks", status: "completed", conclusion: "success" }];
    statuses = [{ context: "deploy/preview", state: "success" }];
    expect(await forge.checks(change)).toEqual({
      overall: "green",
      items: [
        { name: "linux-checks", state: "success" },
        { name: "deploy/preview", state: "success" },
      ],
    });
    // A queued run or a pending status is not green yet, and not red.
    runs = [{ name: "linux-checks", status: "queued", conclusion: null }];
    expect((await forge.checks(change)).overall).toBe("pending");
    // A conditional skipped run is finished and does not block green.
    runs = [{ name: "linux-checks", status: "completed", conclusion: "skipped" }];
    expect((await forge.checks(change)).overall).toBe("green");
    // Skips do not hide unfinished runs or change the neutral policy.
    runs.push({ name: "review", status: "in_progress", conclusion: null });
    expect((await forge.checks(change)).overall).toBe("pending");
    runs = [{ name: "review", status: "completed", conclusion: "neutral" }];
    expect((await forge.checks(change)).overall).toBe("pending");
    // Any terminal failure on either source is red.
    runs = [{ name: "linux-checks", status: "completed", conclusion: "success" }];
    statuses = [{ context: "deploy/preview", state: "failure" }];
    expect((await forge.checks(change)).overall).toBe("red");
    expect(seen.every((request) => request.method === "GET")).toBe(true);
  });

  it("sets aside a cancelled check only when a later run of the same workflow and event decides it", async () => {
    type Run = { id: number; workflow: number; event: string; status: string };
    type Check = { name: string; status: string; conclusion: string | null; suite?: number };
    let workflowRuns: Run[] = [];
    let checks: Check[] = [];
    let runsAnswer: { status: number; json: unknown } | undefined;
    const { forge, seen } = await stub({
      "GET /repos/octo/meter/commits/feedbeef/check-runs": () => ({
        json: {
          check_runs: checks.map(({ suite, ...run }) =>
            suite === undefined ? run : { ...run, check_suite: { id: suite } },
          ),
        },
      }),
      "GET /repos/octo/meter/commits/feedbeef/status": () => ({ json: { statuses: [] } }),
      "GET /repos/octo/meter/actions/runs": () =>
        runsAnswer ?? {
          json: {
            total_count: workflowRuns.length,
            workflow_runs: workflowRuns.map((run) => ({
              id: run.id,
              check_suite_id: run.id * 10,
              workflow_id: run.workflow,
              event: run.event,
              run_number: run.id,
              status: run.status,
              head_sha: "feedbeef",
            })),
          },
        },
    });
    const change = { number: 23, url: null, branch: "b", headSha: "feedbeef" };
    const ci = (id: number, status = "completed"): Run => ({
      id,
      workflow: 7,
      event: "pull_request",
      status,
    });
    const check = (suite: number, conclusion: string | null, status = "completed"): Check => ({
      name: "linux-checks",
      status,
      conclusion,
      suite: suite * 10,
    });
    const actionsReads = () =>
      seen.filter((request) => request.url.startsWith("/repos/octo/meter/actions/runs")).length;

    // Read the workflow list once even without a cancellation: waiting jobs
    // may not have created checks yet.
    workflowRuns = [ci(41)];
    checks = [check(41, "success")];
    expect((await forge.checks(change)).overall).toBe("green");
    expect(actionsReads()).toBe(1);

    // PR #632's version: one push started two runs of ci, the second
    // cancelled the first before it began, and the second passed.
    workflowRuns = [ci(42), ci(41)];
    checks = [check(41, "cancelled"), check(42, "success")];
    expect(await forge.checks(change)).toEqual({
      overall: "green",
      items: [{ name: "linux-checks", state: "success" }],
    });
    expect(seen.at(-1)?.url).toBe("/repos/octo/meter/actions/runs?head_sha=feedbeef&per_page=100");

    // The later run's own check decides, whatever it reads.
    checks = [check(41, "cancelled"), check(42, null, "in_progress")];
    expect((await forge.checks(change)).overall).toBe("pending");
    checks = [check(41, "cancelled"), check(42, "failure")];
    expect((await forge.checks(change)).overall).toBe("red");

    // A later run that has not created the check yet: pending, never green.
    workflowRuns = [ci(42, "queued"), ci(41)];
    checks = [check(41, "cancelled"), { name: "lint", status: "completed", conclusion: "success" }];
    expect(await forge.checks(change)).toEqual({
      overall: "pending",
      items: [
        { name: "linux-checks", state: "pending" },
        { name: "lint", state: "success" },
        { name: "workflow (run 42)", state: "pending" },
      ],
    });
    // Finished without it, the cancellation still counts.
    workflowRuns = [ci(42), ci(41)];
    expect((await forge.checks(change)).overall).toBe("red");

    // Only a cancellation is set aside: an earlier failure counts beside a later pass.
    checks = [check(41, "failure"), check(42, "success")];
    expect((await forge.checks(change)).overall).toBe("red");
    // The latest run's cancellation counts, whatever ran before it.
    checks = [check(41, "success"), check(42, "cancelled")];
    expect((await forge.checks(change)).overall).toBe("red");
    // Another workflow or another event is not the same check, even under one name.
    for (const later of [
      { ...ci(42), workflow: 8 },
      { ...ci(42), event: "push" },
    ]) {
      workflowRuns = [later, ci(41)];
      checks = [check(41, "cancelled"), check(42, "success")];
      expect((await forge.checks(change)).overall).toBe("red");
    }
    // A check the app cannot place in a workflow run counts as it reads.
    workflowRuns = [ci(42), ci(41)];
    checks = [{ ...check(41, "cancelled"), suite: undefined }, check(42, "success")];
    expect((await forge.checks(change)).overall).toBe("red");

    // A side read GitHub refuses leaves every check counted; a hiccup or a
    // refused sign-in fails the reading instead of guessing.
    checks = [check(41, "cancelled"), check(42, "success")];
    runsAnswer = { status: 403, json: { message: "Resource not accessible" } };
    expect((await forge.checks(change)).overall).toBe("red");
    runsAnswer = { status: 503, json: { message: "unavailable" } };
    await expect(forge.checks(change)).rejects.toMatchObject({ failure: "transient" });
    runsAnswer = { status: 401, json: { message: "Bad credentials" } };
    await expect(forge.checks(change)).rejects.toMatchObject({ failure: "sign-in" });
  });

  it("puts the change in only at the checked head, and closes one without putting it in", async () => {
    const { forge, seen } = await stub({
      "PUT /repos/octo/meter/pulls/23/merge": () => ({ json: { merged: true } }),
      "PATCH /repos/octo/meter/pulls/23": () => ({ json: { state: "closed" } }),
    });
    const change = {
      number: 23,
      url: null,
      branch: "b",
      headSha: "feedbeef",
      title: "fix: correct meter",
      body: "Why",
    };
    await forge.putIn(change, "feedbeef");
    await expect(forge.putIn({ ...change, title: "Plain change" }, "feedbeef")).rejects.toThrow(
      /conventional name/,
    );
    await forge.close(change);
    expect(seen.map((request) => [request.method, request.url, request.body])).toEqual([
      [
        "PUT",
        "/repos/octo/meter/pulls/23/merge",
        {
          sha: "feedbeef",
          merge_method: "squash",
          commit_title: "fix: correct meter",
          commit_message: "Why",
        },
      ],
      ["PATCH", "/repos/octo/meter/pulls/23", { state: "closed" }],
    ]);
  });

  it("reads every page of the checks, and never reads a suite it could not finish as green (FI3-304)", async () => {
    const runsPage = (page: number, count: number, conclusion = "success") =>
      Array.from({ length: count }, (_, i) => ({
        name: `job-${page}-${i}`,
        status: "completed",
        conclusion,
      }));
    let total = 130;
    let lastConclusion = "success";
    const { forge, seen } = await stub({
      "GET /repos/octo/meter/commits/feedbeef/check-runs": (request) => {
        const page = Number(new URL(request.url, "http://stub").searchParams.get("page"));
        const remaining = Math.max(0, total - (page - 1) * 100);
        return {
          json: {
            total_count: total,
            check_runs: runsPage(
              page,
              Math.min(100, remaining),
              page === 2 ? lastConclusion : "success",
            ),
          },
        };
      },
      "GET /repos/octo/meter/commits/feedbeef/status": () => ({
        json: { total_count: 1, statuses: [{ context: "deploy", state: "success" }] },
      }),
    });
    const change = { number: 23, url: null, branch: "b", headSha: "feedbeef" };
    const read = await forge.checks(change);
    expect(read.items).toHaveLength(131);
    expect(read.overall).toBe("green");
    expect(
      seen.filter((request) => request.url.includes("/check-runs")).map((request) => request.url),
    ).toEqual([
      "/repos/octo/meter/commits/feedbeef/check-runs?per_page=100&page=1",
      "/repos/octo/meter/commits/feedbeef/check-runs?per_page=100&page=2",
    ]);
    // A failure on the second page is a failure of the suite.
    lastConclusion = "failure";
    expect((await forge.checks(change)).overall).toBe("red");
    // More checks than the pages the app reads: one pending item stands for the rest.
    lastConclusion = "success";
    total = 1_500;
    const past = await forge.checks(change);
    expect(past.overall).toBe("pending");
    expect(past.items.at(-1)).toEqual({ name: "more checks than the app reads", state: "pending" });
  });

  it("reads a pull request by its number with whether it may merge now, in the seam's terms", async () => {
    let pull: Record<string, unknown> = {};
    const { forge } = await stub({
      "GET /repos/octo/meter/pulls/23": () => ({
        json: { ...PULL, state: "open", base: { ref: "main" }, ...pull },
      }),
    });
    const readiness = async (fields: Record<string, unknown>) => {
      pull = fields;
      return (await forge.pull(23)).readiness;
    };
    expect(await readiness({ mergeable: true, mergeable_state: "clean" })).toBe("clean");
    expect(await readiness({ mergeable: true, mergeable_state: "unstable" })).toBe("clean");
    expect(await readiness({ mergeable: false, mergeable_state: "dirty" })).toBe("conflict");
    expect(await readiness({ mergeable: true, mergeable_state: "behind" })).toBe("behind");
    // Branch rules - a required review among them - hold it, whoever is signed in.
    expect(await readiness({ mergeable: true, mergeable_state: "blocked" })).toBe("blocked");
    expect(await readiness({ mergeable: null, mergeable_state: "unknown" })).toBe("computing");
    expect(await readiness({ mergeable: true, mergeable_state: "clean", draft: true })).toBe(
      "draft",
    );
    expect(await readiness({ mergeable: true, mergeable_state: "something-new" })).toBe(
      "computing",
    );
    pull = { state: "closed", merged: true, merge_commit_sha: "squash01" };
    expect(await forge.pull(23)).toEqual({
      number: 23,
      state: "closed",
      merged: true,
      mergedSha: "squash01",
      headSha: "feedbeef",
      base: "main",
      branch: "fm/task-1",
      title: "fix: correct meter",
      readiness: "computing",
    });
  });

  it("takes a merge only when GitHub says it merged, and answers its commit", async () => {
    let answer: unknown = { merged: true, sha: "squash01" };
    const { forge } = await stub({
      "PUT /repos/octo/meter/pulls/23/merge": () => ({ json: answer }),
    });
    const change = { number: 23, url: null, branch: "b", headSha: "feedbeef", title: "fix: meter" };
    await expect(forge.putIn(change, "feedbeef")).resolves.toEqual({ sha: "squash01" });
    answer = { merged: false, message: "Base branch was modified" };
    await expect(forge.putIn(change, "feedbeef")).rejects.toMatchObject({
      failure: "refused",
      message: "GitHub did not confirm the merge of #23: Base branch was modified",
    });
  });

  it("opens a change onto the default branch and lists the person's projects, newest first", async () => {
    const { forge, seen } = await stub({
      "GET /repos/octo/meter": () => ({ json: { default_branch: "trunk" } }),
      "POST /repos/octo/meter/pulls": () => ({ status: 201, json: PULL }),
      "GET /user/repos": () => ({
        json: [
          {
            full_name: "octo/meter",
            clone_url: "https://github.com/octo/meter.git",
            html_url: "https://github.com/octo/meter",
            updated_at: "2026-09-24T10:00:00Z",
            private: true,
          },
        ],
      }),
    });
    const opened = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "Why" });
    expect(opened.number).toBe(23);
    expect(seen[1]?.body).toEqual({ title: "Fix", head: "fm/task-1", base: "trunk", body: "Why" });
    expect(await forge.listProjects()).toEqual([
      {
        fullName: "octo/meter",
        cloneUrl: "https://github.com/octo/meter.git",
        url: "https://github.com/octo/meter",
        updatedAt: "2026-09-24T10:00:00Z",
        private: true,
      },
    ]);
    expect(seen[2]?.url).toBe(
      "/user/repos?sort=updated&per_page=100&page=1&affiliation=owner,collaborator,organization_member",
    );
  });

  it("lists every page of the sign-in's repos, newest first, and finds one exact repo", async () => {
    const repo = (n: number) => ({
      full_name: `octo/r${n}`,
      clone_url: `https://github.com/octo/r${n}.git`,
    });
    const { seen, forge } = await stub({
      "GET /user/repos": (request) => {
        const page = Number(new URL(request.url, "http://x").searchParams.get("page"));
        const count = page < 3 ? 100 : 4;
        return { json: Array.from({ length: count }, (_, i) => repo(page * 1000 + i)) };
      },
      "GET /repos/acme/lab": () => ({
        json: {
          full_name: "Acme/lab",
          clone_url: "https://github.com/Acme/lab.git",
          private: true,
        },
      }),
    });
    const listed = await forge.listProjectsPaged();
    expect(listed.projects).toHaveLength(204);
    expect(listed.complete).toBe(true);
    expect(
      seen.map((request) => new URL(request.url, "http://x").searchParams.get("page")),
    ).toEqual(["1", "2", "3"]);
    expect(await forge.findProject("acme/lab")).toMatchObject({
      fullName: "Acme/lab",
      private: true,
    });
    expect(await forge.findProject("acme/missing")).toBeNull();
    expect(await forge.findProject("not-a-name")).toBeNull();
  });

  it("stops at 1,000 repos and says the list was not complete", async () => {
    const { forge } = await stub({
      "GET /user/repos": () => ({
        json: Array.from({ length: 100 }, (_, i) => ({
          full_name: `octo/r${i}`,
          clone_url: "https://github.com/octo/r.git",
        })),
      }),
    });
    const listed = await forge.listProjectsPaged();
    expect(listed.projects).toHaveLength(1000);
    expect(listed.complete).toBe(false);
  });

  it("types every refusal: 401 the sign-in, 403 permission, 5xx transient, and a stale head refused", async () => {
    const status = { code: 401, headers: {} as Record<string, string> };
    const { forge } = await stub({
      "GET /repos/octo/meter/pulls": () => ({
        status: status.code,
        json: { message: "said no" },
        headers: status.headers,
      }),
      "PUT /repos/octo/meter/pulls/23/merge": () => ({
        status: 409,
        json: { message: "Head branch was modified. Review and try the merge again." },
      }),
    });
    const failure = () => forge.changeFor("b").catch((caught: unknown) => caught);
    expect(await failure()).toMatchObject({ failure: "sign-in" });
    status.code = 403;
    expect(await failure()).toMatchObject({ failure: "permission" });
    status.headers = { "x-ratelimit-remaining": "0" };
    expect(await failure()).toMatchObject({
      failure: "permission",
      message: expect.stringContaining("the hourly allowance is spent"),
    });
    for (const code of [502, 503, 504]) {
      status.code = code;
      expect(await failure()).toMatchObject({ failure: "transient" });
    }
    await expect(
      forge.putIn(
        { number: 23, url: null, branch: "b", headSha: "old", title: "fix: correct meter" },
        "old",
      ),
    ).rejects.toMatchObject({
      failure: "refused",
      message: expect.stringContaining("Head branch was modified"),
    });
  });

  it("is transient when GitHub cannot be reached, and asks nothing without a sign-in", async () => {
    const unreachable = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/r" },
      { token: async () => "gho_test", apiBaseUrl: "http://127.0.0.1:9" },
    );
    await expect(unreachable.changeFor("b")).rejects.toMatchObject({ failure: "transient" });

    const { seen, base } = await stub({});
    const signedOut = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/r" },
      { token: async () => undefined, apiBaseUrl: base },
    );
    await expect(signedOut.changeFor("b")).rejects.toMatchObject({
      failure: "sign-in",
      message: "Not signed in to GitHub (github.com)",
    });
    expect(seen).toEqual([]);
  });
});

describe("the app's own sign-in on a request", () => {
  it("asks the sign-in service to look again when GitHub refuses the sign-in, and only then", async () => {
    const status = { code: 401 };
    const { base } = await stub({
      "GET /repos/octo/meter/pulls": () => ({ status: status.code, json: [] }),
    });
    let rejected = 0;
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/r" },
      { token: async () => "gho_test", apiBaseUrl: base, onSignInRejected: () => rejected++ },
    );
    await expect(forge.changeFor("b")).rejects.toMatchObject({ failure: "sign-in" });
    expect(rejected).toBe(1);
    status.code = 403;
    await expect(forge.changeFor("b")).rejects.toMatchObject({ failure: "permission" });
    status.code = 200;
    await expect(forge.changeFor("b")).resolves.toBeNull();
    expect(rejected).toBe(1);
  });
});

describe("readOpenChanges (the forge.changes read)", () => {
  it("reads the person's open changes and their checks in one request", async () => {
    const node = (number: number, state: string | null, draft = false) => ({
      number,
      title: `Change ${number}`,
      url: `https://github.com/octo/meter/pull/${number}`,
      isDraft: draft,
      updatedAt: "2026-09-24T00:00:00Z",
      repository: { nameWithOwner: "octo/meter" },
      commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
    });
    const { seen, base } = await stub({
      "POST /graphql": () => ({
        json: {
          data: {
            viewer: {
              pullRequests: {
                nodes: [
                  node(3, "SUCCESS"),
                  node(2, "FAILURE", true),
                  node(1, "PENDING"),
                  node(0, null),
                ],
              },
            },
          },
        },
      }),
    });
    const rows = await readOpenChanges({ host: "github.com", token: "gho_test", apiBaseUrl: base });
    expect(rows.map((row) => [row.number, row.checks, row.draft])).toEqual([
      [3, "passed", false],
      [2, "failed", true],
      [1, "pending", false],
      [0, "none", false],
    ]);
    expect(rows[0]).toMatchObject({ host: "github.com", project: "octo/meter" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe("Bearer gho_test");
  });

  it("types a refused sign-in like every other GitHub request", async () => {
    const { base } = await stub({ "POST /graphql": () => ({ status: 401, json: {} }) });
    await expect(
      readOpenChanges({ host: "github.com", token: "gho_test", apiBaseUrl: base }),
    ).rejects.toMatchObject({ failure: "sign-in" });
  });
});

/**
 * GitHub on the person's own server (`docs/forge.md`, "Hosts on your own
 * server"): the same forge, at the host's own API, under its own path.
 */
describe("a GitHub Enterprise host", () => {
  it("is asked at its own API: api.<name>.ghe.com, or the server's /api/v3 and /api/graphql", () => {
    const options = { packaged: true, env: {} };
    expect(githubApiBaseFor("github.com", options)).toBe(GITHUB_API_URL);
    expect(githubApiBaseFor("octo.ghe.com", options)).toBe("https://api.octo.ghe.com");
    expect(githubApiBaseFor("github.corp.example", options)).toBe(
      "https://github.corp.example/api/v3",
    );
    expect(githubGraphqlUrl("https://github.corp.example/api/v3")).toBe(
      "https://github.corp.example/api/graphql",
    );
    expect(githubGraphqlUrl("https://api.octo.ghe.com")).toBe("https://api.octo.ghe.com/graphql");
    expect(githubGraphqlUrl(GITHUB_API_URL)).toBe(`${GITHUB_API_URL}/graphql`);
    // The stand-in override reaches every enterprise host, and only off a packaged app.
    const env = { INFINITARY_GITHUB_ENTERPRISE_API_URL: "http://127.0.0.1:7777/api/v3/" };
    expect(githubApiBaseFor("github.corp.example", { packaged: false, env })).toBe(
      "http://127.0.0.1:7777/api/v3",
    );
    expect(githubApiBaseFor("github.corp.example", { packaged: true, env })).toBe(
      "https://github.corp.example/api/v3",
    );
    expect(githubApiBaseFor("github.com", { packaged: false, env })).toBe(GITHUB_API_URL);
  });

  it("opens a pull request under the server's /api/v3 and names the host where it is not signed in", async () => {
    const { seen, base } = await stub({
      "GET /api/v3/repos/acme/meter": () => ({ json: { default_branch: "main" } }),
      "POST /api/v3/repos/acme/meter/pulls": () => ({
        status: 201,
        json: { ...PULL, html_url: "https://github.corp.example/acme/meter/pull/7" },
      }),
    });
    const location = {
      kind: "github" as const,
      host: "github.corp.example",
      owner: "acme",
      name: "meter",
      dir: "/r",
    };
    const forge = new GitHubForge(location, {
      token: async () => "ghp_enterprise",
      apiBaseUrl: `${base}/api/v3`,
    });
    expect(forge.place).toBe("github.corp.example");
    const change = await forge.openChange({ branch: "fm/x", title: "feat: x", body: "" });
    expect(change.url).toBe("https://github.corp.example/acme/meter/pull/7");
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "GET /api/v3/repos/acme/meter",
      "POST /api/v3/repos/acme/meter/pulls",
    ]);
    expect(seen[1]?.headers.authorization).toBe("Bearer ghp_enterprise");
    const signedOut = new GitHubForge(location, {
      token: async () => undefined,
      apiBaseUrl: `${base}/api/v3`,
    });
    await expect(signedOut.defaultBranch()).rejects.toMatchObject({
      failure: "sign-in",
      message: "Not signed in to github.corp.example",
    });
  });
});

describe("githubApiBaseUrl", () => {
  it("honours the dev override only in an unpackaged app", () => {
    const env = { INFINITARY_GITHUB_API_URL: "http://127.0.0.1:7777/" };
    expect(githubApiBaseUrl({ packaged: false, env })).toBe("http://127.0.0.1:7777");
    expect(githubApiBaseUrl({ packaged: true, env })).toBe(GITHUB_API_URL);
    expect(githubApiBaseUrl({ packaged: false, env: {} })).toBe(GITHUB_API_URL);
  });

  it("reads the override under the older FM3000_ name too; Infinitary's wins", () => {
    const older = { FM3000_GITHUB_API_URL: "http://127.0.0.1:7777/" };
    expect(githubApiBaseUrl({ packaged: false, env: older })).toBe("http://127.0.0.1:7777");
    const env = { ...older, INFINITARY_GITHUB_API_URL: "http://127.0.0.1:8888/" };
    expect(githubApiBaseUrl({ packaged: false, env })).toBe("http://127.0.0.1:8888");
    expect(githubApiBaseUrl({ packaged: true, env })).toBe(GITHUB_API_URL);
  });
});
