import { describe, expect, it, vi } from "vitest";
import { ForgeError } from "../../forge";
import { readDataCenterOpenChanges } from "./dataCenterChanges";
import { DataCenterForge } from "./dataCenterForge";

/**
 * The crew's reach on Bitbucket Data Center (`docs/forge.md`, "On Bitbucket
 * Data Center"), the task's intent being the captain's "adding bitbucket as
 * another forge integration just like github and gitlab, reaching parity as
 * much as possible": the comment wake reads who wrote each comment and
 * where, never its words; a batch's own story comments are written and
 * replaced at the version read; the main-failure wake reads main's build
 * statuses; a fork is read and made in the person's own project; and the
 * open pull requests panel lists the person's pull requests with their
 * checks. Answers follow the server's published REST shapes (8.19).
 */

const HOST = "bitbucket.example.com";
const SERVER = `https://${HOST}`;
const KEY = "BBDC-MTIzNDU2Nzg5MDEy+disposable/test=";
const REPO = "/rest/api/latest/projects/PRJ/repos/app";
const PULL = `${REPO}/pull-requests/7`;
const MAIN = "c0ffee00d15ea5e0b16b00b5ca5cade0ddba11ed";
const FORK = "/rest/api/latest/projects/~jane.doe/repos/app";

type Call = { method: string; path: string; body: unknown };
/** Answers a call named `METHOD /path` (no query), or leaves it to a 404. */
type Route = (where: string, url: URL) => Response | undefined;

/** A stand-in Data Center, recording every call; it names the signed-in user `jane.doe` unless told. */
function server(route: Route, user = "jane.doe") {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    if (method === "GET" && url.pathname === "/rest/api/latest/application-properties")
      return Response.json({ version: "8.19.1" }, { headers: { "X-AUSERNAME": user } });
    return (
      route(`${method} ${url.pathname}`, url) ??
      Response.json(
        { errors: [{ message: "no such path", exceptionName: "NoSuchEntityException" }] },
        { status: 404 },
      )
    );
  });
  return { fetcher, calls };
}

function page(values: unknown[]) {
  return Response.json({ size: values.length, limit: 100, start: 0, isLastPage: true, values });
}

function forgeWith(
  fetcher: typeof fetch,
  location: { owner?: string; name?: string; source?: { id: number; fullName: string } } = {
    owner: "scm/prj",
    name: "app",
  },
) {
  return new DataCenterForge(
    { kind: "bitbucket", host: HOST, dir: "", ...location },
    { token: async () => KEY, serverUrl: SERVER, fetch: fetcher },
  );
}

const person = (name: string, type = "NORMAL") => ({ name, slug: name, displayName: name, type });

/** A pull request's activity, newest first, as the server lists it. */
const activities = [
  // The visitor edited their comment: this newest reading is the one kept.
  {
    action: "COMMENTED",
    commentAction: "EDITED",
    comment: {
      id: 11,
      version: 1,
      text: "Could the photo keep its caption? (edited)",
      author: person("visitor"),
      createdDate: 1_000,
      updatedDate: 5_000,
    },
  },
  { action: "APPROVED", user: person("maintainer") },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    commentAnchor: { path: "src/notes.ts", line: 41, lineType: "ADDED" },
    comment: {
      id: 12,
      version: 0,
      text: "This line drops the caption.",
      author: person("maintainer"),
      createdDate: 3_000,
      updatedDate: 3_000,
      comments: [
        {
          id: 13,
          version: 0,
          text: "Kept it.",
          author: person("jane.doe"),
          createdDate: 4_000,
          updatedDate: 4_000,
        },
      ],
    },
  },
  {
    action: "COMMENTED",
    commentAction: "DELETED",
    comment: { id: 14, version: 1, author: person("visitor") },
  },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    comment: { id: 14, version: 0, text: "gone", author: person("visitor"), createdDate: 2_500 },
  },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    comment: {
      id: 15,
      version: 0,
      text: "draft",
      state: "PENDING",
      author: person("maintainer"),
      createdDate: 2_600,
    },
  },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    comment: {
      id: 16,
      version: 0,
      text: "Build 57 failed.",
      author: person("ci-bot", "SERVICE"),
      createdDate: 2_700,
    },
  },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    comment: {
      id: 17,
      version: 2,
      text: "<!-- infinitary-story: batch -->\n## Why",
      author: person("jane.doe"),
      createdDate: 2_000,
    },
  },
  {
    action: "COMMENTED",
    commentAction: "ADDED",
    comment: {
      id: 11,
      version: 0,
      text: "Could the photo keep its caption?",
      author: person("visitor"),
      createdDate: 1_000,
      updatedDate: 1_000,
    },
  },
];

