import { describe, expect, it } from "vitest";
import { QUEUE_STATUS } from "../../forge";
import { GitLabForge } from "./gitlabForge";

/** Approved change D: GitLab contributions use a verified personal fork and an upstream target. */
const upstream = {
  id: 3,
  path_with_namespace: "examples/hello",
  http_url_to_repo: "https://gitlab.com/examples/hello.git",
  namespace: { id: 10, kind: "group", path: "examples" },
  permissions: { project_access: { access_level: 20 }, group_access: null },
  default_branch: "main",
  visibility: "public",
};
const fork = {
  ...upstream,
  id: 20,
  path_with_namespace: "contributor/renamed-hello",
  http_url_to_repo: "https://gitlab.com/contributor/renamed-hello.git",
  namespace: { id: 21, kind: "user", path: "contributor" },
  owner: { id: 12 },
  forked_from_project: upstream,
};
const head = "5a0874c2a566e422e3373b42c7e2c994cd3a5ab1";
function fixture(source = false) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const response = new Map<string, unknown>([
    ["/user", { id: 12, username: "contributor" }],
    ["/projects/examples%2Fhello", upstream],
    [`/projects/${upstream.id}/members/all/12`, { id: 12, access_level: 20 }],
    [
      "/projects/examples%2Fhello/forks?owned=true&per_page=100&page=1",
      [
        {
          id: fork.id,
          path_with_namespace: fork.path_with_namespace,
          http_url_to_repo: fork.http_url_to_repo,
          namespace: fork.namespace,
          owner: fork.owner,
        },
      ],
    ],
  ]);
  const forge = new GitLabForge(
    {
      kind: "gitlab",
      host: "gitlab.com",
      owner: "examples",
      name: "hello",
      dir: "",
      ...(source ? { source: { id: fork.id, fullName: fork.path_with_namespace } } : {}),
    },
    {
      apiBaseUrl: "https://gitlab.com/api/v4",
      token: async () => "disposable-test-sign-in",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname.slice("/api/v4".length) + url.search;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        calls.push({ path, method, ...(body ? { body } : {}) });
        const value = response.get(`${method} ${path}`) ?? response.get(path);
        if (value instanceof Response) return value.clone();
        if (value === undefined) throw new Error(`Unexpected host request: ${method} ${path}`);
        return new Response(JSON.stringify(value), {
          status: value === null ? 404 : method === "POST" ? 201 : 200,
        });
      },
    },
  );
  return { forge, response, calls };
}

