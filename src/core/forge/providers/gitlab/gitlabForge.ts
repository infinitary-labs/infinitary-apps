import { forgePlace } from "@shared/forge";
import type { ForgeProject } from "@shared/forges";
import { requireConventional } from "../../../workspace/conventional";
import type { ForgeApi } from "../../api";
import {
  checkTimes,
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  type ForgeLocation,
  type ForgePull,
  type ForgeReadiness,
  ForgeWriteError,
  isFullCommitId,
} from "../../forge";
import { gitLabReleaseUpload, nextGitLabPagePath, parseGitLabApiRequest } from "./api";
import { GitLabAttachments } from "./attachments";
import { GITLAB_READ_MAX_BYTES, GitLabClient, type GitLabOptions } from "./client";
import { GitLabProjects } from "./projects";
import { GitLabWorkflows } from "./workflows";

/**
 * GitLab over its REST API (`docs/forge.md`, "GitLab merge requests"), on
 * gitlab.com and on the person's own server, with the key the person made
 * there (`./signIn.ts`). A proposed change is a merge request onto the
 * default branch, named `!N`; its checks are the pipelines GitLab ran for
 * the change's head; putting it in is GitLab's squash merge, only while the
 * merge request is still at the checked head (`sha`).
 *
 * The checks are read for one head, never for an earlier one, and never
 * read green while a pipeline GitLab will run for it has not finished:
 * - every pipeline on the head counts - a branch pipeline, a merge request
 *   pipeline - and so does a merged-results or merge-train pipeline, whose
 *   own commit is a merge of the head into the target branch (read through
 *   the commit's parents, never assumed); a later pipeline on the same ref
 *   for the same head stands for that ref, the way a rerun does;
 * - each counted pipeline is one check, and each of its jobs another: a
 *   running, created or scheduled one is pending; a manual job a person
 *   must start is held (neutral), never a pass; a job the project allows to
 *   fail, or a manual job it marks optional, does not hold the change;
 * - a merge request whose pipelines ran for earlier heads, or a project
 *   that runs pipelines for merge requests or branches, has an empty list
 *   only while its pipeline has not started: that reads pending.
 *
 * The same pipelines are a crewmate's evidence - a job's log and its
 * artifacts archive (`./workflows.ts`) - and the same API its gateway,
 * under GitLab's own policy (`./api.ts`).
 */

type MergeRequestJson = {
  iid: number;
  project_id?: number;
  source_project_id?: number;
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string | null;
  web_url: string;
  /** `opened`, `closed`, `locked` (GitLab is merging it) or `merged`. */
  state: string;
  sha?: string | null;
  diff_refs?: { head_sha?: string | null } | null;
  draft?: boolean;
  work_in_progress?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  has_conflicts?: boolean;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merge_error?: string | null;
};

type PipelineJson = { id: number; sha: string; ref: string; status: string; source?: string };

type JobJson = {
  id: number;
  name: string;
  status: string;
  allow_failure?: boolean;
  started_at?: string | null;
  finished_at?: string | null;
};

/** GitLab's page size for a list read that names no `per_page`. */
const GITLAB_DEFAULT_PER_PAGE = 20;
/** The most job pages one pipeline's reading follows (100 per page). */
const MAX_JOB_PAGES = 5;
/** The most merged-result commits one reading opens to find the head among their parents. */
const MAX_MERGE_COMMIT_READS = 6;

/** A merge request's own refs: its head, its merged result, its merge train. */
const MERGE_REQUEST_REF = /^refs\/merge-requests\/(\d+)\/(head|merge|train)$/;

