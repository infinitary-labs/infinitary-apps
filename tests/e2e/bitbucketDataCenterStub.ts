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
 * A local stand-in for a Bitbucket Data Center server's REST API
 * (`/rest/...`), over real HTTP so the app runs its real token sign-in,
 * project listing, pull requests and merge against it. The app finds it
 * through `INFINITARY_BITBUCKET_DATA_CENTER_URL`, which only an unpackaged
 * app reads; no real server is ever asked.
 *
 * It answers the way Bitbucket Data Center 8.19's published REST API does
 * (docs/e2e-contracts.md, "Keep fixtures truthful"): its version without a
 * sign-in; a 401 naming an authentication exception for any token but the
 * one it accepts; the signed-in user in the `X-AUSERNAME` header; the
 * repositories the token may read, paged by `start` and `nextPageStart`; and
 * for the one repository the journeys deliver to, its pull requests. A pull
 * request names its head by the full commit id and carries a version that
 * goes up whenever its branch moves; a merge names the version it was read
 * at, and the server refuses an older one with a 409 naming
 * `PullRequestOutOfDateException`, merging nothing.
 */
export const DATA_CENTER_HOST = "bitbucket.example.com";
export const DATA_CENTER_KEY = "BBDC-NzE2MDk4ODQ0NTQ0OkxqZm1vY2tfdG9rZW5fZm9yX3Rlc3Q";
export const DATA_CENTER_LOGIN = "jane.doe";
/** The project the journeys deliver to, as Data Center names it: project key, then slug. */
export const DATA_CENTER_PROJECT = { key: "FLD", slug: "field-notes" };
/** Its clone address over HTTPS, as the server writes it without the user name. */
export const DATA_CENTER_ORIGIN = `https://${DATA_CENTER_HOST}/scm/fld/field-notes.git`;

/** A Data Center sign-in already made on the server, exactly where the app keeps one. */
export function seedDataCenterSignIn(userDataDir: string): void {
  const forges = join(userDataDir, "forges");
  mkdirSync(join(forges, DATA_CENTER_HOST), { recursive: true, mode: 0o700 });
  chmodSync(forges, 0o700);
  writeFileSync(
    join(forges, DATA_CENTER_HOST, "sign-in.json"),
    `${JSON.stringify({
      token: DATA_CENTER_KEY,
      scopes: [],
      login: DATA_CENTER_LOGIN,
      createdAt: 1,
      kind: "bitbucket",
      gitUser: DATA_CENTER_LOGIN,
    })}\n`,
    { mode: 0o600 },
  );
}

/** One build status a build server posted on a commit, as Data Center keeps it. */
export type DataCenterStatus = {
  key: string;
  name: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "CANCELLED";
};

/** A merge the server made: the pull request, the version and head it merged, and how. */
export type DataCenterMerge = {
  id: number;
  version: number;
  head: string;
  strategy: string;
  message: string;
};

type StubPullRequest = {
  id: number;
  version: number;
  branch: string;
  title: string;
  description: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  draft: boolean;
  /** The branch head the version was last moved for. */
  seenHead?: string;
  mergedHead?: string;
  mergeCommit?: string;
};

/** The commit the server writes for a squash of `head`: distinct per head. */
export function dataCenterMergeCommit(head: string): string {
  return createHash("sha1").update(`squash of ${head}`).digest("hex");
}

