import { pbkdf2 } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { writeAskStrip } from "../../../orchestrator/requestStrips";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { API_RESPONSE_MAX_BYTES } from "../../api";
import { GitLabForge } from "./gitlabForge";

/**
 * The crewmate's API tools on a GitLab project (`docs/forge.md`, "The
 * gateway"), driven through the tool entries, the gateway service and the
 * real GitLab forge over a local HTTP stand-in: GitLab's own paths, the key
 * made there, project-scoped writes, and a job retry that arms the check
 * watch the way a GitHub rerun does.
 */

const KEY = "glpat-fixture-owned-by-app";
const HEAD = "a".repeat(40);
const PROJECT = "group/sub/field-notes";
const OWN = `/projects/${encodeURIComponent(PROJECT)}`;
const cleanup: (() => Promise<void> | void)[] = [];

/** A GitLab user as a merge request's author or reviewer carries it. */
function gitlabUser(id: number, username: string) {
  return {
    id,
    username,
    name: username,
    state: "active",
    locked: false,
    avatar_url: `https://secure.gravatar.com/avatar/${id}?s=80&d=identicon`,
    web_url: `https://gitlab.com/${username}`,
  };
}

/**
 * One merge request as GitLab lists it, with the fields of its documented
 * list answer and a description the length of a change story's (INF-733).
 */
function mergeRequest(iid: number) {
  const author = gitlabUser(3233006, "kunchenguid");
  return {
    id: 300_000 + iid,
    iid,
    project_id: 42,
    title: `feat(notes): keep field note ${iid} beside its photo`,
    description: "## Why\nThe field notes lost their photo after a sync.\n\n".repeat(60),
    state: "merged",
    created_at: "2026-10-20T17:53:59.000Z",
    updated_at: "2026-10-21T09:14:12.000Z",
    merged_by: author,
    merge_user: author,
    merged_at: "2026-10-21T09:14:12.000Z",
    closed_by: null,
    closed_at: null,
    target_branch: "main",
    source_branch: `fm/task-${iid}`,
    user_notes_count: 2,
    upvotes: 0,
    downvotes: 0,
    author,
    assignees: [author],
    assignee: author,
    reviewers: [gitlabUser(1001, "reviewer")],
    source_project_id: 42,
    target_project_id: 42,
    labels: ["crew"],
    draft: false,
    work_in_progress: false,
    milestone: null,
    merge_when_pipeline_succeeds: false,
    merge_status: "can_be_merged",
    detailed_merge_status: "not_open",
    sha: HEAD,
    merge_commit_sha: null,
    squash_commit_sha: "b".repeat(40),
    discussion_locked: null,
    should_remove_source_branch: true,
    force_remove_source_branch: true,
    prepared_at: "2026-10-20T17:54:09.000Z",
    reference: `!${iid}`,
    references: { short: `!${iid}`, relative: `!${iid}`, full: `${PROJECT}!${iid}` },
    web_url: `https://gitlab.com/${PROJECT}/-/merge_requests/${iid}`,
    time_stats: {
      time_estimate: 0,
      total_time_spent: 0,
      human_time_estimate: null,
      human_total_time_spent: null,
    },
    squash: true,
    squash_on_merge: true,
    task_completion_status: { count: 0, completed_count: 0 },
    has_conflicts: false,
    blocking_discussions_resolved: true,
  };
}

/** The project's merge requests, newest first, as GitLab pages them. */
const MERGE_REQUESTS = Array.from({ length: 150 }, (_, index) => mergeRequest(150 - index));

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Seen = { method: string; path: string; key?: string; body: string };

