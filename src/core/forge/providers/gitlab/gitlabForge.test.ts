import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitLabForge } from "./gitlabForge";

/**
 * The GitLab forge's reading of answers the stand-in (`tests/gitlabStub.test.ts`)
 * does not script: every `detailed_merge_status` GitLab documents and the
 * older `merge_status`, a merge GitLab answers before it finishes, and a 401
 * GitLab sends a key that may not accept the merge.
 */

const HOST = "gitlab.example.com";
const KEY = "glpat-disposable-test-key";
/** The project's API path as the forge names it in a refusal: relative to the API. */
const PROJECT = `/projects/${encodeURIComponent("group/subgroup/app")}`;

const request = (fields: Record<string, unknown> = {}) => ({
  iid: 4,
  project_id: 7,
  source_project_id: 7,
  source_branch: "fm/task-1",
  target_branch: "main",
  title: "fix: the meter",
  description: "Why",
  web_url: `https://${HOST}/group/subgroup/app/-/merge_requests/4`,
  state: "opened",
  sha: "a".repeat(40),
  ...fields,
});

function forgeAnswering(answer: (method: string, path: string, init?: RequestInit) => Response) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) =>
    answer(init?.method ?? "GET", new URL(String(input)).pathname, init),
  );
  const rejected = vi.fn();
  const forge = new GitLabForge(
    { kind: "gitlab", host: HOST, owner: "group/subgroup", name: "app", dir: "/r" },
    {
      token: async () => KEY,
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: fetcher,
      onSignInRejected: rejected,
    },
  );
  return { forge, fetcher, rejected };
}

