import { describe, expect, it, vi } from "vitest";
import { readBitbucketOpenChanges } from "./changes";

// The task's intent (the captain's "adding bitbucket as another forge
// integration just like github and gitlab, reaching parity as much as
// possible"; its plan's piece 4): the open pull requests panel lists the
// person's open Bitbucket pull requests across their workspaces, newest
// first, each with its checks. Answers follow Bitbucket's published shapes:
// workspace access entries, the per-workspace pull request list for an
// account, and a pull request's build statuses.
const API = "https://api.bitbucket.org/2.0";
const KEY = "ATATT3xFfGF0disposable_test-key=0A1B2C3D";
const ME = "557058:6f1c2a9b-e07d-4c55-a1e8-b2f06d9c4a7e";
const FIELDS =
  "values.id,values.title,values.draft,values.updated_on,values.destination.repository.full_name,values.links.html.href";

function pullRequest(repo: string, id: number, updated: string, draft = false) {
  return {
    id,
    title: `fix: field note ${id}`,
    draft,
    updated_on: updated,
    destination: { repository: { full_name: repo } },
    links: { html: { href: `https://bitbucket.org/${repo}/pull-requests/${id}` } },
  };
}

function standIn(statuses: Record<string, string[]>, refuse?: string) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/2\.0/, "") + url.search;
    if (path === "/user?fields=account_id") return Response.json({ account_id: ME });
    if (path === "/user/workspaces?pagelen=100&fields=next,values.workspace.slug")
      return Response.json({
        values: [{ workspace: { slug: "field-team" } }, { workspace: { slug: "mapping" } }],
      });
    const listed = `/pullrequests/${encodeURIComponent(ME)}?state=OPEN&pagelen=20&fields=${FIELDS}`;
    if (path === `/workspaces/field-team${listed}`)
      return Response.json({
        values: [pullRequest("field-team/field-notes", 7, "2026-11-19T10:00:00.000000+00:00")],
      });
    if (path === `/workspaces/mapping${listed}`)
      return refuse === "mapping"
        ? Response.json({ type: "error" }, { status: 500 })
        : Response.json({
            values: [
              pullRequest("mapping/tiles", 3, "2026-11-19T12:00:00.000000+00:00", true),
              pullRequest("mapping/legend", 9, "2026-11-18T08:00:00.000000+00:00"),
            ],
          });
    const status = /^\/repositories\/([^/]+\/[^/]+)\/pullrequests\/(\d+)\/statuses/.exec(
      url.pathname.replace(/^\/2\.0/, ""),
    );
    if (status)
      return Response.json({
        values: (statuses[`${status[1]}#${status[2]}`] ?? []).map((state) => ({ state })),
      });
    return Response.json({ type: "error" }, { status: 404 });
  });
  return readBitbucketOpenChanges({
    host: "bitbucket.org",
    token: async () => KEY,
    apiBaseUrl: API,
    fetch: fetcher,
  });
}

describe("the open pull requests panel on Bitbucket", () => {
  it("lists the person's open pull requests across workspaces, newest first, each with its checks", async () => {
    const rows = await standIn({
      "field-team/field-notes#7": ["SUCCESSFUL", "INPROGRESS"],
      "mapping/tiles#3": ["SUCCESSFUL", "FAILED"],
      "mapping/legend#9": ["SUCCESSFUL"],
    });
    expect(rows).toEqual([
      {
        host: "bitbucket.org",
        project: "mapping/tiles",
        number: 3,
        label: "#3",
        title: "fix: field note 3",
        url: "https://bitbucket.org/mapping/tiles/pull-requests/3",
        draft: true,
        checks: "failed",
        updatedAt: "2026-11-19T12:00:00.000000+00:00",
      },
      expect.objectContaining({ project: "field-team/field-notes", number: 7, checks: "pending" }),
      expect.objectContaining({ project: "mapping/legend", number: 9, checks: "passed" }),
    ]);
  });

  it("reads a pull request with no build status as no checks", async () => {
    const rows = await standIn({});
    expect(rows.map((row) => row.checks)).toEqual(["none", "none", "none"]);
  });

  it("fails the whole host when one workspace cannot be read, never showing part of it", async () => {
    await expect(standIn({}, "mapping")).rejects.toThrow();
  });
});
