/**
 * The GitHub gateway over a local stand-in of GitHub's API, for the
 * gateway's tests: a task service with seeded tasks, the app's sign-in
 * stand-in, and every request the stand-in saw. Each test file closes what
 * a fixture opened with its own afterEach over `cleanup`.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ValidationForgeWrite } from "@shared/liveValidation";
import type { ForgeWriteAsk, WriteAsk } from "@shared/writeAsk";
import { vi } from "vitest";
import { GitHubForge } from "../../src/core/forge/providers/github/githubForge";
import { GithubGatewayService } from "../../src/core/orchestrator/githubGateway";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../../src/core/pi/forgeTools";
import { bindTool } from "../../src/core/session/tools";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { seedProject } from "../../src/core/workspace/seedProject";
import { freshDatabase } from "./database";
import { scratchDir } from "./scratchDirs";
import { seedDelivery } from "./taskDelivery";

export const HEAD = "a".repeat(40);
/** Invented. GitHub's private-file download_url carries a query parameter of this name. */
export const INVENTED_DOWNLOAD_TOKEN = "INVENTED_DOWNLOAD_TOKEN";
export const cleanup: (() => Promise<void> | void)[] = [];

/** GitHub's contents answer for one private file, with the temporary download token. */
export function privateFile(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    type: "file",
    encoding: "base64",
    size: 5,
    name,
    path,
    content: "aGVsbG8=",
    sha: "3d21ec53a331a6f037a91c368710b99387d012c1",
    url: `https://api.github.com/repos/octo/meter/contents/${path}`,
    git_url:
      "https://api.github.com/repos/octo/meter/git/blobs/3d21ec53a331a6f037a91c368710b99387d012c1",
    html_url: `https://github.com/octo/meter/blob/main/${path}`,
    download_url: `https://raw.githubusercontent.com/octo/meter/main/${path}?token=${INVENTED_DOWNLOAD_TOKEN}`,
    _links: {
      self: `https://api.github.com/repos/octo/meter/contents/${path}`,
      git: "https://api.github.com/repos/octo/meter/git/blobs/3d21ec53a331a6f037a91c368710b99387d012c1",
      html: `https://github.com/octo/meter/blob/main/${path}`,
    },
  };
}

/** Invented. GitHub's answer for a private repository the sign-in can push to carries one. */
export const INVENTED_CLONE_TOKEN = "INVENTEDCLONETOKEN7OC2876QJ2O";

/**
 * GitHub's repository answer, trimmed from a real reading of a public
 * repository with pull-only permissions, where `temp_clone_token` was empty.
 * The private one is the same shape with push permissions and a token.
 */
export function repository(name: string, visibility: "private" | "public") {
  const full = `octo/${name}`;
  return {
    id: 1296269,
    node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    name,
    full_name: full,
    private: visibility === "private",
    owner: { login: "octo", id: 583231, type: "User", site_admin: false },
    html_url: `https://github.com/${full}`,
    fork: false,
    url: `https://api.github.com/repos/${full}`,
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    clone_url: `https://github.com/${full}.git`,
    visibility,
    default_branch: "main",
    permissions:
      visibility === "private"
        ? { admin: true, maintain: true, push: true, triage: true, pull: true }
        : { admin: false, maintain: false, push: false, triage: false, pull: true },
    temp_clone_token: visibility === "private" ? INVENTED_CLONE_TOKEN : "",
    network_count: 0,
    subscribers_count: 1,
  };
}

/** A directory listing entry: GitHub omits content, and a private file still has the token. */
export function directoryEntry(path: string, withToken = true) {
  const { content: _content, encoding: _encoding, ...entry } = privateFile(path);
  return withToken
    ? entry
    : {
        ...entry,
        download_url: `https://raw.githubusercontent.com/octo/meter/main/${path}`,
      };
}
/**
 * GitHub's answer to a workflow dispatch that asked for `return_run_details`:
 * INF-724's nightly full check, run 39631227000 on Oct 21.
 */