describe("GitLabForge", () => {
  it("INF-203 F5: removes only the prerequisite draft prefix, at the reviewed version", async () => {
    let draft = true;
    const { forge, fetcher } = forgeAnswering((method) => {
      if (method === "PUT") draft = false;
      return Response.json(
        request({
          draft,
          title: draft ? "Draft: fix: the meter" : "fix: the meter",
          detailed_merge_status: "mergeable",
        }),
      );
    });
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      draft: true,
    };
    await expect(forge.markReady({ ...change, headSha: "b".repeat(40) }, () => {})).rejects.toThrow(
      "changed",
    );
    await expect(
      forge.markReady(change, () => {
        throw new Error("Proof changed before send");
      }),
    ).rejects.toThrow("Proof changed");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    expect(await forge.markReady(change, () => {})).toMatchObject({ title: "fix: the meter" });
    expect((await forge.pull(4)).readiness).toBe("clean");
    await forge.markReady(change, () => {
      throw new Error("Already ready must not send");
    });
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ title: "fix: the meter" });
  });

  it.each([
    [{ detailed_merge_status: "mergeable" }, "clean"],
    [{ detailed_merge_status: "conflict" }, "conflict"],
    [{ detailed_merge_status: "mergeable", has_conflicts: true }, "conflict"],
    [{ detailed_merge_status: "need_rebase" }, "behind"],
    [{ detailed_merge_status: "draft_status" }, "draft"],
    [{ detailed_merge_status: "mergeable", draft: true }, "draft"],
    [{ detailed_merge_status: "not_approved" }, "blocked"],
    [{ detailed_merge_status: "discussions_not_resolved" }, "blocked"],
    [{ detailed_merge_status: "ci_must_pass" }, "blocked"],
    [{ detailed_merge_status: "ci_still_running" }, "blocked"],
    [{ detailed_merge_status: "checking" }, "computing"],
    [{ detailed_merge_status: "unchecked" }, "computing"],
    [{ detailed_merge_status: "a status from a newer GitLab" }, "computing"],
    [{ merge_status: "can_be_merged" }, "clean"],
    [{ merge_status: "cannot_be_merged" }, "conflict"],
    [{ merge_status: "checking" }, "computing"],
  ])("reads %j as %s", async (fields, readiness) => {
    const { forge } = forgeAnswering(() => Response.json(request(fields)));
    expect((await forge.pull(4)).readiness).toBe(readiness);
  });

  it("takes a merge GitLab finished after it answered, waits on one it is still making, and refuses one it never finished", async () => {
    let after: "merged" | "locked" | "failed" = "merged";
    const { forge } = forgeAnswering((method) =>
      method === "PUT"
        ? Response.json(request())
        : Response.json(
            after === "merged"
              ? request({ state: "merged", merge_commit_sha: "b".repeat(40) })
              : after === "locked"
                ? request({ state: "locked" })
                : request({ merge_error: "The merge could not be finished" }),
          ),
    );
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      title: "fix: the meter",
      body: "Why",
    };
    expect(await forge.putIn(change, change.headSha)).toEqual({ sha: "b".repeat(40) });
    after = "locked";
    // Still merging is no verdict: a transient failure the merge reads back.
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "transient",
    });
    expect(await forge.pull(4)).toMatchObject({ state: "open", readiness: "computing" });
    after = "failed";
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "refused",
      message: `${HOST} did not confirm the merge of !4: The merge could not be finished`,
    });
  });

  it("reads GitLab's 401 on a merge as a permission while GitLab still answers for the key", async () => {
    let keyAccepted = true;
    const { forge, fetcher, rejected } = forgeAnswering((_method, path) => {
      if (path === "/api/v4/user") {
        return keyAccepted
          ? Response.json({ username: "octo" })
          : Response.json({ message: "401 Unauthorized" }, { status: 401 });
      }
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    });
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      title: "fix: the meter",
      body: "",
    };
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "permission",
      message: `${HOST} answered 401 to PUT ${PROJECT}/merge_requests/4/merge: 401 Unauthorized`,
    });
    expect(rejected).not.toHaveBeenCalled();
    keyAccepted = false;
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "sign-in",
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    // The squash was asked for with the title alone when the description is empty.
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      sha: "a".repeat(40),
      squash: true,
      squash_commit_message: "fix: the meter",
    });
  });

  // INF-223 / accepted INF-132: the saved-story writes tell a refusal from a lost answer.
  describe("saved-story writes", () => {
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      title: "fix: the meter",
      body: "Why",
    };

    it("replaces a description only while the merge request is open at the read head and words", async () => {
      for (const fields of [
        { description: "Someone added words" },
        { sha: "b".repeat(40) },
        { state: "closed" },
      ]) {
        const { forge, fetcher } = forgeAnswering(() => Response.json(request(fields)));
        await expect(forge.updateChangeBody(change, "The story")).rejects.toMatchObject({
          outcome: "failed",
        });
        expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET"]);
      }
      const { forge, fetcher } = forgeAnswering(() => Response.json(request()));
      await forge.updateChangeBody(change, "The story");
      const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(new URL(String(put?.[0])).pathname).toBe(`/api/v4${PROJECT}/merge_requests/4`);
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({ description: "The story" });
    });

    it("INF-717: keeps a draft's marker before a saved story's title, in the description's write", async () => {
      const draft = { ...change, title: "Draft: fix: the meter", draft: true };
      const { forge, fetcher } = forgeAnswering(() =>
        Response.json(request({ title: draft.title, draft: true })),
      );
      await forge.updateChangeBody(draft, "The story", "fix!: the meter");
      const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        title: "Draft: fix!: the meter",
        description: "The story",
      });
      // Someone renamed it after the read: only the reread goes.
      const moved = forgeAnswering(() => Response.json(request({ title: "fix: the meter's lag" })));
      await expect(
        moved.forge.updateChangeBody(change, "The story", "fix!: the meter"),
      ).rejects.toMatchObject({ outcome: "failed" });
      expect(moved.fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET"]);
    });

    it.each([
      [
        "a refusal GitLab answered",
        () => Response.json({ message: "Invalid" }, { status: 422 }),
        "failed",
      ],
      ["a server failure", () => Response.json({ message: "502" }, { status: 502 }), "uncertain"],
      ["a lost connection", () => Promise.reject(new Error("socket hang up")), "uncertain"],
    ] as const)("records %s on a description write as %s", async (_case, answer, outcome) => {
      const { forge } = forgeAnswering((method) =>
        method === "PUT" ? (answer() as Response) : Response.json(request()),
      );
      await expect(forge.updateChangeBody(change, "The story")).rejects.toMatchObject({ outcome });
    });

    it.each([
      [
        "already open for the branch",
        () =>
          Response.json(
            { message: ["Another open merge request already exists"] },
            { status: 409 },
          ),
        "failed",
      ],
      ["unanswered", () => Promise.reject(new Error("socket hang up")), "uncertain"],
      ["answered unreadably", () => new Response("<html>", { status: 201 }), "uncertain"],
    ] as const)("records an opening %s as %s", async (_case, answer, outcome) => {
      const { forge } = forgeAnswering((method) =>
        method === "POST" ? (answer() as Response) : Response.json({ default_branch: "main" }),
      );
      await expect(
        forge.openChange({ branch: "fm/task-1", title: "fix: the meter", body: "Why" }),
      ).rejects.toMatchObject({ outcome });
    });

    it("opens onto the branch open_change names without reading the default branch, and carries the target on each read (INF-1873)", async () => {
      const { forge, fetcher } = forgeAnswering(() =>
        Response.json(request({ target_branch: "fm/task-lower" }), { status: 201 }),
      );
      const opened = await forge.openChange({
        branch: "fm/task-1",
        title: "fix: the meter",
        body: "Why",
        base: "fm/task-lower",
      });
      expect(opened.base).toBe("fm/task-lower");
      expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST"]);
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
        source_branch: "fm/task-1",
        target_branch: "fm/task-lower",
      });
    });

    it("sends no opening when the default branch cannot be read", async () => {
      const { forge, fetcher } = forgeAnswering(() =>
        Response.json({ message: "503" }, { status: 503 }),
      );
      await expect(
        forge.openChange({ branch: "fm/task-1", title: "fix: the meter", body: "Why" }),
      ).rejects.toMatchObject({ outcome: "failed" });
      expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    });

    it("squashes a saved story under its title and plain summary, never its rendered description", async () => {
      const { forge, fetcher } = forgeAnswering(() =>
        Response.json(request({ state: "merged", merge_commit_sha: "b".repeat(40) })),
      );
      await forge.putIn(
        {
          ...change,
          body: "<!-- infinitary-story:x:start -->\n## Why",
          squashMessage: "The meter reads on time.",
        },
        change.headSha,
      );
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
        squash_commit_message: "fix: the meter\n\nThe meter reads on time.",
      });
    });

    it("confirms the pushed branch's version where the project lives", async () => {
      const { forge, fetcher } = forgeAnswering((_method, path) =>
        path.endsWith("/missing")
          ? Response.json({ message: "404 Branch Not Found" }, { status: 404 })
          : Response.json({ name: "fm/task-1", commit: { id: "c".repeat(40) } }),
      );
      expect(await forge.branchHead("fm/task-1")).toBe("c".repeat(40));
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe(
        `/api/v4${PROJECT}/repository/branches/fm%2Ftask-1`,
      );
      await expect(forge.branchHead("missing")).rejects.toMatchObject({ failure: "refused" });
    });

    // INF-290 F5: an upload's 401 is read the way the client reads every other 401.
    it.each([
      [true, "permission", 0],
      [false, "sign-in", 1],
    ] as const)(
      "reads an upload's 401 with GitLab still answering for the key: %s",
      async (keyAccepted, failure, asked) => {
        const rejected = vi.fn();
        const fetcher = vi.fn<typeof fetch>(async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/v4/user")
            return keyAccepted
              ? Response.json({ username: "octo" })
              : Response.json({ message: "401 Unauthorized" }, { status: 401 });
          if (path.endsWith("/uploads"))
            return Response.json({ message: "401 Unauthorized" }, { status: 401 });
          return Response.json({
            id: 7,
            path_with_namespace: "group/subgroup/app",
            visibility: "public",
          });
        });
        const forge = new GitLabForge(
          { kind: "gitlab", host: "gitlab.com", owner: "group/subgroup", name: "app", dir: "/r" },
          {
            token: async () => KEY,
            apiBaseUrl: "https://gitlab.com/api/v4",
            fetch: fetcher,
            onSignInRejected: rejected,
          },
        );
        const attachments = forge.attachments;
        if (!attachments) throw new Error("gitlab.com offers native attachments");
        const bytes = new Uint8Array([137, 80, 78, 71]);
        await expect(
          attachments.upload(await attachments.destination(), {
            bytes,
            mediaType: "image/png",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }),
        ).rejects.toMatchObject({ outcome: "failed", failure });
        expect(rejected).toHaveBeenCalledTimes(asked);
      },
    );

    it("offers native story attachments on gitlab.com alone", () => {
      const at = (host: string) =>
        new GitLabForge(
          { kind: "gitlab", host, owner: "group/subgroup", name: "app", dir: "/r" },
          { token: async () => KEY, apiBaseUrl: `https://${host}/api/v4` },
        ).attachments;
      expect(at("gitlab.com")).toBeDefined();
      expect(at(HOST)).toBeUndefined();
    });
  });

  // INF-1184: a repair declared at a version the host holds no commit for is
  // refused, and one saved there closes void, so only GitLab's own answer
  // that the commit is missing from a project it can read says no.
  it("holds a repair's version only on GitLab's answer for that exact commit", async () => {
    const held = "0b59b6d4863943cc06b1e6e16308572380eb3873";
    const missing = "a75f9eb4d0f888d5a7fee139a342cbb35a86af3c";
    const project = (projectFound: boolean) =>
      forgeAnswering((_method, path) =>
        path === `/api/v4${PROJECT}/repository/commits/${held}`
          ? Response.json({ id: held, short_id: held.slice(0, 8), title: "fix: the meter" })
          : path === `/api/v4${PROJECT}` && projectFound
            ? Response.json({ id: 7, path_with_namespace: "group/subgroup/app" })
            : Response.json(
                {
                  message: path.includes("/commits/")
                    ? "404 Commit Not Found"
                    : "404 Project Not Found",
                },
                { status: 404 },
              ),
      );

    const { forge } = project(true);
    expect(await forge.holdsCommit(held)).toBe(true);
    expect(await forge.holdsCommit(missing)).toBe(false);

    // A project the key cannot read says nothing about the commit.
    await expect(project(false).forge.holdsCommit(missing)).rejects.toMatchObject({
      failure: "not-found",
    });
  });

  // INF-1185: a repair at a version no check ran on stays open while a
  // branch is still at it, where a pipeline can start. GitLab lists the
  // branches that hold a commit, so only those whose head it is count.
  it("lists the branches whose head is a version, not every branch that holds it", async () => {
    const at = "a75f9eb4d0f888d5a7fee139a342cbb35a86af3b";
    const branch = (name: string, id: string) =>
      Response.json({
        name,
        commit: { id, short_id: id.slice(0, 8) },
        merged: false,
        default: false,
      });
    const holding = (names: string[]) =>
      forgeAnswering((_method, path) => {
        if (path === `/api/v4${PROJECT}/repository/commits/${at}/refs`)
          return Response.json(names.map((name) => ({ type: "branch", name })));
        if (
          path ===
          `/api/v4${PROJECT}/repository/branches/${encodeURIComponent("fm/task-1-evidence")}`
        )
          return branch("fm/task-1-evidence", at);
        if (path === `/api/v4${PROJECT}/repository/branches/${encodeURIComponent("fm/task-1")}`)
          return branch("fm/task-1", "21e5511e4c597e6475da40dcda2d8e0c6bec9e67");
        return Response.json({ message: "404 Branch Not Found" }, { status: 404 });
      });

    // The change's branch holds the version but has moved past it, and a
    // branch deleted since the list is at no version.
    const { forge, fetcher } = holding(["fm/task-1", "fm/task-1-evidence", "fm/task-1-old"]);
    expect(await forge.branchesAt(at)).toEqual(["fm/task-1-evidence"]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("type=branch");
    expect(await holding([]).forge.branchesAt(at)).toEqual([]);

    // A full page may hold more branches than it lists, so it says nothing.
    const many = Array.from({ length: 100 }, (_, index) => `fm/task-${index + 2}`);
    await expect(holding(many).forge.branchesAt(at)).rejects.toMatchObject({
      failure: "transient",
    });
  });

  it("finds only a merge request from the project's own branch, never a fork's of the same name", async () => {
    const { forge } = forgeAnswering(() =>
      Response.json([request({ iid: 5, source_project_id: 99 }), request()]),
    );
    expect(await forge.changeFor("fm/task-1")).toMatchObject({ number: 4 });
  });

  // A user's report: check_change refused a no-checks declaration on a merge
  // request from a branch in the same GitLab project as a fork. Expected:
  // accept a verified same-project merge request, "while continuing to
  // reject unknown identity. The accepted contributor plan adds fork identity". The merge review reads that
  // identity as the pull request's head repository.
  it("keeps a fork source as its immutable project identity and refuses an unknown source", async () => {
    const pulled = async (fields: Record<string, unknown>) => {
      const { forge } = forgeAnswering(() =>
        Response.json(request({ target_project_id: 7, ...fields })),
      );
      return (await forge.pull(4)).headRepo;
    };
    expect(await pulled({})).toBe("group/subgroup/app");
    expect(await pulled({ source_project_id: 99 })).toBe("gitlab-project:99");
    expect(await pulled({ source_project_id: undefined })).toBeUndefined();
    expect(await pulled({ target_project_id: undefined })).toBeUndefined();
  });

  // Accepted contributor plan A: a fork's jobs belong to the project GitLab
  // names on the pipeline, not necessarily the merge request's target.
  it("reads a fork pipeline's failed jobs from the source project", async () => {
    const head = request().sha;
    const { forge, fetcher } = forgeAnswering((_method, path) => {
      if (path.endsWith("/merge_requests/4/pipelines"))
        return Response.json([
          {
            id: 44,
            project_id: 99,
            sha: head,
            ref: "fm/task-1",
            status: "success",
            source: "merge_request_event",
          },
        ]);
      if (path === "/api/v4/projects/99/pipelines/44/jobs")
        return Response.json([{ id: 78, name: "build", status: "failed", allow_failure: false }]);
      return Response.json([]);
    });
    const checks = await forge.checks({ number: 4, branch: "fm/task-1", headSha: head, url: null });
    expect(checks.items).toContainEqual(
      expect.objectContaining({ name: "build", state: "failure" }),
    );
    expect(
      fetcher.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === "/api/v4/projects/99/pipelines/44/jobs",
      ),
    ).toBe(true);
  });

  // The team queue the app once shipped left its files in a project; the
  // app reads only whether they are still there, for its one offer to remove
  // them (docs/forge.md, "A project that still carries the team queue's files").
  it("names the team queue's files a project still carries on its default branch", async () => {
    const blob = (name: string) => ({ id: "0".repeat(40), name, type: "blob", path: name });
    const { forge, fetcher } = forgeAnswering(() =>
      Response.json({ message: "404 Not Found" }, { status: 404 }),
    );
    // The folder and the branch ride the query, which this file's helper does not pass on.
    fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v4${PROJECT}`) return Response.json({ default_branch: "trunk" });
      if (url.pathname !== `/api/v4${PROJECT}/repository/tree`)
        return Response.json({ message: "404 Not Found" }, { status: 404 });
      expect(url.searchParams.get("ref")).toBe("trunk");
      if (url.searchParams.get("path") === ".gitlab")
        return Response.json([
          { id: "1".repeat(40), name: "infinitary", type: "tree", path: ".gitlab/infinitary" },
          blob("infinitary-queue.yml"),
          blob("infinitary-batch.yml"),
          blob("infinitary-batch-checks.yml"),
          blob("merge_request_templates.md"),
        ]);
      // GitLab answers 404 for a folder the branch does not hold.
      return Response.json({ message: "404 Tree Not Found" }, { status: 404 });
    });

    expect(await forge.teamQueueLeftovers()).toEqual({
      files: [
        ".gitlab/infinitary-queue.yml",
        ".gitlab/infinitary-batch.yml",
        ".gitlab/infinitary-batch-checks.yml",
      ],
    });
  });

  it("names nothing for a project that carries none of the team queue's files", async () => {
    const { forge } = forgeAnswering((_method, path) =>
      path === `/api/v4${PROJECT}`
        ? Response.json({ default_branch: "main" })
        : path === `/api/v4${PROJECT}/repository/tree`
          ? Response.json([{ id: "2".repeat(40), name: "ci", type: "tree", path: ".gitlab/ci" }])
          : Response.json({ message: "404 Not Found" }, { status: 404 }),
    );
    expect(await forge.teamQueueLeftovers()).toEqual({ files: [] });
  });
});
