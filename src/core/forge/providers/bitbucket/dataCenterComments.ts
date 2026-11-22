import type { CommentRelation } from "@shared/pullComments";
import { type ForgeComment, ForgeError, type ForgePullComment } from "../../forge";

/**
 * Bitbucket Data Center's pull request comments as the comment wake and a
 * batch's own comments read them (`docs/forge.md`, "Comments on a pull
 * request"). Data Center lists a pull request's comments in its activity:
 * each comment activity carries the comment whole, its replies nested in
 * `comments`, and a comment on a line of the change names its file and line
 * in the activity's `commentAnchor`. A comment is listed again each time it
 * is edited, newest first, and a deleted one is named by a `DELETED`
 * activity. A draft comment (`PENDING`) is left out. The words are read
 * only to tell the app's own story comment; they never leave this reader.
 */

/** The page size the activity is read at. */
const PAGE = 100;

/** Pages read per reading; a pull request with more activity is read up to here. */
const PAGES = 10;

/** The marker the app's own story comment opens with (`presentationRegionMarkers`). */
const STORY_MARKER = "<!-- infinitary-story:";

/** The permissions that can push, on the repository or its project. */
const WRITE_PERMISSIONS = new Set(["REPO_WRITE", "REPO_ADMIN", "PROJECT_WRITE", "PROJECT_ADMIN"]);

type Author = {
  name?: string;
  slug?: string;
  displayName?: string;
  /** `NORMAL` for a person, `SERVICE` for an app or bot account. */
  type?: string;
} | null;

export type DataCenterCommentJson = {
  id?: number;
  version?: number;
  text?: string;
  author?: Author;
  state?: string;
  createdDate?: number;
  updatedDate?: number;
  comments?: DataCenterCommentJson[];
};

type ActivityJson = {
  action?: string;
  commentAction?: string;
  comment?: DataCenterCommentJson | null;
  commentAnchor?: { path?: string; line?: number } | null;
};

type Page = { values?: ActivityJson[]; isLastPage?: boolean; nextPageStart?: number } | null;

type Get = (path: string) => Promise<unknown>;

/** One comment as the activity left it: its root's anchor, and the comment it answers. */
export type ListedComment = {
  comment: DataCenterCommentJson & { id: number };
  anchor?: { path?: string; line?: number };
  parent?: number;
};

/**
 * Every comment on the pull request, newest reading of each, deleted and
 * draft ones left out; `complete` is false when the activity had more than
 * the page budget.
 */
export async function listDataCenterComments(
  get: Get,
  pullRequestPath: string,
): Promise<{ comments: ListedComment[]; complete: boolean }> {
  const activities: ActivityJson[] = [];
  let start: number | undefined = 0;
  for (let page = 0; start !== undefined && page < PAGES; page++) {
    const read = (await get(`${pullRequestPath}/activities?start=${start}&limit=${PAGE}`)) as Page;
    if (!Array.isArray(read?.values))
      throw new ForgeError("transient", "The pull request's activity could not be read.");
    activities.push(...read.values);
    start =
      read.isLastPage === false &&
      typeof read.nextPageStart === "number" &&
      read.nextPageStart > start
        ? read.nextPageStart
        : undefined;
  }
  const deleted = new Set<number>();
  const found = new Map<number, ListedComment>();
  const keep = (
    comment: DataCenterCommentJson,
    anchor: ListedComment["anchor"],
    parent?: number,
  ) => {
    if (typeof comment.id !== "number" || !Number.isSafeInteger(comment.id)) return;
    // Activities run newest first: the first reading of a comment is its newest.
    if (!found.has(comment.id))
      found.set(comment.id, {
        comment: comment as ListedComment["comment"],
        ...(anchor ? { anchor } : {}),
        ...(parent !== undefined ? { parent } : {}),
      });
    for (const reply of comment.comments ?? []) keep(reply, anchor, comment.id);
  };
  for (const activity of activities) {
    if (activity.action !== "COMMENTED" || !activity.comment) continue;
    if (activity.commentAction === "DELETED") {
      if (typeof activity.comment.id === "number") deleted.add(activity.comment.id);
      continue;
    }
    keep(activity.comment, activity.commentAnchor ?? undefined);
  }
  return {
    comments: [...found.values()].filter(
      ({ comment }) => !deleted.has(comment.id) && comment.state !== "PENDING",
    ),
    complete: start === undefined,
  };
}

