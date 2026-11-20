import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { ForgeSignInStore, ForgeSignIns } from "../../signIns";
import { GitLabClient, gitlabApiBaseFor } from "./client";
import { GitLabProjects } from "./projects";
import { createGitLabServer } from "./signIn";

const HOST = "gitlab.example.com";
const KEY = "glpat-disposable-test-key";
const row = {
  path_with_namespace: "group/subgroup/app",
  http_url_to_repo: `https://${HOST}/group/subgroup/app.git`,
  web_url: `https://${HOST}/group/subgroup/app`,
  last_activity_at: "2026-10-09T12:00:00Z",
  visibility: "private",
};

function responder(reply: (path: string) => Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(init?.redirect).toBe("error");
    return reply(new URL(String(input)).pathname + new URL(String(input)).search);
  });
}

describe("GitLab projects and key sign-in", () => {
  it("lists every page, newest first, and finds a project in a nested group", async () => {
    const fetcher = responder((path) => {
      if (path === "/api/v4/projects/group%2Fsubgroup%2Fapp") return Response.json(row);
      return Response.json(
        path.endsWith("page=1") ? Array.from({ length: 100 }, () => row) : [row],
      );
    });
    const projects = new GitLabProjects(HOST, {
      token: async () => KEY,
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: fetcher,
    });
    const listed = await projects.listProjectsPaged();
    expect(listed.complete).toBe(true);
    expect(listed.projects).toHaveLength(101);
    expect(listed.projects[0]).toEqual({
      fullName: row.path_with_namespace,
      cloneUrl: row.http_url_to_repo,
      url: row.web_url,
      updatedAt: row.last_activity_at,
      private: true,
    });
    expect(await projects.findProject("group/subgroup/app")).toEqual(listed.projects[0]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "membership=true&simple=true&order_by=last_activity_at&sort=desc",
    );
  });
  it("does not call a truncated listing complete and does not hide a refused lookup", async () => {
    const fetcher = responder((path) =>
      path.includes("?")
        ? Response.json(Array.from({ length: 100 }, () => row))
        : new Response(null, { status: 404 }),
    );
    const projects = new GitLabProjects(HOST, {
      token: async () => KEY,
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: fetcher,
    });
    expect((await projects.listProjectsPaged()).complete).toBe(false);
    expect(await projects.findProject("group/missing")).toBeNull();
  });
  it.each(["gitlab.com", HOST])(
    "keeps a verified key for %s across restart, with the git user and no secret in views",
    async (host) => {
      let status = 200;
      const fetcher = responder(() =>
        status === 200 ? Response.json({ username: "octo" }) : new Response(null, { status }),
      );
      const store = new ForgeSignInStore(join(scratchDir("fm-gitlab-key-"), "forges"));
      const options = {
        store,
        providers: [],
        servers: [
          createGitLabServer({
            apiBaseFor: (name: string) => `https://${name}/api/v4`,
            fetch: fetcher,
          }),
        ],
        projectsOn: () => 0,
        push: () => {},
      };
      const service = new ForgeSignIns(options);
      status = 401;
      expect(await service.signInWithKey({ kind: "gitlab", address: host, key: KEY })).toEqual({
        ok: false,
        problem: "refused",
        host,
      });
      expect(store.read(host)).toBeUndefined();
      status = 200;
      expect(await service.signInWithKey({ kind: "gitlab", address: host, key: KEY })).toEqual({
        ok: true,
        host,
      });
      expect(store.read(host)).toMatchObject({
        token: KEY,
        kind: "gitlab",
        gitUser: "oauth2",
        login: "octo",
      });
      expect(statSync(join(store.dirFor(host), "sign-in.json")).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(service.view())).not.toContain(KEY);
      expect(readFileSync(join(store.root, "health.log"), "utf8")).not.toContain(KEY);
      const restarted = new ForgeSignIns(options);
      expect(await restarted.token(host)).toBe(KEY);
      expect(restarted.gitHosts()).toContain(host);
      expect(restarted.nameOf(host)).toBe(host === "gitlab.com" ? "GitLab" : host);
      restarted.signOut(host);
      expect(store.read(host)).toBeUndefined();
    },
  );
  it("keeps 403 distinct from sign-in rejection, and reports unreadable successful answers", async () => {
    for (const [response, expected] of [
      [new Response(null, { status: 403 }), { state: "unavailable", status: 403 }],
      [Response.json({}), { state: "unavailable", status: 200 }],
    ] as const) {
      const server = createGitLabServer({
        apiBaseFor: () => `https://${HOST}/api/v4`,
        fetch: responder(() => response),
      });
      expect(await server.signIn(HOST).whoAmI(KEY)).toMatchObject(expected);
    }
  });
  it("uses the host's API and ignores a development override in a packaged build", () => {
    const env = { FM3000_GITLAB_API_URL: "http://localhost:1234/api/v4/" };
    expect(gitlabApiBaseFor(HOST, { packaged: true, env })).toBe(`https://${HOST}/api/v4`);
    expect(gitlabApiBaseFor("gitlab.com", { packaged: false, env })).toBe(
      "http://localhost:1234/api/v4",
    );
    expect(
      gitlabApiBaseFor("gitlab.com", {
        packaged: false,
        env: { ...env, INFINITARY_GITLAB_API_URL: "http://localhost:4321/api/v4/" },
      }),
    ).toBe("http://localhost:4321/api/v4");
  });
  it("requires this app's sign-in and refuses oversized or invalid responses", async () => {
    const noFetch = vi.fn<typeof fetch>();
    const missing = new GitLabClient(HOST, {
      token: async () => undefined,
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: noFetch,
    });
    await expect(missing.get("/user")).rejects.toMatchObject({ failure: "sign-in" });
    expect(noFetch).not.toHaveBeenCalled();
    for (const response of [new Response("x".repeat(262145)), new Response("not json")]) {
      const client = new GitLabClient(HOST, {
        token: async () => KEY,
        apiBaseUrl: `https://${HOST}/api/v4`,
        fetch: responder(() => response),
      });
      await expect(client.get("/user")).rejects.toThrow();
    }
  });
  it("asks the existing health service to check a 401, but not a 403", async () => {
    const rejected = vi.fn();
    for (const status of [401, 403]) {
      const client = new GitLabClient(HOST, {
        token: async () => KEY,
        apiBaseUrl: `https://${HOST}/api/v4`,
        fetch: responder(() => new Response(null, { status })),
        onSignInRejected: rejected,
      });
      await expect(client.get("/projects")).rejects.toMatchObject({
        failure: status === 401 ? "sign-in" : "permission",
      });
    }
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});