export const DISPATCHED_RUN = {
  workflow_run_id: 39631227000,
  run_url: "https://api.github.com/repos/octo/meter/actions/runs/39631227000",
  html_url: "https://github.com/octo/meter/actions/runs/39631227000",
};

/** A GitHub account as a run's actor or a repository's owner carries it, with every link it lists. */
export function account(login: string, id: number, type: "User" | "Organization") {
  const url = `https://api.github.com/users/${login}`;
  return {
    login,
    id,
    node_id: "MDQ6VXNlcjMyMzMwMDY=",
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: "",
    url,
    html_url: `https://github.com/${login}`,
    followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`,
    gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`,
    subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`,
    repos_url: `${url}/repos`,
    events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`,
    type,
    user_view_type: "public",
    site_admin: false,
  };
}

/** The repository a run carries twice, as `repository` and `head_repository`, with every link GitHub lists. */
export function runRepository() {
  const url = "https://api.github.com/repos/octo/meter";
  const links = Object.fromEntries(
    [
      ["forks", "forks"],
      ["keys", "keys{/key_id}"],
      ["collaborators", "collaborators{/collaborator}"],
      ["teams", "teams"],
      ["hooks", "hooks"],
      ["issue_events", "issues/events{/number}"],
      ["events", "events"],
      ["assignees", "assignees{/user}"],
      ["branches", "branches{/branch}"],
      ["tags", "tags"],
      ["blobs", "git/blobs{/sha}"],
      ["git_tags", "git/tags{/sha}"],
      ["git_refs", "git/refs{/sha}"],
      ["trees", "git/trees{/sha}"],
      ["statuses", "statuses/{sha}"],
      ["languages", "languages"],
      ["stargazers", "stargazers"],
      ["contributors", "contributors"],
      ["subscribers", "subscribers"],
      ["subscription", "subscription"],
      ["commits", "commits{/sha}"],
      ["git_commits", "git/commits{/sha}"],
      ["comments", "comments{/number}"],
      ["issue_comment", "issues/comments{/number}"],
      ["contents", "contents/{+path}"],
      ["compare", "compare/{base}...{head}"],
      ["merges", "merges"],
      ["archive", "{archive_format}{/ref}"],
      ["downloads", "downloads"],
      ["issues", "issues{/number}"],
      ["pulls", "pulls{/number}"],
      ["milestones", "milestones{/number}"],
      ["notifications", "notifications{?since,all,participating}"],
      ["labels", "labels{/name}"],
      ["releases", "releases{/id}"],
      ["deployments", "deployments"],
    ].map(([name, rest]) => [`${name}_url`, `${url}/${rest}`]),
  );
  return {
    id: 1296269,
    node_id: "R_kgDOVLsFlA",
    name: "meter",
    full_name: "octo/meter",
    private: true,
    owner: account("octo", 341614947, "Organization"),
    html_url: "https://github.com/octo/meter",
    description: null,
    fork: false,
    url,
    ...links,
  };
}

/**
 * One workflow run as GitHub lists it under `workflow_runs`, from a reading
 * of this project's own run listing on Oct 21 (INF-733), where a page of 20
 * passed 256 KiB: a pull request's ci run, its squash commit's message, and
 * the repository twice. `message` stands in for a longer commit message.
 */