export class GitLabForge implements Forge {
  readonly kind = "gitlab" as const;
  readonly host: string;
  /** "GitLab", or a self-hosted server's own address. */
  readonly place: string;
  readonly hasChecks = true;
  readonly nestedNamespace = true;
  /** Pipelines, job logs and artifacts archives, by pipeline and job ids. */
  readonly workflows: GitLabWorkflows;
  /** The gateway's raw call under GitLab's policy for this project. */
  readonly api: ForgeApi;
  /** Native story uploads (INF-132), on gitlab.com alone: a server's own host keeps its delivery. */
  readonly attachments?: GitLabAttachments;
  private readonly client: GitLabClient;
  private readonly projects: GitLabProjects;

  constructor(
    readonly location: ForgeLocation,
    private readonly options: GitLabOptions,
  ) {
    this.host = location.host ?? "gitlab.com";
    this.place = forgePlace({ kind: "gitlab", host: this.host }) ?? this.host;
    this.client = new GitLabClient(this.host, options);
    this.projects = new GitLabProjects(this.host, options);
    this.workflows = new GitLabWorkflows(this.client, () => this.projectPath());
    const project = location.owner && location.name ? `${location.owner}/${location.name}` : null;
    this.api = {
      place: this.place,
      defaultPerPage: GITLAB_DEFAULT_PER_PAGE,
      route: (method, raw, bodyBytes) => parseGitLabApiRequest(method, raw, project, bodyBytes),
      nextPath: (link) => nextGitLabPagePath(link, options.apiBaseUrl, project),
      call: (method, path, body) => this.client.call(method, path, body),
      releaseUpload: (raw) => gitLabReleaseUpload(raw, project),
      upload: (route, file) => this.client.upload(route.path, file),
    };
    if (this.host === "gitlab.com" && project) {
      this.attachments = new GitLabAttachments({
        fullName: project,
        apiBaseUrl: options.apiBaseUrl,
        token: options.token,
        readProject: () => this.read(this.projectPath()),
        fetch: options.fetch,
        unauthorized: () => this.client.unauthorized(),
      });
    }
  }

  listProjects(): Promise<ForgeProject[]> {
    return this.projects.listProjects();
  }

  listProjectsPaged(): Promise<{ projects: ForgeProject[]; complete: boolean }> {
    return this.projects.listProjectsPaged();
  }

  findProject(fullName: string): Promise<ForgeProject | null> {
    return this.projects.findProject(fullName);
  }

  async defaultBranch(): Promise<string> {
    const project = (await this.read(this.projectPath())) as { default_branch?: string | null };
    if (!project?.default_branch) {
      throw new ForgeError("not-found", `${this.place} named no default branch`);
    }
    return project.default_branch;
  }

  async openChange(input: {
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
    base?: string;
  }): Promise<ForgeChange> {
    const target =
      input.base ??
      (await this.defaultBranch().catch((error: unknown) => {
        throw new ForgeWriteError(
          "failed",
          error instanceof ForgeError ? error.failure : "transient",
          `Could not read the default branch on ${this.place}; no merge request was sent.${error instanceof Error ? ` ${error.message}` : ""}`,
        );
      }));
    const opened = (await this.client.write(
      "POST",
      `${this.projectPath()}/merge_requests`,
      {
        source_branch: input.branch,
        target_branch: target,
        title: input.draft ? `Draft: ${input.title}` : input.title,
        description: input.body,
      },
      "opening the merge request",
    )) as MergeRequestJson;
    return this.changeOf(opened);
  }

