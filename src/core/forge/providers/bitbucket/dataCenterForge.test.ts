import { join } from "node:path";
import { BITBUCKET } from "@shared/forges";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { forgeHostIntegration } from "../../../integrations";
import { ForgeError } from "../../forge";
import { requestLinkAtRepo } from "../../index";
import { ForgeSignInStore, ForgeSignIns } from "../../signIns";
import { dataCenterFailureOf } from "./dataCenterClient";
import { DataCenterForge } from "./dataCenterForge";
import { dataCenterProjectKey } from "./dataCenterProjects";
import { atLeast, createBitbucketServer } from "./signIn";

// Answers shaped as Bitbucket Data Center's published REST API (8.19) gives them.
const HOST = "bitbucket.example.com";
const SERVER = `https://${HOST}`;
const KEY = "BBDC-MTIzNDU2Nzg5MDEy+disposable/test=";
const HEAD = "4f1c2a9b7e3d5c6f8a0b1c2d3e4f5a6b7c8d9e0f";
const MOVED = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
const MERGED = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const REPO = "/rest/api/latest/projects/PRJ/repos/app";

const repository = { id: 42, slug: "app", project: { key: "PRJ", type: "NORMAL" } };

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    version: 3,
    title: "feat: add the export",
    description: "Exports the report.",
    state: "OPEN",
    open: true,
    closed: false,
    draft: false,
    fromRef: {
      id: "refs/heads/inf/export",
      displayId: "inf/export",
      latestCommit: HEAD,
      repository,
    },
    toRef: { id: "refs/heads/main", displayId: "main", latestCommit: MOVED, repository },
    reviewers: [{ user: { name: "reviewer", slug: "reviewer" }, approved: false }],
    links: { self: [{ href: `${SERVER}/projects/PRJ/repos/app/pull-requests/7` }] },
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown };

