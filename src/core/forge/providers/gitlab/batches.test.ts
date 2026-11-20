import { describe, expect, it, vi } from "vitest";
import { BATCH_STORIES_MARKER } from "../../presentationText";
import { GitLabForge } from "./gitlabForge";

// Intent: the captain's approved plan for batches of their own, piece 1, on GitLab: a
// batch merges with "GitLab's merge without squash", a change is "a pushed branch ... and
// no pull request of its own" whose checks are read "by commit without a pull request",
// the batch branch is deleted after the merge, and a change that had its own merge
// request has it closed with a link.
//
// GitLab is the stand-in: its REST answers as its API documents them, through the
// forge's own `fetch`.

const HOST = "gitlab.example.com";
const API = `/api/v4/projects/${encodeURIComponent("acme/meter")}`;

type Call = { method: string; path: string; query: string; body: unknown };

function forgeAnswering(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call);
  });
  const forge = new GitLabForge(
    { kind: "gitlab", host: HOST, owner: "acme", name: "meter", dir: "/code/meter" },
    {
      token: async () => "glpat-disposable-test-key",
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: fetcher,
    },
  );
  return { forge, calls };
}

const notFound = () => Response.json({ message: "404 Not Found" }, { status: 404 });

describe("the merges a GitLab project allows", () => {
  // GitLab's four squash settings, as a project's `squash_option` answers them.
  it.each([
    ["default_off", { squash: true, rebase: false, merge: true }],
    ["default_on", { squash: true, rebase: false, merge: true }],
    ["always", { squash: true, rebase: false, merge: false }],
    ["never", { squash: false, rebase: false, merge: true }],
  ])("reads squash setting %s as %j", async (squash_option, ways) => {
    const { forge } = forgeAnswering(({ path }) =>
      path === API
        ? Response.json({ id: 7, path_with_namespace: "acme/meter", squash_option })
        : notFound(),
    );
    expect(await forge.mergeWays()).toEqual(ways);
  });
});

describe("merging a batch's merge request on GitLab", () => {
  const head = "c7e9d1f3b5a79d1c7e2a4b6f8091a3c5e7d9f1b3";
  const merged = "4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c2b";
  const batch = {
    number: 12,
    url: `https://${HOST}/acme/meter/-/merge_requests/12`,
    branch: "infinitary-batch/3fa9c1d2",
    headSha: head,
    title: "chore: merge 2 approved changes",
    squashMessage: "- fix(parser): read dates with a time zone\n- feat(export): add a CSV export",
  };
  const merging = () =>
    forgeAnswering(({ method, path }) =>
      method === "PUT" && path === `${API}/merge_requests/12/merge`
        ? Response.json({ iid: 12, state: "merged", sha: head, merge_commit_sha: merged })
        : notFound(),
    );

  it("merges without squash at the batch's version, so each change keeps its commit", async () => {
    const { forge, calls } = merging();
    expect(await forge.putIn(batch, head, "merge")).toEqual({ sha: merged });
    expect(calls.map((call) => call.body)).toEqual([
      {
        sha: head,
        squash: false,
        merge_commit_message: `chore: merge 2 approved changes\n\n${batch.squashMessage}`,
      },
    ]);
  });

  it("squashes when no way is named, as a change's own merge request merges", async () => {
    const { forge, calls } = merging();
    const own = {
      ...batch,
      title: "fix(parser): read dates with a time zone",
      squashMessage: "- Dates with a time zone are read as written.",
    };
    await forge.putIn(own, head);
    expect(calls.map((call) => call.body)).toEqual([
      {
        sha: head,
        squash: true,
        squash_commit_message:
          "fix(parser): read dates with a time zone\n\n- Dates with a time zone are read as written.",
      },
    ]);
  });
});

describe("a pushed branch with no merge request on GitLab", () => {
  const head = "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0";
  const branch = { url: null, branch: "fm/task-parser", headSha: head };

  it("reads the checks of its commit's own pipelines, and asks for no merge request", async () => {
    const { forge, calls } = forgeAnswering(({ path, query }) => {
      if (path === `${API}/pipelines` && query.includes(`sha=${head}`))
        return Response.json([
          {
            id: 8841,
            project_id: 7,
            sha: head,
            ref: "fm/task-parser",
            status: "failed",
            source: "push",
          },
        ]);
      // GitLab names the pipeline's own project by its number; its jobs are read there.
      if (path === "/api/v4/projects/7/pipelines/8841/jobs")
        return Response.json([
          {
            id: 5501,
            name: "unit",
            status: "failed",
            allow_failure: false,
            started_at: "2026-11-10T18:02:11Z",
            finished_at: "2026-11-10T18:05:40Z",
          },
          { id: 5502, name: "lint", status: "success", allow_failure: false },
        ]);
      if (path === `${API}/repository/commits/${head}/statuses`) return Response.json([]);
      return notFound();
    });

    const checks = await forge.checks(branch);
    expect(checks.complete).toBe(true);
    expect(checks.items.map((item) => [item.name, item.state])).toEqual([
      ["pipeline #8841 (branch)", "failure"],
      ["unit", "failure"],
      ["lint", "success"],
    ]);
    // INF-5097 piece 1's review: the pipeline's row sums up its jobs, so a batch's list of
    // checks that never ran takes its jobs and never the pipeline by name.
    expect(checks.items.map((item) => item.summary === true)).toEqual([true, false, false]);
    expect(calls.some((call) => call.path.includes("/merge_requests/"))).toBe(false);
  });

  it("reads a branch whose project runs no pipeline there as having no checks", async () => {
    const { forge } = forgeAnswering(({ path }) =>
      path === `${API}/pipelines` || path === `${API}/repository/commits/${head}/statuses`
        ? Response.json([])
        : notFound(),
    );
    expect(await forge.checks(branch)).toEqual({ items: [], complete: true });
  });
});

