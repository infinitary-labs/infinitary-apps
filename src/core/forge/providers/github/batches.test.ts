import { describe, expect, it, vi } from "vitest";
import { GitHubForge } from "./githubForge";

// Intent: the captain's approved plan for batches of their own, piece 1: a batch merges
// "keeping one commit per change: GitHub's rebase merge where allowed, else a merge
// commit", the merge way is chosen "from host facts", the batch branch is deleted after
// the merge, and a change that had its own pull request has it closed with a link.
//
// GitHub is the stand-in: its REST answers as its API documents them, through the
// forge's own `fetch`.

type Call = { method: string; path: string; body: unknown };

function forgeAnswering(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call);
  });
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "acme", name: "meter", dir: "/code/meter" },
    { token: async () => "gho_disposable-test-token", fetch: fetcher },
  );
  return { forge, calls };
}

const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });

/** The repository as GitHub answers it to a sign-in that can push: its three merge buttons. */
const REPOSITORY = {
  full_name: "acme/meter",
  default_branch: "main",
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: true,
};

describe("the merges a GitHub project allows", () => {
  function projectWith(settings: Record<string, unknown>, rules: unknown[] | Response) {
    return forgeAnswering(({ method, path }) => {
      if (method !== "GET") return notFound();
      if (path === "/repos/acme/meter") return Response.json({ ...REPOSITORY, ...settings });
      if (path === "/repos/acme/meter/rules/branches/main")
        return rules instanceof Response ? rules : Response.json(rules);
      if (path === "/repos/acme/meter/rulesets/4410")
        return Response.json({ id: 4410, name: "Protect main", current_user_can_bypass: "never" });
      return notFound();
    });
  }

  it("reads the project's own merge buttons where no rule narrows them", async () => {
    const { forge } = projectWith({}, []);
    expect(await forge.mergeWays()).toEqual({ squash: true, rebase: true, merge: true });
  });

  it("reads a project whose settings allow only squash merges as one that keeps no commits", async () => {
    const { forge } = projectWith({ allow_merge_commit: false, allow_rebase_merge: false }, []);
    expect(await forge.mergeWays()).toEqual({ squash: true, rebase: false, merge: false });
  });

  it("narrows them by the default branch's rules: the methods a rule lists, and no merge commit under a linear history", async () => {
    const { forge, calls } = projectWith({}, [
      {
        type: "pull_request",
        ruleset_id: 4410,
        parameters: { allowed_merge_methods: ["squash", "rebase", "merge"] },
      },
      { type: "required_linear_history", ruleset_id: 4410 },
    ]);
    expect(await forge.mergeWays()).toEqual({ squash: true, rebase: true, merge: false });
    // The rules are read for the default branch GitHub named, not a guessed one.
    expect(calls.map((call) => call.path)).toContain("/repos/acme/meter/rules/branches/main");
  });

  it("answers the settings alone where the project has no rules to read", async () => {
    // A plan without rule sets answers 404; a sign-in that may not read them, 403.
    for (const status of [404, 403]) {
      const { forge } = projectWith(
        { allow_merge_commit: false },
        Response.json(
          { message: "Upgrade to GitHub Pro or make this repository public." },
          { status },
        ),
      );
      expect(await forge.mergeWays()).toEqual({ squash: true, rebase: true, merge: false });
    }
  });

  it("refuses to guess where GitHub leaves the merge buttons out for this sign-in", async () => {
    const { forge } = forgeAnswering(({ path }) =>
      path === "/repos/acme/meter"
        ? Response.json({ full_name: "acme/meter", default_branch: "main" })
        : notFound(),
    );
    await expect(forge.mergeWays()).rejects.toMatchObject({
      failure: "permission",
      message: "GitHub did not say which merges this project allows for this sign-in.",
    });
  });
});

describe("merging a batch's pull request on GitHub", () => {
  const head = "c7e9d1f3b5a79d1c7e2a4b6f8091a3c5e7d9f1b3";
  const batch = {
    number: 31,
    url: "https://github.com/acme/meter/pull/31",
    branch: "infinitary-batch/3fa9c1d2",
    headSha: head,
    title: "chore: merge 2 approved changes",
    squashMessage: "- fix(parser): read dates with a time zone\n- feat(export): add a CSV export",
  };
  const merging = () =>
    forgeAnswering(({ method, path }) =>
      method === "PUT" && path === "/repos/acme/meter/pulls/31/merge"
        ? Response.json({ merged: true, sha: "4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c2b" })
        : notFound(),
    );

  it("merges by rebase at the batch's version with no commit words of its own, so each change keeps its commit", async () => {
    const { forge, calls } = merging();
    expect(await forge.putIn(batch, head, "rebase")).toEqual({
      sha: "4d6f8a0c1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c2b",
    });
    expect(calls.map((call) => call.body)).toEqual([{ sha: head, merge_method: "rebase" }]);
  });

  it("merges with a merge commit under the batch's title and its list of changes", async () => {
    const { forge, calls } = merging();
    await forge.putIn(batch, head, "merge");
    expect(calls.map((call) => call.body)).toEqual([
      {
        sha: head,
        merge_method: "merge",
        commit_title: "chore: merge 2 approved changes",
        commit_message: batch.squashMessage,
      },
    ]);
  });

  it("squashes when no way is named, as a change's own pull request merges", async () => {
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
        merge_method: "squash",
        commit_title: "fix(parser): read dates with a time zone",
        commit_message: "- Dates with a time zone are read as written.",
      },
    ]);
  });

  it("answers GitHub's refusal of a rebase merge as a refusal, in GitHub's words", async () => {
    const { forge } = forgeAnswering(() =>
      Response.json(
        { message: "Rebase merges are not allowed on this repository." },
        { status: 405 },
      ),
    );
    await expect(forge.putIn(batch, head, "rebase")).rejects.toMatchObject({
      failure: "refused",
      message: expect.stringContaining("Rebase merges are not allowed on this repository."),
    });
  });
});

