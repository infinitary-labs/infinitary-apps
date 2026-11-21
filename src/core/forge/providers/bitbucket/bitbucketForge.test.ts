import { describe, expect, it, vi } from "vitest";
import { ForgeBaseMoved, type ForgeChange, ForgeError, ForgeMergeUnconfirmed } from "../../forge";
import { BitbucketForge } from "./bitbucketForge";

// The task's intent (INF-5193, the captain's "adding bitbucket as another
// forge integration just like github and gitlab, reaching parity as much as
// possible"): a Bitbucket Cloud project opens a pull request, reads its
// build statuses as checks, says whether Bitbucket would merge it, and is
// merged at the approved version only. Each answer follows the shapes
// Bitbucket's published API gives: short commit ids on a pull request, full
// ones on a branch, and the merge's 200, 202 and 409.
const API = "https://api.bitbucket.org/2.0";
const KEY = "ATATT3xFfGF0disposable_test-key=0A1B2C3D";
const REPO = "/repositories/field-team/field-notes";
const HEAD = "4f1c2a9be07d3c55a1e8b2f06d9c4a7e3b5d1f20";
const NEWER = "9a8b7c6d5e4f30211203f4e5d6c7b8a9f0e1d2c3";
const MERGED = "c0ffee00d15ea5e0b16b00b5ca5cade0ddba11ed";
const BRANCH = "inf/add-field-notes-bb01";

type Sent = { method: string; path: string; body?: unknown };

/** A stand-in for bitbucket.org's API: `routes` answers `METHOD path`, and every request is kept. */
function standIn(
  routes: Record<string, (body: unknown) => Response>,
  source?: { id: number; fullName: string },
) {
  const sent: Sent[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/2\.0/, "") + url.search;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const route = routes[`${method} ${path}`];
    return route ? route(body) : Response.json({ type: "error" }, { status: 404 });
  });
  const forge = new BitbucketForge(
    {
      kind: "bitbucket",
      host: "bitbucket.org",
      owner: "field-team",
      name: "field-notes",
      dir: "",
      ...(source ? { source } : {}),
    },
    { token: async () => KEY, apiBaseUrl: API, fetch: fetcher },
  );
  return { forge, sent };
}

/** A pull request as Bitbucket answers it: the head by its short id. */
function pullRequest(fields: { id?: number; state?: string; head?: string; draft?: boolean }) {
  const id = fields.id ?? 7;
  return {
    type: "pullrequest",
    id,
    title: "feat: keep field notes",
    description: "Field notes, kept beside the map.",
    state: fields.state ?? "OPEN",
    draft: fields.draft ?? false,
    source: {
      branch: { name: BRANCH },
      commit: { hash: (fields.head ?? HEAD).slice(0, 12) },
      repository: { full_name: "field-team/field-notes" },
    },
    destination: { branch: { name: "main" }, commit: { hash: "1a2b3c4d5e6f" } },
    merge_commit: fields.state === "MERGED" ? { hash: MERGED.slice(0, 12) } : null,
    links: { html: { href: `https://bitbucket.org/field-team/field-notes/pull-requests/${id}` } },
  };
}

/** Bitbucket's commit read, which turns a short id into its full one. */
function commits(...full: string[]) {
  return Object.fromEntries(
    full.map((sha) => [
      `GET ${REPO}/commit/${sha.slice(0, 12)}?fields=hash`,
      () => Response.json({ hash: sha }),
    ]),
  );
}

const change: ForgeChange = {
  number: 7,
  url: "https://bitbucket.org/field-team/field-notes/pull-requests/7",
  branch: BRANCH,
  headSha: HEAD,
  title: "feat: keep field notes",
  body: "Field notes, kept beside the map.",
  squashMessage: "Field notes, kept beside the map.",
};