  async branchHead(branch: string): Promise<string> {
    let found: { commit?: { id?: unknown } } | null;
    try {
      found = (await this.read(
        `${this.projectPath()}/repository/branches/${encodeURIComponent(branch)}`,
      )) as { commit?: { id?: unknown } } | null;
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "sign-in") throw caught;
      throw new ForgeError(
        "refused",
        `The story's branch has not been confirmed on ${this.place}. Push the reviewed version first.`,
      );
    }
    const sha = found?.commit?.id;
    if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha))
      throw new ForgeError("refused", `${this.place} did not confirm the branch's code version.`);
    return sha;
  }

  /** GitLab has no conditional description write: reread first, and the caller reads it back after. */
  async updateChangeBody(change: ForgeChange, body: string, title?: string): Promise<void> {
    const iid = numbered(change, this.place);
    let fresh: MergeRequestJson;
    try {
      fresh = await this.mergeRequest(iid);
    } catch (error) {
      throw new ForgeWriteError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        `Could not reread merge request !${iid}; no description was sent.`,
      );
    }
    if (
      fresh.state !== "opened" ||
      (fresh.sha ?? fresh.diff_refs?.head_sha) !== change.headSha ||
      (fresh.description ?? "") !== (change.body ?? "") ||
      (title !== undefined && fresh.title !== change.title)
    )
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The merge request changed after it was read, so its description was not replaced. Read it again before updating.",
      );
    // A draft stays one: GitLab reads its marker from the title, before the change's own title.
    const marker = fresh.title.startsWith("Draft: ") ? "Draft: " : "";
    await this.client.write(
      "PUT",
      this.mergeRequestPath(iid),
      title === undefined
        ? { description: body }
        : { title: `${marker}${title}`, description: body },
      "replacing the description",
    );
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const listed = (await this.read(
      `${this.projectPath()}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&per_page=20`,
    )) as MergeRequestJson[];
    if (!Array.isArray(listed)) throw unreadable(this.place, "its merge requests");
    // A merge request from this project's own branch, never a fork's of the same name.
    const open = listed.find(
      (request) =>
        request.source_branch === branch &&
        (request.source_project_id === undefined ||
          request.project_id === undefined ||
          request.source_project_id === request.project_id),
    );
    return open ? this.changeOf(open) : null;
  }

  async checks(change: ForgeChange, movedPast?: string) {
    const iid = numbered(change, this.place);
    const head = movedPast ?? change.headSha;
    const ofRequest = await this.pipelines(`${this.mergeRequestPath(iid)}/pipelines?per_page=100`);
    const onHead = await this.pipelines(
      `${this.projectPath()}/pipelines?sha=${encodeURIComponent(head)}&per_page=100`,
    );
    const counted = await this.countedPipelines([...ofRequest, ...onHead], head, iid);
    const items: ForgeCheck[] = [];
    let complete =
      ofRequest.length < 100 &&
      onHead.length < 100 &&
      new Map([...ofRequest, ...onHead].map((pipeline) => [pipeline.id, pipeline])).size <=
        MAX_MERGE_COMMIT_READS;
    for (const pipeline of counted) {
      const read = await this.pipelineChecks(pipeline, counted.length > 1);
      items.push(...read.items);
      complete &&= read.complete;
    }
    return { items, complete };
  }

  /**
   * GitLab's commit read also resolves a short id or a branch, so its answer
   * must name `sha` itself (INF-1184); a 404 means no such commit only once
   * the project reads, as for GitHub.
   */
  async holdsCommit(sha: string): Promise<boolean> {
    if (!isFullCommitId(sha)) return false;
    const path = `${this.projectPath()}/repository/commits/${encodeURIComponent(sha)}`;
    try {
      const commit = (await this.read(path)) as { id?: unknown } | null;
      return commit?.id === sha;
    } catch (caught) {
      if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
    }
    await this.read(this.projectPath());
    return false;
  }

  /**
   * GitLab lists the branches that hold a commit (`refs`), not the ones it
   * heads, so each listed branch's own head decides; one deleted since the
   * list is at no version. A full page may hold more than it lists, so the
   * answer is then unknown.
   */
  async branchesAt(sha: string): Promise<string[]> {
    const refs = await this.read(
      `${this.projectPath()}/repository/commits/${encodeURIComponent(sha)}/refs?type=branch&per_page=100`,
    );
    if (!Array.isArray(refs)) throw unreadable(this.place, `the branches holding ${sha}`);
    if (refs.length >= 100) {
      throw new ForgeError(
        "transient",
        `${this.place} lists more branches holding ${sha} than the app reads.`,
      );
    }
    const at: string[] = [];
    for (const ref of refs as { name?: unknown }[]) {
      if (typeof ref?.name !== "string") continue;
      try {
        const branch = (await this.read(
          `${this.projectPath()}/repository/branches/${encodeURIComponent(ref.name)}`,
        )) as { commit?: { id?: unknown } } | null;
        if (branch?.commit?.id === sha) at.push(ref.name);
      } catch (caught) {
        if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
      }
    }
    return at;
  }

  async putIn(change: ForgeChange, headSha: string): Promise<{ sha?: string }> {
    const iid = numbered(change, this.place);
    const title = requireConventional(
      change.title ?? "",
      "pull request title",
      this.options.namingRule?.(),
    );
    // A saved story squashes under its plain summary, never its rendered evidence (INF-228 F2).
    const body = (change.squashMessage ?? change.body)?.trim() ?? "";
    // `sha` is GitLab's guard: the merge is refused (409) if the merge
    // request moved on after its checks were read.
    let answer = (await this.client.request(
      "PUT",
      `${this.mergeRequestPath(iid)}/merge`,
      { sha: headSha, squash: true, squash_commit_message: body ? `${title}\n\n${body}` : title },
      GITLAB_READ_MAX_BYTES,
    )) as MergeRequestJson | null;
    if (answer?.state !== "merged") {
      // A 200 is not a merge on its own: GitLab says merged, or it did not.
      const after = await this.mergeRequest(iid);
      // Locked is GitLab still merging: no verdict yet, so the caller reads it back.
      if (after.state === "locked") {
        throw new ForgeError("transient", `${this.place} is still merging !${iid}`);
      }
      if (after.state !== "merged") {
        throw new ForgeError(
          "refused",
          `${this.place} did not confirm the merge of !${iid}${after.merge_error ? `: ${after.merge_error}` : ""}`,
        );
      }
      answer = after;
    }
    const sha = answer.merge_commit_sha ?? answer.squash_commit_sha;
    return sha ? { sha } : {};
  }

  async markReady(change: ForgeChange, beforeSend: () => void): Promise<ForgeChange> {
    const request = await this.mergeRequest(numbered(change, this.place));
    const current = this.changeOf(request);
    if (
      current.headSha !== change.headSha ||
      current.branch !== change.branch ||
      request.state !== "opened"
    )
      throw new ForgeError(
        "refused",
        "The prerequisite merge request changed; review its current version first.",
      );
    if (!current.draft) return current;
    if (!request.title.startsWith("Draft: "))
      throw new ForgeError(
        "refused",
        "The draft title changed; read the merge request before making it ready.",
      );
    const updated = (await this.client.request(
      "PUT",
      this.mergeRequestPath(request.iid),
      { title: request.title.slice("Draft: ".length) },
      GITLAB_READ_MAX_BYTES,
      beforeSend,
    )) as MergeRequestJson;
    const ready = this.changeOf(updated);
    if (ready.draft)
      throw new ForgeError(
        "refused",
        "GitLab did not confirm the draft is ready; read its state before another request.",
      );
    return ready;
  }

  async pull(number: number): Promise<ForgePull> {
    const request = await this.mergeRequest(number);
    const merged = request.state === "merged";
    const mergedSha = request.merge_commit_sha ?? request.squash_commit_sha;
    return {
      number: request.iid,
      // Locked is a merge GitLab is still making: open until it reads merged.
      state: request.state === "opened" || request.state === "locked" ? "open" : "closed",
      merged,
      ...(merged && mergedSha ? { mergedSha } : {}),
      headSha: headOf(request, this.place),
      base: request.target_branch,
      ...(request.source_branch ? { branch: request.source_branch } : {}),
      ...(request.title ? { title: request.title } : {}),
      readiness: readinessOf(request),
      mergeable: null,
      mergeableState: request.detailed_merge_status ?? request.merge_status,
    };
  }

  async close(change: ForgeChange): Promise<void> {
    await this.client.request(
      "PUT",
      this.mergeRequestPath(numbered(change, this.place)),
      { state_event: "close" },
      GITLAB_READ_MAX_BYTES,
    );
  }

  label(change: ForgeChange): string {
    return change.number !== undefined ? `!${change.number}` : change.branch;
  }

  url(change: ForgeChange): string | null {
    return change.url;
  }

  private changeOf(request: MergeRequestJson): ForgeChange {
    return {
      number: request.iid,
      ...(request.draft === true ||
      request.work_in_progress === true ||
      request.title.startsWith("Draft: ")
        ? { draft: true }
        : {}),
      url: request.web_url,
      branch: request.source_branch,
      headSha: headOf(request, this.place),
      title: request.title,
      body: request.description ?? "",
      base: request.target_branch,
    };
  }

  private async mergeRequest(iid: number): Promise<MergeRequestJson> {
    const request = (await this.read(this.mergeRequestPath(iid))) as MergeRequestJson | null;
    if (!request || typeof request.iid !== "number") {
      throw unreadable(this.place, `merge request !${iid}`);
    }
    return request;
  }

  private async pipelines(path: string): Promise<PipelineJson[]> {
    const listed = await this.read(path);
    if (!Array.isArray(listed)) throw unreadable(this.place, "its pipelines");
    return listed as PipelineJson[];
  }

  /**
   * The pipelines that speak for the head: the newest pipeline on each ref
   * whose commit is the head, or - for a merged result or merge train - a
   * merge of the head.
   */
  private async countedPipelines(
    listed: PipelineJson[],
    head: string,
    iid: number,
  ): Promise<PipelineJson[]> {
    const byId = new Map(listed.map((pipeline) => [pipeline.id, pipeline]));
    const newestFirst = [...byId.values()].sort((a, b) => b.id - a.id);
    const counted: PipelineJson[] = [];
    // A merged-result ref whose newest pipeline merged an earlier head holds
    // none for this one yet: older pipelines there are older still.
    let opened = 0;
    for (const pipeline of newestFirst) {
      if (pipeline.sha === head) {
        counted.push(pipeline);
        continue;
      }
      const ref = MERGE_REQUEST_REF.exec(pipeline.ref);
      if (!ref || Number(ref[1]) !== iid || ref[2] === "head") continue;
      if (opened >= MAX_MERGE_COMMIT_READS) continue;
      opened += 1;
      if (await this.mergesHead(pipeline.sha, head)) counted.push(pipeline);
    }
    return counted.sort((a, b) => a.id - b.id);
  }

  /** Whether a merged-result commit merges the head: the head is one of its parents. */
  private async mergesHead(sha: string, head: string): Promise<boolean> {
    try {
      const commit = (await this.read(
        `${this.projectPath()}/repository/commits/${encodeURIComponent(sha)}`,
      )) as { parent_ids?: string[] } | null;
      return commit?.parent_ids?.includes(head) === true;
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return false;
      throw caught;
    }
  }

  /** A pipeline as checks: the pipeline itself, then each of its jobs (latest attempts only). */
  private async pipelineChecks(
    pipeline: PipelineJson,
    several: boolean,
  ): Promise<{ items: ForgeCheck[]; complete: boolean }> {
    const what = pipelineKind(pipeline.ref);
    const items: ForgeCheck[] = [
      {
        name: `pipeline #${pipeline.id} (${what})`,
        state: pipelineState(pipeline.status),
        run: pipeline.id,
        event: pipeline.source,
        status: pipeline.status,
        ref: pipeline.ref,
      },
    ];
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      const jobs = await this.read(
        `${this.projectPath()}/pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(jobs)) throw unreadable(this.place, `pipeline #${pipeline.id}'s jobs`);
      for (const job of jobs as JobJson[]) {
        const check = {
          ...jobCheck(job),
          ...checkTimes(job.started_at, job.finished_at),
          run: pipeline.id,
          event: pipeline.source,
          ref: pipeline.ref,
        };
        items.push(several ? { ...check, name: `${check.name} [${what}]` } : check);
      }
      if (jobs.length < 100) return { items, complete: true };
    }
    return { items, complete: false };
  }

  private read(path: string): Promise<unknown> {
    return this.client.request("GET", path, undefined, GITLAB_READ_MAX_BYTES);
  }

  private projectPath(): string {
    if (!this.location.owner || !this.location.name) {
      throw new ForgeError(
        "not-found",
        `the project's address on ${this.place} names no group and name`,
      );
    }
    return `/projects/${encodeURIComponent(`${this.location.owner}/${this.location.name}`)}`;
  }

  private mergeRequestPath(iid: number): string {
    return `${this.projectPath()}/merge_requests/${iid}`;
  }
}

