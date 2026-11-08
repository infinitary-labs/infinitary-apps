/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/forge/providers/github/
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * A local stand-in for GitHub (git integration PR 1.2), in the shape of the
 * quota sensor's vendor stubs: the REST calls the forge makes and GitHub's
 * device flow, served over real HTTP so the app runs its real forge, its
 * real sign-in service and its real health read against it. The app finds
 * it through `INFINITARY_GITHUB_API_URL` and `INFINITARY_GITHUB_OAUTH_URL`, which
 * only an unpackaged app reads (`stubEnv`). It stands in for a GitHub
 * Enterprise host too (`host`): the same API under the server's own
 * `/api/v3` and `/api/graphql`, through `INFINITARY_GITHUB_ENTERPRISE_API_URL`,
 * with that host in every address it hands out. Nothing here ever reaches
 * github.com, and no test raises a keychain or password prompt.
 *
 * The test drives it: approve, deny or expire the code; refuse the
 * sign-in the way GitHub does when it no longer accepts one; or hand over
 * short-lived sign-ins, as GitHub does by default for an OAuth App
 * registered since 2026-08-14, and end one. As on GitHub, a code's sign-in
 * is handed over once and a refresh token works once. Every request is
 * logged for the test to read.
 *
 * A change is coherent the way GitHub's is (docs/e2e-contracts.md): it
 * carries the title and body it was opened or served with, never one the
 * stand-in makes up; its head is the branch's own commit in the disposable
 * repository (`headOf`) wherever the app puts it in; and a merge is
 * GitHub's squash at the head the app asks for, refused (409) when the head
 * has moved on since. A change with a wrong title, an unknown head or
 * failing checks is a refusal case its spec names, never a happy path.
 */

type StubPull = {
  /** GitHub's `mergeable_state` for this change: `clean` unless a spec names another. */
  mergeableState?: string;
  /**
   * How many reads of the change by its number GitHub answers `mergeable:
   * null` with `mergeable_state: unknown` before `mergeableState`: what it
   * answered PR #94 just after main moved, while it worked out a fresh test
   * merge (INF-456).
   */
  undecidedReads?: number;
  number: number;
  /** The head when no branch head is read (`headOf`): only for a change never put in. */
  headSha?: string;
  branch?: string;
  title: string;
  body?: string;
  merged?: boolean;
  closed?: boolean;
};

export type StubDispatch = {
  workflow: string;
  ref: string;
  headSha: string;
  inputs?: Record<string, string | boolean | number>;
};

type StubCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  run?: number;
  started_at?: string;
  completed_at?: string;
};

/** One merge GitHub accepted, as the app asked for it. */
export type StubMerge = {
  number: number;
  /** The head the app required the change to still be at. */
  sha: string;
  method: string;
  title: string;
  message: string;
};

/** One merge past the rules (`merge-async`) GitHub accepted, as the app asked for it. */
export type StubAsyncMerge = StubMerge & { action: string; bypass: boolean };

/** One rule set holding the default branch, and what the signed-in person may skip. */
export type StubRuleset = {
  id: number;
  name: string;
  /** GitHub's `current_user_can_bypass`. */
  bypass: string;
  rules: { type: string; parameters?: Record<string, unknown> }[];
};

/** A workflow file the stub serves: its path, GitHub's state for it, and its text. */
export type StubWorkflowFile = { path: string; state: string; text: string };

