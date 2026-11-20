import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { type ForgeHealthChange, ForgeSignInStore, ForgeSignIns } from "../../signIns";
import { BitbucketClient, bitbucketApiBaseFor } from "./client";
import { BitbucketProjects } from "./projects";
import { BITBUCKET_GIT_USER, createBitbucketServer } from "./signIn";

// The task's intent (INF-5192): sign in to Bitbucket Cloud with an API
// token and list its projects by workspace; INF-5193: git answers
// bitbucket.org with the app's sign-in alone. The answers follow Bitbucket's own
// published shapes for /user, /user/workspaces and /repositories.
const API = "https://api.bitbucket.org/2.0";
const HOST = "bitbucket.org";
// An Atlassian API token's shape, which ends in `=` and a check; disposable.
const KEY = "ATATT3xFfGF0disposable_test-key=0A1B2C3D";

function repository(fullName: string, updatedOn: string, isPrivate = true) {
  return {
    type: "repository",
    full_name: fullName,
    is_private: isPrivate,
    updated_on: updatedOn,
    links: {
      html: { href: `https://bitbucket.org/${fullName}` },
      clone: [{ name: "https", href: `https://someone@bitbucket.org/${fullName}.git` }],
    },
  };
}

// The few fields each listing asks Bitbucket for, as the requests carry them.
const WORKSPACES = "/user/workspaces?pagelen=100&fields=next,values.workspace.slug";
const repos = (slug: string) =>
  `/repositories/${slug}?role=member&sort=-updated_on&pagelen=100&fields=next,values.full_name,values.is_private,values.updated_on,values.links.html.href`;

function responder(reply: (path: string) => Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input));
    return reply(url.pathname.replace(/^\/2\.0/, "") + url.search);
  });
}

function projectsWith(fetcher: typeof fetch, onSignInRejected?: () => void) {
  return new BitbucketProjects(HOST, {
    token: async () => KEY,
    apiBaseUrl: API,
    fetch: fetcher,
    ...(onSignInRejected ? { onSignInRejected } : {}),
  });
}