function numbered(change: ForgeChange, place: string): number {
  if (change.number === undefined) {
    throw new ForgeError("unsupported", `${change.branch} has no merge request on ${place}`);
  }
  return change.number;
}

function headOf(request: MergeRequestJson, place: string): string {
  const head = request.sha ?? request.diff_refs?.head_sha;
  if (!head) {
    throw new ForgeError(
      "transient",
      `${place} has not read merge request !${request.iid}'s head yet`,
    );
  }
  return head;
}

function unreadable(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}

/** Which of the change's pipelines a ref is, in the crewmate's words. */
function pipelineKind(ref: string): string {
  const kind = MERGE_REQUEST_REF.exec(ref)?.[2];
  if (kind === "head") return "merge request";
  if (kind === "merge") return "merged result";
  if (kind === "train") return "merge train";
  return "branch";
}

/** A pipeline's status: finished ones decide, a blocked manual one holds, everything else runs. */
function pipelineState(status: string): ForgeCheckState {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
      return "neutral";
    default:
      return "pending";
  }
}

/**
 * One job as a check. A job the project lets fail, or a manual job it marks
 * optional, does not hold the change - its name says so; a manual job that
 * blocks the pipeline is held until a person starts it.
 */
function jobCheck(job: JobJson): ForgeCheck {
  return {
    name: job.name,
    state: pipelineState(job.status),
    status: job.status,
    ...(typeof job.allow_failure === "boolean" ? { allowFailure: job.allow_failure } : {}),
  };
}