describe("a Bitbucket Cloud pull request", () => {
  it("opens onto the main branch as a draft and is read back with its full head version", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}?fields=mainbranch.name`]: () => Response.json({ mainbranch: { name: "main" } }),
      [`POST ${REPO}/pullrequests`]: () =>
        Response.json(pullRequest({ draft: true }), { status: 201 }),
      ...commits(HEAD),
    });
    const opened = await forge.openChange({
      branch: BRANCH,
      title: "feat: keep field notes",
      body: "Field notes, kept beside the map.",
      draft: true,
    });
    expect(sent.find((request) => request.method === "POST")?.body).toEqual({
      title: "feat: keep field notes",
      description: "Field notes, kept beside the map.",
      source: { branch: { name: BRANCH } },
      destination: { branch: { name: "main" } },
      close_source_branch: false,
      draft: true,
    });
    expect(opened).toMatchObject({ number: 7, draft: true, headSha: HEAD, base: "main" });
    expect(forge.label(opened)).toBe("#7");
  });

  it("reads each build status on the version as a check, a running one pending", async () => {
    const statuses = `GET ${REPO}/commit/${HEAD}/statuses?pagelen=100`;
    const { forge } = standIn({
      [statuses]: () =>
        Response.json({
          values: [
            { key: "lint", name: "Lint", state: "SUCCESSFUL", url: "https://ci.example/1" },
            { key: "unit", name: "Unit tests", state: "FAILED", url: "https://ci.example/2" },
            { key: "deploy", name: "Deploy", state: "INPROGRESS" },
            { key: "docs", name: "Docs", state: "STOPPED" },
          ],
        }),
    });
    const read = await forge.checks(change);
    expect(read.complete).toBe(true);
    expect(read.items.map(({ name, state }) => [name, state])).toEqual([
      ["Lint", "success"],
      ["Unit tests", "failure"],
      ["Deploy", "pending"],
      ["Docs", "cancelled"],
    ]);
  });

  it.each([
    [
      "conflict",
      [{ type: "git_mergeability_check", status: "FAILED", reason: "conflicts", blocking: true }],
    ],
    [
      "behind",
      [
        { type: "git_mergeability_check", status: "PASSED", reason: "clean" },
        {
          type: "standard_merge_check",
          status: "FAILED",
          blocking: true,
          check: { kind: "maximum_commits_behind" },
        },
      ],
    ],
    [
      "blocked",
      [
        { type: "git_mergeability_check", status: "PASSED", reason: "clean" },
        {
          type: "standard_merge_check",
          status: "FAILED",
          blocking: true,
          check: { kind: "minimum_approvals" },
        },
      ],
    ],
    ["computing", [{ type: "git_mergeability_check", status: "PENDING" }]],
    ["clean", [{ type: "git_mergeability_check", status: "PASSED", reason: "clean" }]],
  ])("reads %s from Bitbucket's own mergeability checks", async (readiness, values) => {
    const { forge } = standIn({
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      [`GET ${REPO}/pullrequests/7/mergeability/checks`]: () => Response.json({ values }),
      ...commits(HEAD),
    });
    expect((await forge.pull(7)).readiness).toBe(readiness);
  });

  it("merges by squash at the approved version, naming the merged commit and version in full", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () => Response.json(pullRequest({ state: "MERGED" })),
      ...commits(HEAD, MERGED),
    });
    expect(await forge.putIn(change, HEAD, "squash")).toEqual({ sha: MERGED, mergedHead: HEAD });
    expect(sent.find((request) => request.path.endsWith("/merge"))?.body).toEqual({
      type: "pullrequest",
      message: "feat: keep field notes\n\nField notes, kept beside the map.",
      merge_strategy: "squash",
      close_source_branch: false,
    });
  });

  it("sends no merge when the branch moved past the approved version", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: NEWER } }),
    });
    const refused = await forge.putIn(change, HEAD, "squash").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForgeError);
    expect(refused).toMatchObject({ failure: "refused", beforeSend: true });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  it("names the newer version Bitbucket merged when a push landed between the read and the merge", async () => {
    const { forge } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        Response.json(pullRequest({ state: "MERGED", head: NEWER })),
      ...commits(NEWER, MERGED),
    });
    expect(await forge.putIn(change, HEAD, "squash")).toEqual({ sha: MERGED, mergedHead: NEWER });
  });

  it("reads a ref that moved during the merge as the base moving", async () => {
    const { forge } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        Response.json(
          { type: "error", error: { message: "A ref was updated during the merge." } },
          { status: 409 },
        ),
    });
    await expect(forge.putIn(change, HEAD, "squash")).rejects.toBeInstanceOf(ForgeBaseMoved);
  });

  it.each([
    [
      "a 202 whose merge has not finished",
      () => new Response(JSON.stringify({ task_id: "merge-1" }), { status: 202 }),
      pullRequest({}),
    ],
    [
      "a merge that does not name the version it merged",
      () =>
        Response.json({
          ...pullRequest({ state: "MERGED" }),
          source: { branch: { name: BRANCH }, commit: null },
        }),
      pullRequest({}),
    ],
    [
      "an accepted merge whose pull request cannot be read after it",
      () => new Response(JSON.stringify({ task_id: "merge-2" }), { status: 202 }),
      null,
    ],
  ])("leaves %s unknown, sending the merge once", async (_case, answer, after) => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: answer,
      [`GET ${REPO}/pullrequests/7`]: () =>
        after ? Response.json(after) : Response.json({ type: "error" }, { status: 404 }),
      ...commits(HEAD, MERGED),
    });
    const outcome = await forge.putIn(change, HEAD, "squash").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ForgeError);
    expect(outcome).toMatchObject({ failure: "transient" });
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("says nothing was sent when the branch read before the merge fails", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ type: "error" }, { status: 503 }),
    });
    const outcome = await forge.putIn(change, HEAD, "squash").catch((error: unknown) => error);
    expect(outcome).toMatchObject({ failure: "transient", beforeSend: true });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  it("runs the caller's last check as the merge request leaves, and sends nothing when it stops", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
    });
    const order: string[] = [];
    const outcome = await forge
      .putIn(change, HEAD, "squash", () => {
        order.push(`check after ${sent.length} read(s)`);
        throw new ForgeError("refused", "the captain's merge approval ended", true);
      })
      .catch((error: unknown) => error);
    expect(order).toEqual(["check after 1 read(s)"]);
    expect(outcome).toMatchObject({ beforeSend: true });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  // Atlassian's description of the task-status read: a 202 names the task
  // only in its Location, and a 400 is a failed merge, a pull request that
  // left its queue unmerged, or a task of another pull request.
  const STATUS = `${API}${REPO}/pullrequests/7/merge/task-status`;
  it.each([
    ["this pull request's task", `${STATUS}/merge-1`, "7/merge-1"],
    [
      "another pull request's task",
      `${API}${REPO}/pullrequests/8/merge/task-status/merge-1`,
      undefined,
    ],
    [
      "another repository's task",
      `${API}/repositories/field-team/other/pullrequests/7/merge/task-status/merge-1`,
      undefined,
    ],
    ["no Location", null, undefined],
  ])("keeps a 202's reference only when its Location names %s", async (_case, location, kept) => {
    const { forge } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        new Response(null, { status: 202, headers: location ? { Location: location } : {} }),
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      ...commits(HEAD),
    });
    const outcome = await forge.putIn(change, HEAD, "squash").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ForgeMergeUnconfirmed);
    expect((outcome as ForgeMergeUnconfirmed).mergeTask).toBe(kept);
  });

  it("reads a kept task's 400 as a refusal, a pending one as not, and asks nothing for another pull request's", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/pullrequests/7/merge/task-status/merge-1`]: () =>
        Response.json({ type: "error", error: { message: "Merge failed" } }, { status: 400 }),
      [`GET ${REPO}/pullrequests/7/merge/task-status/merge-2`]: () =>
        Response.json({ task_status: "PENDING" }),
    });
    expect(await forge.mergeTaskRefused(7, "7/merge-1")).toBe(true);
    expect(await forge.mergeTaskRefused(7, "7/merge-2")).toBe(false);
    const asked = sent.length;
    expect(await forge.mergeTaskRefused(7, "8/merge-1")).toBe(false);
    expect(await forge.mergeTaskRefused(7, "merge-1")).toBe(false);
    expect(sent).toHaveLength(asked);
  });

  // INF-5193 (the review of Bitbucket's merge): a read that settles a merge
  // whose outcome is unknown must be one of the states Bitbucket names; an
  // answer with none, or an unknown one, is unreadable, never closed.
  it("reads a declined pull request as closed, and one with no state it names as unreadable", async () => {
    const { state: _state, ...stateless } = pullRequest({ id: 8 });
    const { forge } = standIn({
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({ state: "DECLINED" })),
      [`GET ${REPO}/pullrequests/8`]: () => Response.json(stateless),
      [`GET ${REPO}/pullrequests/9`]: () =>
        Response.json(pullRequest({ id: 9, state: "ARCHIVED" })),
      ...commits(HEAD),
    });
    expect(await forge.pull(7)).toMatchObject({ state: "closed", merged: false });
    await expect(forge.pull(8)).rejects.toMatchObject({ failure: "transient" });
    await expect(forge.pull(9)).rejects.toMatchObject({ failure: "transient" });
  });

  // The live check on bitbucket.org (this task's review): a new comment
  // leaves a pull request's `updated_on` where it was, so a last-changed time
  // read from it would keep the comment wake from ever reading the comment.
  it("names no last-changed time for a pull request, since Bitbucket's leaves out comments", async () => {
    const { forge } = standIn({
      [`GET ${REPO}/pullrequests/7`]: () =>
        Response.json({ ...pullRequest({}), updated_on: "2026-11-21T03:14:31.633308+00:00" }),
      [`GET ${REPO}/pullrequests/7/mergeability/checks`]: () =>
        Response.json({
          values: [{ type: "git_mergeability_check", status: "PASSED", reason: "clean" }],
        }),
      ...commits(HEAD),
    });
    const pull = await forge.pull(7);
    expect(pull.readiness).toBe("clean");
    expect(pull).not.toHaveProperty("updatedAt");
  });

  // INF-5193 (the review of Bitbucket's merge): an answer about another pull
  // request is no reading of this one, so it confirms no merge and settles
  // no merge whose outcome is unknown.
  it("confirms no merge and reads nothing from an answer about another pull request", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        Response.json(pullRequest({ id: 8, state: "MERGED" })),
      [`GET ${REPO}/pullrequests/7`]: () =>
        Response.json(pullRequest({ id: 8, state: "DECLINED" })),
      ...commits(HEAD, MERGED),
    });
    await expect(forge.putIn(change, HEAD, "squash")).rejects.toBeInstanceOf(ForgeMergeUnconfirmed);
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
    await expect(forge.pull(7)).rejects.toBeInstanceOf(ForgeError);
  });

  it("does not take an answer about another pull request as this draft made ready", async () => {
    const { forge } = standIn({
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({ draft: true })),
      [`PUT ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({ id: 8 })),
      ...commits(HEAD),
    });
    await expect(forge.markReady({ ...change, draft: true }, () => {})).rejects.toBeInstanceOf(
      ForgeError,
    );
  });

  it("replaces only the description, leaving a title a person changed since", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      [`PUT ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      ...commits(HEAD),
    });
    await forge.updateChangeBody(change, "The story, published.");
    expect(sent.find((request) => request.method === "PUT")?.body).toEqual({
      description: "The story, published.",
    });
  });
});

