import type { CommentRelation } from "@shared/pullComments";
import type { ForgePullComment } from "../../forge";

/**
 * Bitbucket's pull request comments as the comment wake reads them
 * (`docs/forge.md`, "Comments on a pull request"). Bitbucket keeps one list:
 * a comment with `inline` is on a line of the change, any other is on the
 * conversation, and `parent` is the comment it answers. An approval carries
 * no words, so it is no comment. A deleted comment and a draft one
 * (`pending`) are left out. The words are read only to tell the app's own
 * story comment; they never leave this reader.
 */

/** The page size the list is read at: Bitbucket's largest. */
const PAGE = 100;

/** Pages read per reading; a pull request with more comments is read up to here. */
const PAGES = 10;

/** The marker the app's own story comment opens with (`presentationRegionMarkers`). */
const STORY_MARKER = "<!-- infinitary-story:";

/** The repository permissions that can push: Bitbucket folds every grant into these. */
const WRITE_ROLES = new Set(["write", "admin"]);

type User = {
  account_id?: string;
  nickname?: string;
  display_name?: string;
  /** `user`, or `app_user` for an app or bot account. */
  type?: string;
} | null;

type CommentJson = {
  id?: number;
  user?: User;
  content?: { raw?: string | null } | null;
  inline?: { path?: string; to?: number | null; from?: number | null } | null;
  parent?: { id?: number } | null;
  deleted?: boolean;
  pending?: boolean;
  updated_on?: string;
  created_on?: string;
};

type Get = (path: string) => Promise<unknown>;

/**
 * The comments changed at or after `since`, oldest first by id, leaving out
 * those in `seen`, which an earlier reading already read. `viewer` reads
 * the signed-in account's `account_id`, asked only when a comment is left
 * to describe, so a reading with nothing new costs the comment list alone.
 * Whether another author of a comment left to describe can write
 * is asked once per author through the repository's user permissions,
 * which only a repository admin may read: a refused lookup counts that
 * author as one who cannot write.
 */
export async function readBitbucketPullComments(
  get: Get,
  repositoryPath: string,
  number: number,
  viewerAccount: () => Promise<string>,
  since?: string,
  seen?: ReadonlySet<number>,
): Promise<ForgePullComment[]> {
  const rows: CommentJson[] = [];
  let link: string | undefined =
    `${repositoryPath}/pullrequests/${number}/comments?pagelen=${PAGE}`;
  for (let page = 0; link && page < PAGES; page++) {
    const read = (await get(link)) as { values?: CommentJson[]; next?: string } | null;
    rows.push(...(Array.isArray(read?.values) ? read.values : []));
    link = typeof read?.next === "string" && read.next ? read.next : undefined;
  }
  const sent = rows
    .filter((row) => Number.isSafeInteger(row.id) && !row.deleted && !row.pending)
    .filter((row) => {
      const changed = row.updated_on ?? row.created_on;
      return !since || (changed !== undefined && Date.parse(changed) >= Date.parse(since));
    })
    .filter((row) => !seen?.has(row.id as number))
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (sent.length === 0) return [];
  const viewer = await viewerAccount();
  const roles = await writeRoles(get, repositoryPath, sent, viewer);
  return sent.map((row) => {
    const user = row.user;
    const inline = row.inline;
    const line = inline?.to ?? inline?.from;
    return {
      id: row.id as number,
      kind: inline ? ("line" as const) : ("comment" as const),
      author: user?.nickname || user?.display_name || "",
      relation: relationOf(user, viewer, roles),
      ...(inline?.path ? { path: inline.path } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(typeof row.parent?.id === "number" ? { replyTo: row.parent.id } : {}),
      ...((row.content?.raw ?? "").includes(STORY_MARKER) ? { story: true as const } : {}),
    };
  });
}

function relationOf(
  user: User | undefined,
  viewer: string,
  roles: ReadonlyMap<string, boolean>,
): CommentRelation {
  if (user?.type === "app_user") return "bot";
  if (user?.account_id && user.account_id === viewer) return "you";
  return user?.account_id && roles.get(user.account_id) ? "can-write" : "cannot-write";
}

async function writeRoles(
  get: Get,
  repositoryPath: string,
  rows: CommentJson[],
  viewer: string,
): Promise<Map<string, boolean>> {
  const authors = new Set(
    rows.flatMap((row) =>
      row.user?.account_id && row.user.type !== "app_user" && row.user.account_id !== viewer
        ? [row.user.account_id]
        : [],
    ),
  );
  const roles = new Map<string, boolean>();
  await Promise.all(
    [...authors].map(async (account) => {
      try {
        const answer = (await get(
          `${repositoryPath}/permissions-config/users/${encodeURIComponent(account)}`,
        )) as { permission?: string } | null;
        if (typeof answer?.permission === "string")
          roles.set(account, WRITE_ROLES.has(answer.permission));
      } catch {
        // Only a repository admin may read another person's permission: that author counts as one who cannot write.
      }
    }),
  );
  return roles;
}
