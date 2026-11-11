/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/forge/providers/gitlab/
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { deferred } from "../helpers/deferred";

/**
 * A local stand-in for GitLab's REST API (`/api/v4`), on gitlab.com or a
 * self-hosted server, over real HTTP so the app runs its real key sign-in,
 * its real GitLab forge and its real git against it. The app finds it
 * through `INFINITARY_GITLAB_API_URL`, which only an unpackaged app reads; no
 * real account is ever asked.
 *
 * It serves the account and project reads sign-in and Add project use, and
 * one project's merge requests and pipelines the way GitLab answers them
 * (docs/e2e-contracts.md, "Keep fixtures truthful"):
 * - a merge request opens only for a branch the test's repository has
 *   (`headOf`), once per branch, with the title and description it was
 *   opened with; its head is that branch's own commit now;
 * - a merge is GitLab's: refused 409 when `sha` is not the head, 422 when
 *   the head conflicts with newer work (`conflicts`), 405 when the merge
 *   request is not open; an accepted one records the squash it was asked
 *   for and the merge request reads merged;
 * - pipelines run for the merge request's current head unless one names an
 *   earlier head: a branch pipeline on the branch, a merge request pipeline
 *   on `refs/merge-requests/<iid>/head`, and a merged-results pipeline on
 *   `refs/merge-requests/<iid>/merge` whose own commit is a merge of the
 *   head into main, as GitLab makes it (its parents are main and the head).
 * A pipeline with a failed job, a manual job or an earlier head is a case
 * its spec names, never a happy path.
 *
 * It also serves what a crewmate reads and asks through the app's gateway
 * and evidence tools, the way GitLab does:
 * - a pipeline by its id, a job by its id (with its pipeline, and its
 *   artifacts archive while it keeps one), a job's log as plain text, and
 *   its archive as a redirect to signed storage on the same address, which
 *   refuses a request that carries the key;
 * - a retried job is a new job of the same name, pending, in the same
 *   pipeline: the listing names the newest attempt;
 * - every merge request the person opened (`GET /merge_requests`), each
 *   with the head pipeline its own read names;
 * - one other project (`acme/site`) whose issues the key may read.
 *
 * And what a saved change story needs on gitlab.com (INF-132): the project's
 * numeric id, visibility, media protection and the key's role; a branch's
 * pushed commit; a merge request's title and description replaced in place; and
 * multipart project uploads, kept byte for byte and served back from the
 * `/-/project/<id>/uploads/<secret>/<name>` address GitLab answers with; and
 * the quick actions a description's own lines carry, run and removed from
 * the saved text as GitLab does.
 *
 * And what the shipped queue reaches (docs/forge.md, "The shipped queue on
 * GitLab"): a version's commit statuses, refusing a waiting status on a
 * version whose newest one of that name already waits, as GitLab does; a
 * pipeline started on a ref; merge-request approval notes and their author's
 * member access; the files on the default branch, base64 as GitLab serves
 * them; the queue's pause issue with its notes and its close;
 * and the project's access tokens and CI variables, a variable's value never
 * read back.
 */
export const GITLAB_STUB_KEY = "glpat-hermetic-sign-in-key";
export const GITLAB_STUB_LOGIN = "octo";
/** The code a device sign-in shows, as GitLab writes it. */
export const GITLAB_STUB_USER_CODE = "WDJBMJHT";
export const GITLAB_STUB_PROJECT = "group/subgroup/field-notes";
/** The project identity GitLab reports on the project, merge requests and pipelines. */
export const GITLAB_STUB_PROJECT_ID = 7;

/**
 * Public applications registered on the stand-in's host, by Application ID.
 * GitLab leaves Device authorization grant off on a new application and
 * refuses its device request as Doorkeeper's 400 `access_denied`; gitlab.com
 * answers an ID it does not know with a plain-text 404 page (INF-1671).
 */
export const GITLAB_STUB_APPLICATION = "a".repeat(64);
export const GITLAB_STUB_APPLICATION_NO_DEVICE = "b".repeat(64);
const STUB_APPLICATIONS = new Map([
  [GITLAB_STUB_APPLICATION, { deviceGrant: true }],
  [GITLAB_STUB_APPLICATION_NO_DEVICE, { deviceGrant: false }],
]);

/** The commit main points at where the project lives: the first parent of a merged result. */
export const GITLAB_STUB_MAIN_SHA = createHash("sha1").update("gitlab stub main").digest("hex");

/** Another project the key may read, never the task's own. */
export const GITLAB_STUB_OTHER_PROJECT = "acme/site";

export type GitLabStubJob = {
  name: string;
  status: string;
  allow_failure?: boolean;
  /** When it started and finished, as GitLab writes them (`2026-10-09T12:01:03.512Z`). */
  started_at?: string;
  finished_at?: string;
  /** The job's log as GitLab keeps it, colour codes and section markers included. */
  trace?: string;
  /** Its artifacts archive: the ZIP's bytes, or the date GitLab removed it. */
  artifacts?: { zip: Uint8Array; filename?: string } | { expiredAt: string };
};