// INF-5186 piece 5 (the captain's "adding bitbucket as another forge
// integration just like github and gitlab, reaching parity as much as
// possible"): batches on Bitbucket send the merge the main branch allows,
// and a branch with Bitbucket's merge queue takes the merge with a 202 that
// reads as queued. The answers follow Bitbucket's published API: a branch's
// `merge_strategies`, the pull request's `queued` flag and the merge task's
// `queued_pullrequest`.
describe("a Bitbucket Cloud batch merge", () => {
  const MAIN = `GET ${REPO}?fields=mainbranch.name`;
  const STRATEGIES = `GET ${REPO}/refs/branches/main?fields=merge_strategies`;
  const BRANCH_READ = `GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`;

  it.each([
    [["merge_commit", "squash", "fast_forward"], { squash: true, rebase: false, merge: true }],
    [["rebase_merge", "rebase_fast_forward"], { squash: false, rebase: true, merge: false }],
    [["fast_forward", "squash_fast_forward"], { squash: false, rebase: false, merge: false }],
  ])("reads the strategies %j as the merges the main branch allows", async (strategies, ways) => {
    const { forge } = standIn({
      [MAIN]: () => Response.json({ mainbranch: { name: "main" } }),
      [STRATEGIES]: () => Response.json({ merge_strategies: strategies }),
    });
    expect(await forge.mergeWays()).toEqual(ways);
  });

  it("assumes no merge when Bitbucket names no strategies", async () => {
    const { forge } = standIn({
      [MAIN]: () => Response.json({ mainbranch: { name: "main" } }),
      [STRATEGIES]: () => Response.json({ name: "main" }),
    });
    await expect(forge.mergeWays()).rejects.toMatchObject({ failure: "transient" });
  });

  it.each([
    ["squash", "squash"],
    ["rebase", "rebase_merge"],
    ["merge", "merge_commit"],
  ] as const)("sends a %s as Bitbucket's %s", async (way, strategy) => {
    const { forge, sent } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () => Response.json(pullRequest({ state: "MERGED" })),
      ...commits(HEAD, MERGED),
    });
    expect(await forge.putIn(change, HEAD, way)).toEqual({ sha: MERGED, mergedHead: HEAD });
    expect(sent.find((request) => request.method === "POST")?.body).toMatchObject({
      merge_strategy: strategy,
    });
  });

  it("sends nothing when no merge was read for it", async () => {
    const { forge, sent } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
    });
    await expect(forge.putIn(change, HEAD, undefined)).rejects.toMatchObject({
      failure: "refused",
      beforeSend: true,
    });
    expect(sent).toHaveLength(0);
  });

  it("reads a 202 from the merge queue as queued, sends it once, and reads the queue from the pull request", async () => {
    const { forge, sent } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        new Response(null, {
          status: 202,
          headers: { Location: `${API}${REPO}/pullrequests/7/merge/task-status/queue-1` },
        }),
      [`GET ${REPO}/pullrequests/7`]: () => Response.json({ ...pullRequest({}), queued: true }),
      ...commits(HEAD),
    });
    expect(await forge.putIn(change, HEAD, "rebase")).toEqual({ queued: true });
    expect(await forge.inHostQueue(7)).toBe(true);
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("reads a pending merge task that names the queue's entry as queued", async () => {
    const { forge } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        new Response(null, {
          status: 202,
          headers: { Location: `${API}${REPO}/pullrequests/7/merge/task-status/queue-1` },
        }),
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      [`GET ${REPO}/pullrequests/7/merge/task-status/queue-1`]: () =>
        Response.json({
          task_status: "PENDING",
          queued_pullrequest: { type: "queued_pullrequest", status: "QUEUED", rank: 2 },
        }),
      ...commits(HEAD),
    });
    expect(await forge.putIn(change, HEAD, "squash")).toEqual({ queued: true });
  });

  it("leaves a pending merge task with no queue entry unknown, keeping its reference", async () => {
    const { forge } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        new Response(null, {
          status: 202,
          headers: { Location: `${API}${REPO}/pullrequests/7/merge/task-status/merge-1` },
        }),
      [`GET ${REPO}/pullrequests/7`]: () => Response.json(pullRequest({})),
      [`GET ${REPO}/pullrequests/7/merge/task-status/merge-1`]: () =>
        Response.json({ task_status: "PENDING" }),
      ...commits(HEAD),
    });
    const outcome = await forge.putIn(change, HEAD, "squash").catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ForgeMergeUnconfirmed);
    expect((outcome as ForgeMergeUnconfirmed).mergeTask).toBe("7/merge-1");
  });

  it.each([
    [503, ForgeMergeUnconfirmed],
    [555, ForgeMergeUnconfirmed],
  ])("leaves a %i after the merge left unknown, never a failure", async (status, kind) => {
    const { forge, sent } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () => Response.json({ type: "error" }, { status }),
    });
    await expect(forge.putIn(change, HEAD, "merge")).rejects.toBeInstanceOf(kind);
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("takes Bitbucket's 400 as its refusal of the merge", async () => {
    const { forge } = standIn({
      [BRANCH_READ]: () => Response.json({ target: { hash: HEAD } }),
      [`POST ${REPO}/pullrequests/7/merge`]: () =>
        Response.json(
          { type: "error", error: { message: "The merge queue is not accepting entries" } },
          { status: 400 },
        ),
    });
    await expect(forge.putIn(change, HEAD, "merge")).rejects.toMatchObject({
      failure: "refused",
    });
  });

  it("reads only the signed-in account's own top comments that open with the marker", async () => {
    const MARKER = "<!-- infinitary:batch-stories -->";
    const { forge, sent } = standIn({
      "GET /user?fields=account_id": () => Response.json({ account_id: "557058:crew" }),
      [`GET ${REPO}/pullrequests/7/comments?pagelen=100&sort=id&fields=next,values.id,values.deleted,values.user.account_id,values.content.raw,values.inline,values.parent.id`]:
        () =>
          Response.json({
            values: [
              { id: 1, user: { account_id: "557058:crew" }, content: { raw: `${MARKER} one` } },
              { id: 2, user: { account_id: "557058:other" }, content: { raw: `${MARKER} two` } },
              { id: 3, user: { account_id: "557058:crew" }, content: { raw: "Looks good." } },
              {
                id: 4,
                deleted: true,
                user: { account_id: "557058:crew" },
                content: { raw: `${MARKER} gone` },
              },
              {
                id: 5,
                user: { account_id: "557058:crew" },
                content: { raw: `${MARKER} reply` },
                parent: { id: 1 },
              },
              { id: 6, user: { account_id: "557058:crew" }, content: { raw: `${MARKER} six` } },
            ],
          }),
      [`POST ${REPO}/pullrequests/7/comments`]: () => Response.json({ id: 7 }, { status: 201 }),
      [`PUT ${REPO}/pullrequests/7/comments/6`]: () => Response.json({ id: 6 }),
      [`DELETE ${REPO}/pullrequests/7/comments/1`]: () => new Response(null, { status: 204 }),
    });
    expect(await forge.ownComments(7, MARKER)).toEqual([
      { id: 1, body: `${MARKER} one` },
      { id: 6, body: `${MARKER} six` },
    ]);
    await forge.writeComment(7, `${MARKER} new`);
    await forge.writeComment(7, `${MARKER} six again`, 6);
    await forge.deleteComment(7, 1);
    // A comment already gone is not an error.
    await forge.deleteComment(7, 99);
    expect(
      sent
        .filter((request) => request.method !== "GET")
        .map(({ method, path, body }) => ({
          method,
          path,
          body,
        })),
    ).toEqual([
      {
        method: "POST",
        path: `${REPO}/pullrequests/7/comments`,
        body: { content: { raw: `${MARKER} new` } },
      },
      {
        method: "PUT",
        path: `${REPO}/pullrequests/7/comments/6`,
        body: { content: { raw: `${MARKER} six again` } },
      },
      { method: "DELETE", path: `${REPO}/pullrequests/7/comments/1`, body: undefined },
      { method: "DELETE", path: `${REPO}/pullrequests/7/comments/99`, body: undefined },
    ]);
  });

  it("reads the files a commit changes from its diffstat, a rename by both paths", async () => {
    const { forge } = standIn({
      [`GET ${REPO}/diffstat/${HEAD}?pagelen=100&fields=next,values.old.path,values.new.path`]:
        () =>
          Response.json({
            values: [
              { old: null, new: { path: "notes/field.md" } },
              { old: { path: "map.md" }, new: { path: "maps/map.md" } },
              { old: { path: "old.txt" }, new: null },
            ],
          }),
    });
    expect((await forge.commitFiles(HEAD)).sort()).toEqual(
      ["map.md", "maps/map.md", "notes/field.md", "old.txt"].sort(),
    );
  });
});