function commentServer() {
  return server((where, url) => {
    if (where === `GET ${PULL}/activities`) return page(activities);
    if (where === `GET ${REPO}/permissions/users`)
      return page(
        url.searchParams.get("filter") === "maintainer"
          ? [{ user: person("maintainer"), permission: "REPO_WRITE" }]
          : [],
      );
    if (where === "GET /rest/api/latest/projects/PRJ/permissions/users") return page([]);
    if (where === `GET ${PULL}/comments/17`) return Response.json({ id: 17, version: 2 });
    if (where === `PUT ${PULL}/comments/17`) return Response.json({ id: 17, version: 3 });
    if (where === `POST ${PULL}/comments`)
      return Response.json({ id: 18, version: 0 }, { status: 201 });
    if (where === `DELETE ${PULL}/comments/17`) return new Response(null, { status: 204 });
    return undefined;
  });
}

describe("comments on a Data Center pull request", () => {
  it("reads who wrote each comment and where, the newest reading of each, leaving out deleted and draft ones", async () => {
    const { fetcher } = commentServer();
    const comments = await forgeWith(fetcher).pullComments?.(7);
    expect(comments).toEqual([
      { id: 11, kind: "comment", author: "visitor", relation: "cannot-write" },
      {
        id: 12,
        kind: "line",
        author: "maintainer",
        relation: "can-write",
        path: "src/notes.ts",
        line: 41,
      },
      {
        id: 13,
        kind: "line",
        author: "jane.doe",
        relation: "you",
        path: "src/notes.ts",
        line: 41,
        replyTo: 12,
      },
      { id: 16, kind: "comment", author: "ci-bot", relation: "bot" },
      { id: 17, kind: "comment", author: "jane.doe", relation: "you", story: true },
    ]);
    // The words never leave the reader.
    expect(JSON.stringify(comments)).not.toContain("caption");
  });

  it("reads only comments changed since the last reading, leaving out those it already read", async () => {
    const { fetcher } = commentServer();
    const comments = await forgeWith(fetcher).pullComments?.(
      7,
      new Date(3_000).toISOString(),
      new Set([12]),
    );
    expect(comments?.map((comment) => comment.id)).toEqual([11, 13]);
  });

  it("finds the app's own story comments by their opening words, and replaces one at the version read", async () => {
    const { fetcher, calls } = commentServer();
    const forge = forgeWith(fetcher);
    expect(await forge.ownComments?.(7, "<!-- infinitary-story:")).toEqual([
      { id: 17, body: "<!-- infinitary-story: batch -->\n## Why" },
    ]);
    await forge.writeComment?.(7, "<!-- infinitary-story: batch -->\n## Why, again", 17);
    expect(calls.find((call) => call.method === "PUT")).toEqual({
      method: "PUT",
      path: `${PULL}/comments/17`,
      body: { text: "<!-- infinitary-story: batch -->\n## Why, again", version: 2 },
    });
    await forge.writeComment?.(7, "A new story");
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      path: `${PULL}/comments`,
      body: { text: "A new story" },
    });
    await forge.deleteComment?.(7, 17);
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(
      `${PULL}/comments/17?version=2`,
    );
    // A comment already gone is nothing left to delete.
    await expect(forge.deleteComment?.(7, 99)).resolves.toBeUndefined();
  });
});