export type GitLabStubPipeline = {
  /** Which ref it runs on: the branch (default), the merge request's head, or its merged result. */
  kind?: "branch" | "head" | "merge";
  status: string;
  jobs?: GitLabStubJob[];
  /** The head it ran for; the merge request's current head when absent. */
  head?: string;
  /** How GitLab started it; `merge_request_event` for a merge request or merged-result one by default. */
  source?: string;
};

/** One merge GitLab accepted, as the app asked for it. */
export type GitLabStubMerge = {
  iid: number;
  /** The head the app required the merge request to still be at. */
  sha: string;
  squash: boolean;
  message: string;
};

/** One commit status GitLab accepted on a version. */
export type GitLabStubStatus = {
  id: number;
  name: string;
  status: string;
  description: string | null;
  target_url: string | null;
  created_at: string;
};

/** An issue the queue opened for a paused batch, as GitLab lists it. */
export type GitLabStubIssue = {
  iid: number;
  description: string;
  labels: string[];
  assignees?: string[];
  state?: "opened" | "closed";
};

/** A project access token, as GitLab lists it; its secret only in the answer that made it. */
export type GitLabStubToken = {
  id: number;
  name: string;
  scopes: string[];
  access_level: number;
  expires_at: string;
  active: boolean;
  revoked: boolean;
};

/** One project upload GitLab kept, as the app sent it. */
export type GitLabStubUpload = {
  secret: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
};

/**
 * GitLab runs the quick actions a description's own lines carry when it is
 * created or updated (`/label ~x`, `/merge`) and removes those lines from the
 * saved text; `ran` records each command line, in order.
 */
function runQuickActions(description: string, ran: string[]): string {
  return description
    .split("\n")
    .filter((line) => {
      const command = /^\/[a-z_]+(?:\s.*)?$/.test(line);
      if (command) ran.push(line);
      return !command;
    })
    .join("\n");
}

type StubMergeRequest = {
  iid: number;
  branch: string;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged";
  /** The head it merged at, once merged. */
  mergedHead?: string;
  draft?: boolean;
};

/** A merged result's commit for a head, as GitLab names one: distinct per head. */
export function gitlabMergedResultSha(head: string): string {
  return createHash("sha1").update(`merged result of ${head}`).digest("hex");
}

/** The job every pipeline runs unless the test names its own: one that passed. */
const PASSED_JOBS: GitLabStubJob[] = [{ name: "test", status: "success" }];

/** A GitLab key sign-in already made on a host, exactly where the app keeps one. */
export function seedGitLabSignIn(userDataDir: string, host: string): void {
  const forges = join(userDataDir, "forges");
  mkdirSync(join(forges, host), { recursive: true, mode: 0o700 });
  chmodSync(forges, 0o700);
  writeFileSync(
    join(forges, host, "sign-in.json"),
    `${JSON.stringify({
      token: GITLAB_STUB_KEY,
      scopes: [],
      login: GITLAB_STUB_LOGIN,
      createdAt: 1,
      kind: "gitlab",
      gitUser: "oauth2",
    })}\n`,
    { mode: 0o600 },
  );
}

/** The one file a multipart form carries under `field`, as GitLab's upload reads it. */
function formFile(
  body: Buffer,
  contentType: string | undefined,
  field: string,
): { filename: string; contentType: string; bytes: Buffer } | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const mark = boundary?.[1] ?? boundary?.[2];
  if (!mark) return undefined;
  const delimiter = Buffer.from(`--${mark}`);
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next < 0) return undefined;
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, split).toString("utf8");
    const named = /name="([^"]*)"(?:; filename="([^"]*)")?/.exec(headers);
    if (named?.[1] === field && named[2] !== undefined) {
      return {
        filename: named[2],
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? "",
        bytes: Buffer.from(part.subarray(split + 4)),
      };
    }
    start = next;
  }
  return undefined;
}