/** A stand-in Data Center answering by method and path, recording every call. */
function server(routes: Record<string, (body: unknown) => Response>) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname + url.search;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname}`];
    return route
      ? route(body)
      : Response.json(
          { errors: [{ message: "no such path", exceptionName: "NoSuchEntityException" }] },
          { status: 404 },
        );
  });
  return { fetcher, calls };
}

function forgeWith(fetcher: typeof fetch, owner = "scm/prj") {
  return new DataCenterForge(
    { kind: "bitbucket", host: HOST, owner, name: "app", dir: "" },
    { token: async () => KEY, serverUrl: SERVER, fetch: fetcher },
  );
}

const change = {
  number: 7,
  url: null,
  branch: "inf/export",
  headSha: HEAD,
  title: "feat: add the export",
  body: "Exports the report.",
};

describe("Bitbucket Data Center sign-in", () => {
  function signIns(routes: Record<string, (body: unknown) => Response>) {
    const { fetcher } = server(routes);
    const store = new ForgeSignInStore(join(scratchDir("fm-bitbucket-dc-key-"), "forges"));
    const service = new ForgeSignIns({
      store,
      providers: [],
      servers: [
        createBitbucketServer({
          apiBaseFor: () => "https://api.bitbucket.org/2.0",
          dataCenterBaseFor: () => SERVER,
          fetch: fetcher,
        }),
      ],
      projectsOn: () => 0,
      push: () => {},
    });
    return { store, service };
  }
  const about = (version: string) => () =>
    Response.json({ version, buildNumber: "8019000", displayName: "Bitbucket" });

  it("keeps a token a recent server answers for, with the person's own name as git's user", async () => {
    const { store, service } = signIns({
      "GET /rest/api/latest/application-properties": about("8.19.4"),
      "GET /rest/api/latest/users?limit=1": () =>
        Response.json(
          { size: 1, limit: 1, isLastPage: false, start: 0, values: [{ name: "other" }] },
          { headers: { "X-AUSERNAME": "jane.doe" } },
        ),
    });
    expect(await service.signInWithKey({ kind: "bitbucket", address: HOST, key: KEY })).toEqual({
      ok: true,
      host: HOST,
    });
    expect(store.read(HOST)).toMatchObject({
      token: KEY,
      kind: "bitbucket",
      login: "jane.doe",
      gitUser: "jane.doe",
    });
    expect(service.nameOf(HOST)).toBe(HOST);
  });

  it("refuses a server older than 8.19 as not this kind of server, and keeps nothing", async () => {
    const { store, service } = signIns({
      "GET /rest/api/latest/application-properties": about("8.18.2"),
    });
    expect(await service.signInWithKey({ kind: "bitbucket", address: HOST, key: KEY })).toEqual({
      ok: false,
      problem: "not-server",
      host: HOST,
    });
    expect(store.read(HOST)).toBeUndefined();
  });

  it("tells a refused token from one lacking permission, both as not accepted", async () => {
    for (const exceptionName of [
      "com.atlassian.bitbucket.auth.IncorrectPasswordAuthenticationException",
      "com.atlassian.bitbucket.AuthorisationException",
    ]) {
      const { service } = signIns({
        "GET /rest/api/latest/application-properties": about("9.4.0"),
        "GET /rest/api/latest/users?limit=1": () =>
          Response.json({ errors: [{ message: "no", exceptionName }] }, { status: 401 }),
      });
      expect(
        await service.signInWithKey({ kind: "bitbucket", address: HOST, key: KEY }),
      ).toMatchObject({ ok: false, problem: "refused" });
    }
    expect(dataCenterFailureOf(401, "com.atlassian.bitbucket.AuthorisationException")).toBe(
      "permission",
    );
    expect(dataCenterFailureOf(401, "")).toBe("sign-in");
  });

  it("reads versions by their number, not their text", () => {
    expect(atLeast("8.19.0", [8, 19])).toBe(true);
    expect(atLeast("10.0.1", [8, 19])).toBe(true);
    expect(atLeast("8.9.30", [8, 19])).toBe(false);
    expect(atLeast("7.21.0", [8, 19])).toBe(false);
  });
});

describe("Bitbucket Data Center projects", () => {
  it("names a project by its key from either clone address, and a person's own project by their name", () => {
    expect(dataCenterProjectKey("scm/prj")).toBe("PRJ");
    expect(dataCenterProjectKey("prj")).toBe("PRJ");
    expect(dataCenterProjectKey("~Jane.Doe")).toBe("~jane.doe");
  });

  it("lists every page the token may read, with a clone address that names no account", async () => {
    const { fetcher } = server({
      "GET /rest/api/latest/repos?permission=REPO_READ&start=0&limit=100": () =>
        Response.json({
          size: 1,
          limit: 100,
          start: 0,
          isLastPage: false,
          nextPageStart: 100,
          values: [
            {
              ...repository,
              public: false,
              links: {
                clone: [
                  { href: `ssh://git@${HOST}:7999/prj/app.git`, name: "ssh" },
                  { href: `https://jane.doe@${HOST}/scm/prj/app.git`, name: "http" },
                ],
                self: [{ href: `${SERVER}/projects/PRJ/repos/app/browse` }],
              },
            },
          ],
        }),
      "GET /rest/api/latest/repos?permission=REPO_READ&start=100&limit=100": () =>
        Response.json({
          size: 1,
          limit: 100,
          start: 100,
          isLastPage: true,
          values: [{ id: 43, slug: "notes", project: { key: "~jane.doe" }, public: true }],
        }),
    });
    const listed = await forgeWith(fetcher).listProjectsPaged();
    expect(listed.complete).toBe(true);
    expect(listed.projects).toEqual([
      {
        fullName: "PRJ/app",
        cloneUrl: `${SERVER}/scm/prj/app.git`,
        url: `${SERVER}/projects/PRJ/repos/app/browse`,
        updatedAt: null,
        private: true,
      },
      {
        fullName: "~jane.doe/notes",
        cloneUrl: `${SERVER}/scm/~jane.doe/notes.git`,
        url: `${SERVER}/projects/~jane.doe/repos/notes/browse`,
        updatedAt: null,
        private: false,
      },
    ]);
  });
});