// INF-5186 piece 5: a person who cannot push to a Bitbucket repository
// contributes from their own fork. The answers follow Bitbucket's published
// API: the repository's `parent`, the caller's repository permission in a
// workspace, the forks a person administers, and a fork made into a named
// workspace.
describe("a Bitbucket Cloud contribution from a fork", () => {
  const UPSTREAM_UUID = "{3f1e9a20-5b7c-4d8e-9f01-23456789abcd}";
  const FORK_UUID = "{7a2b4c6d-8e0f-4a1b-8c2d-3e4f5a6b7c8d}";
  const OTHER_UUID = "{0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e}";
  const ME = "{9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a}";
  const FORK = "/repositories/jo-field/field-notes";
  const FIELDS = "uuid,full_name,owner.uuid,parent.uuid,parent.full_name";
  const upstreamNumber = 0x3f1e9a205b7c4;
  const forkNumber = 0x7a2b4c6d8e0f4;
  const fork = {
    id: forkNumber,
    fullName: "jo-field/field-notes",
    origin: "https://bitbucket.org/jo-field/field-notes.git",
  };
  const permission = (value: string | null) => () =>
    Response.json({
      values: value
        ? [{ permission: value, repository: { full_name: "field-team/field-notes" } }]
        : [],
    });
  const PERMISSION = `GET /user/workspaces/field-team/permissions/repositories?q=${encodeURIComponent('repository.full_name="field-team/field-notes"')}`;

  it.each([
    ["read", false, false],
    [null, false, false],
    ["write", true, false],
    ["admin", true, true],
  ])("reads permission %s as canPush %s and owned %s", async (value, canPush, owned) => {
    const { forge } = standIn({
      [`GET ${REPO}?fields=${FIELDS}`]: () =>
        Response.json({
          uuid: UPSTREAM_UUID,
          full_name: "field-team/field-notes",
          owner: { uuid: "{team}" },
        }),
      [PERMISSION]: permission(value),
    });
    expect(await forge.contributions?.inspect()).toEqual({
      project: {
        id: upstreamNumber,
        fullName: "field-team/field-notes",
        origin: "https://bitbucket.org/field-team/field-notes.git",
      },
      canPush,
      owned,
    });
  });

  it("reads a repository outside the person's workspaces as one they cannot push to, and names its parent", async () => {
    const { forge } = standIn({
      [`GET ${REPO}?fields=${FIELDS}`]: () =>
        Response.json({
          uuid: UPSTREAM_UUID,
          full_name: "field-team/field-notes",
          parent: { uuid: OTHER_UUID, full_name: "maps-org/field-notes" },
        }),
      [PERMISSION]: () => Response.json({ type: "error" }, { status: 403 }),
    });
    expect(await forge.contributions?.inspect()).toMatchObject({
      canPush: false,
      owned: false,
      parent: { fullName: "maps-org/field-notes" },
    });
  });

  it("reuses the person's fork whose parent is this repository, and finds none otherwise", async () => {
    const FORKS = `GET ${REPO}/forks?role=admin&pagelen=100&fields=next,values.uuid,values.full_name,values.owner.uuid,values.parent.uuid,values.parent.full_name`;
    const listed = [
      {
        uuid: OTHER_UUID,
        full_name: "jo-field/field-notes-copy",
        parent: { uuid: OTHER_UUID },
      },
      {
        uuid: FORK_UUID,
        full_name: "jo-field/field-notes",
        parent: { uuid: UPSTREAM_UUID, full_name: "field-team/field-notes" },
      },
    ];
    const read = (values: unknown[]) =>
      standIn({
        [`GET ${REPO}?fields=uuid,full_name`]: () =>
          Response.json({ uuid: UPSTREAM_UUID, full_name: "field-team/field-notes" }),
        [FORKS]: () => Response.json({ values }),
      }).forge;
    expect(await read(listed).contributions?.findFork()).toEqual(fork);
    expect(await read(listed.slice(0, 1)).contributions?.findFork()).toBeNull();
  });

  const WORKSPACES =
    "GET /user/workspaces?administrator=true&pagelen=100&fields=next,values.workspace.slug,values.workspace.uuid";

  it("makes the fork in the person's own workspace", async () => {
    const { forge, sent } = standIn({
      "GET /user?fields=uuid": () => Response.json({ uuid: ME }),
      [WORKSPACES]: () =>
        Response.json({
          values: [
            { workspace: { slug: "field-team-admins", uuid: "{another}" } },
            { workspace: { slug: "jo-field", uuid: ME } },
          ],
        }),
      [`POST ${REPO}/forks`]: () =>
        Response.json(
          {
            uuid: FORK_UUID,
            full_name: "jo-field/field-notes",
            parent: { uuid: UPSTREAM_UUID, full_name: "field-team/field-notes" },
          },
          { status: 201 },
        ),
    });
    expect(await forge.contributions?.createFork()).toEqual(fork);
    expect(sent.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: `${REPO}/forks`, body: { workspace: { slug: "jo-field" } } },
    ]);
  });

  it("sends nothing when the person administers several workspaces and none is their own", async () => {
    const { forge, sent } = standIn({
      "GET /user?fields=uuid": () => Response.json({ uuid: ME }),
      [WORKSPACES]: () =>
        Response.json({
          values: [
            { workspace: { slug: "maps-a", uuid: "{a}" } },
            { workspace: { slug: "maps-b", uuid: "{b}" } },
          ],
        }),
    });
    await expect(forge.contributions?.createFork()).rejects.toMatchObject({
      failure: "refused",
      beforeSend: true,
    });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  it("says nothing was sent when the workspace read fails before the fork request", async () => {
    const { forge, sent } = standIn({
      "GET /user?fields=uuid": () => Response.json({ uuid: ME }),
      [WORKSPACES]: () => new Response("unavailable", { status: 503 }),
    });
    await expect(forge.contributions?.createFork()).rejects.toMatchObject({ beforeSend: true });
    expect(sent.some((request) => request.method === "POST")).toBe(false);
  });

  it("opens the pull request here from the fork, and reads its branch and checks in the fork", async () => {
    const source = { id: forkNumber, fullName: "jo-field/field-notes" };
    const forkHead = { ...pullRequest({}) };
    forkHead.source = { ...forkHead.source, repository: { full_name: "jo-field/field-notes" } };
    const query = encodeURIComponent(`source.branch.name="${BRANCH}"`);
    const { forge, sent } = standIn(
      {
        [`GET ${REPO}?fields=mainbranch.name`]: () =>
          Response.json({ mainbranch: { name: "main" } }),
        [`POST ${REPO}/pullrequests`]: () => Response.json(forkHead, { status: 201 }),
        [`GET ${FORK}/commit/${HEAD.slice(0, 12)}?fields=hash`]: () =>
          Response.json({ hash: HEAD }),
        [`GET ${FORK}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
          Response.json({ target: { hash: HEAD } }),
        [`GET ${FORK}/commit/${HEAD}/statuses?pagelen=100`]: () =>
          Response.json({ values: [{ key: "build", name: "Build", state: "SUCCESSFUL" }] }),
        [`GET ${REPO}/pullrequests?state=OPEN&pagelen=50&q=${query}`]: () =>
          Response.json({ values: [pullRequest({ id: 6 }), { ...forkHead }] }),
      },
      source,
    );
    const opened = await forge.openChange({
      branch: BRANCH,
      title: "feat: keep field notes",
      body: "Notes.",
    });
    expect(sent.find((request) => request.method === "POST")?.body).toMatchObject({
      source: { branch: { name: BRANCH }, repository: { full_name: "jo-field/field-notes" } },
      destination: { branch: { name: "main" } },
    });
    expect(opened).toMatchObject({ number: 7, headSha: HEAD });
    expect(await forge.branchHead(BRANCH)).toBe(HEAD);
    expect((await forge.checks(opened)).items.map((item) => item.state)).toEqual(["success"]);
    // The upstream's own pull request #6 from a branch of the same name is not the fork's.
    expect((await forge.changeFor(BRANCH))?.number).toBe(7);
    await expect(forge.putIn(opened, HEAD, "squash")).rejects.toMatchObject({
      failure: "permission",
    });
  });
});