export async function startGitLabStub(host: string) {
  const requests: string[] = [];
  const uploads: GitLabStubUpload[] = [];
  const quickActions: string[] = [];
  /** GitLab's "Require authentication to view media files"; off until a test turns it on. */
  let mediaProtected = false;
  const merges: GitLabStubMerge[] = [];
  const mergeRequests = new Map<number, StubMergeRequest>();
  let nextIid = 1;
  let headOf: ((branch: string) => string) | null = null;
  let conflicted: (head: string) => boolean = () => false;
  let onMergeRequest: () => void = () => {};
  let pipelines: GitLabStubPipeline[] = [{ status: "success" }];
  /** Pipelines the project ran before any merge request here: its branches and main. */
  let history: { ref: string; source: string }[] = [];
  /** A retried job's first id to its newest attempt's. */
  const retried = new Map<number, number>();
  /** Commit statuses by version, oldest first, as GitLab keeps every one it accepted. */
  const statuses = new Map<string, GitLabStubStatus[]>();
  let nextStatusId = 1;
  /** Every pipeline the API started on a ref (`POST /pipeline`), in order. */
  const started: { ref: string }[] = [];
  /** Files on the default branch, by path. */
  const files = new Map<string, string>();
  /** The queue's one pause issue, open or closed, and every note written on it. */
  let pauseIssue: GitLabStubIssue | null = null;
  // A journey may order the next issue-list response after its UI observation,
  // without changing the issue, the writes, or the response GitLab sends.
  let closedPauseReads:
    | { response: Promise<void>; waiting: boolean; release: () => void }
    | undefined;
  const notes: { iid: number; body: string }[] = [];
  // Merge approvals belong to merge-request notes, separate from pause-issue notes.
  const requestNotes = new Map<
    number,
    { id: number; body: string; author: { id: number; username: string } }[]
  >();
  let nextNoteId = 1;
  /** The project's access tokens, and its CI variables by key. */
  const tokens: GitLabStubToken[] = [];
  const variables = new Map<string, Record<string, unknown>>();
  const namespacePath = GITLAB_STUB_PROJECT.slice(0, GITLAB_STUB_PROJECT.lastIndexOf("/"));
  const project = {
    id: GITLAB_STUB_PROJECT_ID,
    namespace: {
      id: 2,
      kind: "group",
      path: namespacePath.slice(namespacePath.lastIndexOf("/") + 1),
      full_path: namespacePath,
    },
    path_with_namespace: GITLAB_STUB_PROJECT,
    http_url_to_repo: `https://${host}/${GITLAB_STUB_PROJECT}.git`,
    web_url: `https://${host}/${GITLAB_STUB_PROJECT}`,
    visibility: "private",
    last_activity_at: "2026-10-09T12:00:00Z",
    default_branch: "main",
    permissions: { project_access: { access_level: 40 }, group_access: null },
  };
  const projectPath = `/api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;

  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  /** A branch's commit now, or undefined when the repository has no such branch. */
  const branchHead = (branch: string): string | undefined => {
    try {
      return headOf?.(branch);
    } catch {
      return undefined;
    }
  };
  const headOfRequest = (request: StubMergeRequest): string | undefined =>
    request.mergedHead ?? branchHead(request.branch);

  const requestJson = (request: StubMergeRequest) => {
    const head = headOfRequest(request);
    const conflict = request.state === "opened" && head !== undefined && conflicted(head);
    return {
      id: 1000 + request.iid,
      iid: request.iid,
      references: { full: `${GITLAB_STUB_PROJECT}!${request.iid}` },
      updated_at: new Date(Date.UTC(2026, 9, 9, 12, request.iid)).toISOString(),
      project_id: project.id,
      source_project_id: project.id,
      target_project_id: project.id,
      source_branch: request.branch,
      target_branch: "main",
      title: request.title,
      description: request.description,
      web_url: `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/${request.iid}`,
      state: request.state,
      sha: head ?? null,
      draft: request.draft === true,
      has_conflicts: conflict,
      detailed_merge_status:
        request.state !== "opened"
          ? "not_open"
          : request.draft
            ? "draft_status"
            : conflict
              ? "conflict"
              : "mergeable",
      merge_commit_sha: request.mergedHead ? gitlabMergedResultSha(request.mergedHead) : null,
      squash_commit_sha: null,
    };
  };

  /** Every pipeline as GitLab lists it: one id each, newest last. */
  const listedPipelines = () => {
    const listed: {
      id: number;
      sha: string;
      ref: string;
      status: string;
      source: string;
      jobs: GitLabStubJob[];
      iid?: number;
      /** A merged result's head: the second parent of its own commit. */
      merges?: string;
    }[] = history.map((past, index) => ({
      id: 10 + index,
      sha: createHash("sha1").update(`history ${index}`).digest("hex"),
      ref: past.ref,
      status: "success",
      source: past.source,
      jobs: PASSED_JOBS,
    }));
    for (const request of mergeRequests.values()) {
      const current = headOfRequest(request);
      pipelines.forEach((pipeline, index) => {
        const head = pipeline.head ?? current;
        if (!head) return;
        const kind = pipeline.kind ?? "branch";
        listed.push({
          id: 100 * request.iid + index + 1,
          sha: kind === "merge" ? gitlabMergedResultSha(head) : head,
          ref: kind === "branch" ? request.branch : `refs/merge-requests/${request.iid}/${kind}`,
          status: pipeline.status,
          source: pipeline.source ?? (kind === "branch" ? "push" : "merge_request_event"),
          jobs: pipeline.jobs ?? PASSED_JOBS,
          iid: request.iid,
          ...(kind === "merge" ? { merges: head } : {}),
        });
      });
    }
    // A pipeline with a retried job runs again until that job finishes.
    for (const pipeline of listed) {
      if ([...retried.keys()].some((first) => Math.floor(first / 1000) === pipeline.id)) {
        pipeline.status = "running";
      }
    }
    return listed.sort((a, b) => b.id - a.id);
  };
  type Listed = ReturnType<typeof listedPipelines>[number];
  /** Each job of a pipeline as GitLab answers it, the newest attempt of a retried one. */
  const jobsOf = (pipeline: Listed) =>
    pipeline.jobs.map((job, index) => {
      const first = pipeline.id * 1000 + index;
      const retry = retried.get(first);
      return jobJson(pipeline, job, retry ?? first, retry !== undefined);
    });
  const jobJson = (pipeline: Listed, job: GitLabStubJob, id: number, retry: boolean) => {
    const archive = job.artifacts && "zip" in job.artifacts ? job.artifacts : undefined;
    const expired = job.artifacts && "expiredAt" in job.artifacts ? job.artifacts : undefined;
    const filename = archive?.filename ?? "artifacts.zip";
    return {
      id,
      name: job.name,
      stage: "test",
      status: retry ? "pending" : job.status,
      allow_failure: job.allow_failure === true,
      // A retried attempt has not started yet.
      started_at: retry ? null : (job.started_at ?? null),
      finished_at: retry ? null : (job.finished_at ?? null),
      ref: pipeline.ref,
      web_url: `https://${host}/${GITLAB_STUB_PROJECT}/-/jobs/${id}`,
      commit: { id: pipeline.sha },
      pipeline: {
        id: pipeline.id,
        project_id: project.id,
        sha: pipeline.sha,
        ref: pipeline.ref,
        status: pipeline.status,
      },
      ...(archive && !retry
        ? {
            artifacts_file: { filename, size: archive.zip.byteLength },
            artifacts: [
              { file_type: "archive", size: archive.zip.byteLength, filename, file_format: "zip" },
            ],
            artifacts_expire_at: "2026-11-09T12:00:00.000Z",
          }
        : { artifacts: [], artifacts_expire_at: expired?.expiredAt ?? null }),
    };
  };
  /** A job by its id, a retry's included: its pipeline and what it is. */
  const jobById = (id: number) => {
    const firstOf = [...retried.entries()].find(([, retry]) => retry === id)?.[0];
    const first = firstOf ?? id;
    const pipeline = listedPipelines().find((listed) => listed.id === Math.floor(first / 1000));
    const job = pipeline?.jobs[first % 1000];
    if (!pipeline || !job || first % 1000 >= 500) return undefined;
    if (firstOf === undefined && retried.has(first)) {
      // The earlier attempt: still readable by its id, never listed.
      return { pipeline, job, json: jobJson(pipeline, job, first, false) };
    }
    return { pipeline, job, json: jobJson(pipeline, job, id, firstOf !== undefined) };
  };

  const pipelineJson = (pipeline: ReturnType<typeof listedPipelines>[number]) => ({
    id: pipeline.id,
    project_id: project.id,
    sha: pipeline.sha,
    ref: pipeline.ref,
    status: pipeline.status,
    source: pipeline.source,
    web_url: `https://${host}/${GITLAB_STUB_PROJECT}/-/pipelines/${pipeline.id}`,
  });

  const server = createServer((req, res) => {
    void read(req).then(async (bytes) => {
      const multipart = /^multipart\/form-data/i.test(req.headers["content-type"] ?? "");
      const raw = multipart ? "" : bytes.toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      requests.push(`${method} ${path}`);
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      // The device authorization grant asks no key, only the public application's ID.
      if (method === "POST" && path === "/oauth/authorize_device") {
        const form = new URLSearchParams(raw);
        const application = STUB_APPLICATIONS.get(form.get("client_id") ?? "");
        if (!application) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("404 page not found\n");
        } else if (!application.deviceGrant) {
          send(400, {
            error: "access_denied",
            error_description: "The resource owner or authorization server denied the request.",
          });
        } else {
          send(200, {
            device_code: "stub-device-code",
            user_code: GITLAB_STUB_USER_CODE,
            verification_uri: `http://127.0.0.1:${port}/oauth/device`,
            verification_uri_complete: `http://127.0.0.1:${port}/oauth/device?user_code=${GITLAB_STUB_USER_CODE}`,
            expires_in: 300,
            interval: 5,
          });
        }
        return;
      }
      // Signed storage: the address is the grant, and the key never belongs here.
      const stored = /^\/storage\/job-artifacts\/(\d+)\.zip$/.exec(path);
      if (method === "GET" && stored) {
        const found = jobById(Number(stored[1]));
        const archive = found?.job.artifacts;
        if (req.headers.authorization !== undefined || url.searchParams.get("signed") !== "1") {
          send(400, { message: "Signed storage takes no key" });
        } else if (!archive || !("zip" in archive)) send(404, { message: "Not found" });
        else {
          res.writeHead(200, { "Content-Type": "application/zip" });
          res.end(Buffer.from(archive.zip));
        }
        return;
      }
      if (req.headers.authorization !== `Bearer ${GITLAB_STUB_KEY}`) {
        send(401, { message: "401 Unauthorized" });
        return;
      }
      // A kept upload at the address GitLab names it by: the project's number, its secret, its name.
      const served = /^\/-\/project\/(\d+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/.exec(path);
      if (method === "GET" && served) {
        const kept = uploads.find(
          (upload) =>
            Number(served[1]) === project.id &&
            upload.secret === served[2] &&
            upload.filename === served[3],
        );
        if (!kept) send(404, { message: "404 Not Found" });
        else {
          res.writeHead(200, { "Content-Type": kept.contentType });
          res.end(kept.bytes);
        }
        return;
      }
      if (method === "GET" && path === "/api/v4/user") {
        send(200, { id: 1, username: GITLAB_STUB_LOGIN });
        return;
      }
      if (method === "GET" && path === "/api/v4/projects") {
        send(200, [project]);
        return;
      }
      if (method === "GET" && path === "/api/v4/merge_requests") {
        // GitLab's default scope is the person's own merge requests; the
        // stand-in's are all theirs.
        const scope = url.searchParams.get("scope") ?? "created_by_me";
        const state = url.searchParams.get("state");
        const theirs = scope === "created_by_me" || scope === "all";
        send(
          200,
          [...mergeRequests.values()]
            .filter((request) => theirs && (!state || request.state === state))
            .sort((a, b) => b.iid - a.iid)
            .map(requestJson),
        );
        return;
      }
      if (
        method === "GET" &&
        path === `/api/v4/projects/${encodeURIComponent(GITLAB_STUB_OTHER_PROJECT)}/issues`
      ) {
        send(200, [{ iid: 5, title: "elsewhere" }]);
        return;
      }
      // The project by its encoded path or, as GitLab also takes it, its number.
      const prefix = [projectPath, `/api/v4/projects/${project.id}`].find(
        (named) => path === named || path.startsWith(`${named}/`),
      );
      if (!prefix) {
        send(404, { message: "404 Project Not Found" });
        return;
      }
      const rest = path.slice(prefix.length);
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      if (method === "DELETE" && rest === "/repository/branches/topic") {
        res.writeHead(204);
        res.end();
        return;
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const paged = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);

      if (method === "GET" && rest === "") {
        send(200, { ...project, enforce_auth_checks_on_uploads: mediaProtected });
        return;
      }
      if (method === "POST" && rest === "/uploads") {
        const file = multipart ? formFile(bytes, req.headers["content-type"], "file") : undefined;
        if (!file) {
          send(400, { message: "400 Bad request - file is missing" });
          return;
        }
        const secret = createHash("md5").update(`${uploads.length}:${file.filename}`).digest("hex");
        uploads.push({ secret, ...file });
        const url = `/uploads/${secret}/${file.filename}`;
        send(201, {
          id: uploads.length,
          alt: file.filename.replace(/\.[^.]+$/, ""),
          url,
          full_path: `/-/project/${project.id}/uploads/${secret}/${file.filename}`,
          markdown: `![${file.filename}](${url})`,
        });
        return;
      }
      const branchRead = /^\/repository\/branches\/(.+)$/.exec(rest);
      if (method === "GET" && branchRead) {
        const branch = decodeURIComponent(branchRead[1] as string);
        const head = branchHead(branch);
        if (!head) send(404, { message: "404 Branch Not Found" });
        else send(200, { name: branch, commit: { id: head } });
        return;
      }
      if (method === "POST" && rest === "/merge_requests") {
        const branch = String(body.source_branch ?? "");
        if (!branchHead(branch)) {
          send(422, { message: ["Source branch does not exist"] });
          return;
        }
        const open = [...mergeRequests.values()].find(
          (request) => request.branch === branch && request.state === "opened",
        );
        if (open) {
          send(409, {
            message: [
              `Another open merge request already exists for this source branch: !${open.iid}`,
            ],
          });
          return;
        }
        const request: StubMergeRequest = {
          iid: nextIid++,
          branch,
          title: String(body.title ?? ""),
          description: runQuickActions(String(body.description ?? ""), quickActions),
          state: "opened",
        };
        mergeRequests.set(request.iid, request);
        send(201, requestJson(request));
        return;
      }
      if (method === "GET" && rest === "/merge_requests") {
        const state = url.searchParams.get("state");
        const branch = url.searchParams.get("source_branch");
        send(
          200,
          [...mergeRequests.values()]
            .filter(
              (request) =>
                (!state || request.state === state) && (!branch || request.branch === branch),
            )
            .sort((a, b) => b.iid - a.iid)
            .map(requestJson),
        );
        return;
      }
      if (method === "GET" && rest === "/members/all/1") {
        send(200, { id: 1, username: GITLAB_STUB_LOGIN, access_level: 40 });
        return;
      }
      const numbered = /^\/merge_requests\/(\d+)(\/merge|\/pipelines|\/notes)?$/.exec(rest);
      const request = numbered ? mergeRequests.get(Number(numbered[1])) : undefined;
      if (numbered && !request) {
        send(404, { message: "404 Not found" });
        return;
      }
      if (request && numbered?.[2] === "/notes" && (method === "GET" || method === "POST")) {
        const rows = requestNotes.get(request.iid) ?? [];
        if (method === "GET") send(200, paged(rows));
        else {
          const row = {
            id: nextNoteId++,
            body: String(body.body ?? ""),
            author: { id: 1, username: GITLAB_STUB_LOGIN },
          };
          requestNotes.set(request.iid, [...rows, row]);
          send(201, row);
        }
        return;
      }
      if (request && method === "GET" && numbered?.[2] === undefined) {
        // A single merge request's read names its head pipeline; the lists do not.
        const head = headOfRequest(request);
        const latest = listedPipelines().find((pipeline) => head && pipeline.sha === head);
        send(200, {
          ...requestJson(request),
          head_pipeline: latest ? pipelineJson(latest) : null,
        });
        return;
      }
      if (request && method === "PUT" && numbered?.[2] === undefined) {
        if (body.state_event === "close" && request.state === "opened") request.state = "closed";
        if (typeof body.title === "string") request.title = body.title;
        if (typeof body.description === "string")
          request.description = runQuickActions(body.description, quickActions);
        send(200, requestJson(request));
        return;
      }
      if (request && method === "GET" && numbered?.[2] === "/pipelines") {
        send(
          200,
          paged(listedPipelines().filter((pipeline) => pipeline.iid === request.iid)).map(
            pipelineJson,
          ),
        );
        return;
      }
      if (request && method === "PUT" && numbered?.[2] === "/merge") {
        onMergeRequest();
        if (request.state !== "opened") {
          send(405, { message: "405 Method Not Allowed" });
          return;
        }
        const head = headOfRequest(request);
        if (!head || body.sha !== head) {
          send(409, { message: "SHA does not match HEAD of source branch" });
          return;
        }
        if (conflicted(head)) {
          send(422, { message: "Branch cannot be merged" });
          return;
        }
        merges.push({
          iid: request.iid,
          sha: head,
          squash: body.squash === true,
          message: String(body.squash_commit_message ?? ""),
        });
        request.state = "merged";
        request.mergedHead = head;
        send(200, requestJson(request));
        return;
      }
      if (method === "GET" && rest === "/pipelines") {
        const sha = url.searchParams.get("sha");
        const source = url.searchParams.get("source");
        send(
          200,
          paged(
            listedPipelines().filter(
              (pipeline) =>
                (!sha || pipeline.sha === sha) && (!source || pipeline.source === source),
            ),
          ).map(pipelineJson),
        );
        return;
      }
      const jobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest);
      if (method === "GET" && jobs) {
        const pipeline = listedPipelines().find((listed) => listed.id === Number(jobs[1]));
        if (!pipeline) {
          send(404, { message: "404 Not found" });
          return;
        }
        send(200, paged(jobsOf(pipeline)));
        return;
      }
      const onePipeline = /^\/pipelines\/(\d+)$/.exec(rest);
      if (method === "GET" && onePipeline) {
        const pipeline = listedPipelines().find((listed) => listed.id === Number(onePipeline[1]));
        if (pipeline) send(200, pipelineJson(pipeline));
        else send(404, { message: "404 Not found" });
        return;
      }
      const job = /^\/jobs\/(\d+)(\/trace|\/artifacts|\/retry)?$/.exec(rest);
      const found = job ? jobById(Number(job[1])) : undefined;
      if (job && !found) {
        send(404, { message: "404 Job Not Found" });
        return;
      }
      if (found && method === "GET" && job?.[2] === undefined) {
        send(200, found.json);
        return;
      }
      if (found && method === "GET" && job?.[2] === "/trace") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(found.job.trace ?? "");
        return;
      }
      if (found && method === "GET" && job?.[2] === "/artifacts") {
        if (!("artifacts_file" in found.json)) {
          send(404, { message: "404 Not found" });
          return;
        }
        // GitLab sends the archive from object storage: a signed address on this host.
        res.writeHead(302, {
          Location: `http://${req.headers.host}/storage/job-artifacts/${found.json.id}.zip?signed=1`,
        });
        res.end();
        return;
      }
      if (found && method === "POST" && job?.[2] === "/retry") {
        const first = found.pipeline.id * 1000 + found.pipeline.jobs.indexOf(found.job);
        const retry = found.pipeline.id * 1000 + 500 + found.pipeline.jobs.indexOf(found.job);
        retried.set(first, retry);
        send(201, jobJson(found.pipeline, found.job, retry, true));
        return;
      }
      const commit = /^\/repository\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (method === "GET" && commit) {
        const head = listedPipelines().find((pipeline) => pipeline.sha === commit[1])?.merges;
        if (!head) {
          send(404, { message: "404 Commit Not Found" });
          return;
        }
        send(200, { id: commit[1], parent_ids: [GITLAB_STUB_MAIN_SHA, head] });
        return;
      }
      // A version's commit statuses: GitLab refuses a waiting status on a
      // version whose newest status of that name already waits.
      const status = /^\/statuses\/([0-9a-f]{40})$/.exec(rest);
      if (method === "POST" && status?.[1]) {
        const sha = status[1];
        const name = typeof body.name === "string" ? body.name : "default";
        const state = String(body.state ?? "");
        const kept = statuses.get(sha) ?? [];
        const newest = kept.filter((row) => row.name === name).at(-1);
        if (newest && ["pending", "running"].includes(newest.status) && newest.status === state) {
          send(400, { message: `Cannot transition status via :enqueue from :${state}` });
          return;
        }
        const row: GitLabStubStatus = {
          id: nextStatusId++,
          name,
          status: state,
          description: typeof body.description === "string" ? body.description : null,
          target_url: typeof body.target_url === "string" ? body.target_url : null,
          created_at: new Date(Date.UTC(2026, 9, 9, 12, 0, nextStatusId)).toISOString(),
        };
        statuses.set(sha, [...kept, row]);
        send(201, { ...row, sha });
        return;
      }
      const statusList = /^\/repository\/commits\/([0-9a-f]{40})\/statuses$/.exec(rest);
      if (method === "GET" && statusList?.[1]) {
        const name = url.searchParams.get("name");
        send(
          200,
          paged((statuses.get(statusList[1]) ?? []).filter((row) => !name || row.name === name)),
        );
        return;
      }
      if (method === "POST" && rest === "/pipeline") {
        const ref = String(body.ref ?? "");
        started.push({ ref });
        const id = 900 + started.length;
        send(201, {
          id,
          ref,
          status: "created",
          source: "api",
          web_url: `https://${host}/${GITLAB_STUB_PROJECT}/-/pipelines/${id}`,
        });
        return;
      }
      const file = /^\/repository\/files\/([^/]+)$/.exec(rest);
      if (method === "GET" && file?.[1]) {
        const text =
          url.searchParams.get("ref") === "main"
            ? files.get(decodeURIComponent(file[1]))
            : undefined;
        if (text === undefined) send(404, { message: "404 File Not Found" });
        else
          send(200, {
            file_path: decodeURIComponent(file[1]),
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          });
        return;
      }
      if (method === "GET" && rest === "/issues") {
        if (pauseIssue?.state === "closed" && closedPauseReads) {
          closedPauseReads.waiting = true;
          await closedPauseReads.response;
        }
        const label = url.searchParams.get("labels");
        const state = url.searchParams.get("state");
        const listed =
          pauseIssue &&
          (!state || (pauseIssue.state ?? "opened") === state) &&
          (!label || pauseIssue.labels.includes(label))
            ? [pauseIssue]
            : [];
        send(
          200,
          paged(
            listed.map((issue) => ({
              iid: issue.iid,
              description: issue.description,
              labels: issue.labels,
              state: issue.state ?? "opened",
              web_url: `https://${host}/${GITLAB_STUB_PROJECT}/-/issues/${issue.iid}`,
              assignees: (issue.assignees ?? []).map((username) => ({ username })),
            })),
          ),
        );
        return;
      }
      const issue = /^\/issues\/(\d+)(\/notes)?$/.exec(rest);
      if (issue && (!pauseIssue || pauseIssue.iid !== Number(issue[1]))) {
        send(404, { message: "404 Issue Not Found" });
        return;
      }
      if (issue && pauseIssue && method === "POST" && issue[2] === "/notes") {
        notes.push({ iid: pauseIssue.iid, body: String(body.body ?? "") });
        send(201, { id: notes.length, body: body.body });
        return;
      }
      if (issue && pauseIssue && method === "PUT" && issue[2] === undefined) {
        if (body.state_event === "close") pauseIssue = { ...pauseIssue, state: "closed" };
        send(200, { iid: pauseIssue.iid, state: pauseIssue.state ?? "opened" });
        return;
      }
      // Project access tokens: the Maintainer key the stand-in signs in with may make them.
      if (method === "GET" && rest === "/access_tokens") {
        const state = url.searchParams.get("state");
        send(
          200,
          paged(tokens.filter((token) => state !== "active" || (token.active && !token.revoked))),
        );
        return;
      }
      if (method === "POST" && rest === "/access_tokens") {
        const token: GitLabStubToken = {
          id: 300 + tokens.length,
          name: String(body.name ?? ""),
          scopes: (body.scopes as string[]) ?? [],
          access_level: Number(body.access_level ?? 30),
          expires_at: String(body.expires_at ?? ""),
          active: true,
          revoked: false,
        };
        tokens.push(token);
        send(201, { ...token, token: `glpat-queue-${token.id}` });
        return;
      }
      const revoke = /^\/access_tokens\/(\d+)$/.exec(rest);
      if (method === "DELETE" && revoke) {
        const token = tokens.find((row) => row.id === Number(revoke[1]));
        if (!token) send(404, { message: "404 Not Found" });
        else {
          token.active = false;
          token.revoked = true;
          res.writeHead(204);
          res.end();
        }
        return;
      }
      if (method === "POST" && rest === "/variables") {
        const key = String(body.key ?? "");
        if (variables.has(key)) {
          send(400, { message: { key: [`(${key}) has already been taken`] } });
          return;
        }
        variables.set(key, body);
        send(201, body);
        return;
      }
      const variable = /^\/variables\/([A-Za-z0-9_]+)$/.exec(rest);
      if (variable?.[1] && method === "GET") {
        const kept = variables.get(variable[1]);
        if (!kept) send(404, { message: "404 Variable Not Found" });
        else send(200, { ...kept, value: undefined });
        return;
      }
      if (variable?.[1] && method === "PUT") {
        if (!variables.has(variable[1])) send(404, { message: "404 Variable Not Found" });
        else {
          variables.set(variable[1], { key: variable[1], ...body });
          send(200, { key: variable[1], ...body });
        }
        return;
      }
      send(404, { message: "404 Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v4`,
    env: {
      INFINITARY_GITLAB_API_URL: `http://127.0.0.1:${port}/api/v4`,
      INFINITARY_GITLAB_OAUTH_URL: `http://127.0.0.1:${port}`,
    },
    /** Every request, `METHOD /path` (query dropped). */
    requests: () => [...requests],
    /** Every merge GitLab accepted, in order; a refused one is only a request. */
    merges: () => [...merges],
    /** Every project upload GitLab kept, in order, byte for byte. */
    uploads: () => uploads.map((upload) => ({ ...upload, bytes: Buffer.from(upload.bytes) })),
    /** Every quick action line GitLab ran from a description, in order. */
    quickActions: () => [...quickActions],
    /** Each merge request's description as GitLab holds it now, by its number. */
    descriptions: () =>
      new Map([...mergeRequests.values()].map((request) => [request.iid, request.description])),
    /** Turn the project's "Require authentication to view media files" on or off. */
    protectMedia: (on: boolean) => {
      mediaProtected = on;
    },
    /** The project's audience, as its settings would change it. */
    setVisibility: (visibility: "private" | "internal" | "public") => {
      project.visibility = visibility;
    },
    /** The version a branch carries where the project lives: every merge request's live head. */
    headOf: (reader: (branch: string) => string) => {
      headOf = reader;
    },
    /**
     * The pipelines GitLab runs for each merge request: one branch pipeline
     * whose one job passed unless the test names others.
     */
    setPipelines: (next: GitLabStubPipeline[]) => {
      pipelines = next;
    },
    /** Pipelines the project ran before, by ref and source: a project that runs CI. */
    setHistory: (next: { ref: string; source: string }[]) => {
      history = next;
    },
    /** Which heads conflict with newer work on main: GitLab refuses their merge (422). */
    conflicts: (next: (head: string) => boolean) => {
      conflicted = next;
    },
    /** Runs when a merge request arrives, before GitLab compares heads. */
    onMergeRequest: (apply: () => void) => {
      onMergeRequest = apply;
    },
    /** Open a merge request as a person would on GitLab's own page, for a change the app finds. */
    openMergeRequest: (input: { branch: string; title: string; description?: string }) => {
      const request: StubMergeRequest = {
        iid: nextIid++,
        branch: input.branch,
        title: input.title,
        description: input.description ?? "",
        state: "opened",
      };
      mergeRequests.set(request.iid, request);
      return request.iid;
    },
    /** Every commit status GitLab holds on a version, oldest first. */
    statuses: (sha: string) => (statuses.get(sha) ?? []).map((row) => ({ ...row })),
    /** Write a commit status as the queue's own job would, with its token. */
    setStatus: (sha: string, row: { name: string; status: string; description: string }) => {
      const kept = statuses.get(sha) ?? [];
      statuses.set(sha, [
        ...kept,
        {
          id: nextStatusId++,
          ...row,
          target_url: null,
          created_at: new Date(Date.UTC(2026, 9, 9, 12, 0, nextStatusId)).toISOString(),
        },
      ]);
    },
    /** Every pipeline the API started, in order. */
    pipelineStarts: () => started.map((start) => ({ ...start })),
    /** The project's files on its default branch. */
    serveFiles: (next: Record<string, string>) => {
      files.clear();
      for (const [path, text] of Object.entries(next)) files.set(path, text);
    },
    /** The queue's pause issue as the queue opened it, and who took it; null for none. */
    servePauseIssue: (next: GitLabStubIssue | null) => {
      pauseIssue = next;
    },
    /**
     * Hold issue-list responses only after the pause issue closes. Resume's
     * prerequisite reads and all writes still finish; the journey can see
     * its confirmation before releasing the sweep's truthful empty list.
     */
    holdClosedPauseReads: () => {
      if (closedPauseReads) throw new Error("Closed pause reads are already held.");
      const { promise, resolve } = deferred<void>();
      const held = {
        response: promise,
        waiting: false,
        release: () => {
          if (closedPauseReads === held) closedPauseReads = undefined;
          resolve();
        },
      };
      closedPauseReads = held;
      return { waiting: () => held.waiting, release: held.release };
    },
    /** The pause issue as GitLab holds it now, and every note written on it. */
    pauseIssue: () =>
      pauseIssue ? { ...pauseIssue, notes: notes.map((note) => note.body) } : null,
    /** The project's access tokens, without their secrets. */
    tokens: () => tokens.map((token) => ({ ...token })),
    /** One CI variable as the project keeps it, its value included. */
    variable: (key: string) => {
      const kept = variables.get(key);
      return kept ? { ...kept } : undefined;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        closedPauseReads?.release();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export type GitLabStub = Awaited<ReturnType<typeof startGitLabStub>>;