describe("Bitbucket projects", () => {
  it("lists every workspace's projects across pages, newest first, with git's own address", async () => {
    const fetcher = responder((path) => {
      if (path === WORKSPACES)
        return Response.json({
          values: [{ workspace: { slug: "team" } }],
          next: `${API}${WORKSPACES}&page=2`,
        });
      if (path === `${WORKSPACES}&page=2`)
        return Response.json({ values: [{ workspace: { slug: "me" } }] });
      if (path === repos("team"))
        return Response.json({
          values: [repository("team/api", "2026-11-02T10:00:00+00:00")],
          next: `${API}${repos("team")}&page=2`,
        });
      if (path === `${repos("team")}&page=2`)
        return Response.json({ values: [repository("team/site", "2026-10-01T10:00:00+00:00")] });
      if (path === repos("me"))
        return Response.json({
          values: [repository("me/notes", "2026-11-10T10:00:00+00:00", false)],
        });
      if (path === "/repositories/team/api")
        return Response.json(repository("team/api", "2026-11-02T10:00:00+00:00"));
      return new Response(null, { status: 404 });
    });
    const projects = projectsWith(fetcher);
    const listed = await projects.listProjectsPaged();
    expect(listed.complete).toBe(true);
    expect(listed.projects.map((project) => project.fullName)).toEqual([
      "me/notes",
      "team/api",
      "team/site",
    ]);
    expect(listed.projects[1]).toEqual({
      fullName: "team/api",
      cloneUrl: "https://bitbucket.org/team/api.git",
      url: "https://bitbucket.org/team/api",
      updatedAt: "2026-11-02T10:00:00+00:00",
      private: true,
    });
    expect(listed.projects[0]?.private).toBe(false);
    expect(projects.nestedNamespace).toBe(false);
    expect(await projects.findProject("team/api")).toEqual(listed.projects[1]);
    expect(await projects.findProject("team/missing")).toBeNull();
    expect(await projects.findProject("team/group/api")).toBeNull();
  });

  it("reads each workspace's newest page before a long workspace's older ones, and says when it stopped short", async () => {
    // One busy workspace with more pages than the budget holds, and a small
    // one listed after it whose project changed most recently.
    let busyPage = 0;
    const fetcher = responder((path) => {
      if (path === WORKSPACES)
        return Response.json({
          values: [{ workspace: { slug: "busy" } }, { workspace: { slug: "small" } }],
        });
      if (path === repos("small"))
        return Response.json({ values: [repository("small/newest", "2026-11-12T10:00:00+00:00")] });
      busyPage++;
      return Response.json({
        values: [
          repository(`busy/app-${busyPage}`, `2026-10-${String(30 - busyPage)}T10:00:00+00:00`),
        ],
        next: `${API}${repos("busy")}&page=${busyPage + 1}`,
      });
    });
    const listed = await projectsWith(fetcher).listProjectsPaged();
    expect(listed.complete).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(listed.projects[0]?.fullName).toBe("small/newest");
    // The busy workspace's newest pages are read; only its older ones are left.
    expect(listed.projects.map((project) => project.fullName).slice(1)).toEqual(
      Array.from({ length: 8 }, (_, index) => `busy/app-${index + 1}`),
    );
  });

  it("never follows a page link away from Bitbucket's API with the token", async () => {
    const fetcher = responder(() =>
      Response.json({ values: [], next: "https://elsewhere.example.com/2.0/user/workspaces" }),
    );
    await expect(projectsWith(fetcher).listProjectsPaged()).rejects.toMatchObject({
      failure: "refused",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks the health service to check a 401, but not a 403", async () => {
    const rejected = vi.fn();
    for (const status of [401, 403]) {
      const projects = projectsWith(
        responder(() => Response.json({ error: { message: "nope" } }, { status })),
        rejected,
      );
      await expect(projects.listProjects()).rejects.toMatchObject({
        failure: status === 401 ? "sign-in" : "permission",
      });
    }
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("requires this app's sign-in and refuses oversized or unreadable answers", async () => {
    const noFetch = vi.fn<typeof fetch>();
    const missing = new BitbucketClient(HOST, {
      token: async () => undefined,
      apiBaseUrl: API,
      fetch: noFetch,
    });
    await expect(missing.get("/user")).rejects.toMatchObject({ failure: "sign-in" });
    expect(noFetch).not.toHaveBeenCalled();
    for (const response of [new Response("x".repeat(262145)), new Response("not json")]) {
      const client = new BitbucketClient(HOST, {
        token: async () => KEY,
        apiBaseUrl: API,
        fetch: responder(() => response),
      });
      await expect(client.get("/user")).rejects.toThrow();
    }
  });

  it("uses Bitbucket's API and ignores a development override in a packaged build", () => {
    const env = { INFINITARY_BITBUCKET_API_URL: "http://localhost:4321/2.0/" };
    expect(bitbucketApiBaseFor(HOST, { packaged: true, env })).toBe(API);
    expect(bitbucketApiBaseFor(HOST, { packaged: false, env })).toBe("http://localhost:4321/2.0");
  });
});

describe("Bitbucket sign-in by API token", () => {
  function service(fetcher: typeof fetch) {
    const store = new ForgeSignInStore(join(scratchDir("fm-bitbucket-key-"), "forges"));
    const options = {
      store,
      providers: [],
      servers: [createBitbucketServer({ apiBaseFor: () => API, fetch: fetcher })],
      projectsOn: () => 0,
      push: () => {},
    };
    return { store, options, signIns: new ForgeSignIns(options) };
  }

  it("keeps a verified token with Bitbucket's git user, across restart, and nowhere in views", async () => {
    let status = 200;
    const fetcher = responder(() =>
      status === 200
        ? Response.json({ type: "user", display_name: "Octo Cat", nickname: "octo" })
        : new Response(null, { status }),
    );
    const { store, options, signIns } = service(fetcher);
    // INF-5193: git answers bitbucket.org with the app's sign-in alone, as the pull requests the app opens there are made with it.
    expect(signIns.gitHosts()).toContain(HOST);
    expect(signIns.view().hosts).toContainEqual(expect.objectContaining({ host: HOST }));
    status = 401;
    expect(await signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: KEY })).toEqual({
      ok: false,
      problem: "refused",
      host: HOST,
    });
    expect(store.read(HOST)).toBeUndefined();
    status = 200;
    expect(
      await signIns.signInWithKey({
        kind: "bitbucket",
        address: "https://bitbucket.org/team/api",
        key: KEY,
      }),
    ).toEqual({ ok: true, host: HOST });
    expect(store.read(HOST)).toMatchObject({
      token: KEY,
      kind: "bitbucket",
      gitUser: BITBUCKET_GIT_USER,
      login: "octo",
    });
    expect(statSync(join(store.dirFor(HOST), "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(signIns.view())).not.toContain(KEY);
    expect(readFileSync(join(store.root, "health.log"), "utf8")).not.toContain(KEY);
    const restarted = new ForgeSignIns(options);
    expect(await restarted.token(HOST)).toBe(KEY);
    expect(restarted.gitHosts()).toContain(HOST);
    expect(restarted.nameOf(HOST)).toBe("Bitbucket");
    restarted.signOut(HOST);
    expect(store.read(HOST)).toBeUndefined();
    // Signed out, git still never falls back to another sign-in there.
    expect(restarted.gitHosts()).toContain(HOST);
  });

  it("asks to sign in again once Bitbucket refuses a kept token, and lets held work go when a new one replaces a working one", async () => {
    // Bitbucket answers only the token it currently accepts, as a revoked
    // token reads there.
    let accepted = KEY;
    const NEW_KEY = "ATATT3xFfGF0disposable_new-key=4E5F6A7B";
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      new Headers(init?.headers).get("Authorization") === `Bearer ${accepted}`
        ? Response.json({ type: "user", nickname: "octo" })
        : Response.json({ type: "error", error: { message: "Token is invalid" } }, { status: 401 }),
    );
    const changes: ForgeHealthChange[] = [];
    const renewed: string[] = [];
    const { options } = service(fetcher);
    const signIns = new ForgeSignIns({
      ...options,
      onHealthChange: (change) => changes.push(change),
      onRenewed: (host) => renewed.push(host),
    });
    expect(await signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: KEY })).toEqual({
      ok: true,
      host: HOST,
    });
    // A Bitbucket read refused the kept token: one look at /user, and no renewal to try.
    accepted = NEW_KEY;
    const listing = projectsWith(fetcher, () => signIns.rejected(HOST));
    await expect(listing.listProjects()).rejects.toMatchObject({ failure: "sign-in" });
    await vi.waitFor(() => expect(signIns.stateOf(HOST)).toBe("needs_reauth"));
    expect(changes.map((change) => `${change.from} -> ${change.to}`)).toEqual([
      "none -> ok",
      "ok -> needs_reauth",
    ]);
    expect(await signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: NEW_KEY })).toEqual(
      {
        ok: true,
        host: HOST,
      },
    );
    expect(changes.at(-1)).toMatchObject({ from: "needs_reauth", to: "ok" });
    expect(renewed).toEqual([]);
    // A token /user accepts can still be refused by git on a project; a new
    // one over it keeps health ok, and still lets the work that refusal held go.
    const THIRD_KEY = "ATATT3xFfGF0disposable_third-key=8C9D0E1F";
    accepted = THIRD_KEY;
    expect(
      await signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: THIRD_KEY }),
    ).toEqual({ ok: true, host: HOST });
    expect(changes).toHaveLength(3);
    expect(renewed).toEqual([HOST]);
    expect(await signIns.token(HOST)).toBe(THIRD_KEY);
  });

  it("signs in to bitbucket.org alone, and refuses a malformed token before asking", async () => {
    const fetcher = responder(() => Response.json({ nickname: "octo" }));
    const { signIns } = service(fetcher);
    expect(
      await signIns.signInWithKey({ kind: "bitbucket", address: "git.example.com", key: KEY }),
    ).toEqual({ ok: false, problem: "not-server", host: "git.example.com" });
    expect(
      await signIns.signInWithKey({ kind: "bitbucket", address: HOST, key: "has spaces in it ok" }),
    ).toEqual({ ok: false, problem: "key", host: HOST });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a 403 distinct from a refused token, and reports an unreadable answer", async () => {
    for (const [response, expected] of [
      [new Response(null, { status: 403 }), { state: "unavailable", status: 403 }],
      [Response.json({}), { state: "unavailable", status: 200 }],
    ] as const) {
      const server = createBitbucketServer({
        apiBaseFor: () => API,
        fetch: responder(() => response),
      });
      expect(await server.signIn(HOST).whoAmI(KEY)).toMatchObject(expected);
    }
  });
});
