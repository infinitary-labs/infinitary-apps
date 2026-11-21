import { describe, expect, it, vi } from "vitest";
import { BitbucketForge } from "./bitbucketForge";

// The task's intent (the captain's "adding bitbucket as another forge
// integration just like github and gitlab, reaching parity as much as
// possible"; its plan's piece 4): the comment wake reads Bitbucket's pull
// request comments - who wrote each and where, never its words - and the
// main-failure wake reads the build statuses on main's head. Answers follow
// Bitbucket's published shapes: one comment list where `inline` marks a line
// comment, and an `app_user` author for an app.
const API = "https://api.bitbucket.org/2.0";
const KEY = "ATATT3xFfGF0disposable_test-key=0A1B2C3D";
const REPO = "/repositories/field-team/field-notes";
const ME = "557058:6f1c2a9b-e07d-4c55-a1e8-b2f06d9c4a7e";
const WRITER = "712020:0d3b5c7a-1e2f-4a6b-9c8d-7e6f5a4b3c2d";
const VISITOR = "5b10ac8d82e05b22cc7d4ef5";
const MAIN = "c0ffee00d15ea5e0b16b00b5ca5cade0ddba11ed";

function author(account_id: string, nickname: string, type = "user") {
  return { type, account_id, nickname, display_name: nickname };
}

const comments = {
  pagelen: 100,
  page: 1,
  values: [
    {
      id: 501,
      content: { raw: "Could the photo keep its caption?" },
      user: author(VISITOR, "visitor"),
      created_on: "2026-11-19T17:00:00.000000+00:00",
      updated_on: "2026-11-19T17:00:00.000000+00:00",
      deleted: false,
      pending: false,
    },
    {
      id: 502,
      content: { raw: "This line drops the caption." },
      user: author(WRITER, "maintainer"),
      inline: { path: "src/notes.ts", from: null, to: 41 },
      created_on: "2026-11-19T18:10:00.000000+00:00",
      updated_on: "2026-11-19T18:10:00.000000+00:00",
      deleted: false,
      pending: false,
    },
    {
      id: 503,
      content: { raw: "Fixed in the next version." },
      user: author(ME, "me"),
      parent: { id: 502 },
      inline: { path: "src/notes.ts", from: null, to: 41 },
      created_on: "2026-11-19T18:20:00.000000+00:00",
      updated_on: "2026-11-19T18:20:00.000000+00:00",
      deleted: false,
      pending: false,
    },
    {
      id: 504,
      content: { raw: "Build 57 failed." },
      user: author("{b1d0c2a3-0000-4000-8000-0000000000a1}", "ci-bot", "app_user"),
      created_on: "2026-11-19T18:30:00.000000+00:00",
      updated_on: "2026-11-19T18:30:00.000000+00:00",
      deleted: false,
      pending: false,
    },
    {
      id: 505,
      content: { raw: "" },
      user: author(WRITER, "maintainer"),
      created_on: "2026-11-19T18:31:00.000000+00:00",
      updated_on: "2026-11-19T18:31:00.000000+00:00",
      deleted: true,
      pending: false,
    },
    {
      id: 506,
      content: { raw: "A draft not yet sent." },
      user: author(WRITER, "maintainer"),
      created_on: "2026-11-19T18:32:00.000000+00:00",
      updated_on: "2026-11-19T18:32:00.000000+00:00",
      deleted: false,
      pending: true,
    },
  ],
};

