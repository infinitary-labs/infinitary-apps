/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/forge/providers/bitbucket/
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * A local stand-in for Bitbucket Cloud's REST API (`/2.0`), over real HTTP
 * so the app runs its real token sign-in and project listing against it.
 * The app finds it through `INFINITARY_BITBUCKET_API_URL`, which only an
 * unpackaged app reads; no real account is ever asked.
 *
 * It answers the way Bitbucket does (docs/e2e-contracts.md, "Keep
 * fixtures truthful"): the account for the one token it accepts and a
 * 401 for any other, Bitbucket's answer to a revoked token; the account's workspaces; each workspace's repositories,
 * newest first, paged by an absolute `next` link on the same API; and one
 * repository by `workspace/name`, with a 404 for any other.
 *
 * For the project the journeys deliver to (`BITBUCKET_STUB_PROJECT`) it
 * also answers the pull request calls (`docs/forge.md`, "Bitbucket pull
 * requests") as Bitbucket's published API does: a pull request names its
 * head by a short commit id, a branch and a commit read name the full one;
 * a pull request's build statuses are those on its head commit; its
 * mergeability checks report a Git conflict; and a merge takes no version,
 * merging whatever the branch holds when it arrives, refusing a conflict
 * with 400 and answering the merged pull request otherwise. A branch names
 * the merge strategies its pull requests may use; with a merge queue on, a
 * merge answers 202 with its task's link and the pull request reads
 * `queued` until the queue merges or removes it; the app's own comments are
 * kept, listed, replaced and deleted; and a deleted branch is gone.
 */
export const BITBUCKET_STUB_KEY = "ATATT3xFfGF0hermetic_sign-in-key=0A1B2C3D";
/** The token the person makes after revoking the first one. */
export const BITBUCKET_STUB_NEW_KEY = "ATATT3xFfGF0hermetic_second-key=4E5F6A7B";
export const BITBUCKET_STUB_LOGIN = "octo";
/** The project the journey clones, in the second workspace's second page. */
export const BITBUCKET_STUB_PROJECT = "field-team/field-notes";

const WORKSPACES = ["octo", "field-team", "archive"];
/** An old workspace with more pages than Add project's listing reads. */
const ARCHIVE_PAGES = 12;
/**
 * The archive's oldest repository, on its last page: the listing stops
 * before it, so the journey adds it by its link.
 */
export const BITBUCKET_STUB_UNLISTED = `archive/old-${ARCHIVE_PAGES}`;
/** Each workspace's repositories, newest first, as Bitbucket lists them. */
const REPOSITORIES: Record<string, { name: string; updated: string; isPrivate: boolean }[][]> = {
  octo: [[{ name: "dotfiles", updated: "2026-11-12T09:30:00.000000+00:00", isPrivate: false }]],
  "field-team": [
    [{ name: "survey-app", updated: "2026-11-14T16:05:00.000000+00:00", isPrivate: true }],
    [{ name: "field-notes", updated: "2026-11-10T11:20:00.000000+00:00", isPrivate: true }],
  ],
  archive: Array.from({ length: ARCHIVE_PAGES }, (_, index) => [
    {
      name: `old-${index + 1}`,
      // Newest first, as Bitbucket sorts by `-updated_on`: one day older per page.
      updated: `2025-10-${String(ARCHIVE_PAGES + 10 - index).padStart(2, "0")}T08:00:00.000000+00:00`,
      isPrivate: true,
    },
  ]),
};

/** A Bitbucket key sign-in already made on bitbucket.org, exactly where the app keeps one. */
export function seedBitbucketSignIn(userDataDir: string): void {
  const forges = join(userDataDir, "forges");
  mkdirSync(join(forges, "bitbucket.org"), { recursive: true, mode: 0o700 });
  chmodSync(forges, 0o700);
  writeFileSync(
    join(forges, "bitbucket.org", "sign-in.json"),
    `${JSON.stringify({
      token: BITBUCKET_STUB_KEY,
      scopes: [],
      login: BITBUCKET_STUB_LOGIN,
      createdAt: 1,
      kind: "bitbucket",
      gitUser: "x-bitbucket-api-token-auth",
    })}\n`,
    { mode: 0o600 },
  );
}

/** One build status a check service posted on a commit, as Bitbucket keeps it. */
export type BitbucketStubStatus = {
  key: string;
  name: string;
  /** `SUCCESSFUL`, `FAILED`, `INPROGRESS` or `STOPPED`. */
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
};

/** A merge Bitbucket made: the pull request, the version it merged, and how. */
export type BitbucketStubMerge = {
  id: number;
  head: string;
  strategy: string;
  message: string;
};

/** Every merge strategy Bitbucket names, each allowed on a new repository's main branch. */
const EVERY_STRATEGY = [
  "merge_commit",
  "squash",
  "fast_forward",
  "squash_fast_forward",
  "rebase_fast_forward",
  "rebase_merge",
];

/** The signed-in account's id, which every comment it writes carries. */
const ACCOUNT_ID = "557058:00000000-0000-0000-0000-000000000000";

type StubComment = { id: number; raw: string; deleted: boolean };

type StubPullRequest = {
  id: number;
  branch: string;
  title: string;
  description: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  draft: boolean;
  /** The merge queue holds it, with the merge it was asked for. */
  queued?: { strategy: string; message: string };
  /** The queue removed it without merging. */
  removed?: boolean;
  comments: StubComment[];
  /** The version it merged, once merged. */
  mergedHead?: string;
  mergeCommit?: string;
};

/** The commit Bitbucket writes for a squash of `head`: distinct per head. */
export function bitbucketMergeCommit(head: string): string {
  return createHash("sha1").update(`squash of ${head}`).digest("hex");
}

export async function startBitbucketStub() {
  const requests: string[] = [];
  let base = "";
  let accepted = BITBUCKET_STUB_KEY;
  const pullRequests = new Map<number, StubPullRequest>();
  let nextId = 1;
  const merges: BitbucketStubMerge[] = [];
  /** The project's branches and commits, as git holds them where it lives. */
  let gitOf: { head: (branch: string) => string; commit: (rev: string) => string } | null = null;
  /** The build status every commit carries unless a test names others: one that passed. */
  let statuses: BitbucketStubStatus[] = [{ key: "build", name: "Build", state: "SUCCESSFUL" }];
  let conflicted = false;
  /** A rule on main that wants an approval this pull request lacks, which an owner's sign-in may still merge past. */
  let approvalRequired = false;
  /** Bitbucket answers a merge 202 and is still merging it in the background. */
  let mergesLater = false;
  /** Main's merge strategies. */
  let strategies = EVERY_STRATEGY;
  /** Main has Bitbucket's merge queue: a merge request joins it. */
  let queueOn = false;
  /** Each pull request's own build statuses on its head, newest last, by its number; one naming a head holds only for that version. */
  const pullStatuses = new Map<number, { head?: string; statuses: BitbucketStubStatus[] }[]>();
  /** Writes each merge on main as Bitbucket does, answering the commit it wrote. */
  let onMerged: ((merge: BitbucketStubMerge) => string) | null = null;
  let onBranchDelete: (branch: string) => void = () => {};
  const deletedBranches: string[] = [];
  let commentId = 100;
  let onMergeRequest: () => void = () => {};
  let onBranchRead: (branch: string) => void = () => {};
  const started = new Date().toISOString();
  const repository = (
    workspace: string,
    row: { name: string; updated: string; isPrivate: boolean },
  ) => ({
    type: "repository",
    full_name: `${workspace}/${row.name}`,
    name: row.name,
    // Bitbucket names a repository by a UUID; each one here is its name's.
    uuid: `{${createHash("sha1").update(`${workspace}/${row.name}`).digest("hex").slice(0, 8)}-0000-4000-8000-000000000000}`,
    mainbranch: { type: "branch", name: "main" },
    is_private: row.isPrivate,
    updated_on: row.updated,
    links: {
      html: { href: `https://bitbucket.org/${workspace}/${row.name}` },
      clone: [
        {
          name: "https",
          href: `https://${BITBUCKET_STUB_LOGIN}@bitbucket.org/${workspace}/${row.name}.git`,
        },
        { name: "ssh", href: `git@bitbucket.org:${workspace}/${row.name}.git` },
      ],
    },
  });
  const branchHead = (branch: string): string | undefined => {
    try {
      return gitOf?.head(branch);
    } catch {
      return undefined;
    }
  };
  /** A commit's full id from any id of it, short or full, or undefined. */
  const fullCommit = (rev: string): string | undefined => {
    if (!/^[0-9a-f]{7,40}$/.test(rev)) return undefined;
    for (const request of pullRequests.values())
      if (request.mergeCommit?.startsWith(rev)) return request.mergeCommit;
    try {
      return gitOf?.commit(rev);
    } catch {
      return undefined;
    }
  };
  const headOfRequest = (request: StubPullRequest) =>
    request.mergedHead ?? branchHead(request.branch);
  const pullRequestJson = (request: StubPullRequest) => {
    const head = headOfRequest(request);
    return {
      type: "pullrequest",
      id: request.id,
      title: request.title,
      description: request.description,
      summary: { raw: request.description, markup: "markdown" },
      state: request.state,
      draft: request.draft,
      queued: request.queued !== undefined,
      source: {
        branch: { name: request.branch },
        // Bitbucket names a pull request's commits by their short id.
        commit: head ? { type: "commit", hash: head.slice(0, 12) } : null,
        repository: { type: "repository", full_name: BITBUCKET_STUB_PROJECT },
      },
      destination: {
        branch: { name: "main" },
        repository: { type: "repository", full_name: BITBUCKET_STUB_PROJECT },
      },
      merge_commit: request.mergeCommit ? { hash: request.mergeCommit.slice(0, 12) } : null,
      close_source_branch: false,
      updated_on: new Date(Date.UTC(2026, 10, 18, 12, request.id)).toISOString(),
      links: {
        html: {
          href: `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}/pull-requests/${request.id}`,
        },
      },
    };
  };
  /** A comment as Bitbucket lists it: every one here is the signed-in account's. */
  const commentJson = (comment: StubComment) => ({
    type: "pullrequest_comment",
    id: comment.id,
    deleted: comment.deleted,
    content: { raw: comment.raw, markup: "markdown" },
    user: { type: "user", account_id: ACCOUNT_ID },
  });
  /** Bitbucket merges whatever the branch holds when the merge is made. */
  const mergeNow = (request: StubPullRequest, head: string, strategy: string, message: string) => {
    const merge = { id: request.id, head, strategy, message };
    merges.push(merge);
    request.state = "MERGED";
    request.queued = undefined;
    request.mergedHead = head;
    request.mergeCommit = onMerged ? onMerged(merge) : bitbucketMergeCommit(head);
  };
  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });
  /** The project's own pull request calls; false for a path it does not answer. */
  const answerProject = (
    method: string,
    rest: string,
    url: URL,
    body: Record<string, unknown>,
    send: (status: number, answer: unknown, headers?: Record<string, string>) => void,
  ): boolean => {
    const notFound = () => send(404, { type: "error", error: { message: "Resource not found" } });
    const branchRead = /^\/refs\/branches\/(.+)$/.exec(rest);
    if (method === "GET" && branchRead) {
      const branch = decodeURIComponent(branchRead[1] ?? "");
      onBranchRead(branch);
      const head = branchHead(branch);
      if (!head) notFound();
      else
        send(200, {
          type: "branch",
          name: branch,
          target: { type: "commit", hash: head },
          merge_strategies: strategies,
          default_merge_strategy: strategies[0],
        });
      return true;
    }
    if (method === "DELETE" && branchRead) {
      const branch = decodeURIComponent(branchRead[1] ?? "");
      if (!branchHead(branch)) notFound();
      else {
        onBranchDelete(branch);
        deletedBranches.push(branch);
        send(204, null);
      }
      return true;
    }
    const commitRead = /^\/commit\/([^/]+)(\/statuses)?$/.exec(rest);
    if (method === "GET" && commitRead) {
      const full = fullCommit(decodeURIComponent(commitRead[1] ?? ""));
      if (!full) notFound();
      else if (!commitRead[2]) send(200, { type: "commit", hash: full });
      else {
        // A pull request's own builds run on its head; every other commit carries the usual ones.
        const own = [...pullRequests.values()]
          .filter((request) => headOfRequest(request) === full)
          .flatMap((request) => pullStatuses.get(request.id) ?? [])
          .filter((entry) => entry.head === undefined || entry.head === full)
          .at(-1);
        const posted = own ? own.statuses : statuses;
        send(200, {
          pagelen: 100,
          page: 1,
          size: posted.length,
          values: posted.map((status) => ({
            type: "build",
            ...status,
            url: `https://bitbucket.org/${BITBUCKET_STUB_PROJECT}/pipelines/results/1`,
            refname: null,
            // Each status was posted as the stand-in started, as a build that just ran.
            created_on: started,
            updated_on: started,
          })),
        });
      }
      return true;
    }
    if (method === "POST" && rest === "/pullrequests") {
      const source = body.source as { branch?: { name?: unknown } } | undefined;
      const branch = String(source?.branch?.name ?? "");
      if (!branchHead(branch)) {
        send(400, { type: "error", error: { message: `${branch}: branch not found` } });
        return true;
      }
      const request: StubPullRequest = {
        id: nextId++,
        branch,
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        state: "OPEN",
        draft: body.draft === true,
        comments: [],
      };
      pullRequests.set(request.id, request);
      send(201, pullRequestJson(request));
      return true;
    }
    if (method === "GET" && rest === "/pullrequests") {
      const state = url.searchParams.get("state");
      const branch = /source\.branch\.name="((?:[^"\\]|\\.)*)"/.exec(
        url.searchParams.get("q") ?? "",
      );
      send(200, {
        pagelen: 50,
        page: 1,
        values: [...pullRequests.values()]
          .filter(
            (request) =>
              (!state || request.state === state) &&
              (!branch || request.branch === branch[1]?.replace(/\\(.)/g, "$1")),
          )
          .sort((a, b) => b.id - a.id)
          .map(pullRequestJson),
      });
      return true;
    }
    const numbered =
      /^\/pullrequests\/(\d+)(\/merge\/task-status\/[^/]+|\/merge|\/decline|\/comments(?:\/\d+)?|\/mergeability\/checks)?$/.exec(
        rest,
      );
    if (!numbered) return false;
    const request = pullRequests.get(Number(numbered[1]));
    if (!request) {
      notFound();
      return true;
    }
    const part = numbered[2];
    if (method === "GET" && part === undefined) send(200, pullRequestJson(request));
    else if (method === "PUT" && part === undefined) {
      if (typeof body.title === "string") request.title = body.title;
      if (typeof body.description === "string") request.description = body.description;
      if (typeof body.draft === "boolean") request.draft = body.draft;
      send(200, pullRequestJson(request));
    } else if (method === "GET" && part === "/mergeability/checks") {
      send(200, {
        values: [
          ...(approvalRequired
            ? [
                {
                  type: "standard_merge_check",
                  status: "FAILED",
                  required: true,
                  blocking: true,
                  check: { kind: "minimum_approvals" },
                },
              ]
            : []),
          conflicted
            ? {
                type: "git_mergeability_check",
                status: "FAILED",
                required: true,
                blocking: true,
                reason: "conflicts",
              }
            : {
                type: "git_mergeability_check",
                status: "PASSED",
                required: true,
                blocking: false,
                reason: "clean",
              },
        ],
      });
    } else if (method === "GET" && part?.startsWith("/merge/task-status/")) {
      // Bitbucket's word on a merge it took with a 202.
      if (request.state === "MERGED")
        send(200, { task_status: "SUCCESS", merge_result: pullRequestJson(request) });
      else if (request.queued)
        send(200, {
          task_status: "PENDING",
          queued_pullrequest: { type: "queued_pullrequest", status: "QUEUED", rank: 1 },
        });
      else if (request.removed)
        send(400, {
          type: "error",
          error: { message: "The pull request left the merge queue without merging." },
        });
      else send(200, { task_status: "PENDING" });
    } else if (method === "POST" && part === "/merge") {
      onMergeRequest();
      const head = headOfRequest(request);
      const taskLink = { location: `${url.pathname}/task-status/queue-${request.id}` };
      if (request.queued) {
        // Asked again while queued: the same link, and nothing new.
        send(202, null, taskLink);
      } else if (request.state !== "OPEN" || !head) {
        send(400, { type: "error", error: { message: "This pull request is already closed." } });
      } else if (conflicted) {
        send(400, {
          type: "error",
          error: { message: "You can't merge until you resolve all merge conflicts." },
        });
      } else if (mergesLater) {
        // The merge runs in the background: the pull request stays open for
        // now, and the Location names the task to ask about it.
        send(202, null, { location: `${url.pathname}/task-status/merge-1` });
      } else if (queueOn) {
        // The merge queue takes it, with the merge it was asked for.
        request.queued = {
          strategy: String(body.merge_strategy ?? "merge_commit"),
          message: String(body.message ?? ""),
        };
        request.removed = false;
        send(202, null, taskLink);
      } else {
        mergeNow(
          request,
          head,
          String(body.merge_strategy ?? "merge_commit"),
          String(body.message ?? ""),
        );
        send(200, pullRequestJson(request));
      }
    } else if (method === "POST" && part === "/decline") {
      request.state = "DECLINED";
      send(200, pullRequestJson(request));
    } else if (method === "POST" && part === "/comments") {
      const raw = String((body.content as { raw?: unknown } | undefined)?.raw ?? "");
      const comment = { id: ++commentId, raw, deleted: false };
      request.comments.push(comment);
      send(201, commentJson(comment));
    } else if (method === "GET" && part === "/comments") {
      send(200, { pagelen: 100, page: 1, values: request.comments.map(commentJson) });
    } else if (part?.startsWith("/comments/") && (method === "PUT" || method === "DELETE")) {
      const comment = request.comments.find(
        (each) => each.id === Number(part.slice("/comments/".length)) && !each.deleted,
      );
      if (!comment) notFound();
      else if (method === "PUT") {
        comment.raw = String((body.content as { raw?: unknown } | undefined)?.raw ?? "");
        send(200, commentJson(comment));
      } else {
        comment.deleted = true;
        send(204, null);
      }
    } else notFound();
    return true;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const body = method === "GET" ? {} : await read(req);
    const send = (status: number, answer: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(answer === null ? "" : JSON.stringify(answer));
    };
    if (req.headers.authorization !== `Bearer ${accepted}`) {
      send(401, {
        type: "error",
        error: { message: "Token is invalid, expired, or not supported for this endpoint." },
      });
      return;
    }
    const path = url.pathname.replace(/^\/2\.0/, "");
    const page = Number(url.searchParams.get("page") ?? "1");
    if (method === "GET" && path === "/user") {
      send(200, {
        type: "user",
        display_name: "Octo Cat",
        nickname: BITBUCKET_STUB_LOGIN,
        account_id: ACCOUNT_ID,
        uuid: "{00000000-0000-0000-0000-000000000001}",
      });
      return;
    }
    if (method === "GET" && path === "/user/workspaces") {
      send(200, {
        pagelen: 100,
        page: 1,
        size: WORKSPACES.length,
        values: WORKSPACES.map((slug) => ({
          type: "workspace_access",
          workspace: { type: "workspace", slug, name: slug },
        })),
      });
      return;
    }
    const project = `/repositories/${BITBUCKET_STUB_PROJECT}`;
    const rest = path.startsWith(`${project}/`) ? path.slice(project.length) : undefined;
    if (rest !== undefined && answerProject(method, rest, url, body, send)) return;
    const listing = /^\/repositories\/([^/]+)$/.exec(path);
    if (method === "GET" && listing) {
      const pages = REPOSITORIES[decodeURIComponent(listing[1] ?? "")];
      if (!pages) {
        send(404, { type: "error", error: { message: "No workspace with identifier" } });
        return;
      }
      const workspace = decodeURIComponent(listing[1] ?? "");
      const rows = pages[page - 1] ?? [];
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      send(200, {
        pagelen: 100,
        page,
        values: rows.map((row) => repository(workspace, row)),
        ...(page < pages.length ? { next: `${base}${path}${next.search}` } : {}),
      });
      return;
    }
    const one = /^\/repositories\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const workspace = decodeURIComponent(one[1] ?? "");
      const row = (REPOSITORIES[workspace] ?? [])
        .flat()
        .find((entry) => entry.name === decodeURIComponent(one[2] ?? ""));
      if (row) send(200, repository(workspace, row));
      else send(404, { type: "error", error: { message: "Repository not found" } });
      return;
    }
    send(404, { type: "error", error: { message: "Resource not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/2.0`;
  return {
    env: { INFINITARY_BITBUCKET_API_URL: base },
    /** Every request, `METHOD /path` (query dropped). */
    requests: () => [...requests],
    /** Every merge Bitbucket made, in order; a refused one is only a request. */
    merges: () => [...merges],
    /** Each pull request's description as Bitbucket holds it now, by its number. */
    descriptions: () =>
      new Map([...pullRequests.values()].map((request) => [request.id, request.description])),
    /** The project's branches and commits where it lives, read from git there. */
    gitOf: (reader: { head: (branch: string) => string; commit: (rev: string) => string }) => {
      gitOf = reader;
    },
    /** The build statuses every commit carries. */
    setStatuses: (next: BitbucketStubStatus[]) => {
      statuses = next;
    },
    /** Whether the pull requests conflict with newer work on main. */
    conflicts: (on: boolean) => {
      conflicted = on;
    },
    /** Whether main's rules want an approval the pull requests lack. */
    requireApproval: (on: boolean) => {
      approvalRequired = on;
    },
    /** Turn an open pull request into a draft, as its author would on its page. */
    markDraft: (id: number) => {
      const request = pullRequests.get(id);
      if (request) request.draft = true;
    },
    /** Whether Bitbucket answers a merge 202 and finishes it later. */
    mergeLater: (on: boolean) => {
      mergesLater = on;
    },
    /** Runs when a merge arrives, before Bitbucket reads the branch it merges. */
    onMergeRequest: (apply: () => void) => {
      onMergeRequest = apply;
    },
    /** Runs when a branch is read, before Bitbucket answers its head. */
    onBranchRead: (apply: (branch: string) => void) => {
      onBranchRead = apply;
    },
    /** Open a pull request as a person would on Bitbucket's own page. */
    openPullRequest: (input: {
      branch: string;
      title: string;
      description?: string;
      draft?: boolean;
    }) => {
      const request: StubPullRequest = {
        id: nextId++,
        branch: input.branch,
        title: input.title,
        description: input.description ?? "",
        state: "OPEN",
        draft: input.draft === true,
        comments: [],
      };
      pullRequests.set(request.id, request);
      return request.id;
    },
    /** Main's merge strategies, as its branch settings allow them. */
    setMergeStrategies: (next: string[]) => {
      strategies = next;
    },
    /** One pull request's own build statuses on its head, by its number; with a head, only on that version. */
    setPullRequestStatuses: (id: number, next: BitbucketStubStatus[], head?: string) => {
      pullStatuses.set(id, [
        ...(pullStatuses.get(id) ?? []),
        { ...(head ? { head } : {}), statuses: next },
      ]);
    },
    /** Write each merge on main as Bitbucket does, answering the commit it wrote. */
    onMerged: (write: (merge: BitbucketStubMerge) => string) => {
      onMerged = write;
    },
    onBranchDelete: (apply: (branch: string) => void) => {
      onBranchDelete = apply;
    },
    /** The branches the app deleted, in order. */
    deletedBranches: () => [...deletedBranches],
    /** Whether main has Bitbucket's merge queue. */
    mergeQueue: (on: boolean) => {
      queueOn = on;
    },
    /** The pull requests the merge queue holds now, by number. */
    queued: () =>
      [...pullRequests.values()].filter((request) => request.queued).map((request) => request.id),
    /** The merge queue merges a pull request it holds, with the merge it was asked for. */
    landQueued: (id: number) => {
      const request = pullRequests.get(id);
      const head = request ? headOfRequest(request) : undefined;
      if (!request?.queued || !head) throw new Error(`The merge queue does not hold #${id}.`);
      mergeNow(request, head, request.queued.strategy, request.queued.message);
    },
    /** The merge queue removes a pull request it holds without merging it. */
    removeQueued: (id: number) => {
      const request = pullRequests.get(id);
      if (request?.queued) {
        request.queued = undefined;
        request.removed = true;
      }
    },
    /** Each pull request as Bitbucket holds it now, oldest first. */
    pullRequests: () =>
      [...pullRequests.values()].map(({ id, branch, title, description, state }) => ({
        id,
        branch,
        title,
        description,
        state,
      })),
    /** The person revoked the first token and made a new one: only that one is accepted now. */
    revokeFirstKey: () => {
      accepted = BITBUCKET_STUB_NEW_KEY;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type BitbucketStub = Awaited<ReturnType<typeof startBitbucketStub>>;
