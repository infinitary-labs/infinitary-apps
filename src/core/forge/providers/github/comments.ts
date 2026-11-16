import type { CommentRelation } from "@shared/pullComments";
import type { ForgePullComment } from "../../forge";

/** The page size each list is read at: GitHub's largest. */
const PAGE = 100;

/** The marker the app's own story comment opens with (`presentationRegionMarkers`). */
const STORY_MARKER = "<!-- infinitary-story:";

/** The associations GitHub gives a person the project may let write to it. */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The associations that do not settle it: an organization member or a
 * collaborator may hold only read or triage, so the reader asks GitHub for
 * that person's role on the project.
 */
const ASK_ROLE = new Set(["MEMBER", "COLLABORATOR"]);

/**
 * The permissions that can push to a project, as GitHub's `permission`
 * field folds every role, a custom one included, into admin, write, read or none.
 */
const WRITE_ROLES = new Set(["admin", "write"]);

type Author = { login?: string; type?: string } | null | undefined;

type CommentJson = {
  id: number;
  user?: Author;
  body?: string | null;
  author_association?: string;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  state?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
};

/**
 * Who wrote it, from the facts GitHub gives: a bot account, the signed-in
 * person, a writer the project names, or anyone else. `roles` holds the
 * role GitHub named for a member or collaborator; without one, the
 * association alone decides.
 */
function relationOf(
  user: Author,
  association: string | undefined,
  viewer: string,
  roles: ReadonlyMap<string, boolean>,
): CommentRelation {
  if (user?.type === "Bot") return "bot";
  if (user?.login && user.login.toLowerCase() === viewer.toLowerCase()) return "you";
  const writes = user?.login ? roles.get(user.login) : undefined;
  if (writes !== undefined) return writes ? "can-write" : "cannot-write";
  return WRITERS.has(association ?? "") ? "can-write" : "cannot-write";
}

/**
 * Whether each member or collaborator author can push to the project, asked
 * once per author per reading (`GET /collaborators/{login}/permission`); a
 * refused lookup leaves that author to the association.
 */
async function writeRoles(
  get: (path: string) => Promise<unknown>,
  repoPath: string,
  rows: CommentJson[],
  viewer: string,
): Promise<Map<string, boolean>> {
  const logins = new Set(
    rows.flatMap((row) =>
      row.user?.login &&
      row.user.type !== "Bot" &&
      row.user.login.toLowerCase() !== viewer.toLowerCase() &&
      ASK_ROLE.has(row.author_association ?? "")
        ? [row.user.login]
        : [],
    ),
  );
  const roles = new Map<string, boolean>();
  await Promise.all(
    [...logins].map(async (login) => {
      try {
        const answer = (await get(
          `${repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
        )) as { permission?: string } | null;
        const role = answer?.permission;
        if (typeof role === "string") roles.set(login, WRITE_ROLES.has(role));
      } catch {
        // GitHub refused the lookup: the association decides, as before.
      }
    }),
  );
  return roles;
}

async function pages(
  get: (path: string) => Promise<unknown>,
  path: string,
): Promise<CommentJson[]> {
  const rows: CommentJson[] = [];
  const join = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const answer = await get(`${path}${join}per_page=${PAGE}&page=${page}`);
    const list = Array.isArray(answer) ? (answer as CommentJson[]) : [];
    rows.push(...list);
    if (list.length < PAGE) return rows;
  }
}

/**
 * A pull request's conversation comments, line comments and reviews changed
 * at or after `since`, oldest first by id within each kind (docs/forge.md,
 * "Comments on a pull request"). The words are read only to tell the app's
 * own story comment and a review with none; they never leave this reader.
 */
export async function readPullComments(
  get: (path: string) => Promise<unknown>,
  repoPath: string,
  number: number,
  viewer: string,
  since?: string,
): Promise<ForgePullComment[]> {
  const after = since ? `?since=${encodeURIComponent(since)}` : "";
  const [comments, lines, reviews] = await Promise.all([
    pages(get, `${repoPath}/issues/${number}/comments${after}`),
    pages(get, `${repoPath}/pulls/${number}/comments${after}`),
    pages(get, `${repoPath}/pulls/${number}/reviews`),
  ]);
  // A review list takes no `since`: a review submitted before it was read before.
  const sent = reviews
    .filter((row) => !since || (row.submitted_at !== undefined && row.submitted_at >= since))
    .filter((row) => row.state !== "PENDING");
  const roles = await writeRoles(get, repoPath, [...comments, ...lines, ...sent], viewer);
  const author = (row: CommentJson) => ({
    id: row.id,
    author: row.user?.login ?? "",
    relation: relationOf(row.user, row.author_association, viewer, roles),
  });
  const story = (row: CommentJson) =>
    (row.body ?? "").includes(STORY_MARKER) ? { story: true as const } : {};
  return [
    ...comments.map((row) => ({ ...author(row), kind: "comment" as const, ...story(row) })),
    ...lines.map((row) => {
      const line = row.line ?? row.original_line;
      return {
        ...author(row),
        kind: "line" as const,
        ...(row.path ? { path: row.path } : {}),
        ...(typeof line === "number" ? { line } : {}),
        ...(row.in_reply_to_id !== undefined ? { replyTo: row.in_reply_to_id } : {}),
        ...(typeof row.pull_request_review_id === "number"
          ? { reviewId: row.pull_request_review_id }
          : {}),
      };
    }),
    ...sent.map((row) => ({
      ...author(row),
      kind: "review" as const,
      ...(!(row.body ?? "").trim() ? { empty: true as const } : {}),
    })),
  ];
}

/** The files one commit changes (`GET /commits/{sha}`), as GitHub lists them. */
export async function readCommitFiles(
  get: (path: string) => Promise<unknown>,
  repoPath: string,
  sha: string,
): Promise<string[]> {
  const answer = (await get(`${repoPath}/commits/${encodeURIComponent(sha)}`)) as {
    files?: { filename?: string }[];
  } | null;
  return (answer?.files ?? []).flatMap((file) => (file.filename ? [file.filename] : []));
}