describe("Bitbucket Data Center pull requests", () => {
  it("opens a pull request from the branch onto the main branch, as a draft when asked", async () => {
    const { fetcher, calls } = server({
      [`GET ${REPO}/default-branch`]: () =>
        Response.json({ id: "refs/heads/main", displayId: "main" }),
      [`POST ${REPO}/pull-requests`]: () =>
        Response.json(pullRequest({ draft: true }), { status: 201 }),
    });
    const opened = await forgeWith(fetcher).openChange({
      branch: "inf/export",
      title: "feat: add the export",
      body: "Exports the report.",
      draft: true,
    });
    expect(calls.at(-1)?.body).toEqual({
      title: "feat: add the export",
      description: "Exports the report.",
      fromRef: {
        id: "refs/heads/inf/export",
        repository: { slug: "app", project: { key: "PRJ" } },
      },
      toRef: { id: "refs/heads/main", repository: { slug: "app", project: { key: "PRJ" } } },
      draft: true,
    });
    expect(opened).toMatchObject({
      number: 7,
      draft: true,
      branch: "inf/export",
      headSha: HEAD,
      base: "main",
      url: `${SERVER}/projects/PRJ/repos/app/pull-requests/7`,
    });
  });

  it("reads the newest build status per key on the version, a cancelled one as cancelled", async () => {
    const { fetcher } = server({
      [`GET /rest/build-status/latest/commits/${HEAD}?orderBy=NEWEST&start=0&limit=100`]: () =>
        Response.json({
          size: 3,
          limit: 100,
          start: 0,
          isLastPage: true,
          values: [
            {
              key: "ci",
              name: "CI",
              state: "SUCCESSFUL",
              url: "https://ci.example.com/2",
              dateAdded: 2000,
            },
            {
              key: "ci",
              name: "CI",
              state: "FAILED",
              url: "https://ci.example.com/1",
              dateAdded: 1000,
            },
            {
              key: "lint",
              name: "Lint",
              state: "CANCELLED",
              url: "https://ci.example.com/3",
              dateAdded: 1500,
            },
          ],
        }),
    });
    const checks = await forgeWith(fetcher).checks(change);
    expect(checks.complete).toBe(true);
    expect(checks.items.map((item) => [item.name, item.state, item.link])).toEqual([
      ["CI", "success", "https://ci.example.com/2"],
      ["Lint", "cancelled", "https://ci.example.com/3"],
    ]);
  });

  it("allows the merges the repository's strategies enable", async () => {
    const { fetcher } = server({
      [`GET ${REPO}/settings/pull-requests`]: () =>
        Response.json({
          mergeConfig: {
            type: "REPOSITORY",
            defaultStrategy: { id: "no-ff", enabled: true },
            strategies: [
              { id: "no-ff", enabled: true },
              { id: "ff", enabled: false },
              { id: "squash", enabled: true },
              { id: "rebase-no-ff", enabled: false },
            ],
          },
        }),
    });
    expect(await forgeWith(fetcher).mergeWays()).toEqual({
      squash: true,
      rebase: false,
      merge: true,
    });
  });

  it("merges at the version it read, and names the merge commit", async () => {
    const { fetcher, calls } = server({
      [`GET ${REPO}/pull-requests/7`]: () => Response.json(pullRequest()),
      [`POST ${REPO}/pull-requests/7/merge`]: () =>
        Response.json(
          pullRequest({ state: "MERGED", version: 4, properties: { mergeCommit: { id: MERGED } } }),
        ),
    });
    const before = vi.fn();
    expect(await forgeWith(fetcher).putIn(change, HEAD, "squash", before)).toEqual({
      sha: MERGED,
    });
    expect(before).toHaveBeenCalledOnce();
    const merge = calls.find((call) => call.method === "POST");
    expect(merge?.path).toBe(`${REPO}/pull-requests/7/merge?version=3`);
    expect(merge?.body).toEqual({
      version: 3,
      message: "feat: add the export\n\nExports the report.",
      strategyId: "squash",
      autoSubject: false,
    });
  });

  it("sends nothing when the branch moved past the version whose checks were read", async () => {
    const { fetcher, calls } = server({
      [`GET ${REPO}/pull-requests/7`]: () =>
        Response.json(pullRequest({ fromRef: { ...pullRequest().fromRef, latestCommit: MOVED } })),
    });
    await expect(forgeWith(fetcher).putIn(change, HEAD, "squash")).rejects.toMatchObject({
      failure: "refused",
      beforeSend: true,
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reads the server's refusal of an older version as nothing merged", async () => {
    const { fetcher } = server({
      [`GET ${REPO}/pull-requests/7`]: () => Response.json(pullRequest()),
      [`POST ${REPO}/pull-requests/7/merge`]: () =>
        Response.json(
          {
            errors: [
              {
                message:
                  "You are attempting to modify a pull request based on out-of-date information.",
                exceptionName: "com.atlassian.bitbucket.pull.PullRequestOutOfDateException",
              },
            ],
          },
          { status: 409 },
        ),
    });
    const refused = await forgeWith(fetcher)
      .putIn(change, HEAD, "squash")
      .catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ForgeError);
    expect(refused).toMatchObject({ failure: "refused", beforeSend: false });
    expect((refused as Error).message).toContain("Nothing was merged");
  });

  it("reads a veto as blocked, a conflict as a conflict and a draft as a draft", async () => {
    for (const [merge, draft, expected] of [
      [
        {
          canMerge: false,
          conflicted: false,
          outcome: "CLEAN",
          vetoes: [{ summaryMessage: "Needs 1 approval" }],
        },
        false,
        "blocked",
      ],
      [{ canMerge: false, conflicted: true, outcome: "CONFLICTED", vetoes: [] }, false, "conflict"],
      [{ canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] }, false, "clean"],
      [{ canMerge: false, conflicted: false, outcome: "UNKNOWN", vetoes: [] }, false, "computing"],
      [{ canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] }, true, "draft"],
    ] as const) {
      const { fetcher } = server({
        [`GET ${REPO}/pull-requests/7`]: () => Response.json(pullRequest({ draft })),
        [`GET ${REPO}/pull-requests/7/merge`]: () => Response.json(merge),
      });
      expect((await forgeWith(fetcher).pull(7)).readiness).toBe(expected);
    }
  });

  it("replaces the description at the version read and keeps the reviewers", async () => {
    const { fetcher, calls } = server({
      [`GET ${REPO}/pull-requests/7`]: () => Response.json(pullRequest()),
      [`PUT ${REPO}/pull-requests/7`]: () => Response.json(pullRequest({ version: 4 })),
    });
    await forgeWith(fetcher).updateChangeBody(change, "The new story.");
    expect(calls.at(-1)?.body).toEqual({
      version: 3,
      title: "feat: add the export",
      description: "The new story.",
      reviewers: [{ user: { name: "reviewer" } }],
    });
  });
});

