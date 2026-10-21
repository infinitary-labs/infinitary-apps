import { createHash } from "node:crypto";
import { symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ValidationForgeWrite } from "@shared/liveValidation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import {
  CLONE_TOKEN_NOTE,
  DOWNLOAD_TOKEN_NOTE,
  GithubGatewayService,
} from "../../../orchestrator/githubGateway";
import { writeAskStrip } from "../../../orchestrator/requestStrips";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { GitHubForge } from "./githubForge";

const HEAD = "a".repeat(40);
/** Invented. GitHub's private-file download_url carries a query parameter of this name. */
const INVENTED_DOWNLOAD_TOKEN = "INVENTED_DOWNLOAD_TOKEN";
const cleanup: (() => Promise<void> | void)[] = [];

/** GitHub's contents answer for one private file, with the temporary download token. */
function privateFile(path: string) {
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
const INVENTED_CLONE_TOKEN = "INVENTEDCLONETOKEN7OC2876QJ2O";

/**
 * GitHub's repository answer, trimmed from a real reading of a public
 * repository with pull-only permissions, where `temp_clone_token` was empty.
 * The private one is the same shape with push permissions and a token.
 */
function repository(name: string, visibility: "private" | "public") {
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
function directoryEntry(path: string, withToken = true) {
  const { content: _content, encoding: _encoding, ...entry } = privateFile(path);
  return withToken
    ? entry
    : {
        ...entry,
        download_url: `https://raw.githubusercontent.com/octo/meter/main/${path}`,
      };
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Seen = { method: string; path: string; auth?: string; body: string };

async function fixture(
  options: {
    oversize?: boolean;
    signedOut?: boolean;
    dispatchStatus?: number;
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
    if (url.pathname === "/repos/octo/meter/pulls") {
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
      else {
        res.writeHead(204);
        res.end();
      }
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
  const onSignInRejected = vi.fn();
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/unused" },
    {
      apiBaseUrl: base,
      onSignInRejected,
      token: async () => (options.signedOut ? undefined : "gho_fixture_owned_by_app"),
    },
  );
  const dir = scratchDir("fm-gateway-");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  db.prepare("INSERT INTO repos (id, path, name, added_at, origin) VALUES (?, ?, ?, ?, ?)").run(
    "repo-1",
    dir,
    "meter",
    1,
    "https://github.com/octo/meter.git",
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
  seedTask(tasks, { id: "task-2", title: "Find", status: "idle" });
  // The check reading arms the watch only once the rerun reads as running.
  let readings = 0;
  const readChecks = vi.fn(async () => {
    readings += 1;
    if (readings >= armOn)
      tasks.recordDelivery("task-1", { ciWatch: { head: HEAD, since: 1 } as never });
    return `reading ${readings}`;
  });
  let armOn = 1;
  const service = new GithubGatewayService({
    tasks,
    repos: new RepoRegistry(db, join(dir, "fleet")),
    forgeFor: () => forge,
    accountForge: () =>
      new GitHubForge(
        { kind: "github", host: "github.com", dir: "" },
        {
          apiBaseUrl: base,
          token: async () => "gho_fixture_owned_by_app",
        },
      ),
    readChecks,
    beforeValidationWrite: options.beforeValidationWrite,
    now: () => 1234,
    sleep: async () => {},
  });
  const read = bindTool(GITHUB_READ_TOOL, { onGithubRead: (i) => service.read("task-1", i) });
  const write = bindTool(GITHUB_WRITE_TOOL, { onGithubWrite: (i) => service.write("task-1", i) });
  const readWithoutProject = bindTool(GITHUB_READ_TOOL, {
    onGithubRead: (i) => service.read("task-2", i),
  });
  const writeWithoutProject = bindTool(GITHUB_WRITE_TOOL, {
    onGithubWrite: (i) => service.write("task-2", i),
  });
  return {
    service,
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
      tasks.recordDelivery("task-1", {
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

describe("the GitHub gateway through crewmate tools and the app's sign-in", () => {
  // INF-285 F2: equivalent GitHub paths cannot bypass the saved-story barrier.
  it.each([
    ["POST", "pulls/"],
    ["POST", "%70ulls"],
    ["PATCH", "pulls/36/"],
    ["PATCH", "pulls/%33%36"],
    ["PATCH", "issues/36/"],
    ["PATCH", "issues/%33%36/"],
    // INF-285 G1: GitHub reads pulls/036 as pull request 36.
    ["PATCH", "pulls/036"],
    ["PATCH", "issues/036"],
  ] as const)("refuses a raw description write through %s %s", async (method, rest) => {
    const f = await fixture();
    f.tasks.recordDelivery("task-1", { prNumber: 36 });
    f.tasks.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
    const result = await f.write.run({
      method,
      path: `/repos/octo/meter/${rest}`,
      body: JSON.stringify({
        title: "fix: meter",
        head: "fm/task-1",
        base: "main",
        body: "Raw replacement",
      }),
    });
    expect(result.text).toContain(
      method === "POST" ? "prepare_change and open_change" : "saved story with open_change",
    );
    expect(f.seen).toEqual([]);
  });

  it("cannot bypass the saved-story publication barrier, while legacy descriptions remain writable (INF-92)", async () => {
    const f = await fixture();
    const opened = await f.write.run({
      method: "POST",
      path: "/repos/octo/meter/pulls",
      body: JSON.stringify({
        title: "fix: meter",
        head: "fm/task-1",
        base: "main",
        body: "No evidence yet",
      }),
    });
    expect(opened.text).toContain("prepare_change and open_change");
    expect(f.seen).toEqual([]);
    await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/pulls/1",
      body: JSON.stringify({ body: "Legacy description" }),
    });
    expect(f.seen).toHaveLength(1);
    f.tasks.recordDelivery("task-1", { prNumber: 1 });
    f.tasks.updateChangePresentation("task-1", () => ({ revisions: [], receipts: [] }));
    const changed = await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/pulls/1",
      body: JSON.stringify({ body: "Bypass the story" }),
    });
    expect(changed.text).toContain("saved story with open_change");
    expect(f.seen).toHaveLength(1);
    // INF-169 F9: GitHub accepts the issues alias for a pull request body too.
    const alias = await f.write.run({
      method: "PATCH",
      path: "/repos/octo/meter/issues/1",
      body: JSON.stringify({ body: "Bypass through issues" }),
    });
    expect(alias.text).toContain("saved story with open_change");
    expect(f.seen).toHaveLength(1);
  });

  it("INF-125: checks the exact declared validation write at execution, including a kept write", async () => {
    const guard = vi.fn(
      async (_task: string, _request: string, _write: ValidationForgeWrite) => {},
    );
    const { service, tasks, write, writeWithoutProject, seen } = await fixture({
      beforeValidationWrite: guard,
    });
    const body = JSON.stringify({ body: "Disposable validation record" });
    const input = {
      method: "POST" as const,
      path: "/repos/octo/meter/issues/1/comments",
      body,
      validationEffect: "shared-1",
    };
    const exact = {
      host: "github.com",
      method: input.method,
      path: input.path,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    };
    await write.run(input);
    expect(guard).toHaveBeenNthCalledWith(1, "task-1", "shared-1", exact);
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(1);
    await writeWithoutProject.run({ ...input, validationEffect: "shared-2" });
    expect(guard).toHaveBeenCalledTimes(1);
    const ask = tasks.get("task-2")?.delivery?.writeAsks?.at(-1);
    expect(ask?.validationEffect).toBe("shared-2");
    await service.sendAsk("task-2", ask!.id);
    expect(guard).toHaveBeenNthCalledWith(2, "task-2", "shared-2", exact);
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(2);
    guard.mockRejectedValueOnce(new Error("The validation action is no longer approved."));
    expect((await write.run({ ...input, validationEffect: "shared-3" })).text).toContain(
      "no longer approved",
    );
    expect(seen.filter((item) => item.method === "POST")).toHaveLength(2);
  });

  it("reads a project route with the app's token and hands back status, request id and a next page", async () => {
    const { read, seen } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/pulls?per_page=1" })).text,
    );
    expect(answer).toMatchObject({
      status: 200,
      ok: true,
      requestId: "REQ-1",
      nextPath: "/repos/octo/meter/pulls?page=2",
      body: [{ number: 1 }],
    });
    expect(seen[0]).toMatchObject({ method: "GET", auth: "Bearer gho_fixture_owned_by_app" });
    expect(JSON.stringify(answer)).not.toContain("gho_");
  });

  it("reads another repository, the repo list and search, and keeps a write there for the captain", async () => {
    const { read, write, seen } = await fixture();
    const other = JSON.parse((await read.run({ path: "/repos/acme/site/issues" })).text);
    expect(other).toMatchObject({ status: 200, body: [{ number: 5 }] });
    for (const path of ["/user/repos?per_page=100", "/search/repositories?q=site+in:name"]) {
      expect(JSON.parse((await read.run({ path })).text)).toMatchObject({ status: 200 });
    }
    expect(seen.map((request) => request.path)).toEqual([
      "/repos/acme/site/issues",
      "/user/repos?per_page=100",
      "/search/repositories?q=site+in%3Aname",
    ]);
    const before = seen.length;
    expect(
      (await write.run({ method: "POST", path: "/repos/acme/site/issues", body: "{}" })).text,
    ).toContain("Not sent: it goes outside this task's own project");
    expect(seen).toHaveLength(before);
  });

  it("gives a task with no project the reads through the github.com sign-in, and keeps its writes for the captain", async () => {
    const { readWithoutProject, writeWithoutProject, seen } = await fixture();
    const answer = JSON.parse((await readWithoutProject.run({ path: "/user/repos" })).text);
    expect(answer).toMatchObject({ status: 200, body: { items: [{ full_name: "acme/site" }] } });
    expect(seen[0]).toMatchObject({ auth: "Bearer gho_fixture_owned_by_app" });
    expect(
      (
        await writeWithoutProject.run({
          method: "POST",
          path: "/repos/acme/site/issues",
          body: "{}",
        })
      ).text,
    ).toContain("Not sent: this task has no project");
    expect(seen).toHaveLength(1);
  });

  it("keeps another project's and the account's writes, refuses GraphQL and invalid JSON before any request, and leaves an account read to GitHub", async () => {
    const { read, write, seen } = await fixture();
    expect(
      (await write.run({ method: "POST", path: "/repos/octo/other/issues", body: "{}" })).text,
    ).toContain("Not sent");
    expect(
      (
        await write.run({
          method: "POST",
          path: "/orgs/octo/actions/permissions",
        })
      ).text,
    ).toContain("Not sent");
    expect((await write.run({ method: "POST", path: "/graphql", body: "{}" })).text).toContain(
      "GraphQL",
    );
    expect((await read.run({ path: "/graphql" })).text).toContain("GraphQL");
    expect(
      (await write.run({ method: "POST", path: "/repos/octo/meter/issues", body: "{nope" })).text,
    ).toContain("JSON");
    expect(seen).toEqual([]);
    // No read list: GitHub's own answer decides what the sign-in may see.
    expect(JSON.parse((await read.run({ path: "/user/keys" })).text)).toMatchObject({
      status: 404,
    });
    expect(seen.map((request) => request.path)).toEqual(["/user/keys"]);
  });

  it.each(["verify.yml", "42"])(
    "dispatches %s with a caller-selected ref and inputs without changing checks or a rerun reservation",
    async (workflow) => {
      const { write, seen, tasks, readChecks, reserve } = await fixture();
      reserve();
      const before = tasks.get("task-1")?.delivery;
      const answer = (
        await write.run({
          method: "POST",
          path: `/repos/octo/meter/actions/workflows/${workflow}/dispatches`,
          body: JSON.stringify({
            ref: "release-candidate",
            inputs: { profile: "alpha", perf: true },
          }),
        })
      ).text;
      expect(answer).toContain('"status": 204');
      expect(JSON.parse(answer)).toMatchObject({ status: 204, ok: true });
      expect(answer).not.toContain("gho_");
      expect(seen).toEqual([
        {
          method: "POST",
          path: `/repos/octo/meter/actions/workflows/${workflow}/dispatches`,
          auth: "Bearer gho_fixture_owned_by_app",
          body: '{"ref":"release-candidate","inputs":{"profile":"alpha","perf":true}}',
        },
      ]);
      expect(readChecks).not.toHaveBeenCalled();
      expect(tasks.get("task-1")?.delivery).toEqual(before);
    },
  );

  it("passes project workflow controls, workflow files, settings and permissions through unchanged", async () => {
    const { write, read, seen } = await fixture();
    const requests = [
      { method: "POST" as const, path: "/repos/octo/meter/actions/runs/9/cancel" },
      { method: "PUT" as const, path: "/repos/octo/meter/actions/workflows/verify.yml/disable" },
      {
        method: "PUT" as const,
        path: "/repos/octo/meter/contents/.github/workflows/verify.yml",
        body: '{"branch":"topic","message":"update checks","content":"bmFtZTogdmVyaWZ5"}',
      },
      { method: "PATCH" as const, path: "/repos/octo/meter", body: '{"description":"Updated"}' },
      {
        method: "PUT" as const,
        path: "/repos/octo/meter/collaborators/someone",
        body: '{"permission":"pull"}',
      },
    ];
    for (const request of requests) {
      const answer = JSON.parse((await write.run(request)).text);
      expect(answer).toMatchObject({ status: 200, ok: true });
    }
    expect(
      JSON.parse((await read.run({ path: "/repos/octo/meter/actions/secrets" })).text),
    ).toMatchObject({ status: 200, ok: true });
    expect(seen.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      ...requests.flatMap((request) => [
        ...(request.path.includes("/contents/")
          ? [{ method: "GET", path: "/repos/octo/meter", body: "" }]
          : []),
        { ...request, body: request.body ?? "" },
      ]),
      { method: "GET", path: "/repos/octo/meter/actions/secrets", body: "" },
    ]);
  });

  it("reports missing sign-in without sending a dispatch", async () => {
    const { write, seen } = await fixture({ signedOut: true });
    const answer = (
      await write.run({
        method: "POST",
        path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
        body: '{"ref":"fm/task-1"}',
      })
    ).text;
    expect(answer).toContain("sign-in");
    expect(seen).toEqual([]);
  });

  it.each([401, 403, 404, 422, 500])(
    "does not retry a dispatch GitHub refuses with %s",
    async (dispatchStatus) => {
      const { write, seen, readChecks, onSignInRejected } = await fixture({ dispatchStatus });
      const answer = (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
          body: '{"ref":"fm/task-1"}',
        })
      ).text;
      expect(answer).not.toContain("accepted");
      expect(seen).toHaveLength(1);
      expect(readChecks).not.toHaveBeenCalled();
      expect(JSON.parse(answer)).toMatchObject({ status: dispatchStatus, ok: false });
      expect(onSignInRejected).toHaveBeenCalledTimes(dispatchStatus === 401 ? 1 : 0);
    },
  );

  it("writes JSON to the project and answers a refusal from GitHub as a status, not a failure", async () => {
    const { write, seen } = await fixture();
    const created = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/issues/1/comments",
          body: '{"body":"hi"}',
        })
      ).text,
    );
    expect(created).toMatchObject({ status: 201, ok: true, body: { id: 7 } });
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"body":"hi"}' });
    const invalid = JSON.parse(
      (await write.run({ method: "POST", path: "/repos/octo/meter/issues/2/comments", body: "{}" }))
        .text,
    );
    expect(invalid).toMatchObject({
      status: 422,
      ok: false,
      body: { message: "Validation Failed" },
    });
  });

  it("reads a private file without saving GitHub's temporary download token", async () => {
    // Intent: a crewmate's read of a private GitHub file no longer saves the
    // download token (INF-206). Tokens already saved are left alone.
    const { read } = await fixture();
    const answer = JSON.parse(
      (await read.run({ path: "/repos/octo/meter/contents/README.md" })).text,
    );
    expect(answer).toMatchObject({
      status: 200,
      ok: true,
      note: DOWNLOAD_TOKEN_NOTE,
      body: {
        type: "file",
        path: "README.md",
        content: "aGVsbG8=",
        html_url: "https://github.com/octo/meter/blob/main/README.md",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/README.md",
      },
    });
    expect(JSON.stringify(answer)).not.toContain(INVENTED_DOWNLOAD_TOKEN);
    expect(JSON.stringify(answer)).not.toContain("token=");
    const plain = JSON.parse((await read.run({ path: "/repos/octo/meter/pulls?per_page=1" })).text);
    expect(plain.note).toBeUndefined();
    expect(plain.body).toEqual([{ number: 1 }]);

    const listing = JSON.parse((await read.run({ path: "/repos/octo/meter/contents/src" })).text);
    expect(listing.body).toEqual([
      expect.objectContaining({
        path: "src/secret.ts",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/src/secret.ts",
      }),
      expect.objectContaining({
        path: "src/public.ts",
        download_url: "https://raw.githubusercontent.com/octo/meter/main/src/public.ts",
      }),
    ]);
    expect(JSON.stringify(listing)).not.toContain(INVENTED_DOWNLOAD_TOKEN);
  });

  it("reads a private repository without its temporary clone token", async () => {
    // Intent: a GitHub read leaves out the private repository's clone
    // credential before a crewmate or a saved transcript sees it (INF-652).
    const { read } = await fixture();
    const answer = JSON.parse((await read.run({ path: "/repos/octo/meter" })).text);
    const { temp_clone_token: _token, ...rest } = repository("meter", "private");
    expect(answer).toMatchObject({ status: 200, ok: true, note: CLONE_TOKEN_NOTE });
    expect(answer.body).toEqual(rest);
    expect(JSON.stringify(answer)).not.toContain(INVENTED_CLONE_TOKEN);

    // A public repository's empty field holds no credential, so its answer is GitHub's own.
    const open = JSON.parse((await read.run({ path: "/repos/octo/lamp" })).text);
    expect(open.note).toBeUndefined();
    expect(open.body).toEqual(repository("lamp", "public"));
  });

  it("refuses an answer over 256 KiB and a redirect, and never echoes the token", async () => {
    const { read } = await fixture({ oversize: true });
    expect((await read.run({ path: "/repos/octo/meter/big" })).text).toContain("256 KiB");
    const redirected = (await read.run({ path: "/repos/octo/meter/redirect" })).text;
    expect(redirected).toContain("redirect");
    expect(redirected).not.toContain("gho_");
  });

  it("answers a task with no sign-in as the sign-in failure, not a crash", async () => {
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/unused" },
      { apiBaseUrl: "http://127.0.0.1:1", token: async () => undefined },
    );
    await expect(forge.api.call("GET", "/repos/octo/meter/pulls")).rejects.toMatchObject({
      failure: "sign-in",
    });
  });

  it("records an existing rerun reservation and watches checks without vetoing another project API request", async () => {
    const { write, tasks, seen, readChecks, reserve } = await fixture();
    const rerun = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
    };
    reserve();
    const answer = (await write.run(rerun)).text;
    expect(seen).toHaveLength(1);
    expect(answer).toContain('"status": 201');
    expect(answer).toContain("reading 1");
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(tasks.get("task-1")?.delivery?.ciWatch).toBeDefined();
    expect(tasks.get("task-1")?.delivery?.ciRepair?.rerun?.startedAt).toBe(1234);

    const delivery = tasks.get("task-1")?.delivery?.ciRepair;
    expect((await write.run(rerun)).text).toContain('"status": 201');
    expect(seen).toHaveLength(2);
    expect(tasks.get("task-1")?.delivery?.ciRepair).toEqual(delivery);
  });

  it("allows a rerun without a reservation and does not invent repair history", async () => {
    const { write, tasks, seen, readChecks } = await fixture();
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
        })
      ).text,
    ).toContain('"status": 201');
    expect(seen).toHaveLength(1);
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(tasks.get("task-1")?.delivery?.ciWatch).toBeDefined();
    expect(tasks.get("task-1")?.delivery?.ciRepair).toBeUndefined();
  });

  it("does not spend a reservation from an older head when a project rerun is accepted", async () => {
    const { write, tasks, reserve } = await fixture();
    reserve();
    const ledger = structuredClone(tasks.get("task-1")?.delivery?.ciRepair);
    if (!ledger?.rerun) throw new Error("fixture has no reservation");
    ledger.rerun.headSha = "b".repeat(40);
    tasks.recordDelivery("task-1", { ciRepair: ledger });
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
        })
      ).text,
    ).toContain('"status": 201');
    expect(tasks.get("task-1")?.delivery?.ciRepair).toEqual(ledger);
  });

  it("reads the checks again while the rerun is not yet running, then says so if it never shows", async () => {
    const first = await fixture();
    first.reserve();
    first.armOn(3);
    const rerun = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/runs/9/rerun-failed-jobs",
    };
    const answer = (await first.write.run(rerun)).text;
    expect(first.readChecks).toHaveBeenCalledTimes(3);
    expect(answer).toContain("reading 3");
    expect(answer).not.toContain("did not read as running");

    const second = await fixture();
    second.reserve();
    second.armOn(99);
    const late = (await second.write.run(rerun)).text;
    expect(second.readChecks).toHaveBeenCalledTimes(3);
    expect(late).toContain("did not read as running yet");
  });

  it("stops a task at its call budget", async () => {
    const { read, seen } = await fixture();
    for (let call = 0; call < 200; call++) await read.run({ path: "/repos/octo/meter/pulls" });
    expect(seen).toHaveLength(200);
    expect((await read.run({ path: "/repos/octo/meter/pulls" })).text).toContain(
      "200 GitHub calls",
    );
    expect(seen).toHaveLength(200);
  });

  it("INF-125: refuses to substitute release-file bytes for an approved JSON validation write", async () => {
    const guard = vi.fn(async () => {});
    const { write, seen, dir, tasks } = await fixture({ beforeValidationWrite: guard });
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const result = await write.run({
      method: "POST",
      path: "/repos/octo/meter/releases/9/assets",
      file: "app.dmg",
      validationEffect: "shared-1",
    });
    expect(result.text).toContain("not a release file");
    expect(seen).toEqual([]);
    expect(guard).not.toHaveBeenCalled();
    expect(tasks.get("task-1")?.delivery?.writeAsks ?? []).toEqual([]);
  });

  it("streams a release file to GitHub's upload address and keeps another project's file for the captain", async () => {
    const { write, writeWithoutProject, seen, types, dir, service, tasks } = await fixture();
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const before = seen.length;
    const sent = JSON.parse(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/releases/9/assets",
          file: "app.dmg",
        })
      ).text,
    );
    expect(sent).toMatchObject({
      status: 201,
      ok: true,
      body: { id: 9, name: "app.dmg", state: "uploaded" },
    });
    expect(seen[before]).toMatchObject({
      method: "POST",
      path: "/repos/octo/meter/releases/9/assets?name=app.dmg",
      auth: "Bearer gho_fixture_owned_by_app",
      body: "release-bytes",
    });
    expect(types[before]).toBe("application/x-apple-diskimage");
    expect(JSON.stringify(sent)).not.toContain("gho_");

    const foreign = (
      await write.run({
        method: "POST",
        path: "https://evil.example/repos/octo/meter/releases/9/assets?name=app.dmg",
        file: "app.dmg",
      })
    ).text;
    expect(foreign).toContain("accepted only on GitHub's upload address");
    expect(seen).toHaveLength(before + 1);

    const kept = (
      await write.run({
        method: "POST",
        path: "/repos/acme/site/releases/3/assets?name=app.dmg",
        file: "app.dmg",
      })
    ).text;
    expect(kept).toContain("Not sent: it goes outside this task's own project");
    expect(seen).toHaveLength(before + 1);
    const askId = kept.match(/ask (wa[a-z0-9]+)/)?.[1];
    expect(askId).toBeTruthy();
    const click = await service.sendAsk("task-1", askId ?? "");
    expect(click.ok).toBe(true);
    expect(click.answer).toContain("uploaded");
    expect(seen.at(-1)).toMatchObject({
      path: "/repos/acme/site/releases/3/assets?name=app.dmg",
      body: "release-bytes",
    });
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    expect(ask?.file).toBe("app.dmg");
    expect(ask && writeAskStrip(ask)).toContain(
      "A file from this task's working copy. It is read only when you click.",
    );

    expect(
      (
        await writeWithoutProject.run({
          method: "POST",
          path: "/repos/octo/meter/releases/9/assets",
          file: "app.dmg",
        })
      ).text,
    ).toContain("no working copy");
  });

  it("refuses a link, a path outside the working copy, and a missing release file", async () => {
    const { write, seen, dir } = await fixture();
    symlinkSync(join(dir, "app.dmg"), join(dir, "linked.dmg"));
    writeFileSync(join(dir, "app.dmg"), "release-bytes");
    const refused = (file: string, body?: string) =>
      write.run({
        method: "POST",
        path: "/repos/octo/meter/releases/9/assets",
        file,
        ...(body !== undefined ? { body } : {}),
      });
    expect((await refused("linked.dmg")).text).toContain("is a link");
    expect((await refused("../secret")).text).toContain("never a link");
    expect((await refused("missing.dmg")).text).toContain("There is no missing.dmg");
    expect(
      (
        await write.run({
          method: "POST",
          path: "/repos/octo/meter/issues",
          file: "app.dmg",
          body: "{}",
        })
      ).text,
    ).toContain("leave body out");
    expect(seen).toHaveLength(0);
  });
});