describe("main's checks on Data Center", () => {
  it("reads the build statuses on the main branch's head, for the main-failure wake", async () => {
    const { fetcher } = server((where) => {
      if (where === `GET ${REPO}/default-branch`)
        return Response.json({ id: "refs/heads/main", displayId: "main" });
      if (where === `GET ${REPO}/branches`)
        return page([
          { id: "refs/heads/main-old", latestCommit: "0".repeat(40) },
          { id: "refs/heads/main", latestCommit: MAIN },
        ]);
      if (where === `GET /rest/build-status/latest/commits/${MAIN}`)
        return page([
          { key: "ci", name: "CI", state: "FAILED", url: "https://ci.example.com/9", dateAdded: 9 },
        ]);
      return undefined;
    });
    const { sha, checks } = (await forgeWith(fetcher).branchChecks?.()) ?? {};
    expect(sha).toBe(MAIN);
    expect(checks?.items.map((item) => [item.name, item.state, item.link])).toEqual([
      ["CI", "failure", "https://ci.example.com/9"],
    ]);
  });
});

describe("a fork on Data Center", () => {
  const upstream = { id: 42, slug: "app", project: { key: "PRJ", type: "NORMAL" } };
  const fork = {
    id: 77,
    slug: "app",
    project: { key: "~JANE.DOE", type: "PERSONAL" },
    origin: upstream,
  };

  it("is offered only to a project read over HTTPS, whose address names its project under scm/", () => {
    const { fetcher } = server(() => undefined);
    expect(forgeWith(fetcher).contributions).toBeDefined();
    expect(forgeWith(fetcher, { owner: "PRJ", name: "app" }).contributions).toBeUndefined();
  });

  it("reads whether the sign-in may push, and an owned fork with the repository it came from", async () => {
    const { fetcher } = server((where) => {
      if (where === `GET ${REPO}`) return Response.json(upstream);
      if (where === `GET ${FORK}`) return Response.json(fork);
      if (where === "GET /rest/api/latest/repos")
        // The person may write to and administer their fork, and only read the repository.
        return page([fork]);
      return undefined;
    });
    expect(await forgeWith(fetcher).contributions?.inspect()).toEqual({
      project: { id: 42, fullName: "scm/prj/app", origin: `${SERVER}/scm/prj/app.git` },
      canPush: false,
      owned: false,
    });
    expect(
      await forgeWith(fetcher, { owner: "scm/~jane.doe", name: "app" }).contributions?.inspect(),
    ).toEqual({
      project: { id: 77, fullName: "scm/~jane.doe/app", origin: `${SERVER}/scm/~jane.doe/app.git` },
      canPush: true,
      owned: true,
      parent: { id: 42, fullName: "scm/prj/app", origin: `${SERVER}/scm/prj/app.git` },
    });
  });

  it("finds the person's fork in their own project, and makes one there when none is", async () => {
    let forks: unknown[] = [{ id: 90, slug: "app", project: { key: "OTHER" } }];
    const { fetcher, calls } = server((where) => {
      if (where === `GET ${REPO}/forks`) return page(forks);
      if (where === `POST ${REPO}`) return Response.json(fork, { status: 201 });
      return undefined;
    });
    const contributions = forgeWith(fetcher).contributions;
    expect(await contributions?.findFork()).toBeNull();
    expect(await contributions?.createFork()).toMatchObject({
      id: 77,
      fullName: "scm/~jane.doe/app",
    });
    expect(calls.find((call) => call.method === "POST")).toEqual({
      method: "POST",
      path: REPO,
      body: {},
    });
    forks = [...forks, fork];
    expect(await contributions?.findFork()).toMatchObject({ id: 77 });
  });

  it("finds the fork of a person whose user name differs from the slug their own project is keyed by", async () => {
    // Data Center keys `jane@example.com`'s own project by her slug, `~JANE_EXAMPLE.COM`.
    const owner = { name: "jane@example.com", slug: "jane_example.com", type: "NORMAL" };
    const theirs = {
      id: 78,
      slug: "app",
      project: { key: "~JANE_EXAMPLE.COM", type: "PERSONAL", owner },
      origin: upstream,
    };
    const someoneElse = {
      id: 79,
      slug: "app",
      project: { key: "~JANE", type: "PERSONAL", owner: { ...owner, name: "jane", slug: "jane" } },
    };
    const { fetcher, calls } = server((where) => {
      if (where === `GET ${REPO}/forks`) return page([someoneElse, theirs]);
      return undefined;
    }, "jane@example.com");
    expect(await forgeWith(fetcher).contributions?.findFork()).toMatchObject({
      id: 78,
      fullName: "scm/~jane_example.com/app",
    });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("opens a contribution from the fork's branch, and leaves its merge to the maintainers", async () => {
    const { fetcher, calls } = server((where) => {
      if (where === `GET ${REPO}/default-branch`)
        return Response.json({ id: "refs/heads/main", displayId: "main" });
      if (where === `POST ${REPO}/pull-requests`)
        return Response.json(
          {
            id: 8,
            version: 0,
            title: "fix: notes",
            state: "OPEN",
            fromRef: { id: "refs/heads/inf/fix-notes", latestCommit: MAIN, repository: fork },
            toRef: { id: "refs/heads/main", latestCommit: MAIN, repository: upstream },
            links: { self: [{ href: `${SERVER}/projects/PRJ/repos/app/pull-requests/8` }] },
          },
          { status: 201 },
        );
      return undefined;
    });
    const forge = forgeWith(fetcher, {
      owner: "scm/prj",
      name: "app",
      source: { id: 77, fullName: "scm/~jane.doe/app" },
    });
    const opened = await forge.openChange({
      branch: "inf/fix-notes",
      title: "fix: notes",
      body: "",
    });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      fromRef: {
        id: "refs/heads/inf/fix-notes",
        repository: { slug: "app", project: { key: "~jane.doe" } },
      },
      toRef: { id: "refs/heads/main", repository: { slug: "app", project: { key: "PRJ" } } },
    });
    await expect(forge.putIn(opened, MAIN, "merge")).rejects.toMatchObject({
      failure: "permission",
    });
    await expect(forge.putIn(opened, MAIN, "merge")).rejects.toBeInstanceOf(ForgeError);
    expect(await forge.branchPage?.("inf/fix-notes")).toBeNull();
    expect(calls.filter((call) => call.path.includes("/merge"))).toEqual([]);
  });
});