/**
 * The comments changed at or after `since`, oldest first by id, leaving out
 * those in `seen`, which an earlier reading already read. `viewer` reads
 * the signed-in user's name, asked only when a comment is left to describe.
 * Whether another author can write is asked once per author through the
 * repository's and its project's user permissions, which only an admin may
 * read: a refused lookup counts that author as one who cannot write.
 */
export async function readDataCenterPullComments(
  get: Get,
  repositoryPath: string,
  projectPath: string,
  number: number,
  viewerName: () => Promise<string | null>,
  since?: string,
  seen?: ReadonlySet<number>,
): Promise<ForgePullComment[]> {
  const { comments } = await listDataCenterComments(
    get,
    `${repositoryPath}/pull-requests/${number}`,
  );
  const after = since ? Date.parse(since) : Number.NaN;
  const sent = comments
    .filter(({ comment }) => {
      const changed = comment.updatedDate ?? comment.createdDate;
      return Number.isNaN(after) || (changed !== undefined && changed >= after);
    })
    .filter(({ comment }) => !seen?.has(comment.id))
    .sort((a, b) => a.comment.id - b.comment.id);
  if (sent.length === 0) return [];
  const viewer = (await viewerName())?.toLowerCase() ?? null;
  const roles = await writeRoles(get, repositoryPath, projectPath, sent, viewer);
  return sent.map(({ comment, anchor, parent }) => {
    const author = comment.author;
    const line = anchor?.line;
    return {
      id: comment.id,
      kind: anchor?.path ? ("line" as const) : ("comment" as const),
      author: author?.name || author?.displayName || "",
      relation: relationOf(author, viewer, roles),
      ...(anchor?.path ? { path: anchor.path } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(parent !== undefined ? { replyTo: parent } : {}),
      ...((comment.text ?? "").includes(STORY_MARKER) ? { story: true as const } : {}),
    };
  });
}

/**
 * The signed-in user's comments on the conversation of the pull request
 * that open with `marker`, oldest first: the app's own comments that carry
 * a batch's stories past its description.
 */
export async function ownDataCenterComments(
  get: Get,
  pullRequestPath: string,
  viewerName: () => Promise<string | null>,
  marker: string,
): Promise<{ comments: ForgeComment[]; complete: boolean }> {
  const { comments, complete } = await listDataCenterComments(get, pullRequestPath);
  const viewer = (await viewerName())?.toLowerCase();
  if (!viewer) throw new ForgeError("transient", "The server did not name the signed-in user.");
  return {
    comments: comments
      .filter(
        ({ comment, anchor, parent }) =>
          !anchor?.path &&
          parent === undefined &&
          comment.author?.name?.toLowerCase() === viewer &&
          typeof comment.text === "string" &&
          comment.text.startsWith(marker),
      )
      .sort((a, b) => a.comment.id - b.comment.id)
      .map(({ comment }) => ({ id: comment.id, body: comment.text as string })),
    complete,
  };
}

function relationOf(
  author: Author | undefined,
  viewer: string | null,
  roles: ReadonlyMap<string, boolean>,
): CommentRelation {
  if (author?.type === "SERVICE") return "bot";
  const name = author?.name?.toLowerCase();
  if (name && name === viewer) return "you";
  return name && roles.get(name) ? "can-write" : "cannot-write";
}

async function writeRoles(
  get: Get,
  repositoryPath: string,
  projectPath: string,
  rows: ListedComment[],
  viewer: string | null,
): Promise<Map<string, boolean>> {
  const authors = new Set(
    rows.flatMap(({ comment }) => {
      const name = comment.author?.name?.toLowerCase();
      return name && comment.author?.type !== "SERVICE" && name !== viewer ? [name] : [];
    }),
  );
  const roles = new Map<string, boolean>();
  await Promise.all(
    [...authors].map(async (name) => {
      for (const place of [repositoryPath, projectPath]) {
        try {
          const answer = (await get(
            `${place}/permissions/users?filter=${encodeURIComponent(name)}&limit=25`,
          )) as { values?: { user?: { name?: string }; permission?: string }[] } | null;
          const grant = answer?.values?.find(
            (row) => row.user?.name?.toLowerCase() === name && typeof row.permission === "string",
          );
          if (grant && WRITE_PERMISSIONS.has(grant.permission as string)) {
            roles.set(name, true);
            return;
          }
        } catch {
          // Only an admin may read another person's permission: that author counts as one who cannot write.
        }
      }
    }),
  );
  return roles;
}
