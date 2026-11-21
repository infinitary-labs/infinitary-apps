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
function standIn(routes: Record<string, (body: unknown) => Response>) {
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
    { kind: "bitbucket", host: "bitbucket.org", owner: "field-team", name: "field-notes", dir: "" },
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
    expect(await forge.putIn(change, HEAD)).toEqual({ sha: MERGED, mergedHead: HEAD });
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
    const refused = await forge.putIn(change, HEAD).catch((error: unknown) => error);
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
    expect(await forge.putIn(change, HEAD)).toEqual({ sha: MERGED, mergedHead: NEWER });
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
    await expect(forge.putIn(change, HEAD)).rejects.toBeInstanceOf(ForgeBaseMoved);
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
    const outcome = await forge.putIn(change, HEAD).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ForgeError);
    expect(outcome).toMatchObject({ failure: "transient" });
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("says nothing was sent when the branch read before the merge fails", async () => {
    const { forge, sent } = standIn({
      [`GET ${REPO}/refs/branches/${encodeURIComponent(BRANCH)}?fields=target.hash`]: () =>
        Response.json({ type: "error" }, { status: 503 }),
    });
    const outcome = await forge.putIn(change, HEAD).catch((error: unknown) => error);
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
    const outcome = await forge.putIn(change, HEAD).catch((error: unknown) => error);
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
    await expect(forge.putIn(change, HEAD)).rejects.toBeInstanceOf(ForgeMergeUnconfirmed);
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