describe("the checks of a batch's pull request on GitHub", () => {
  // Intent: the same plan: the app merges a batch "when every check on the batch's
  // version passed or was skipped". The bug this fixes: on a project whose one
  // workflow runs on every pushed branch, a batch's passed check was read as no
  // check at all, so the batch waited with nothing left to wait for.
  //
  // The readings are GitHub's own answers at such a batch's version, with the
  // project renamed: one workflow run started by the push of the batch branch,
  // its one check, and no commit status.
  const HEAD = "935b2d1821272036f179e6cd820d427038bbb2eb";
  const PUSHED_RUN = {
    id: 43141748667,
    name: "checks",
    event: "push",
    run_number: 2,
    workflow_id: 415405409,
    check_suite_id: 116828103675,
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-12T02:29:16Z",
    head_sha: HEAD,
    head_branch: "infinitary-batch/3014ae8f",
  };
  const ITS_CHECK = {
    name: "unit-tests",
    status: "completed",
    conclusion: "success",
    started_at: "2026-11-12T02:29:19Z",
    completed_at: "2026-11-12T02:29:22Z",
    check_suite: { id: PUSHED_RUN.check_suite_id },
  };
  const atTheVersion = () =>
    forgeAnswering(({ path }) => {
      if (path === `/repos/acme/meter/commits/${HEAD}/check-runs`)
        return Response.json({ total_count: 1, check_runs: [ITS_CHECK] });
      if (path === `/repos/acme/meter/commits/${HEAD}/status`)
        return Response.json({ state: "pending", statuses: [], total_count: 0 });
      if (path === "/repos/acme/meter/actions/runs")
        return Response.json({ total_count: 1, workflow_runs: [PUSHED_RUN] });
      return notFound();
    }).forge;

  it("counts the check GitHub ran for the push of the batch's own branch, and still leaves a pushed run out of a change's own pull request", async () => {
    const batch = { number: 1, url: null, branch: PUSHED_RUN.head_branch, headSha: HEAD };
    expect(await atTheVersion().checks(batch)).toMatchObject({
      items: [{ name: "unit-tests", state: "success", run: PUSHED_RUN.id, event: "push" }],
      complete: true,
    });
    // A change's own pull request keeps its rule: only the runs the pull request started.
    const own = { ...batch, branch: "fm/task-94c93b40" };
    expect(await atTheVersion().checks(own)).toMatchObject({ items: [], complete: true });
  });
});

describe("clearing up after a batch on GitHub", () => {
  it("deletes the batch branch by its whole name, and takes one already gone as done", async () => {
    let status = 204;
    const { forge, calls } = forgeAnswering(() =>
      status === 204
        ? new Response(null, { status })
        : Response.json({ message: "Reference does not exist" }, { status }),
    );
    await forge.deleteBranch("infinitary-batch/3fa9c1d2");
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/repos/acme/meter/git/refs/heads/infinitary-batch/3fa9c1d2",
        body: undefined,
      },
    ]);
    status = 422;
    await expect(forge.deleteBranch("infinitary-batch/3fa9c1d2")).resolves.toBeUndefined();
  });

  it("says so when GitHub refuses to delete the branch", async () => {
    const { forge } = forgeAnswering(() =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    );
    await expect(forge.deleteBranch("infinitary-batch/3fa9c1d2")).rejects.toMatchObject({
      message: expect.stringContaining("Resource not accessible by integration"),
    });
  });

  it("closes a change's own pull request with a note saying where its work went", async () => {
    const { forge, calls } = forgeAnswering(({ method }) =>
      method === "POST"
        ? Response.json({ id: 9001 }, { status: 201 })
        : Response.json({ state: "closed" }),
    );
    const note =
      "This change merged as part of #31 (https://github.com/acme/meter/pull/31), so this pull request is closed.";
    await forge.closeWithNote(
      {
        number: 27,
        url: null,
        branch: "fm/task-parser",
        headSha: "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0",
      },
      note,
    );
    expect(calls).toEqual([
      { method: "POST", path: "/repos/acme/meter/issues/27/comments", body: { body: note } },
      { method: "PATCH", path: "/repos/acme/meter/pulls/27", body: { state: "closed" } },
    ]);
  });
});