export async function startDataCenterStub() {
  const requests: string[] = [];
  let version = "8.19.4";
  const pullRequests = new Map<number, StubPullRequest>();
  let nextId = 1;
  const merges: DataCenterMerge[] = [];
  let gitOf: { head: (branch: string) => string; commit: (rev: string) => string } | null = null;
  let statuses: DataCenterStatus[] = [{ key: "build", name: "Build", state: "SUCCESSFUL" }];
  let onMergeRequest: () => void = () => {};
  const started = Date.now();
  const repositoryPath = `/rest/api/latest/projects/${DATA_CENTER_PROJECT.key}/repos/${DATA_CENTER_PROJECT.slug}`;
  const repository = {
    id: 12,
    slug: DATA_CENTER_PROJECT.slug,
    name: DATA_CENTER_PROJECT.slug,
    public: false,
    project: { key: DATA_CENTER_PROJECT.key, type: "NORMAL", name: "Field" },
    links: {
      clone: [
        {
          href: `https://${DATA_CENTER_LOGIN}@${DATA_CENTER_HOST}/scm/fld/field-notes.git`,
          name: "http",
        },
        { href: `ssh://git@${DATA_CENTER_HOST}:7999/fld/field-notes.git`, name: "ssh" },
      ],
      self: [{ href: `https://${DATA_CENTER_HOST}/projects/FLD/repos/field-notes/browse` }],
    },
  };
  const branchHead = (branch: string): string | undefined => {
    try {
      return gitOf?.head(branch);
    } catch {
      return undefined;
    }
  };
  /** A push to a pull request's branch moves its version, as Data Center rescopes it. */
  const rescope = (request: StubPullRequest) => {
    if (request.state !== "OPEN") return;
    const head = branchHead(request.branch);
    if (head && head !== request.seenHead) {
      if (request.seenHead) request.version++;
      request.seenHead = head;
    }
  };
  const ref = (branch: string, head: string | undefined) => ({
    id: `refs/heads/${branch}`,
    displayId: branch,
    latestCommit: head,
    repository,
  });
  const pullRequestJson = (request: StubPullRequest) => {
    rescope(request);
    const head = request.mergedHead ?? branchHead(request.branch);
    return {
      id: request.id,
      version: request.version,
      title: request.title,
      description: request.description,
      state: request.state,
      open: request.state === "OPEN",
      closed: request.state !== "OPEN",
      draft: request.draft,
      fromRef: ref(request.branch, head),
      toRef: ref("main", branchHead("main")),
      reviewers: [],
      links: {
        self: [
          {
            href: `https://${DATA_CENTER_HOST}/projects/FLD/repos/field-notes/pull-requests/${request.id}`,
          },
        ],
      },
      ...(request.mergeCommit ? { properties: { mergeCommit: { id: request.mergeCommit } } } : {}),
    };
  };
  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const page = <T>(values: T[]) => ({
    size: values.length,
    limit: 100,
    start: 0,
    isLastPage: true,
    values,
  });
  const error = (message: string, exceptionName: string) => ({
    errors: [{ context: null, message, exceptionName }],
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const path = url.pathname;
    const method = request.method ?? "GET";
    requests.push(`${method} ${path}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (method === "GET" && path === "/rest/api/latest/application-properties") {
      send(200, {
        version,
        buildNumber: version.replaceAll(".", "0"),
        buildDate: String(started),
        displayName: "Bitbucket",
      });
      return;
    }
    if (request.headers.authorization !== `Bearer ${DATA_CENTER_KEY}`) {
      send(
        401,
        error(
          "Authentication failed. Please check your credentials and try again.",
          "com.atlassian.bitbucket.auth.IncorrectPasswordAuthenticationException",
        ),
      );
      return;
    }
    const signedIn = { "X-AUSERNAME": DATA_CENTER_LOGIN };
    if (method === "GET" && path === "/rest/api/latest/users") {
      send(
        200,
        page([{ name: DATA_CENTER_LOGIN, slug: DATA_CENTER_LOGIN, type: "NORMAL" }]),
        signedIn,
      );
      return;
    }
    if (method === "GET" && path === "/rest/api/latest/repos") {
      send(200, page([repository]), signedIn);
      return;
    }
    const build = /^\/rest\/build-status\/latest\/commits\/([0-9a-f]{40})$/.exec(path);
    if (method === "GET" && build) {
      send(
        200,
        page(
          statuses.map((status, index) => ({
            ...status,
            url: `https://ci.example.com/${status.key}`,
            dateAdded: started + index,
          })),
        ),
      );
      return;
    }
    if (
      path === "/rest/branch-utils/latest/projects/FLD/repos/field-notes/branches" &&
      method === "DELETE"
    ) {
      send(204, undefined);
      return;
    }
    if (!path.startsWith(repositoryPath)) {
      send(
        404,
        error(
          "No such repository.",
          "com.atlassian.bitbucket.repository.NoSuchRepositoryException",
        ),
      );
      return;
    }
    const rest = path.slice(repositoryPath.length);
    if (method === "GET" && rest === "") return send(200, repository);
    if (method === "GET" && rest === "/default-branch")
      return send(200, {
        id: "refs/heads/main",
        displayId: "main",
        type: "BRANCH",
        isDefault: true,
      });
    if (method === "GET" && rest === "/settings/pull-requests")
      return send(200, {
        mergeConfig: {
          type: "DEFAULT",
          defaultStrategy: { id: "no-ff", enabled: true },
          strategies: [
            "no-ff",
            "ff",
            "ff-only",
            "rebase-no-ff",
            "rebase-ff-only",
            "squash",
            "squash-ff-only",
          ].map((id) => ({ id, enabled: true })),
        },
      });
    if (method === "GET" && rest === "/branches") {
      const filter = url.searchParams.get("filterText") ?? "";
      const head = branchHead(filter);
      return send(200, page(head ? [{ ...ref(filter, head), type: "BRANCH" }] : []));
    }
    const commit = /^\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (method === "GET" && commit) {
      try {
        const id = gitOf?.commit(commit[1] ?? "");
        if (id) return send(200, { id, displayId: id.slice(0, 11) });
      } catch {
        /* no such commit */
      }
      return send(
        404,
        error("No such commit.", "com.atlassian.bitbucket.commit.NoSuchCommitException"),
      );
    }
    if (rest === "/pull-requests" && method === "GET") {
      const at = url.searchParams.get("at");
      const open = [...pullRequests.values()].filter(
        (entry) => entry.state === "OPEN" && (!at || `refs/heads/${entry.branch}` === at),
      );
      return send(200, page(open.map(pullRequestJson)));
    }
    if (rest === "/pull-requests" && method === "POST") {
      const body = await readBody(request);
      const from = (body.fromRef as { id?: string } | undefined)?.id ?? "";
      const created: StubPullRequest = {
        id: nextId++,
        version: 0,
        branch: from.replace(/^refs\/heads\//, ""),
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
        state: "OPEN",
        draft: body.draft === true,
      };
      pullRequests.set(created.id, created);
      return send(201, pullRequestJson(created));
    }
    const one = /^\/pull-requests\/(\d+)(\/merge|\/decline|\/comments)?$/.exec(rest);
    const found = one ? pullRequests.get(Number(one[1])) : undefined;
    if (!one || !found)
      return send(
        404,
        error("No such pull request.", "com.atlassian.bitbucket.pull.NoSuchPullRequestException"),
      );
    const action = one[2];
    if (method === "GET" && !action) return send(200, pullRequestJson(found));
    if (method === "GET" && action === "/merge")
      return send(200, { canMerge: !found.draft, conflicted: false, outcome: "CLEAN", vetoes: [] });
    if (method === "PUT" && !action) {
      const body = await readBody(request);
      rescope(found);
      if (body.version !== found.version)
        return send(
          409,
          error(
            "You are attempting to modify a pull request based on out-of-date information.",
            "com.atlassian.bitbucket.pull.PullRequestOutOfDateException",
          ),
        );
      if (typeof body.title === "string") found.title = body.title;
      if (typeof body.description === "string") found.description = body.description;
      if (typeof body.draft === "boolean") found.draft = body.draft;
      found.version++;
      return send(200, pullRequestJson(found));
    }
    if (method === "POST" && action === "/merge") {
      const body = await readBody(request);
      onMergeRequest();
      rescope(found);
      const asked = Number(url.searchParams.get("version"));
      if (asked !== found.version || found.state !== "OPEN")
        return send(
          409,
          error(
            "You are attempting to modify a pull request based on out-of-date information.",
            "com.atlassian.bitbucket.pull.PullRequestOutOfDateException",
          ),
        );
      const head = branchHead(found.branch) ?? "";
      found.state = "MERGED";
      found.mergedHead = head;
      found.mergeCommit = dataCenterMergeCommit(head);
      found.version++;
      merges.push({
        id: found.id,
        version: asked,
        head,
        strategy: String(body.strategyId ?? ""),
        message: String(body.message ?? ""),
      });
      return send(200, pullRequestJson(found));
    }
    if (method === "POST" && action === "/decline") {
      found.state = "DECLINED";
      found.version++;
      return send(200, pullRequestJson(found));
    }
    if (method === "POST" && action === "/comments") return send(201, { id: 1, version: 0 });
    send(404, error("No such resource.", "com.atlassian.bitbucket.NoSuchEntityException"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    env: { INFINITARY_BITBUCKET_DATA_CENTER_URL: base },
    /** Every request, `METHOD /path` (query dropped). */
    requests: () => [...requests],
    /** Every merge the server made, in order; a refused one is only a request. */
    merges: () => [...merges],
    /** The version the server says it runs. */
    runs: (next: string) => {
      version = next;
    },
    /** The project's branches and commits where it lives, read from git there. */
    gitOf: (reader: { head: (branch: string) => string; commit: (rev: string) => string }) => {
      gitOf = reader;
    },
    setStatuses: (next: DataCenterStatus[]) => {
      statuses = next;
    },
    /** Runs when a merge arrives, before the server checks its version. */
    onMergeRequest: (apply: () => void) => {
      onMergeRequest = apply;
    },
    /** Open a pull request as a person would on the server's own page. */
    openPullRequest: (input: { branch: string; title: string; description?: string }) => {
      const created: StubPullRequest = {
        id: nextId++,
        version: 0,
        branch: input.branch,
        title: input.title,
        description: input.description ?? "",
        state: "OPEN",
        draft: false,
      };
      pullRequests.set(created.id, created);
      rescope(created);
      return created.id;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type DataCenterStub = Awaited<ReturnType<typeof startDataCenterStub>>;