describe("clearing up after a batch on GitLab", () => {
  it("deletes the batch branch by its whole name, and takes one already gone as done", async () => {
    let gone = false;
    const { forge, calls } = forgeAnswering(() =>
      gone
        ? Response.json({ message: "404 Branch Not Found" }, { status: 404 })
        : new Response(null, { status: 204 }),
    );
    await forge.deleteBranch("infinitary-batch/3fa9c1d2");
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["DELETE", `${API}/repository/branches/${encodeURIComponent("infinitary-batch/3fa9c1d2")}`],
    ]);
    gone = true;
    await expect(forge.deleteBranch("infinitary-batch/3fa9c1d2")).resolves.toBeUndefined();
  });

  it("says so when GitLab refuses to delete the branch", async () => {
    const { forge } = forgeAnswering(() =>
      Response.json({ message: "403 Forbidden" }, { status: 403 }),
    );
    await expect(forge.deleteBranch("infinitary-batch/3fa9c1d2")).rejects.toMatchObject({
      failure: "permission",
    });
  });

  it("closes a change's own merge request with a note saying where its work went", async () => {
    const { forge, calls } = forgeAnswering(({ method }) =>
      method === "POST"
        ? Response.json({ id: 9001 }, { status: 201 })
        : Response.json({ iid: 9, state: "closed" }),
    );
    const note = `This change merged as part of !12 (https://${HOST}/acme/meter/-/merge_requests/12), so this pull request is closed.`;
    await forge.closeWithNote(
      {
        number: 9,
        url: null,
        branch: "fm/task-parser",
        headSha: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
      },
      note,
    );
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", `${API}/merge_requests/9/notes`, { body: note }],
      ["PUT", `${API}/merge_requests/9`, { state_event: "close" }],
    ]);
  });
});

// Intent: a bug being fixed, in the words of its task: a batch's merge request opens "with
// complete, accessible change information when their combined stories exceed the host's
// description limit". The stories past the description are the app's own notes, read,
// written and deleted by id with the captain's sign-in, and never a person's or GitLab's own.
describe("the notes that carry a batch's stories on GitLab", () => {
  const stories = `${BATCH_STORIES_MARKER}\n\nStories of this batch's changes that did not fit in its description.`;

  it("reads only the signed-in person's notes that open with the app's mark, oldest first", async () => {
    const { forge, calls } = forgeAnswering(({ path }) =>
      path === "/api/v4/user"
        ? Response.json({ id: 41, username: "captain" })
        : Response.json([
            { id: 501, system: true, author: { id: 41 }, body: "added 1 commit" },
            { id: 502, system: false, author: { id: 41 }, body: stories },
            { id: 503, system: false, author: { id: 41 }, body: "Merging after the release." },
            { id: 504, system: false, author: { id: 77 }, body: stories },
          ]),
    );
    expect(await forge.ownComments(12, BATCH_STORIES_MARKER)).toEqual([{ id: 502, body: stories }]);
    expect(calls.map((call) => [call.method, call.path, call.query])).toEqual([
      ["GET", "/api/v4/user", ""],
      [
        "GET",
        `${API}/merge_requests/12/notes`,
        "?sort=asc&order_by=created_at&per_page=100&page=1",
      ],
    ]);
  });

  it("posts a new one, rewrites and deletes one by its id, and takes one already gone as done", async () => {
    let gone = false;
    const { forge, calls } = forgeAnswering(({ method }) =>
      method === "POST"
        ? Response.json({ id: 505 }, { status: 201 })
        : method === "PUT"
          ? Response.json({ id: 502 })
          : gone
            ? notFound()
            : new Response(null, { status: 204 }),
    );
    await forge.writeComment(12, stories);
    await forge.writeComment(12, stories, 502);
    await forge.deleteComment(12, 502);
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", `${API}/merge_requests/12/notes`, { body: stories }],
      ["PUT", `${API}/merge_requests/12/notes/502`, { body: stories }],
      ["DELETE", `${API}/merge_requests/12/notes/502`, undefined],
    ]);
    gone = true;
    await expect(forge.deleteComment(12, 502)).resolves.toBeUndefined();
  });
});