describe("Bitbucket Data Center in Integrations", () => {
  it("lists the server's sign-in as a Bitbucket row whose actions reach the server's own REST API", async () => {
    const reads: { host: string; path: string }[] = [];
    const unused = () => {
      throw new Error("no write is expected");
    };
    const binding = forgeHostIntegration("bitbucket", {
      signIns: {
        view: () => ({
          signIns: [
            {
              host: HOST,
              name: HOST,
              login: "jane.doe",
              state: "ok",
              projects: 1,
              since: 1,
              server: BITBUCKET,
            },
          ],
          hosts: [],
          flow: null,
          ended: null,
        }),
        stateOf: () => "ok",
        loginOf: () => "jane.doe",
        checkNow: async () => {},
        signOut: () => {},
        presentHosts: () => [HOST],
      },
      gateway: (host) => ({
        read: async (_task, input) => {
          reads.push({ host, path: input.path });
          return "answered";
        },
        write: unused,
        readAsSeat: unused,
        writeAsSeat: unused,
      }),
    });
    const [row] = binding.connections();
    expect(row).toMatchObject({ host: HOST, name: HOST, account: "jane.doe" });
    const read = row?.actions.find((action) => action.name === "read");
    expect(row?.actions.map((action) => action.name)).toEqual(["read", "write"]);
    expect(read?.description).toContain("Bitbucket Data Center REST API path");
    expect(read?.description).toContain("/rest/");
    // Allow for the rest of this task covers one repository, whichever of the server's APIs a path names.
    const path = "/rest/api/latest/projects/FLD/repos/field-notes/pull-requests?state=OPEN";
    expect(read?.scope?.({ method: "GET", path })).toEqual(
      read?.scope?.({
        method: "GET",
        path: "/rest/build-status/latest/projects/fld/repos/field-notes/commits",
      }),
    );
    expect(read?.scope?.({ method: "GET", path })?.words).toBe("GET requests to fld/field-notes");
    await binding.call(row?.id ?? "", "read", { path }, { kind: "task", taskId: "t1" });
    expect(reads).toEqual([{ host: HOST, path }]);
  });
});

describe("a Data Center pull request's page", () => {
  // Data Center's page is projects/KEY/repos/slug while its clone address is scm/key/slug.
  it("belongs to the repository whose clone address names it, and to no other", () => {
    const repo = (origin: string) => ({
      path: "/work/field-notes",
      origin,
      host: { kind: "bitbucket" as const, name: HOST },
    });
    const page = `https://${HOST}/projects/FLD/repos/field-notes/pull-requests/1`;
    expect(requestLinkAtRepo(repo(`https://${HOST}/scm/fld/field-notes.git`), page)).toBe(true);
    expect(requestLinkAtRepo(repo(`ssh://git@${HOST}:7999/fld/field-notes.git`), page)).toBe(true);
    // The server's own links may name it over http or with www., as forgeOf reads any address.
    expect(
      requestLinkAtRepo(
        repo(`https://${HOST}/scm/fld/field-notes.git`),
        `http://www.${HOST}/projects/FLD/repos/field-notes/pull-requests/1`,
      ),
    ).toBe(true);
    expect(
      requestLinkAtRepo(
        repo(`https://${HOST}/scm/fld/field-notes.git`),
        `https://elsewhere.example.com/projects/FLD/repos/field-notes/pull-requests/1`,
      ),
    ).toBe(false);
    expect(requestLinkAtRepo(repo(`https://${HOST}/scm/fld/other-notes.git`), page)).toBe(false);
    expect(requestLinkAtRepo(repo(`https://${HOST}/scm/abc/field-notes.git`), page)).toBe(false);
  });
});
