import { describe, expect, it } from "vitest";
import { readPullComments } from "./comments";

// Intent: INF-4445's approved plan - the comment wake names each comment's
// author relation (the signed-in person, a writer, anyone else, a bot) from
// GitHub's own facts, and marks the app's story comment and a review with no
// words so they wake nobody. The rows below are trimmed from GitHub's REST
// answers for issue comments, review comments and reviews. Review INF-4479's
// F4 (the captain's answer): a member or collaborator counts as a writer only
// when GitHub names a write, maintain or admin role on the project, and the
// association decides when GitHub refuses that lookup.

const user = (login: string, type: "User" | "Bot" = "User") => ({ login, id: 1, type });

const ISSUE_COMMENTS = [
  {
    id: 11,
    user: user("octo-owner"),
    author_association: "OWNER",
    body: "<!-- infinitary-story:task-1:start -->\n## Why\n...",
    created_at: "2026-11-15T16:00:00Z",
    updated_at: "2026-11-15T16:00:00Z",
  },
  {
    id: 12,
    user: user("drive-by"),
    author_association: "NONE",
    body: "Does this handle expired links?",
    created_at: "2026-11-15T16:30:00Z",
    updated_at: "2026-11-15T16:30:00Z",
  },
];
const REVIEW_COMMENTS = [
  {
    id: 21,
    pull_request_review_id: 31,
    user: user("maria-dev"),
    author_association: "MEMBER",
    body: "This throws when the invite is missing.",
    path: "src/invite.ts",
    line: 42,
    original_line: 40,
    created_at: "2026-11-15T16:40:00Z",
    updated_at: "2026-11-15T16:40:00Z",
  },
  {
    id: 22,
    pull_request_review_id: 32,
    in_reply_to_id: 21,
    user: user("Octo-Owner"),
    author_association: "OWNER",
    body: "Agreed.",
    path: "src/invite.ts",
    line: null,
    original_line: 40,
    created_at: "2026-11-15T16:45:00Z",
    updated_at: "2026-11-15T16:45:00Z",
  },
];
const REVIEWS = [
  {
    id: 30,
    user: user("lint-bot[bot]", "Bot"),
    author_association: "NONE",
    body: "Two style issues.",
    state: "COMMENTED",
    submitted_at: "2026-11-15T15:00:00Z",
  },
  {
    id: 31,
    user: user("maria-dev"),
    author_association: "MEMBER",
    body: "",
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-11-15T16:40:00Z",
  },
  {
    id: 33,
    user: user("helper"),
    author_association: "COLLABORATOR",
    body: "Looks right to me once the error page is decided.",
    state: "APPROVED",
    submitted_at: "2026-11-15T16:50:00Z",
  },
  { id: 34, user: user("maria-dev"), author_association: "MEMBER", body: "", state: "PENDING" },
  {
    id: 35,
    user: user("org-peer"),
    author_association: "MEMBER",
    body: "Please also cover the admin view.",
    state: "COMMENTED",
    submitted_at: "2026-11-15T16:55:00Z",
  },
  {
    id: 36,
    user: user("custom-dev"),
    author_association: "COLLABORATOR",
    body: "Ship it after the changelog line.",
    state: "COMMENTED",
    submitted_at: "2026-11-15T16:58:00Z",
  },
];
/** GitHub's collaborator permission answers; org-peer's lookup is refused. */
const ROLES: Record<string, { permission: string; role_name: string }> = {
  "maria-dev": { permission: "write", role_name: "write" },
  helper: { permission: "read", role_name: "triage" },
  // A custom role with write access: GitHub folds it to write.
  "custom-dev": { permission: "write", role_name: "release-manager" },
};

function github() {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const url = new URL(path, "https://api.github.invalid");
    const role = /^\/repos\/octo\/invites\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (role) {
      const answer = ROLES[decodeURIComponent(role[1] ?? "")];
      if (!answer) throw new Error("Must have push access to view collaborator permission.");
      return answer;
    }
    if (url.searchParams.get("page") !== "1") return [];
    if (url.pathname === "/repos/octo/invites/issues/12/comments") return ISSUE_COMMENTS;
    if (url.pathname === "/repos/octo/invites/pulls/12/comments") return REVIEW_COMMENTS;
    if (url.pathname === "/repos/octo/invites/pulls/12/reviews") return REVIEWS;
    throw new Error(`unexpected ${path}`);
  };
  return { asked, get };
}

describe("GitHub's comments on a pull request", () => {
  it("names each one's kind, relation and place, and marks the story comment and a wordless review", async () => {
    const { get } = github();
    const read = await readPullComments(get, "/repos/octo/invites", 12, "octo-owner");
    expect(read).toEqual([
      { id: 11, author: "octo-owner", relation: "you", kind: "comment", story: true },
      { id: 12, author: "drive-by", relation: "cannot-write", kind: "comment" },
      {
        id: 21,
        author: "maria-dev",
        relation: "can-write",
        kind: "line",
        path: "src/invite.ts",
        line: 42,
        reviewId: 31,
      },
      {
        id: 22,
        author: "Octo-Owner",
        relation: "you",
        kind: "line",
        path: "src/invite.ts",
        line: 40,
        replyTo: 21,
        reviewId: 32,
      },
      { id: 30, author: "lint-bot[bot]", relation: "bot", kind: "review" },
      { id: 31, author: "maria-dev", relation: "can-write", kind: "review", empty: true },
      { id: 33, author: "helper", relation: "cannot-write", kind: "review" },
      { id: 35, author: "org-peer", relation: "can-write", kind: "review" },
      { id: 36, author: "custom-dev", relation: "can-write", kind: "review" },
    ]);
  });

  it("asks only for what changed since the last reading, and leaves out reviews sent before it", async () => {
    const { asked, get } = github();
    const read = await readPullComments(
      get,
      "/repos/octo/invites",
      12,
      "octo-owner",
      "2026-11-15T16:00:00Z",
    );
    expect(asked).toEqual([
      "/repos/octo/invites/issues/12/comments?since=2026-11-15T16%3A00%3A00Z&per_page=100&page=1",
      "/repos/octo/invites/pulls/12/comments?since=2026-11-15T16%3A00%3A00Z&per_page=100&page=1",
      "/repos/octo/invites/pulls/12/reviews?per_page=100&page=1",
      // One role lookup per member or collaborator author of what this reading returns.
      "/repos/octo/invites/collaborators/maria-dev/permission",
      "/repos/octo/invites/collaborators/helper/permission",
      "/repos/octo/invites/collaborators/org-peer/permission",
      "/repos/octo/invites/collaborators/custom-dev/permission",
    ]);
    expect(read.filter((comment) => comment.kind === "review").map((review) => review.id)).toEqual([
      31, 33, 35, 36,
    ]);
  });
});