export type GitHubStub = {
  url: string;
  /** The environment that points the app here. */
  env: Record<string, string>;
  /** Every request, `METHOD /path` (query dropped). */
  requests: () => string[];
  /** Every merge GitHub accepted, in order; a refused one is only a request. */
  merges: () => StubMerge[];
  /** Verification requests accepted for an existing pushed branch. */
  dispatches: () => StubDispatch[];
  /** Every by-hand start of the project's shipped queue, `POST .../infinitary-queue.yml/dispatches`, in order. */
  queueStarts: () => { ref: string; inputs: Record<string, string> }[];
  /** Every asynchronous merge GitHub accepted, in order. */
  asyncMerges: () => StubAsyncMerge[];
  /** The rule sets holding the default branch; none by default. */
  setRulesets: (sets: StubRuleset[]) => void;
  /**
   * Serve this change for the first branch the app asks about (the app
   * mints the branch), with the title and body it was opened with. Its head
   * is that branch's own commit when the test reads one (`headOf`);
   * `headSha` is a head for a change whose checks are read and that is
   * never put in.
   */
  servePull: (pull: { number: number; title: string; body?: string; headSha?: string }) => void;
  /**
   * Serve this change for the next branch the app asks about that has no
   * change yet, in the order queued: a later task's change, in a journey
   * whose earlier task already holds the one `servePull` serves. Its head is
   * that branch's own commit (`headOf`).
   */
  serveNext: (pull: {
    number: number;
    title: string;
    body?: string;
    mergeableState?: string;
  }) => void;
  /**
   * Serve a pull request that is not the task's branch. `changeFor` of
   * another branch does not return it.
   */
  serveNumbered: (pull: {
    number: number;
    branch: string;
    title: string;
    body?: string;
    headSha: string;
    mergeableState?: string;
    undecidedReads?: number;
  }) => void;
  /**
   * Earlier pull requests ran workflows, while this head has none, so an
   * empty check list reads as not started rather than green.
   */
  priorPullRequestWorkflows: (on: boolean) => void;
  /** Move a served change's head, for a change that is never put in. */
  setHead: (sha: string) => void;
  /**
   * The person merges change N on GitHub's own page: it leaves the open
   * changes and reads merged by its number, and no merge request from the
   * app is recorded.
   */
  mergeByHand: (number: number) => void;
  /**
   * The check runs on every head: completed and successful by default. A
   * check run that names `run` belongs to that run (by its number) of one
   * pull request workflow; the version's workflow runs list those runs.
   */
  setChecks: (runs: StubCheckRun[]) => void;
  /**
   * Every commit status the app or the test set, by commit, as GitHub's
   * combined status lists them: one per context, the newest kept.
   */
  statuses: (sha: string) => { context: string; state: string; description?: string }[];
  /** Sets a commit status, as a project's own workflow does through `POST /statuses/{sha}`. */
  setStatus: (
    sha: string,
    status: { context: string; state: string; description?: string },
  ) => void;
  /**
   * The project's workflow files on its default branch, as GitHub's list of
   * workflows and its contents read answer them; none until set.
   */
  serveWorkflows: (files: StubWorkflowFile[]) => void;
  /**
   * The shipped queue's one open pause issue, as GitHub lists the project's
   * open issues with its pause label (`GitHubForge.queuePause`), with its
   * body and assignees; null once the queue closed it. None until set.
   */
  servePauseIssue: (issue: { number: number; body: string; assignees?: string[] } | null) => void;
  /** INF-1555 F14: refuse the version's workflow metadata list, not its sign-in or registered checks. */
  setWorkflowReadFailure: (failure: { status: number; message: string } | undefined) => void;
  /**
   * INF-2546 R8: GitHub fails to read pull request N by its number with this
   * answer, until it is cleared (undefined); every other request reads as usual.
   */
  setPullReadFailure: (
    number: number,
    failure: { status: number; message: string } | undefined,
  ) => void;
  /** Every failed-job rerun GitHub accepted, `POST /path`, in order. */
  reruns: () => string[];
  /** A completed measurement workflow on this exact disposable project version. */
  serveWorkflowEvidence: (headSha: string) => void;
  /** GitHub no longer accepts the sign-in: every API request answers 401. */
  rejectSignIn: () => void;
  acceptSignIn: () => void;
  /** From now on a sign-in is short-lived: eight hours, with a refresh token that works once. */
  issueShortLived: () => void;
  /** The current short-lived sign-in's eight hours ran out: GitHub answers it 401. */
  endAccess: () => void;
  /** Every refresh token the app spent, in order. */
  refreshes: () => string[];
  /** How many sign-ins GitHub handed over for an approved code. */
  exchanges: () => number;
  /** How the next device code ends when the app asks for its sign-in. */
  device: {
    /** The user-facing code the next sign-in attempt displays. */
    setCode: (code: string) => void;
    approve: (token?: string) => void;
    deny: () => void;
    expire: () => void;
  };
  /** The person's repositories `GET /user/repos` lists, newest first. */
  setProjects: (projects: { fullName: string; private?: boolean; updatedAt?: string }[]) => void;
  /** The person's open changes `forge.changes` reads, beside any the app opened. */
  setOpenChanges: (
    changes: { number: number; title: string; draft?: boolean; checks?: string | null }[],
  ) => void;
  /** The version a branch carries where the project lives: every change's live head. */
  headOf: (read: (branch: string) => string) => void;
  /**
   * Runs when a merge request arrives, before GitHub compares heads: a push
   * that lands between the app's check and its put-in.
   */
  onMergeRequest: (apply: () => void) => void;
  /** Move a local stand-in's main ref when GitHub accepts a put-in. */
  onPutIn: (apply: (sha: string) => void) => void;
  /**
   * Which heads GitHub refuses to merge for conflicting with newer work: it
   * answers the merge request 405, as GitHub does. Its mergeability read
   * (`GET /pulls/N`) initially says clean, the way GitHub's lazily computed
   * one can lag a change on the default branch. After the refused send,
   * reads of that head report the known conflict until it is resolved.
   */
  conflicts: (conflicted: (head: string) => boolean) => void;
  close: () => Promise<void>;
};

export const STUB_USER_CODE = "WDJB-MJHT";
export const STUB_LOGIN = "octo";
/** The notification `/notifications` answers with, and the pull request on a listing's second page. */
export const STUB_NOTIFICATION_TITLE = "Release 0.4.0 is out";
export const STUB_SECOND_PAGE_TITLE = "Second page";
/** What the REST API answers, with its 401, a call whose sign-in it does not take. */
export const STUB_BAD_CREDENTIALS = "Bad credentials";
/** The line of the failed job's log that says why it failed. */
export const STUB_JOB_FAILURE_LINE = "Missing measurement input";
/** The Nth refresh token a short-lived sign-in is handed, and the Nth access token a renewal answers. */
export const stubRefreshToken = (n: number) => `ghr_e2e_refresh_${n}`;
export const stubRenewedToken = (n: number) => `gho_e2e_renewed_${n}`;