export function workflowRun(index: number, message?: string) {
  const id = 39647876291 - index;
  const sha = createHash("sha1").update(String(index)).digest("hex");
  const url = `https://api.github.com/repos/octo/meter/actions/runs/${id}`;
  const branch = `fm/task-${sha.slice(0, 8)}`;
  const repo = { id: 1296269, url: "https://api.github.com/repos/octo/meter", name: "meter" };
  const actor = account("kunchenguid", 3233006, "User");
  return {
    id,
    name: "ci",
    node_id: "WFR_kwLOVLsFlM8AAAAJOzKUww",
    head_branch: branch,
    head_sha: sha,
    path: ".github/workflows/ci.yml",
    display_title: "test(e2e): turn the microphone check off for the run-evidence fixture runs",
    run_number: 618 - index,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    workflow_id: 386227718,
    check_suite_id: 107449288593,
    check_suite_node_id: "CS_kwDOVLsFlM8AAAAZBHoHkQ",
    url,
    html_url: `https://github.com/octo/meter/actions/runs/${id}`,
    pull_requests: [
      {
        url: "https://api.github.com/repos/octo/meter/pulls/250",
        id: 4955987269,
        number: 250,
        head: { ref: branch, sha, repo },
        base: { ref: "main", sha: "7ba8b811f44141d42a14e049bad9cc310063df92", repo },
      },
    ],
    created_at: "2026-10-21T17:53:59Z",
    updated_at: "2026-10-21T17:54:09Z",
    actor,
    run_attempt: 1,
    referenced_workflows: [],
    run_started_at: "2026-10-21T17:53:59Z",
    triggering_actor: actor,
    jobs_url: `${url}/jobs`,
    logs_url: `${url}/logs`,
    check_suite_url: "https://api.github.com/repos/octo/meter/check-suites/107449288593",
    artifacts_url: `${url}/artifacts`,
    cancel_url: `${url}/cancel`,
    rerun_url: `${url}/rerun`,
    previous_attempt_url: null,
    workflow_url: "https://api.github.com/repos/octo/meter/actions/workflows/386227718",
    head_commit: {
      id: sha,
      tree_id: "8ac84a35d8406eea66624bca5a3167d56e7a4eff",
      message:
        message ??
        "test(e2e): turn the microphone check off for the run-evidence fixture runs\n\nThe fixture runs in tests/run-evidence-playwright.test.ts go through the\ne2e global setup, which in a virtual Mac boots Electron to open the fake\nmicrophone (20 s budget) before the held spec writes. On a slow guest, or\na stage without the microphone grant, that outlasted the test's 12 s wait.\nTheir specs open no microphone, so the test sets\nINFINITARY_E2E_MIC_PREFLIGHT=0, a new value that turns the check off.\n\nRefs: INF-726",
      timestamp: "2026-10-21T17:47:46Z",
      author: { name: "kunchenguid", email: "kun@kunchenguid.com" },
      committer: { name: "kunchenguid", email: "kun@kunchenguid.com" },
    },
    repository: runRepository(),
    head_repository: runRepository(),
  };
}

/** The project's runs, newest first, as GitHub pages them. */
export const RUNS = Array.from({ length: 120 }, (_, index) => workflowRun(index));
export const RUN_LISTING = (runs: unknown[]) => ({ total_count: RUNS.length, workflow_runs: runs });

/**
 * GitHub's compare answer between two versions far apart: its commits and
 * every changed file with its patch, two lists in one object, where a
 * reading of per_page=1 still passed 256 KiB (INF-733).
 */
export function comparison() {
  const file = (index: number) => ({
    sha: createHash("sha1").update(`file ${index}`).digest("hex"),
    filename: `src/core/feature${index}.ts`,
    status: "modified",
    additions: 120,
    deletions: 40,
    changes: 160,
    blob_url: `https://github.com/octo/meter/blob/${HEAD}/src/core/feature${index}.ts`,
    raw_url: `https://github.com/octo/meter/raw/${HEAD}/src/core/feature${index}.ts`,
    contents_url: `https://api.github.com/repos/octo/meter/contents/src/core/feature${index}.ts?ref=${HEAD}`,
    patch: `@@ -1,40 +1,120 @@\n${"+  const reading = await readings.next();\n".repeat(120)}`,
  });
  return {
    url: "https://api.github.com/repos/octo/meter/compare/v0.4.1...main",
    status: "ahead",
    ahead_by: 300,
    behind_by: 0,
    total_commits: 300,
    commits: [{ sha: HEAD, commit: { message: "feat: one change" } }],
    files: Array.from({ length: 60 }, (_, index) => file(index)),
  };
}