/** GitLab statuses that are a rule holding the merge, not a conflict or a computation. */
const BLOCKED = new Set([
  "ci_must_pass",
  "ci_still_running",
  "commits_status",
  "discussions_not_resolved",
  "external_status_checks",
  "jira_association_missing",
  "locked_lfs_files",
  "locked_paths",
  "merge_request_blocked",
  "merge_time",
  "not_approved",
  "requested_changes",
  "security_policy_pipeline_check",
  "security_policy_violations",
  "status_checks_must_pass",
  "title_regex",
]);

/**
 * GitLab's `detailed_merge_status` in the seam's terms: `mergeable` may
 * merge; `conflict` and `need_rebase` need the change brought up to date;
 * a draft is a draft; a rule (an approval, a discussion, a required
 * pipeline) blocks; GitLab still checking is computing. A server older than
 * `detailed_merge_status` answers `merge_status`. Anything the app cannot
 * place reads computing, never clean.
 */
function readinessOf(request: MergeRequestJson): ForgeReadiness {
  const status = request.detailed_merge_status;
  if (request.state === "locked") return "computing";
  if (request.draft === true || request.work_in_progress === true || status === "draft_status") {
    return "draft";
  }
  if (status === "conflict" || request.has_conflicts === true) return "conflict";
  if (status === "need_rebase") return "behind";
  if (status === "mergeable") return "clean";
  if (status && BLOCKED.has(status)) return "blocked";
  if (status) return "computing";
  if (request.merge_status === "can_be_merged") return "clean";
  if (request.merge_status === "cannot_be_merged") return "conflict";
  return "computing";
}
