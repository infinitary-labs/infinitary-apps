import { describe, expect, it } from "vitest";
import { GitHubForge } from "./githubForge";

/** Approved change D: host fork facts and source identity determine where a contribution opens. */
const upstream = {
  id: 1296269,
  full_name: "octocat/Hello-World",
  clone_url: "https://github.com/octocat/Hello-World.git",
  owner: { id: 1 },
  permissions: { push: false },
  default_branch: "main",
  visibility: "public",
  private: false,
};
const fork = {
  ...upstream,
  id: 210,
  full_name: "contributor/renamed-fork",
  clone_url: "https://github.com/contributor/renamed-fork.git",
  owner: { id: 2 },
  permissions: { push: true },
  fork: true,
  parent: upstream,
  source: { id: upstream.id },
};
const head = "5a0874c2a566e422e3373b42c7e2c994cd3a5ab1";

function fixture(
  source = false,
  token: () => Promise<string | undefined> = async () => "disposable-test-sign-in",
) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const response = new Map<string, unknown>([
    ["/user", { id: fork.owner.id, login: "contributor" }],
    ["/repos/octocat/Hello-World", upstream],
    ["/repos/contributor/renamed-fork", fork],
    ["/repos/contributor/Hello-World", null],
    ["/user/repos?affiliation=owner&per_page=100&page=1", [fork]],
  ]);
  const forge = new GitHubForge(
    {
      kind: "github",
      host: "github.com",
      owner: "octocat",
      name: "Hello-World",
      dir: "",
      ...(source ? { source: { id: fork.id, fullName: fork.full_name } } : {}),
    },
    {
      token,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname + new URL(String(input)).search;
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        calls.push({ path, method, ...(body ? { body } : {}) });
        const value = response.get(`${method} ${path}`) ?? response.get(path);
        if (value instanceof Response) return value.clone();
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`Unexpected host request: ${method} ${path}`);
        return new Response(JSON.stringify(value), {
          status: value === null ? 404 : method === "POST" ? 201 : 200,
        });
      },
    },
  );
  return { forge, calls, response };
}

describe("approved fork contribution route on GitHub", () => {
  // Regression: normal fork discovery takes one direct repository read, not a scan of every owned fork.
  it("checks the normal fork address before enumerating renamed forks", async () => {
    const { forge, response, calls } = fixture();
    response.set("/repos/contributor/Hello-World", {
      ...fork,
      full_name: "contributor/Hello-World",
      clone_url: "https://github.com/contributor/Hello-World.git",
    });
    expect(await forge.contributions.findFork()).toMatchObject({
      fullName: "contributor/Hello-World",
    });
    expect(calls.some((call) => call.path.startsWith("/user/repos"))).toBe(false);
  });

  // Regression: only an explicit host refusal may allow another fork-creation request.
  it.each([
    { status: 403, outcome: "failed" },
    { status: 502, outcome: "uncertain" },
  ])("classifies a $status fork-creation answer as $outcome", async ({ status, outcome }) => {
    const { forge, response } = fixture();
    response.set(
      "POST /repos/octocat/Hello-World/forks",
      new Response(
        JSON.stringify({
          message: status === 403 ? "Resource not accessible by integration" : "Bad gateway",
        }),
        { status },
      ),
    );
    await expect(forge.contributions.createFork()).rejects.toMatchObject({ outcome });
  });

  it("classifies an unreadable sign-in before transmission as a definite failed attempt", async () => {
    const { forge, calls } = fixture(false, async () => {
      throw new Error("The saved sign-in is unavailable");
    });
    await expect(forge.contributions.createFork()).rejects.toMatchObject({
      outcome: "failed",
      failure: "transient",
    });
    expect(calls).toHaveLength(0);
  });

  it("retains an uncertain outcome when the fork-creation connection fails", async () => {
    const { forge, response } = fixture();
    response.set(
      "POST /repos/octocat/Hello-World/forks",
      new Error("Connection closed after request transmission"),
    );
    await expect(forge.contributions.createFork()).rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("reads an imported owned fork's parent and finds a renamed owned fork without creating another", async () => {
    const { forge, response, calls } = fixture();
    const facts = await forge.contributions.inspect();
    expect(facts).toMatchObject({ canPush: false, owned: false, project: { id: upstream.id } });
    expect(await forge.contributions.findFork()).toEqual({
      id: fork.id,
      fullName: fork.full_name,
      origin: fork.clone_url,
    });
    response.set("/repos/octocat/Hello-World", fork);
    expect(await forge.contributions.inspect()).toMatchObject({
      owned: true,
      parent: { id: upstream.id },
    });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("opens upstream using the fork's owner and repository, reads its branch, and keeps pictures local", async () => {
    const { forge, response, calls } = fixture(true);
    const branch = "contribute/fix";
    response.set(`/repos/contributor/renamed-fork/git/ref/heads/${encodeURIComponent(branch)}`, {
      object: { type: "commit", sha: head },
    });
    response.set("POST /repos/octocat/Hello-World/pulls", {
      number: 12,
      html_url: "https://github.com/octocat/Hello-World/pull/12",
      title: "fix: correct the example",
      body: "Contribution story",
      head: { sha: head, ref: branch, repo: { full_name: fork.full_name } },
      base: { ref: upstream.default_branch },
    });
    expect(await forge.branchHead(branch)).toBe(head);
    const opened = await forge.openChange({
      branch,
      title: "fix: correct the example",
      body: "Contribution story",
    });
    expect(opened).toMatchObject({ number: 12, headSha: head, branch });
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      path: "/repos/octocat/Hello-World/pulls",
      body: {
        head: `contributor:${branch}`,
        head_repo: "renamed-fork",
        base: upstream.default_branch,
      },
    });
    expect(await forge.storyDestination()).toMatchObject({
      projectId: upstream.id,
      media: "card-only",
    });
  });

  it("does not confuse another fork's identically named branch with this contribution", async () => {
    const { forge, response } = fixture(true);
    const path = "/repos/octocat/Hello-World/pulls?head=contributor%3Afix&state=open&per_page=1";
    response.set(path, [
      {
        number: 1,
        head: { sha: head, ref: "fix", repo: { full_name: "contributor/different-project" } },
      },
    ]);
    expect(await forge.changeFor("fix")).toBeNull();
  });
  it("cannot merge or change the maintainers' queue through a source-bound provider", async () => {
    const { forge, calls } = fixture(true);
    const change = { branch: "contribute/fix", number: 12, url: null, headSha: head };
    await expect(forge.putIn(change, head)).rejects.toMatchObject({ failure: "permission" });
    await expect(forge.markQueued(head)).rejects.toMatchObject({ failure: "permission" });
    // Contribution refusal precedes the queue's approval comment as well as its status write.
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
    await expect(forge.putInSkippingRules(change, head)).rejects.toMatchObject({
      failure: "permission",
    });
    expect(calls).toEqual([]);
  });
});