describe("the open pull requests panel on Data Center", () => {
  it("lists the person's open pull requests newest first, with the newest build status of each key", async () => {
    const FAILED = "1".repeat(40);
    const PASSED = "2".repeat(40);
    const { fetcher, calls } = server((where) => {
      if (where === "GET /rest/api/latest/dashboard/pull-requests")
        return page([
          {
            id: 3,
            title: "fix: older",
            updatedDate: Date.UTC(2026, 10, 18),
            fromRef: { latestCommit: PASSED },
            toRef: { repository: { slug: "app", project: { key: "PRJ" } } },
            links: { self: [{ href: `${SERVER}/projects/PRJ/repos/app/pull-requests/3` }] },
          },
          {
            id: 9,
            title: "feat: newer",
            draft: true,
            updatedDate: Date.UTC(2026, 10, 19),
            fromRef: { latestCommit: FAILED },
            toRef: { repository: { slug: "site", project: { key: "WEB" } } },
          },
        ]);
      if (where === `GET /rest/build-status/latest/commits/${FAILED}`)
        return page([
          { key: "ci", state: "SUCCESSFUL", dateAdded: 2 },
          { key: "lint", state: "FAILED", dateAdded: 1 },
        ]);
      if (where === `GET /rest/build-status/latest/commits/${PASSED}`)
        return page([
          { key: "ci", state: "SUCCESSFUL", dateAdded: 2 },
          { key: "ci", state: "FAILED", dateAdded: 1 },
        ]);
      return undefined;
    });
    const rows = await readDataCenterOpenChanges({
      host: HOST,
      token: async () => KEY,
      serverUrl: SERVER,
      fetch: fetcher,
    });
    expect(rows).toEqual([
      {
        host: HOST,
        project: "WEB/site",
        number: 9,
        label: "#9",
        title: "feat: newer",
        url: `${SERVER}/projects/WEB/repos/site/pull-requests/9`,
        draft: true,
        checks: "failed",
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
      {
        host: HOST,
        project: "PRJ/app",
        number: 3,
        label: "#3",
        title: "fix: older",
        url: `${SERVER}/projects/PRJ/repos/app/pull-requests/3`,
        draft: false,
        checks: "passed",
        updatedAt: "2026-11-18T00:00:00.000Z",
      },
    ]);
    expect(calls[0]?.path).toBe(
      "/rest/api/latest/dashboard/pull-requests?state=OPEN&role=AUTHOR&order=NEWEST&limit=20",
    );
  });
});