describe("approved fork contribution route on GitLab", () => {
  // Regression: absent direct/group entries do not describe an inherited or shared member's effective access.
  it.each([undefined, { project_access: null, group_access: null }])(
    "resolves unlisted GitLab access through effective membership",
    async (permissions) => {
      const { forge, response } = fixture();
      response.set(`/projects/${encodeURIComponent(upstream.path_with_namespace)}`, {
        ...upstream,
        permissions,
      });
      response.set(`/projects/${upstream.id}/members/all/12`, { id: 12, access_level: 30 });
      expect(await forge.contributions.inspect()).toMatchObject({ canPush: true, owned: false });
    },
  );

  // N3: a public non-member and an inherited/shared member can have the same null/null permissions.
  it("identifies a public non-member from the membership 404 without creating a fork", async () => {
    const { forge, response, calls } = fixture();
    response.set("/projects/examples%2Fhello", {
      ...upstream,
      permissions: { project_access: null, group_access: null },
    });
    response.set(`/projects/${upstream.id}/members/all/12`, null);
    expect(await forge.contributions.inspect()).toMatchObject({ canPush: false, owned: false });
    expect(calls.some((call) => call.path === `/projects/${upstream.id}/members/all/12`)).toBe(
      true,
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("does not cache an unavailable membership reading as no membership", async () => {
    const { forge, response } = fixture();
    response.set(
      `/projects/${upstream.id}/members/all/12`,
      new Response(JSON.stringify({ message: "Service unavailable" }), { status: 503 }),
    );
    await expect(forge.contributions.inspect()).rejects.toMatchObject({ failure: "transient" });
  });

  it("reads the sign-in's access and an imported personal fork's parent without a write", async () => {
    const { forge, response, calls } = fixture();
    expect(await forge.contributions.inspect()).toMatchObject({ canPush: false, owned: false });
    expect(await forge.contributions.findFork()).toMatchObject({
      id: fork.id,
      fullName: fork.path_with_namespace,
    });
    response.set("/projects/examples%2Fhello", fork);
    expect(await forge.contributions.inspect()).toMatchObject({
      canPush: true,
      owned: true,
      parent: { id: upstream.id },
    });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("creates the merge request in the fork with the original target project and publishes text only", async () => {
    const { forge, response, calls } = fixture(true);
    const branch = "contribute/fix";
    response.set(`/projects/${fork.id}/repository/branches/${encodeURIComponent(branch)}`, {
      commit: { id: head },
    });
    const request = {
      iid: 4,
      project_id: upstream.id,
      source_project_id: fork.id,
      target_project_id: upstream.id,
      source_branch: branch,
      target_branch: upstream.default_branch,
      title: "fix: correct the example",
      description: "Contribution story",
      web_url: "https://gitlab.com/examples/hello/-/merge_requests/4",
      state: "opened",
      sha: head,
    };
    response.set(`POST /projects/${fork.id}/merge_requests`, request);
    expect(await forge.branchHead(branch)).toBe(head);
    expect(
      await forge.openChange({ branch, title: request.title, body: request.description }),
    ).toMatchObject({ number: request.iid, headSha: head });
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      path: `/projects/${fork.id}/merge_requests`,
      body: {
        source_branch: branch,
        target_project_id: upstream.id,
        target_branch: upstream.default_branch,
      },
    });
    expect(await forge.storyDestination()).toMatchObject({
      projectId: upstream.id,
      media: "card-only",
    });
    response.set(
      `/projects/examples%2Fhello/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=20`,
      [{ ...request, source_project_id: 99 }, request],
    );
    expect(await forge.changeFor(branch)).toMatchObject({ number: request.iid });
  });
  it("reads a contribution pipeline's jobs in the fork that actually ran it", async () => {
    const { forge, response } = fixture(true);
    const pipeline = {
      id: 31,
      project_id: fork.id,
      sha: head,
      ref: "contribute/fix",
      status: "failed",
      source: "merge_request_event",
    };
    const job = { id: 32, name: "check-example", status: "failed", allow_failure: false };
    response.set("/projects/examples%2Fhello/merge_requests/4/pipelines?per_page=100", [pipeline]);
    response.set(`/projects/${fork.id}/pipelines?sha=${head}&per_page=100`, []);
    response.set(`/projects/${fork.id}/pipelines/${pipeline.id}/jobs?per_page=100&page=1`, [job]);
    response.set(
      `/projects/examples%2Fhello/repository/commits/${head}/statuses?name=${encodeURIComponent(QUEUE_STATUS)}&all=true&per_page=100`,
      [],
    );
    const checks = await forge.checks({
      branch: pipeline.ref,
      number: 4,
      url: null,
      headSha: head,
    });
    expect(checks).toMatchObject({ complete: true });
    expect(checks.items).toContainEqual(
      expect.objectContaining({ name: job.name, state: "failure", run: pipeline.id }),
    );
  });

  it("cannot merge or change the maintainers' queue through a source-bound provider", async () => {
    const { forge, calls } = fixture(true);
    const change = { branch: "contribute/fix", number: 12, url: null, headSha: head };
    await expect(forge.putIn(change, head)).rejects.toMatchObject({ failure: "permission" });
    await expect(forge.markQueued(head)).rejects.toMatchObject({ failure: "permission" });
    // Contribution refusal precedes the queue's approval note as well as its status write.
    await expect(
      forge.markQueued(head, {
        number: change.number,
        title: "fix: contribute an example",
        naming: null,
      }),
    ).rejects.toMatchObject({ failure: "permission" });
    await expect(forge.removeQueued(head, change.number)).rejects.toMatchObject({
      failure: "permission",
    });
    await expect(forge.startQueue({ action: "form" })).rejects.toMatchObject({
      failure: "permission",
    });
    expect(calls).toEqual([]);
  });
});