export async function startGitHubStub(
  options: {
    /** The host the stand-in is: github.com, or a GitHub Enterprise host's name. */
    host?: string;
  } = {},
): Promise<GitHubStub> {
  const webHost = options.host ?? "github.com";
  const log: string[] = [];
  const evidenceProjects = new Set<number>();
  const evidence = new Map<string, { bytes: Buffer; mediaType: string }>();
  const merges: StubMerge[] = [];
  const commitStatuses = new Map<
    string,
    { id: number; context: string; state: string; description?: string }[]
  >();
  // GitHub gives every status it is sent an id of its own, newest highest.
  let statusIds = 0;
  const putStatus = (
    sha: string,
    status: { context: string; state: string; description?: string },
  ): number => {
    statusIds += 1;
    commitStatuses.set(sha, [
      ...(commitStatuses.get(sha) ?? []).filter((item) => item.context !== status.context),
      { id: statusIds, ...status },
    ]);
    return statusIds;
  };
  let workflowFiles: StubWorkflowFile[] = [];
  let pauseIssue: { number: number; body: string; assignees?: string[] } | null = null;
  const asyncMerges: StubAsyncMerge[] = [];
  const asyncResults = new Map<string, { status: string; details: Record<string, unknown> }>();
  let rulesets: StubRuleset[] = [];
  const dispatches: StubDispatch[] = [];
  const queueStarts: { ref: string; inputs: Record<string, string> }[] = [];
  const cancelledRuns = new Set<number>();
  let anyPull: StubPull | null = null;
  const opened = new Map<string, StubPull>();
  const queued: StubPull[] = [];
  const reruns: string[] = [];
  let nextNumber = 100;
  let checkRuns: StubCheckRun[] = [
    { name: "linux-checks", status: "completed", conclusion: "success" },
  ];
  let evidenceHead: string | undefined;
  let workflowReadFailure: { status: number; message: string } | undefined;
  const pullReadFailures = new Map<number, { status: number; message: string }>();
  const measurementZip = readFileSync("tests/fixtures/forge/measurement.zip");
  let rejected = false;
  let device: {
    mode: "pending" | "approved" | "exchanged" | "denied" | "expired";
    token: string;
  } = {
    mode: "pending",
    token: "gho_e2e_sign_in",
  };
  let userCode = STUB_USER_CODE;
  let shortLived = false;
  let access = "";
  let liveRefresh = "";
  let refreshSerial = 0;
  let renewals = 0;
  let exchanges = 0;
  const ended = new Set<string>();
  const refreshes: string[] = [];
  /** A sign-in as GitHub hands it over, short-lived or not. */
  const issue = (token: string) => {
    access = token;
    if (!shortLived) return { access_token: token, token_type: "bearer", scope: "repo,workflow" };
    refreshSerial += 1;
    liveRefresh = stubRefreshToken(refreshSerial);
    return {
      access_token: token,
      token_type: "bearer",
      scope: "repo,workflow",
      expires_in: 28_800,
      refresh_token: liveRefresh,
      refresh_token_expires_in: 15_897_600,
    };
  };
  let projects = [{ fullName: "octo/meterlab", private: true, updatedAt: "2026-09-20T10:00:00Z" }];
  let headOf: ((branch: string) => string) | null = null;
  let onMergeRequest: () => void = () => {};
  let onPutIn: (sha: string) => void = () => {};
  let priorPullRequestWorkflows = false;
  let conflicted: (head: string) => boolean = () => false;
  const knownConflicts = new Set<string>();
  let openChanges: { number: number; title: string; draft?: boolean; checks?: string | null }[] =
    [];
  let base = "";

  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  /** A change's head now: its branch's commit where the test reads one. */
  const headOfPull = (pull: StubPull): string | undefined =>
    (pull.branch && headOf ? headOf(pull.branch) : undefined) ?? pull.headSha;

  const pullJson = (pull: StubPull, owner: string, name: string) => ({
    number: pull.number,
    title: pull.title,
    html_url: `https://${webHost}/${owner}/${name}/pull/${pull.number}`,
    head: {
      sha: headOfPull(pull),
      ref: pull.branch ?? "",
      repo: { full_name: `${owner}/${name}` },
    },
    body: pull.body ?? "",
  });

  const server: Server = createServer((req, res) => {
    void read(req)
      .then((bytes) => {
        const raw = bytes.toString("utf8");
        const url = new URL(req.url ?? "/", "http://stub");
        // A GitHub Enterprise Server's API lives under its own path.
        const path = url.pathname
          .replace(/^\/api\/v3(?=\/)/, "")
          .replace(/^\/api\/graphql$/, "/graphql");
        const method = req.method ?? "GET";
        log.push(`${method} ${url.pathname}`);
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        };

        // GitHub's device flow (the OAuth host).
        if (method === "POST" && path === "/login/device/code") {
          // A new code starts pending: the test answers for the person.
          device = { ...device, mode: "pending" };
          send(200, {
            device_code: "stub-device",
            user_code: userCode,
            verification_uri: `${base}/login/device`,
            expires_in: 900,
            interval: 1,
          });
          return;
        }
        if (method === "POST" && path === "/login/oauth/access_token") {
          const form = new URLSearchParams(raw);
          if (form.get("grant_type") === "refresh_token") {
            const spent = form.get("refresh_token") ?? "";
            refreshes.push(spent);
            if (!spent || spent !== liveRefresh) {
              send(200, { error: "bad_refresh_token" });
              return;
            }
            // The refresh token works once and retires the access token it came with.
            ended.add(access);
            renewals += 1;
            send(200, issue(stubRenewedToken(renewals)));
            return;
          }
          if (device.mode === "approved") {
            exchanges += 1;
            const token = device.token;
            device = { ...device, mode: "exchanged" };
            send(200, issue(token));
          } else if (device.mode === "exchanged") {
            // GitHub hands a code's sign-in over once.
            send(200, { error: "bad_verification_code" });
          } else if (device.mode === "denied") {
            send(200, { error: "access_denied" });
          } else if (device.mode === "expired") {
            send(200, { error: "expired_token" });
          } else {
            send(200, { error: "authorization_pending" });
          }
          return;
        }

        // Signed storage reads deliberately need no sign-in; the forge must drop it.
        if (method === "GET" && path === "/workflow-storage/measurement.zip") {
          if (req.headers.authorization) {
            send(400, { message: "Sign-in leaked to storage" });
            return;
          }
          res.writeHead(200, { "content-type": "application/zip" });
          res.end(measurementZip);
          return;
        }
        if (method === "GET" && path === "/workflow-storage/job.log") {
          if (req.headers.authorization) {
            send(400, { message: "Sign-in leaked to storage" });
            return;
          }
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`Prepare data\nMeasure pairs: exit 1\n${STUB_JOB_FAILURE_LINE}\n`);
          return;
        }
        // The REST API: every call carries the app's sign-in as a bearer.
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ") || rejected || ended.has(auth.slice("Bearer ".length))) {
          send(401, { message: STUB_BAD_CREDENTIALS });
          return;
        }
        // INF-285 F4: native evidence uses the same local endpoint override as the API.
        if (webHost === "github.com" && method === "POST" && path === "/user-attachments/assets") {
          const projectId = Number(url.searchParams.get("repository_id"));
          const mediaType = url.searchParams.get("content_type") ?? "";
          if (
            !evidenceProjects.has(projectId) ||
            !bytes.length ||
            !url.searchParams.get("name") ||
            !["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(mediaType)
          ) {
            send(422, {
              message: "An evidence upload needs the confirmed project, name, media type and bytes",
            });
            return;
          }
          const id = randomUUID();
          evidence.set(id, { bytes, mediaType });
          send(201, { url: `https://github.com/user-attachments/assets/${id}` });
          return;
        }
        const evidenceId = /^\/user-attachments\/assets\/([0-9a-f-]{36})$/.exec(path)?.[1];
        if (method === "GET" && evidenceId) {
          const file = evidence.get(evidenceId);
          if (!file) send(404, { message: "Not Found" });
          else {
            res.writeHead(200, { "content-type": file.mediaType });
            res.end(file.bytes);
          }
          return;
        }
        if (method === "GET" && path === "/user") {
          send(200, { login: STUB_LOGIN });
          return;
        }
        if (method === "GET" && path === "/user/repos") {
          send(
            200,
            projects.map((project) => ({
              full_name: project.fullName,
              clone_url: `https://${webHost}/${project.fullName}.git`,
              html_url: `https://${webHost}/${project.fullName}`,
              updated_at: project.updatedAt ?? null,
              private: project.private === true,
            })),
          );
          return;
        }
        if (method === "POST" && path === "/graphql") {
          const pulls = [
            ...openChanges,
            ...[...opened.values()]
              .filter((pull) => !pull.merged)
              .map((pull) => ({ number: pull.number, title: pull.title })),
          ];
          send(200, {
            data: {
              viewer: {
                pullRequests: {
                  nodes: pulls.map(
                    (pull: {
                      number: number;
                      title: string;
                      draft?: boolean;
                      checks?: string | null;
                    }) => ({
                      number: pull.number,
                      title: pull.title,
                      url: `https://${webHost}/octo/meterlab/pull/${pull.number}`,
                      isDraft: pull.draft === true,
                      updatedAt: "2026-09-24T00:00:00Z",
                      repository: { nameWithOwner: "octo/meterlab" },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              statusCheckRollup:
                                pull.checks === null ? null : { state: pull.checks ?? "SUCCESS" },
                            },
                          },
                        ],
                      },
                    }),
                  ),
                },
              },
            },
          });
          return;
        }
        // The writes a crewmate's ask sends once the captain clicks (FI3-1571 piece 4).
        if (method === "POST" && path === "/user/repos") {
          const body = JSON.parse(raw || "{}") as { name?: string; private?: boolean };
          send(201, {
            full_name: `${STUB_LOGIN}/${body.name ?? ""}`,
            private: body.private === true,
            html_url: `https://${webHost}/${STUB_LOGIN}/${body.name ?? ""}`,
          });
          return;
        }
        if (method === "GET" && path === "/notifications") {
          send(200, [{ id: "1", subject: { title: STUB_NOTIFICATION_TITLE, type: "Release" } }]);
          return;
        }
        // GitHub names a repository listing's next page by the repository's id.
        if (method === "GET" && path === "/repositories/77/pulls") {
          send(200, [{ number: 2, title: STUB_SECOND_PAGE_TITLE }]);
          return;
        }
        const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
        if (!repo) {
          send(404, { message: "Not Found" });
          return;
        }
        const [, owner, name, rest = ""] = repo as unknown as [string, string, string, string?];
        if (
          method === "GET" &&
          rest === "/actions/runs" &&
          url.searchParams.has("head_sha") &&
          workflowReadFailure
        ) {
          send(workflowReadFailure.status, { message: workflowReadFailure.message });
          return;
        }
        if (method === "POST" && rest === "/actions/workflows/verify.yml/dispatches") {
          const body = JSON.parse(raw || "{}") as { ref?: string; inputs?: StubDispatch["inputs"] };
          let headSha: string | undefined;
          try {
            headSha = body.ref && headOf ? headOf(body.ref) : undefined;
          } catch {
            /* unknown ref */
          }
          if (!body.ref || !headSha) {
            send(422, { message: "The requested branch has not been pushed." });
            return;
          }
          dispatches.push({
            workflow: "verify.yml",
            ref: body.ref,
            headSha,
            ...(body.inputs ? { inputs: body.inputs } : {}),
          });
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === "POST" && rest === "/actions/workflows/infinitary-queue.yml/dispatches") {
          const body = JSON.parse(raw || "{}") as { ref?: string; inputs?: Record<string, string> };
          queueStarts.push({ ref: body.ref ?? "", inputs: body.inputs ?? {} });
          res.writeHead(204);
          res.end();
          return;
        }
        const cancel = /^\/actions\/runs\/(\d+)\/cancel$/.exec(rest);
        if (method === "POST" && cancel) {
          const runId = Number(cancel[1]);
          if (!dispatches[runId - 1000]) send(404, { message: "Run not found" });
          else {
            cancelledRuns.add(runId);
            send(202, {});
          }
          return;
        }
        // GitHub's failed-job reruns answer 201 with an empty body.
        if (
          method === "POST" &&
          /^\/actions\/(?:jobs\/\d+\/rerun|runs\/\d+\/rerun(?:-failed-jobs)?)$/.test(rest)
        ) {
          reruns.push(`${method} ${path}`);
          send(201, {});
          return;
        }
        if (
          method === "GET" &&
          rest === "/actions/runs" &&
          url.searchParams.get("event") === "workflow_dispatch"
        ) {
          const runs = dispatches
            .map((run, index) => ({
              id: 1000 + index,
              path: `.github/workflows/${run.workflow}`,
              event: "workflow_dispatch",
              head_branch: run.ref,
              head_sha: run.headSha,
              status: cancelledRuns.has(1000 + index) ? "completed" : "queued",
              conclusion: cancelledRuns.has(1000 + index) ? "cancelled" : null,
            }))
            .filter((run) => run.head_branch === url.searchParams.get("branch"));
          send(200, { total_count: runs.length, workflow_runs: runs });
          return;
        }
        if (
          method === "GET" &&
          evidenceHead &&
          owner === "octo" &&
          name === "meterlab" &&
          rest.startsWith("/actions/")
        ) {
          const run = {
            id: 10,
            name: "Test-speed experiment",
            head_sha: evidenceHead,
            head_branch: "main",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
            html_url: `https://${webHost}/${owner}/${name}/actions/runs/10`,
          };
          const job = {
            id: 20,
            run_id: 10,
            head_sha: evidenceHead,
            run_attempt: 1,
            name: "test-speed-experiment",
            status: "completed",
            conclusion: "failure",
            steps: [
              { name: "Measure pairs", number: 3, status: "completed", conclusion: "failure" },
            ],
          };
          const artifact = {
            id: 30,
            name: "test-speed-measurements",
            size_in_bytes: measurementZip.length,
            expired: false,
            expires_at: "2026-10-14T00:00:00Z",
            workflow_run: { id: 10 },
          };
          if (rest === "/actions/runs") {
            const runs = url.searchParams.get("head_sha") === evidenceHead ? [run] : [];
            send(200, { workflow_runs: runs, total_count: runs.length });
            return;
          }
          if (rest === "/actions/runs/10") {
            send(200, run);
            return;
          }
          if (rest === "/actions/runs/10/attempts/1/jobs") {
            send(200, { jobs: [job], total_count: 1 });
            return;
          }
          if (rest === "/actions/runs/10/artifacts") {
            send(200, { artifacts: [artifact], total_count: 1 });
            return;
          }
          if (rest === "/actions/jobs/20") {
            send(200, job);
            return;
          }
          if (rest === "/actions/artifacts/30") {
            send(200, artifact);
            return;
          }
          if (rest === "/actions/jobs/20/logs" || rest === "/actions/artifacts/30/zip") {
            const file = rest.endsWith("/logs") ? "job.log" : "measurement.zip";
            res.writeHead(302, { location: `${base}/workflow-storage/${file}?signed=disposable` });
            res.end();
            return;
          }
        }
        if (method === "GET" && rest === "/issues" && url.searchParams.get("labels")) {
          const label = url.searchParams.get("labels");
          send(
            200,
            pauseIssue && label === "infinitary-queue-paused"
              ? [
                  {
                    number: pauseIssue.number,
                    body: pauseIssue.body,
                    html_url: `https://${webHost}/${owner}/${name}/issues/${pauseIssue.number}`,
                    assignees: (pauseIssue.assignees ?? []).map((login) => ({ login })),
                  },
                ]
              : [],
          );
          return;
        }
        if (method === "POST" && rest === "/issues") {
          const body = JSON.parse(raw || "{}") as { title?: string };
          send(201, {
            number: 12,
            title: body.title ?? "",
            html_url: `https://${webHost}/${owner}/${name}/issues/12`,
          });
          return;
        }
        if (method === "PATCH" && rest === "/git/refs/heads/topic") {
          const body = JSON.parse(raw || "{}") as { sha?: string; force?: boolean };
          const head = headOf?.("topic");
          if (!head || body.sha !== head) send(422, { message: "Unknown topic version" });
          else send(200, { ref: "refs/heads/topic", object: { sha: head } });
          return;
        }
        if (method === "GET" && rest === "") {
          const fullName = `${owner}/${name}`;
          const index = projects.findIndex((project) => project.fullName === fullName);
          const project = projects[index];
          evidenceProjects.add(index + 2);
          send(200, {
            id: index + 2,
            full_name: fullName,
            default_branch: "main",
            private: project?.private ?? true,
            visibility: (project?.private ?? true) ? "private" : "public",
            permissions: { push: true },
          });
          return;
        }
        if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
          const branch = decodeURIComponent(rest.slice("/git/ref/heads/".length));
          let sha: string | undefined;
          try {
            sha = headOf?.(branch);
          } catch {
            /* unknown branch */
          }
          send(
            sha ? 200 : 404,
            sha
              ? { ref: `refs/heads/${branch}`, object: { type: "commit", sha } }
              : { message: "Not Found" },
          );
          return;
        }
        if (method === "GET" && rest === "/pulls" && owner === "octo" && name === "website") {
          res.writeHead(200, {
            "content-type": "application/json",
            link: `<${base}/repositories/77/pulls?per_page=1&page=2>; rel="next"`,
          });
          res.end(JSON.stringify([{ number: 1, title: "First page" }]));
          return;
        }
        if (method === "GET" && rest === "/pulls") {
          const head = url.searchParams.get("head") ?? "";
          const branch = head.slice(head.indexOf(":") + 1);
          const found = opened.get(branch);
          if (found && !found.merged && !found.closed) {
            send(200, [pullJson(found, owner, name)]);
          } else if (
            anyPull &&
            !anyPull.merged &&
            !anyPull.closed &&
            (anyPull.branch ?? branch) === branch
          ) {
            anyPull.branch = branch;
            send(200, [pullJson(anyPull, owner, name)]);
          } else if (queued.length > 0 && !found && anyPull?.branch !== branch) {
            const pull = { ...(queued.shift() as StubPull), branch };
            opened.set(branch, pull);
            send(200, [pullJson(pull, owner, name)]);
          } else {
            send(200, []);
          }
          return;
        }
        if (method === "POST" && rest === "/pulls") {
          const body = JSON.parse(raw || "{}") as { head?: string; title?: string; body?: string };
          const branch = body.head ?? "";
          if (!headOf) {
            // GitHub opens a change only for a branch it has: the spec names it.
            send(422, { message: `No commits between main and ${branch}` });
            return;
          }
          const pull: StubPull = { number: nextNumber++, branch, title: body.title ?? "" };
          if (body.body !== undefined) pull.body = body.body;
          opened.set(branch, pull);
          send(201, pullJson(pull, owner, name));
          return;
        }
        const numbered = /^\/pulls\/(\d+)$/.exec(rest);
        if (method === "GET" && numbered) {
          const number = Number(numbered[1]);
          const failure = pullReadFailures.get(number);
          if (failure) {
            send(failure.status, { message: failure.message });
            return;
          }
          const pull =
            [...opened.values()].find((open) => open.number === number) ??
            (anyPull?.number === number ? anyPull : undefined);
          if (!pull) {
            send(404, { message: "Not Found" });
            return;
          }
          const head = headOfPull(pull);
          const conflict = head !== undefined && knownConflicts.has(head) && conflicted(head);
          const undecided = (pull.undecidedReads ?? 0) > 0;
          if (undecided) pull.undecidedReads = (pull.undecidedReads ?? 0) - 1;
          send(200, {
            ...pullJson(pull, owner, name),
            state: pull.merged || pull.closed ? "closed" : "open",
            merged: pull.merged === true,
            merge_commit_sha: pull.merged ? `squash-${headOfPull(pull)}` : null,
            draft: false,
            base: { ref: "main" },
            mergeable: undecided ? null : !conflict,
            mergeable_state: undecided
              ? "unknown"
              : conflict
                ? "dirty"
                : (pull.mergeableState ?? "clean"),
          });
          return;
        }
        if (method === "GET" && /^\/commits\/[^/]+\/check-runs$/.test(rest)) {
          const listed = checkRuns.map(({ run, ...check }) =>
            run === undefined ? check : { ...check, check_suite: { id: run } },
          );
          send(200, { total_count: listed.length, check_runs: listed });
          return;
        }
        if (method === "GET" && rest === "/actions/runs") {
          if (
            priorPullRequestWorkflows &&
            url.searchParams.get("event") === "pull_request" &&
            checkRuns.length === 0
          ) {
            send(200, { total_count: 1, workflow_runs: [] });
            return;
          }
          if (url.searchParams.get("head_sha") && checkRuns.length === 0) {
            send(200, { total_count: 0, workflow_runs: [] });
            return;
          }
          // One pull request workflow's runs, each a check suite, finished
          // once every check run in it has.
          const numbers = [...new Set(checkRuns.flatMap((check) => check.run ?? []))];
          const runs = numbers.map((number) => ({
            id: number,
            run_number: number,
            check_suite_id: number,
            workflow_id: 1,
            name: "ci",
            event: "pull_request",
            head_sha: url.searchParams.get("head_sha"),
            status: checkRuns.every((check) => check.run !== number || check.status === "completed")
              ? "completed"
              : "in_progress",
          }));
          send(200, { total_count: runs.length, workflow_runs: runs });
          return;
        }
        if (method === "GET" && rest === "/actions/workflows") {
          send(200, {
            total_count: workflowFiles.length,
            workflows: workflowFiles.map((file, index) => ({
              id: index + 1,
              name: file.path,
              path: file.path,
              state: file.state,
            })),
          });
          return;
        }
        const contents = method === "GET" ? /^\/contents\/(.+)$/.exec(rest) : null;
        const workflowFile = contents?.[1]
          ? workflowFiles.find((file) => file.path === decodeURIComponent(contents[1] ?? ""))
          : undefined;
        if (workflowFile) {
          send(200, {
            path: workflowFile.path,
            encoding: "base64",
            content: Buffer.from(workflowFile.text).toString("base64"),
          });
          return;
        }
        const statusPost = method === "POST" ? /^\/statuses\/([^/]+)$/.exec(rest) : null;
        if (statusPost?.[1]) {
          const body = JSON.parse(raw) as { context: string; state: string; description?: string };
          const id = putStatus(decodeURIComponent(statusPost[1]), body);
          send(201, { id, ...body });
          return;
        }
        const statusRead = method === "GET" ? /^\/commits\/([^/]+)\/status$/.exec(rest) : null;
        if (statusRead?.[1]) {
          const statuses = commitStatuses.get(decodeURIComponent(statusRead[1])) ?? [];
          const state = statuses.some(
            (status) => status.state === "failure" || status.state === "error",
          )
            ? "failure"
            : statuses.some((status) => status.state === "pending")
              ? "pending"
              : "success";
          send(200, { state, statuses, total_count: statuses.length });
          return;
        }
        if (method === "GET" && /^\/rules\/branches\/.+$/.test(rest)) {
          send(
            200,
            rulesets.flatMap((set) =>
              set.rules.map((rule) => ({
                type: rule.type,
                ruleset_source_type: "Repository",
                ruleset_source: `${owner}/${name}`,
                ruleset_id: set.id,
                ...(rule.parameters ? { parameters: rule.parameters } : {}),
              })),
            ),
          );
          return;
        }
        const ruleset = /^\/rulesets\/(\d+)$/.exec(rest);
        if (method === "GET" && ruleset) {
          const set = rulesets.find((entry) => entry.id === Number(ruleset[1]));
          if (!set) send(404, { message: "Not Found" });
          else
            send(200, {
              id: set.id,
              name: set.name,
              enforcement: "active",
              current_user_can_bypass: set.bypass,
            });
          return;
        }
        const mergeAsync = /^\/pulls\/(\d+)\/merge-async$/.exec(rest);
        if (method === "PUT" && mergeAsync) {
          const number = Number(mergeAsync[1]);
          const body = JSON.parse(raw || "{}") as {
            sha?: string;
            merge_method?: string;
            merge_action?: string;
            bypass_rules?: boolean;
            commit_title?: string;
            commit_message?: string;
          };
          const pull =
            [...opened.values()].find((open) => open.number === number) ??
            (anyPull?.number === number ? anyPull : undefined);
          if (!pull || pull.merged) {
            send(400, { message: "Pull request is not open" });
            return;
          }
          const uuid = `merge-${asyncMerges.length + 1}-${number}`;
          const head = headOfPull(pull);
          if (!body.sha || body.sha !== head) {
            asyncResults.set(uuid, {
              status: "failed",
              details: {
                uuid,
                message: "Head branch was modified. Review and try the merge again.",
              },
            });
          } else {
            asyncMerges.push({
              number,
              sha: body.sha,
              method: body.merge_method ?? "merge",
              title: body.commit_title ?? pull.title,
              message: body.commit_message ?? "",
              action: body.merge_action ?? "default",
              bypass: body.bypass_rules === true,
            });
            pull.merged = true;
            onPutIn(body.sha);
            asyncResults.set(uuid, {
              status: "merged",
              details: { uuid, sha: `squash-${body.sha}`, message: "Pull request merged" },
            });
          }
          // Accepted to run in the background: the result is read by its id.
          send(202, {
            status: "pending",
            details: {
              uuid,
              merge_method: body.merge_method ?? "default",
              merge_action: body.merge_action ?? "default",
              expected_head_sha: body.sha ?? "",
              bypass_rules: body.bypass_rules === true,
            },
          });
          return;
        }
        const asyncResult = /^\/pulls\/\d+\/merge-async\/([^/]+)$/.exec(rest);
        if (method === "GET" && asyncResult) {
          const result = asyncResults.get(decodeURIComponent(asyncResult[1] ?? ""));
          if (!result) send(404, { message: "Not Found" });
          else send(200, result);
          return;
        }
        const merge = /^\/pulls\/(\d+)\/merge$/.exec(rest);
        if (method === "PUT" && merge) {
          const number = Number(merge[1]);
          const body = JSON.parse(raw || "{}") as {
            sha?: string;
            merge_method?: string;
            commit_title?: string;
            commit_message?: string;
          };
          const pull =
            [...opened.values()].find((open) => open.number === number) ??
            (anyPull?.number === number ? anyPull : undefined);
          if (!pull || pull.merged) {
            send(404, { message: "Not Found" });
            return;
          }
          onMergeRequest();
          const head = headOfPull(pull);
          // GitHub's "match head commit" guard: the change moved on since.
          if (!body.sha || body.sha !== head) {
            send(409, { message: "Head branch was modified. Review and try the merge again." });
            return;
          }
          if (conflicted(body.sha)) {
            knownConflicts.add(body.sha);
            send(405, { message: "Pull Request has merge conflicts" });
            return;
          }
          merges.push({
            number,
            sha: body.sha,
            method: body.merge_method ?? "merge",
            title: body.commit_title ?? pull.title,
            message: body.commit_message ?? "",
          });
          pull.merged = true;
          onPutIn(body.sha);
          send(200, { merged: true, sha: body.sha });
          return;
        }
        if (method === "PATCH" && numbered) {
          const number = Number(numbered[1]);
          const pull =
            [...opened.values()].find((open) => open.number === number) ??
            (anyPull?.number === number ? anyPull : undefined);
          if (!pull) {
            send(404, { message: "Not Found" });
            return;
          }
          const update = JSON.parse(raw || "{}") as {
            title?: string;
            body?: string;
            state?: string;
          };
          if (update.title !== undefined) pull.title = update.title;
          if (update.body !== undefined) pull.body = update.body;
          if (update.state === "closed") pull.closed = true;
          send(200, { ...pullJson(pull, owner, name), state: pull.closed ? "closed" : "open" });
          return;
        }
        send(404, { message: "Not Found" });
      })
      .catch((caught: unknown) => {
        // A stand-in that cannot answer says so at once, never a hung request.
        if (res.headersSent) return;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `the GitHub stand-in failed: ${String(caught)}` }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    env: {
      INFINITARY_GITHUB_API_URL: base,
      INFINITARY_GITHUB_OAUTH_URL: base,
      INFINITARY_GITHUB_ENTERPRISE_API_URL: `${base}/api/v3`,
    },
    requests: () => [...log],
    merges: () => [...merges],
    dispatches: () => [...dispatches],
    queueStarts: () => [...queueStarts],
    asyncMerges: () => [...asyncMerges],
    setRulesets: (sets) => {
      rulesets = sets;
    },
    servePull: (pull) => {
      anyPull = { ...pull };
    },
    serveNext: (pull) => {
      queued.push({ ...pull });
    },
    serveNumbered(pull: {
      number: number;
      branch: string;
      title: string;
      body?: string;
      headSha: string;
      mergeableState?: string;
      undecidedReads?: number;
    }) {
      opened.set(pull.branch, { ...pull });
    },
    priorPullRequestWorkflows(on: boolean) {
      priorPullRequestWorkflows = on;
    },
    setHead: (sha) => {
      if (anyPull) anyPull = { ...anyPull, headSha: sha };
    },
    mergeByHand: (number) => {
      const pull =
        [...opened.values()].find((open) => open.number === number) ??
        (anyPull?.number === number ? anyPull : undefined);
      if (!pull) throw new Error(`no change #${number} to merge`);
      pull.merged = true;
    },
    setChecks: (runs) => {
      checkRuns = runs;
    },
    statuses: (sha) => [...(commitStatuses.get(sha) ?? [])],
    setStatus: (sha, status) => {
      putStatus(sha, status);
    },
    serveWorkflows: (files) => {
      workflowFiles = files;
    },
    servePauseIssue: (issue) => {
      pauseIssue = issue;
    },
    setWorkflowReadFailure: (failure) => {
      workflowReadFailure = failure;
    },
    setPullReadFailure: (number, failure) => {
      if (failure) pullReadFailures.set(number, failure);
      else pullReadFailures.delete(number);
    },
    reruns: () => [...reruns],
    serveWorkflowEvidence: (headSha) => {
      evidenceHead = headSha;
    },
    rejectSignIn: () => {
      rejected = true;
    },
    acceptSignIn: () => {
      rejected = false;
    },
    issueShortLived: () => {
      shortLived = true;
    },
    endAccess: () => {
      ended.add(access);
    },
    refreshes: () => [...refreshes],
    exchanges: () => exchanges,
    device: {
      setCode: (code) => {
        userCode = code;
      },
      approve: (token = "gho_e2e_sign_in") => {
        device = { mode: "approved", token };
      },
      deny: () => {
        device = { ...device, mode: "denied" };
      },
      expire: () => {
        device = { ...device, mode: "expired" };
      },
    },
    setProjects: (next) => {
      projects = next.map((project) => ({
        fullName: project.fullName,
        private: project.private === true,
        updatedAt: project.updatedAt ?? "2026-09-20T10:00:00Z",
      }));
    },
    setOpenChanges: (next) => {
      openChanges = next;
    },
    headOf: (reader) => {
      headOf = reader;
    },
    onMergeRequest: (apply) => {
      onMergeRequest = apply;
    },
    onPutIn: (apply) => {
      onPutIn = apply;
    },
    conflicts: (next) => {
      conflicted = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A GitHub sign-in already made, exactly where the app keeps one
 * (`userData/forges/github.com/sign-in.json`, 0700 and 0600): for the specs
 * whose subject is a proposed change rather than signing in.
 */
export function seedGitHubSignIn(
  userDataDir: string,
  token = "gho_e2e_sign_in",
  host = "github.com",
): void {
  const dir = join(userDataDir, "forges", host);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(userDataDir, "forges"), 0o700);
  const file = join(dir, "sign-in.json");
  // A GitHub Enterprise host's key names its kind and git's user name, as a key sign-in keeps it.
  const server = host === "github.com" ? {} : { kind: "github", gitUser: "x-access-token" };
  writeFileSync(
    file,
    `${JSON.stringify({ token, scopes: ["repo"], login: STUB_LOGIN, createdAt: 1, ...server })}\n`,
    { mode: 0o600 },
  );
}

/**
 * A real git repository the app manages as a project on GitHub: the
 * direct-pr specs' working folder. Its origin is recorded on the repos row;
 * nothing here pushes anywhere.
 */
export function seedRepo(userDataDir: string): {
  repoDir: string;
  branchHead: (branch: string) => string;
} {
  const repoDir = join(userDataDir, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString();
  git("init", "--initial-branch=main", repoDir);
  git("-C", repoDir, "config", "user.name", "Test");
  git("-C", repoDir, "config", "user.email", "test@localhost");
  git("-C", repoDir, "commit", "--allow-empty", "-m", "init");
  return {
    repoDir,
    branchHead: (branch: string) => git("-C", repoDir, "rev-parse", `refs/heads/${branch}`).trim(),
  };
}