/**
 * GitHub's contributor statistics: every contributor with a week-by-week
 * count, one answer that ignores per_page.
 */
export const CONTRIBUTORS = Array.from({ length: 40 }, (_, index) => ({
  author: account(`author${index}`, 1000 + index, "User"),
  total: 300,
  weeks: Array.from({ length: 300 }, (_, week) => ({
    w: 1_600_000_000 + week * 604_800,
    a: 10,
    d: 4,
    c: 1,
  })),
}));

export type Seen = { method: string; path: string; auth?: string; body: string };

export async function fixture(
  options: {
    host?: string;
    oversize?: boolean;
    signedOut?: boolean;
    dispatchStatus?: number;
    /** Someone else dispatches the same workflow on the same ref with each dispatch. */
    raceDispatch?: boolean;
    watchRun?: (taskId: string, runId: number) => string;
    beforeValidationWrite?: (
      taskId: string,
      request: string,
      write: ValidationForgeWrite,
    ) => Promise<void>;
  } = {},
) {
  const seen: Seen[] = [];
  const types: (string | undefined)[] = [];
  let base = "";
  // verify.yml's dispatched runs, newest first: an earlier one on main, then
  // one per dispatch GitHub took, each with the next run number.
  const dispatchedRuns = [{ ...workflowRun(7), event: "workflow_dispatch", head_branch: "main" }];
  const dispatchRun = (ref: string) => {
    const run = workflowRun(0);
    dispatchedRuns.unshift({
      ...run,
      id: (dispatchedRuns[0]?.id ?? run.id) + 1,
      event: "workflow_dispatch",
      head_branch: ref.replace(/^refs\/heads\//, ""),
      status: "queued",
      conclusion: null as never,
    });
  };
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({
      method: req.method ?? "",
      path: req.url ?? "",
      auth: req.headers.authorization,
      body,
    });
    types.push(req.headers["content-type"]);
    const url = new URL(req.url ?? "/", base);
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "x-github-request-id": "REQ-1",
        "x-ratelimit-remaining": "4999",
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    // GitHub's paging: per_page (30 when unnamed) and page, and a next link by repository id.
    const paged = (items: unknown[], wrap: (page: unknown[]) => unknown, nextPath: string) => {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = new URLSearchParams(url.searchParams);
      next.set("page", String(page + 1));
      json(
        wrap(items.slice((page - 1) * perPage, page * perPage)),
        200,
        page * perPage < items.length ? { link: `<${base}${nextPath}?${next}>; rel="next"` } : {},
      );
    };
    if (url.pathname === "/repos/octo/meter/actions/runs") {
      paged(RUNS, RUN_LISTING, "/repositories/1296269/actions/runs");
    } else if (url.pathname === "/repositories/1296269/actions/runs") {
      paged(RUNS, RUN_LISTING, "/repositories/1296269/actions/runs");
    } else if (url.pathname === "/repos/octo/meter/actions/workflows/phone.yml/runs") {
      // A run whose squash commit's message alone passes the cap leads the list.
      const runs = [workflowRun(0, "x".repeat(300 * 1024)), ...RUNS.slice(1)];
      paged(runs, RUN_LISTING, "/repositories/1296269/actions/workflows/phone.yml/runs");
    } else if (url.pathname === "/repos/octo/meter/compare/v0.4.1...main") {
      json(comparison());
    } else if (url.pathname === "/repos/octo/meter/stats/contributors") {
      json(CONTRIBUTORS);
    } else if (url.pathname === "/repos/octo/meter/pulls") {
      json([{ number: 1 }], 200, {
        link: `<${base}/repos/octo/meter/pulls?page=2>; rel="next"`,
      });
    } else if (url.pathname === "/repos/acme/site/issues") {
      json([{ number: 5, title: "elsewhere" }]);
    } else if (url.pathname === "/user/repos" || url.pathname === "/search/repositories") {
      json({ items: [{ full_name: "acme/site" }] });
    } else if (url.pathname === "/repos/octo/meter/big") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(options.oversize ? "x".repeat(300 * 1024) : "{}");
    } else if (url.pathname === "/repos/octo/meter/issues/1/comments" && req.method === "POST") {
      json({ id: 7 }, 201);
    } else if (url.pathname === "/repos/octo/meter/issues/2/comments") {
      json({ message: "Validation Failed" }, 422);
    } else if (
      /^\/repos\/octo\/meter\/actions\/workflows\/(?:verify\.yml|42)\/dispatches$/.test(
        url.pathname,
      )
    ) {
      if (options.dispatchStatus) json({ message: "Dispatch refused" }, options.dispatchStatus);
      else if (JSON.parse(body || "{}").return_run_details) json(DISPATCHED_RUN);
      else {
        const ref = String(JSON.parse(body || "{}").ref ?? "main");
        dispatchRun(ref);
        if (options.raceDispatch) dispatchRun(ref);
        res.writeHead(204);
        res.end();
      }
    } else if (url.pathname === "/repos/octo/meter/actions/workflows/verify.yml/runs") {
      const event = url.searchParams.get("event");
      json(RUN_LISTING(dispatchedRuns.filter((run) => !event || run.event === event)));
    } else if (url.pathname === "/repos/octo/meter" && req.method === "GET") {
      json(repository("meter", "private"));
    } else if (url.pathname === "/repos/octo/lamp" && req.method === "GET") {
      json(repository("lamp", "public"));
    } else if (
      [
        "/repos/octo/meter/actions/runs/9/cancel",
        "/repos/octo/meter/actions/workflows/verify.yml/disable",
        "/repos/octo/meter/contents/.github/workflows/verify.yml",
        "/repos/octo/meter",
        "/repos/octo/meter/collaborators/someone",
        "/repos/octo/meter/actions/secrets",
      ].includes(url.pathname)
    ) {
      json({ accepted: true });
    } else if (url.pathname === "/repos/octo/meter/actions/runs/9/rerun-failed-jobs") {
      json({}, 201);
    } else if (
      (url.pathname === "/repos/octo/meter/releases/9/assets" ||
        url.pathname === "/repos/acme/site/releases/3/assets") &&
      req.method === "POST"
    ) {
      json({ id: 9, name: url.searchParams.get("name"), state: "uploaded" }, 201);
    } else if (url.pathname === "/repos/octo/meter/redirect") {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    } else if (url.pathname === "/repos/octo/meter/issues/7") {
      json({ number: 7, state: "open", html_url: "https://github.com/octo/meter/issues/7" });
    } else if (url.pathname === "/repos/octo/meter/issues/8") {
      json({ number: 8, state: "closed", html_url: "https://github.com/octo/meter/issues/8" });
    } else if (url.pathname === "/repos/octo/meter/issues/9") {
      json({
        number: 9,
        state: "open",
        html_url: "https://github.com/octo/meter/pull/9",
        pull_request: { url: "https://api.github.com/repos/octo/meter/pulls/9" },
      });
    } else if (url.pathname === "/repos/octo/meter/contents/README.md") {
      json(privateFile("README.md"));
    } else if (url.pathname === "/repos/octo/meter/contents/src") {
      json([directoryEntry("src/secret.ts"), directoryEntry("src/public.ts", false)]);
    } else json({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const onSignInRejected = vi.fn<() => void>();
  const forge = new GitHubForge(
    {
      kind: "github",
      host: options.host ?? "github.com",
      owner: "octo",
      name: "meter",
      dir: "/unused",
    },
    {
      apiBaseUrl: base,
      onSignInRejected,
      token: async () => (options.signedOut ? undefined : "gho_fixture_owned_by_app"),
    },
  );
  const dir = scratchDir("fm-gateway-");
  const db = freshDatabase();
  cleanup.push(() => {
    db.close();
  });
  seedProject(db, {
    id: "repo-1",
    name: "meter",
    path: dir,
    setupKind: "adopt",
    origin: `https://${options.host ?? "github.com"}/octo/meter.git`,
    addedAt: 1,
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "task-1",
    title: "Fix",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-1",
  });
  seedTask(tasks, { id: "task-2", title: "Find", status: "idle" });
  // INF-724's shape: the nightly full check, a task that only answers, in its project.
  seedTask(tasks, {
    id: "task-3",
    title: "Run the nightly full check",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-3",
    shape: { kind: "research", deliverable: "answer" },
  });
  seedTask(tasks, {
    id: "task-4",
    title: "Answer with no project",
    status: "idle",
    shape: { kind: "research", deliverable: "answer" },
  });
  // An unsafe data reader (docs/agents-reach.md): a read-only answer task in its project.
  seedTask(tasks, {
    id: "task-reader",
    title: "Triage the waiting issues",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-reader",
    shape: { kind: "research", deliverable: "answer", unsafe_data_reader: true },
  });
  // An unsafe data reader with no project, in an empty folder of its own (INF-6427's piece 4).
  seedTask(tasks, {
    id: "task-reader-alone",
    title: "Read the stand-in notes",
    status: "idle",
    shape: { kind: "research", deliverable: "answer", unsafe_data_reader: true },
  });
  // A side-effect task filed without the read-only constraint (docs/task-graph.md, "A side-effect task").
  seedTask(tasks, {
    id: "task-side-effect",
    title: "Tell the issue how the fix ended",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-side-effect",
    shape: { kind: "unclear", side_effect: true },
  });
  seedTask(tasks, {
    id: "task-operation",
    title: "Cancel the superseded check",
    status: "idle",
    repoId: "repo-1",
    worktreeDir: dir,
    branch: "fm/task-operation",
    shape: { kind: "unclear", deliverable: "operation" },
  });
  // The check reading arms the watch only once the rerun reads as running.
  let readings = 0;
  const readChecks = vi.fn(async () => {
    readings += 1;
    if (readings >= armOn)
      seedDelivery(tasks, "task-1", { ciWatch: { head: HEAD, since: 1 } as never });
    return `reading ${readings}`;
  });
  let armOn = 1;
  const presentReaderAsk =
    vi.fn<(taskId: string, ask: ForgeWriteAsk, dropped: WriteAsk[]) => void>();
  const service = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(dir, "fleet")),
    forgeFor: () => forge,
    accountForge: (host = "github.com") =>
      new GitHubForge(
        { kind: "github", host, dir: "" },
        {
          apiBaseUrl: base,
          token: async () => "gho_fixture_owned_by_app",
        },
      ),
    readChecks,
    beforeValidationWrite: options.beforeValidationWrite,
    ...(options.watchRun ? { watchRun: options.watchRun } : {}),
    now: () => 1234,
    sleep: async () => {},
  });
  service.presentReaderAsksWith(presentReaderAsk);
  const read = bindTool(GITHUB_READ_TOOL, { onGithubRead: (i) => service.read("task-1", i) });
  const write = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write("task-1", i) });
  const readWithoutProject = bindTool(GITHUB_READ_TOOL, {
    onGithubRead: (i) => service.read("task-2", i),
  });
  const writeWithoutProject = bindTool(GITHUB_WRITE_TOOL, {
    onGithubWrite: (i) => service.write("task-2", i),
  });
  const writeAs = (taskId: string) =>
    bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write(taskId, i) });
  return {
    service,
    presentReaderAsk,
    writeAs,
    readWithoutProject,
    writeWithoutProject,
    seen,
    types,
    onSignInRejected,
    tasks,
    dir,
    read,
    write,
    readChecks,
    armOn: (n: number) => {
      armOn = n;
    },
    reserve: () =>
      seedDelivery(tasks, "task-1", {
        headSha: HEAD,
        ci: "red",
        ciRepair: {
          failures: [{ headSha: HEAD, checks: ["mac"] }],
          diagnoses: [],
          repairs: [],
          rerun: { headSha: HEAD, check: "mac", evidence: "flake" },
        },
      }),
  };
}