function standIn(permissions: Record<string, string | null>) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/2\.0/, "") + url.search;
    if (path === "/user?fields=account_id") return Response.json({ account_id: ME });
    if (path === `${REPO}/pullrequests/7/comments?pagelen=100`) return Response.json(comments);
    const asked = /\/permissions-config\/users\/(.+)$/.exec(url.pathname)?.[1];
    if (asked) {
      const permission = permissions[decodeURIComponent(asked)];
      return permission
        ? Response.json({ type: "repository_user_permission", permission })
        : Response.json({ type: "error", error: { message: "Forbidden" } }, { status: 403 });
    }
    if (path === `${REPO}?fields=mainbranch.name`)
      return Response.json({ mainbranch: { name: "main" } });
    if (path === `${REPO}/refs/branches/main?fields=target.hash`)
      return Response.json({ target: { hash: MAIN } });
    if (path === `${REPO}/commit/${MAIN}/statuses?pagelen=100`)
      return Response.json({
        values: [
          {
            key: "pipelines",
            name: "Pipeline #58 for main",
            state: "FAILED",
            refname: "main",
            created_on: "2026-11-19T19:00:00.000000+00:00",
            updated_on: "2026-11-19T19:04:00.000000+00:00",
          },
        ],
      });
    return Response.json({ type: "error" }, { status: 404 });
  });
  const forge = new BitbucketForge(
    { kind: "bitbucket", host: "bitbucket.org", owner: "field-team", name: "field-notes", dir: "" },
    { token: async () => KEY, apiBaseUrl: API, fetch: fetcher },
  );
  return Object.assign(forge, { asked: () => fetcher.mock.calls.map(([input]) => String(input)) });
}

describe("the wakes' readings on Bitbucket", () => {
  it("names each sent comment's author, place and answer, leaving out deleted and draft ones", async () => {
    const forge = standIn({ [WRITER]: "write", [VISITOR]: "read" });
    expect(await forge.pullComments(7)).toEqual([
      { id: 501, kind: "comment", author: "visitor", relation: "cannot-write" },
      {
        id: 502,
        kind: "line",
        author: "maintainer",
        relation: "can-write",
        path: "src/notes.ts",
        line: 41,
      },
      {
        id: 503,
        kind: "line",
        author: "me",
        relation: "you",
        path: "src/notes.ts",
        line: 41,
        replyTo: 502,
      },
      { id: 504, kind: "comment", author: "ci-bot", relation: "bot" },
    ]);
  });

  it("reads only comments changed since the cursor", async () => {
    const forge = standIn({ [WRITER]: "admin" });
    const since = await forge.pullComments(7, "2026-11-19T18:15:00Z");
    expect(since.map((comment) => comment.id)).toEqual([503, 504]);
  });

  // The review of this task's live check: Bitbucket's pull request names no
  // last-changed time, so every reading reads the comment list; the account
  // and each author's permission are asked only for comments not yet read,
  // so a quiet reading spends one page of the hourly allowance.
  it("asks no account or permission for comments an earlier reading already read", async () => {
    const forge = standIn({ [WRITER]: "write", [VISITOR]: "read" });
    expect(await forge.pullComments(7, undefined, new Set([501, 502, 503, 504]))).toEqual([]);
    expect(forge.asked()).toEqual([`${API}${REPO}/pullrequests/7/comments?pagelen=100`]);
    const fresh = await forge.pullComments(7, undefined, new Set([501, 503, 504]));
    expect(fresh.map((comment) => [comment.id, comment.relation])).toEqual([[502, "can-write"]]);
    expect(forge.asked().filter((url) => url.includes("/permissions-config/"))).toEqual([
      `${API}${REPO}/permissions-config/users/${encodeURIComponent(WRITER)}`,
    ]);
  });

  it("counts an author as one who cannot write when Bitbucket refuses the permission read", async () => {
    const forge = standIn({});
    const read = await forge.pullComments(7);
    expect(read.find((comment) => comment.id === 502)?.relation).toBe("cannot-write");
  });

  it("reads main's head and the build statuses on it for the main-failure wake", async () => {
    const forge = standIn({});
    const { sha, checks } = await forge.branchChecks();
    expect(sha).toBe(MAIN);
    expect(checks.complete).toBe(true);
    expect(checks.items).toMatchObject([{ name: "Pipeline #58 for main", state: "failure" }]);
  });
});