async function fixture(
  options: {
    host?: string;
    signedOut?: boolean;
    oversize?: boolean;
    /** What GitLab answers a write to the project's notes. */
    notesStatus?: number;
    keyRefused?: boolean;
    /** What the package registry answers a release file. */
    registryStatus?: number;
    watchRun?: (taskId: string, runId: number) => string;
  } = {},
) {
  const seen: Seen[] = [];
  let base = "";
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const key = req.headers.authorization?.replace(/^Bearer /, "");
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      key: typeof key === "string" ? key : undefined,
      body,
    });
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "x-request-id": "REQ-GL-1",
        "ratelimit-remaining": "1999",
        "ratelimit-reset": "1760000000",
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (path === "/user") {
      if (options.keyRefused) json({ message: "401 Unauthorized" }, 401);
      else json({ username: "octo" });
    } else if (path === `${OWN}/merge_requests` && url.searchParams.get("state") === "merged") {
      // GitLab's paging: per_page (20 when unnamed) and page, and a next link.
      const perPage = Number(url.searchParams.get("per_page") ?? 20);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = new URLSearchParams(url.searchParams);
      next.set("page", String(page + 1));
      json(
        MERGE_REQUESTS.slice((page - 1) * perPage, page * perPage),
        200,
        page * perPage < MERGE_REQUESTS.length
          ? { link: `<${base}/api/v4${OWN}/merge_requests?${next}>; rel="next"` }
          : {},
      );
    } else if (path === `${OWN}/merge_requests`) {
      json([{ iid: 1 }], 200, {
        link: `<${base}/api/v4${OWN}/merge_requests?id=group%2Fsub%2Ffield-notes&page=2&per_page=1>; rel="next"`,
      });
    } else if (path === "/projects/acme%2Fsite/issues" || path === "/projects/42/issues") {
      json([{ iid: 5, title: "elsewhere" }]);
    } else if (path === "/projects" || path === "/search") {
      json([{ path_with_namespace: "acme/site" }]);
    } else if (path === `${OWN}/big`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(options.oversize ? "x".repeat(300 * 1024) : "{}");
    } else if (path === `${OWN}/merge_requests/1/notes` && req.method === "POST") {
      if (options.notesStatus) json({ message: "401 Unauthorized" }, options.notesStatus);
      else json({ id: 7 }, 201);
    } else if (
      (path === `${OWN}/pipeline` || path === `${OWN}/pipelines/31/retry`) &&
      req.method === "POST"
    ) {
      // GitLab answers a pipeline start or retry with the pipeline, trimmed.
      json({ id: 31, iid: 4, status: "created", ref: "main", sha: HEAD, source: "api" }, 201);
    } else if (path === `${OWN}/pipelines/31/cancel` && req.method === "POST") {
      json({ id: 31, status: "canceled" });
    } else if (path === `${OWN}/jobs/20/retry` && req.method === "POST") {
      json({ id: 21, status: "pending" }, 201);
    } else if (path === `${OWN}/releases/v1` && req.method === "GET") {
      json({ tag_name: "v1" });
    } else if (path === `${OWN}/packages/generic/release/v1/app.dmg` && req.method === "PUT") {
      if (options.registryStatus)
        json({ message: "Packages are disabled" }, options.registryStatus);
      else json({ file_name: "app.dmg", size: body.length }, 201);
    } else if (path === `${OWN}/releases/v1/assets/links` && req.method === "POST") {
      json({ name: "app.dmg", url: JSON.parse(body).url }, 201);
    } else if (path === `${OWN}/redirect`) {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    } else json({ message: "404 Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const onSignInRejected = vi.fn();
  const host = options.host ?? "gitlab.com";
  const forge = new GitLabForge(
    { kind: "gitlab", host, owner: "group/sub", name: "field-notes", dir: "/unused" },
    {
      apiBaseUrl: `${base}/api/v4`,
      onSignInRejected,
      token: async () => (options.signedOut ? undefined : KEY),
    },
  );
  const dir = scratchDir("fm-gitlab-gateway-");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  db.prepare("INSERT INTO repos (id, path, name, added_at, origin) VALUES (?, ?, ?, ?, ?)").run(
    "repo-1",
    dir,
    "field-notes",
    1,
    `https://${host}/${PROJECT}.git`,
  );
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-1",
  });
  // A task that only answers, in its project, like the nightly checks (INF-729).
  seedTask(tasks, {
    id: "task-3",
    title: "Run the nightly check",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-3",
    shape: { kind: "research", deliverable: "answer" },
  });
  const readChecks = vi.fn(async () => {
    tasks.recordDelivery("task-1", { ciWatch: { head: HEAD, since: 1 } as never });
    return "checks pending";
  });
  const service = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(dir, "fleet")),
    forgeFor: () => forge,
    readChecks,
    ...(options.watchRun ? { watchRun: options.watchRun } : {}),
    now: () => 1234,
    sleep: async () => {},
  });
  const read = bindTool(GITHUB_READ_TOOL, { onGithubRead: (i) => service.read("task-1", i) });
  const write = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write("task-1", i) });
  const answerWrite = bindTool(GITHUB_WRITE_TOOL, {
    onGithubWrite: (i) => service.write("task-3", i),
  });
  return {
    dir,
    read,
    write,
    answerWrite,
    seen,
    tasks,
    readChecks,
    onSignInRejected,
    reserve: () =>
      tasks.recordDelivery("task-1", {
        headSha: HEAD,
        ci: "red",
        ciRepair: {
          failures: [{ headSha: HEAD, checks: ["test"] }],
          diagnoses: [],
          repairs: [],
          rerun: { headSha: HEAD, check: "test", evidence: "flake" },
        },
      }),
  };
}

describe("the gateway on a GitLab project, through crewmate tools and the key made there", () => {
  // INF-223 / accepted INF-132: on gitlab.com every planned attachment is confirmed before
  // a merge request opens, and its saved description changes only through open_change.
  it.each([
    // GitLab's path policy already refuses a trailing slash before anything is sent.
    ["POST", "merge_requests"],
    ["POST", "%6Derge_requests"],
    ["PUT", "merge_requests/36"],
    ["PUT", "merge_requests/036"],
    ["PUT", "merge_requests/%33%36"],
  ] as const)(
    "refuses a raw merge request write through %s %s on gitlab.com",
    async (method, rest) => {
      const f = await fixture();
      f.tasks.recordDelivery("task-1", { prNumber: 36 });
      f.tasks.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
      const result = await f.write.run({
        method,
        path: `${OWN}/${rest}`,
        body: JSON.stringify({
          source_branch: "fm/task-1",
          target_branch: "main",
          title: "fix: notes",
          description: "Raw replacement",
        }),
      });
      expect(result.text).toContain(
        method === "POST" ? "prepare_change and open_change" : "saved story with open_change",
      );
      expect(f.seen).toEqual([]);
    },
  );

  // INF-290 F1: GitLab reads a field from the query string as well as the JSON body.
  it.each([
    ["merge_requests/36?description=Raw%20replacement", "{}"],
    ["merge_requests/36?%64escription=Raw", undefined],
    ["merge_requests/036?labels=evidence&description=Raw", "{}"],
  ])("refuses a description named in the query string: %s", async (rest, body) => {
    const f = await fixture();
    f.tasks.recordDelivery("task-1", { prNumber: 36 });
    f.tasks.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
    const result = await f.write.run({
      method: "PUT",
      path: `${OWN}/${rest}`,
      ...(body === undefined ? {} : { body }),
    });
    expect(result.text).toContain("saved story with open_change");
    expect(f.seen).toEqual([]);
  });

  it("keeps a gitlab.com merge request's other writes and a server's own merge requests writable", async () => {
    const f = await fixture();
    f.tasks.recordDelivery("task-1", { prNumber: 36 });
    f.tasks.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
    // A title or label change is not the description; another merge request is not this task's.
    await f.write.run({
      method: "PUT",
      path: `${OWN}/merge_requests/36`,
      body: JSON.stringify({ labels: "evidence" }),
    });
    await f.write.run({
      method: "PUT",
      path: `${OWN}/merge_requests/37`,
      body: JSON.stringify({ description: "Another change" }),
    });
    expect(f.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      `PUT /api/v4${OWN}/merge_requests/36`,
      `PUT /api/v4${OWN}/merge_requests/37`,
    ]);
    const server = await fixture({ host: "gitlab.example.com" });
    await server.write.run({
      method: "POST",
      path: `${OWN}/merge_requests`,
      body: JSON.stringify({
        source_branch: "fm/task-1",
        target_branch: "main",
        title: "fix: notes",
      }),
    });
    expect(server.seen.map((seen) => `${seen.method} ${seen.path}`)).toEqual([
      `POST /api/v4${OWN}/merge_requests`,
    ]);
  });

  it("reads the project by its encoded path with the key, and hands back GitLab's ids, allowance and next page", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/projects/group%2Fsub%2Ffield-notes/merge_requests?per_page=1" }))
        .text,
    );
    expect(answer).toMatchObject({
      status: 200,
      ok: true,
      requestId: "REQ-GL-1",
      rateLimit: { remaining: 1999, resetAt: new Date(1_760_000_000_000).toISOString() },
      nextPath: `${OWN}/merge_requests?id=group%2Fsub%2Ffield-notes&page=2&per_page=1`,
      body: [{ iid: 1 }],
    });
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: `/api/v4${OWN}/merge_requests?per_page=1`,
      key: KEY,
    });
    expect(JSON.stringify(answer)).not.toContain("glpat-");
  });

  it("reads other projects, the project list and search, and keeps a write there for the captain", async () => {
    const { read, write, seen } = await fixture();
    for (const path of [
      "/projects/acme%2Fsite/issues",
      "/projects/42/issues",
      "/projects?membership=true",
      "/search?scope=projects&search=site",
    ]) {
      expect(JSON.parse((await read.run({ path })).text)).toMatchObject({ status: 200 });
    }
    const before = seen.length;
    for (const path of ["/projects/acme%2Fsite/issues", "/projects/42/issues"]) {
      expect((await write.run({ method: "POST", path, body: "{}" })).text).toContain("Not sent");
    }
    expect((await write.run({ method: "DELETE", path: OWN })).text).toContain(
      "Deleting the project itself",
    );
    expect(seen).toHaveLength(before);
    // No read list: GitLab's own answer decides what the key may see.
    for (const path of ["/user/keys", "/groups/acme/members"]) {
      expect(JSON.parse((await read.run({ path })).text)).toMatchObject({ status: 404 });
    }
    expect(seen.slice(before).map((entry) => entry.path)).toEqual([
      "/api/v4/user/keys",
      "/api/v4/groups/acme/members",
    ]);
  });

  it("writes JSON to the project, and answers GitLab's refusal as a status", async () => {
    const { write, seen } = await fixture();
    const created = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: "/projects/group%2Fsub%2Ffield-notes/merge_requests/1/notes",
          body: '{"body":"pipeline read"}',
        })
      ).text,
    );
    expect(created).toMatchObject({ status: 201, ok: true, body: { id: 7 } });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/api/v4${OWN}/merge_requests/1/notes`,
      key: KEY,
      body: '{"body":"pipeline read"}',
    });
    const missing = JSON.parse(
      (await write.run({ method: "PUT", path: `${OWN}/merge_requests/9`, body: "{}" })).text,
    );
    expect(missing).toMatchObject({ status: 404, ok: false });
  });

  it("asks GitLab who the key is before a 401 counts as a sign-in", async () => {
    const permitted = await fixture({ notesStatus: 401 });
    const answer = JSON.parse(
      (
        await permitted.write.run({
          method: "POST",
          path: `${OWN}/merge_requests/1/notes`,
          body: "{}",
        })
      ).text,
    );
    expect(answer).toMatchObject({ status: 401, ok: false });
    expect(permitted.seen.map((entry) => entry.path)).toEqual([
      `/api/v4${OWN}/merge_requests/1/notes`,
      "/api/v4/user",
    ]);
    expect(permitted.onSignInRejected).not.toHaveBeenCalled();
    const lapsed = await fixture({ notesStatus: 401, keyRefused: true });
    await lapsed.write.run({ method: "POST", path: `${OWN}/merge_requests/1/notes`, body: "{}" });
    expect(lapsed.onSignInRejected).toHaveBeenCalledTimes(1);
  });

  it("records an existing rerun reservation and arms the check watch when a job retry is accepted", async () => {
    const { write, tasks, readChecks, reserve } = await fixture();
    reserve();
    const answer = (await write.run({ method: "POST", path: `${OWN}/jobs/20/retry` })).text;
    expect(answer).toContain('"status": 201');
    expect(answer).toContain("checks pending");
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(tasks.get("task-1")?.delivery?.ciWatch).toBeDefined();
    expect(tasks.get("task-1")?.delivery?.ciRepair?.rerun?.startedAt).toBe(1234);
  });

  // INF-729 way D: GitLab follows the same rule as GitHub.
  it("sends a task that only answers' pipeline start and retries on its own project at once, while every other write still asks", async () => {
    const watchRun = vi.fn(
      (_taskId: string, runId: number) => `The app watches pipeline ${runId}.`,
    );
    const { answerWrite, seen } = await fixture({ watchRun });
    const started = (
      await answerWrite.run({ method: "POST", path: `${OWN}/pipeline`, body: '{"ref":"main"}' })
    ).text;
    expect(started).toContain('"status": 201');
    expect(started).toContain("The app watches pipeline 31.");
    expect(watchRun).toHaveBeenCalledWith("task-3", 31);
    expect(
      (await answerWrite.run({ method: "POST", path: `${OWN}/pipelines/31/retry` })).text,
    ).toContain('"status": 201');
    expect(
      (await answerWrite.run({ method: "POST", path: `${OWN}/jobs/20/retry` })).text,
    ).toContain('"status": 201');
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST /api/v4${OWN}/pipeline`,
      `POST /api/v4${OWN}/pipelines/31/retry`,
      `POST /api/v4${OWN}/jobs/20/retry`,
    ]);

    for (const ask of [
      { method: "POST" as const, path: `${OWN}/pipelines/31/cancel` },
      { method: "POST" as const, path: `${OWN}/merge_requests/1/notes`, body: "{}" },
      { method: "POST" as const, path: "/projects/acme%2Fsite/pipeline", body: '{"ref":"main"}' },
    ]) {
      expect((await answerWrite.run(ask)).text).toContain(
        "Not sent: this task only answers, so every write it makes but a run start or rerun on its own project asks the captain",
      );
    }
    expect(seen).toHaveLength(3);
  });

  it("refuses an answer over 256 KiB and a redirect, and names a self-hosted server in its refusals", async () => {
    const { read } = await fixture({ oversize: true, host: "gitlab.example.com" });
    expect((await read.run({ path: `${OWN}/big` })).text).toContain("256 KiB");
    const redirected = (await read.run({ path: `${OWN}/redirect` })).text;
    expect(redirected).toContain("Cannot call gitlab.example.com (refused)");
    expect(redirected).toContain("redirect");
    expect(redirected).not.toContain("glpat-");
  });

  // INF-733 (INF-721 friction 7): an oversized read pages on GitLab as it does on GitHub.
  it("reads a merge request listing over 256 KiB again at the largest page that fits, and its nextPath goes on from there", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: `${OWN}/merge_requests?state=merged&per_page=100` })).text,
    );
    const served = answer.body.length;
    expect(answer.status).toBe(200);
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(100);
    const bytes = (count: number) =>
      Buffer.byteLength(JSON.stringify(MERGE_REQUESTS.slice(0, count)));
    expect(bytes(served)).toBeLessThanOrEqual(API_RESPONSE_MAX_BYTES);
    expect(bytes(served + 1)).toBeGreaterThan(API_RESPONSE_MAX_BYTES);
    expect(answer.note).toContain(`GitLab's page at per_page=${served}`);
    expect(seen.map((request) => request.path)).toEqual([
      `/api/v4${OWN}/merge_requests?state=merged&per_page=100`,
      `/api/v4${OWN}/merge_requests?state=merged&per_page=${served}`,
    ]);
    const next = JSON.parse((await read.run({ path: answer.nextPath })).text);
    const iids = (requests: { iid: number }[]) => requests.map((request) => request.iid);
    expect(iids(next.body)).toEqual(iids(MERGE_REQUESTS.slice(served, served * 2)));
  });

  it("answers a missing sign-in without a request, and stops a task at its call budget", async () => {
    const signedOut = await fixture({ signedOut: true });
    expect((await signedOut.read.run({ path: `${OWN}/merge_requests` })).text).toContain(
      "Not signed in to GitLab",
    );
    expect(signedOut.seen).toEqual([]);
    const { read, seen } = await fixture();
    for (let call = 0; call < 200; call++) await read.run({ path: "/projects" });
    expect(seen).toHaveLength(200);
    expect((await read.run({ path: "/projects" })).text).toContain("200 GitLab calls");
    expect(seen).toHaveLength(200);
  });

  it("attaches a release file through the package registry and refuses a registry that is not available", async () => {
    const { write, seen, dir } = await fixture();
    writeFileSync(join(dir, "app.dmg"), "gitlab-bytes");
    const sent = JSON.parse(
      (await write.run({ method: "POST", path: `${OWN}/releases/v1`, file: "app.dmg" })).text,
    );
    expect(sent).toMatchObject({ status: 201, ok: true, body: { name: "app.dmg" } });
    expect(seen[0]).toMatchObject({ method: "GET", path: `/api/v4${OWN}/releases/v1` });
    expect(seen[1]).toMatchObject({
      method: "PUT",
      path: `/api/v4${OWN}/packages/generic/release/v1/app.dmg`,
      body: "gitlab-bytes",
      key: KEY,
    });
    expect(seen[2]?.path).toBe(`/api/v4${OWN}/releases/v1/assets/links`);
    expect(JSON.parse(seen[2]?.body ?? "{}").url).toContain(
      `${OWN}/packages/generic/release/v1/app.dmg`,
    );
    expect(
      (await write.run({ method: "POST", path: `${OWN}/uploads`, file: "app.dmg" })).text,
    ).toContain("Give the release");
    expect(seen).toHaveLength(3);

    const unavailable = await fixture({ registryStatus: 403 });
    writeFileSync(join(unavailable.dir, "app.dmg"), "gitlab-bytes");
    const refused = (
      await unavailable.write.run({
        method: "POST",
        path: `${OWN}/releases/v1`,
        file: "app.dmg",
      })
    ).text;
    expect(refused).toContain("package registry is not available");
    expect(refused).toContain("answered 403: Packages are disabled");
    expect(unavailable.seen.map((request) => request.path)).toEqual([
      `/api/v4${OWN}/releases/v1`,
      `/api/v4${OWN}/packages/generic/release/v1/app.dmg`,
    ]);
    const missing = await fixture();
    writeFileSync(join(missing.dir, "app.dmg"), "gitlab-bytes");
    const notFound = (
      await missing.write.run({ method: "POST", path: `${OWN}/releases/missing`, file: "app.dmg" })
    ).text;
    expect(notFound).toContain("not found");
    expect(missing.seen.map((request) => request.method)).toEqual(["GET"]);
    const strip = writeAskStrip({
      id: "wa1",
      kind: "gitlab",
      host: "gitlab.com",
      place: "GitLab",
      via: "project",
      method: "POST",
      path: `${OWN}/releases/v1`,
      file: "dist/app.dmg",
      at: 1,
    });
    expect(strip).toContain(`PUT ${OWN}/packages/generic/release/v1/app.dmg`);
    expect(strip).toContain(`POST ${OWN}/releases/v1/assets/links`);
  });

  // INF-777 (reproduced in INF-773): a release GitLab says is missing refuses the file before
  // reading it. The answer must wait until the file's stream has closed, or an open still queued
  // can fail after the working copy is gone, with no listener, and crash the process.
  it("answers a refused release file only after its stream has closed", async () => {
    const missing = await fixture();
    writeFileSync(join(missing.dir, "app.dmg"), "gitlab-bytes");
    // Every thread of Node's file pool busy, so the file's open queues behind them.
    const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
    let freed = 0;
    const busy = Array.from(
      { length: threads },
      () =>
        new Promise<void>((resolve) =>
          pbkdf2("x", "y", 1_000_000, 32, "sha256", () => {
            freed++;
            resolve();
          }),
        ),
    );
    const notFound = (
      await missing.write.run({ method: "POST", path: `${OWN}/releases/missing`, file: "app.dmg" })
    ).text;
    const freedBeforeAnswer = freed;
    await Promise.all(busy);
    expect(notFound).toContain("not found");
    expect(missing.seen.map((request) => request.method)).toEqual(["GET"]);
    expect(freedBeforeAnswer).toBeGreaterThan(0);
  });
});
