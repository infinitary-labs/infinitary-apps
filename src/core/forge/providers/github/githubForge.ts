import { BATCH_BRANCH_PREFIX, type MergeWay, type MergeWays } from "@shared/batches";
import { CONTRIBUTION_MERGE_REFUSAL } from "@shared/contributions";
import { settingFrom } from "@shared/envSettings";
import { forgePlace, GITHUB_COM, isGitHubEnterpriseCloud } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { cutText } from "@shared/textCut";
import type { NamingRule } from "../../../../shared/runbooks";
import { GITHUB_QUEUE_PART, readQueueStamp } from "../../../queue/shipped";
import { MERGE_PERMISSIONS, WORKFLOW as QUEUE_WORKFLOW } from "../../../queue/shipped/github.mjs";
import {
  commitEnvelope,
  NAMING_DECISION,
  newestTrustedApproval,
  revocationEnvelope,
} from "../../../queue/shipped/message.mjs";
import { PAUSE_LABEL, REMOVED, readPauseMarker } from "../../../queue/shipped/rules.mjs";
import { requireNamed } from "../../../workspace/naming";
import {
  type ApiProject,
  type ApiRoute,
  type ForgeApi,
  type ForgeApiResponse,
  gatewayAnswerBytes,
  nextPagePath,
  parseApiRequest,
  type ReleaseUpload,
} from "../../api";
import {
  allowanceResetOf,
  checkTimes,
  type Forge,
  ForgeAllowanceSpent,
  ForgeBaseMoved,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgeChecks,
  ForgeError,
  type ForgeLocation,
  type ForgeProject,
  type ForgePull,
  type ForgeQueueApproval,
  type ForgeQueueMark,
  type ForgeQueuePause,
  type ForgeQueueStart,
  type ForgeReadiness,
  type ForgeRuleset,
  type ForgeSkipMerge,
  ForgeWriteError,
  isFullCommitId,
  isSignInForgeFailure,
  isTransientForgeFailure,
  type MergeAnswer,
  ownChecksOf,
  QUEUE_STATUS,
  QUEUE_WAITING_WORDS,
  type QueueWorkflow,
} from "../../forge";
import { waysUnderRules } from "../../mergeWays";
import { RELEASE_UPLOAD_TIMEOUT_MS } from "../../releaseFile";
import type { ArchiveRanges } from "../../workflows";
import { GitHubAttachments, githubStoryDestination } from "./attachments";
import { GitHubContributions } from "./contributions";
import { GitHubWorkflows } from "./workflows";

/**
 * GitHub over its REST API (git integration PR 1.1), with the app's own
 * GitHub sign-in as a bearer token (PR 1.2: the device flow in `./oauth.ts`,
 * the store in `../../signIns.ts`). The composition root binds every
 * project on GitHub to one of these; nothing else on this Mac - no other
 * program's sign-in - is ever read.
 *
 * Reads checks and workflow identity as GitHub reports them.
 * Readiness, supersession and repair settlement are crew declarations.
 */

export const GITHUB_API_URL = "https://api.github.com";
/** GitHub's page size for a list read that names no `per_page`. */
const GITHUB_DEFAULT_PER_PAGE = 30;
const API_VERSION = "2022-11-28";
/** GitHub documents its asynchronous merge, the call every merge goes through, at this version. */
const ASYNC_MERGE_API_VERSION = "2026-03-10";
/** How long the app waits before each read of an asynchronous merge's result; after the last it calls the result unknown. */
const ASYNC_MERGE_READ_DELAYS_MS = [250, 500, 1000, 2000, 3000, 4000];
/** The most pages of a branch's rules a reading follows (100 a page). */
const MAX_RULE_PAGES = 5;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The API base: `INFINITARY_GITHUB_API_URL` in dev and e2e only, gated exactly
 * like the quota sensor's endpoint overrides, so a packaged app can never
 * be pointed anywhere but GitHub.
 */
export function githubApiBaseUrl(options: { packaged: boolean; env?: NodeJS.ProcessEnv }): string {
  const override = settingFrom(options.env ?? process.env, "GITHUB_API_URL")?.trim();
  return !options.packaged && override ? override.replace(/\/+$/, "") : GITHUB_API_URL;
}

/**
 * The API of any GitHub host (`docs/forge.md`, "GitHub Enterprise"):
 * github.com's own (`githubApiBaseUrl`); a GitHub Enterprise Cloud host's
 * `api.<name>.ghe.com`; any other GitHub Enterprise host's `/api/v3`.
 * `INFINITARY_GITHUB_ENTERPRISE_API_URL` stands in for every enterprise host's
 * API in dev and e2e only, gated like the github.com override.
 */
export function githubApiBaseFor(
  host: string,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): string {
  if (host === GITHUB_COM) return githubApiBaseUrl(options);
  const override = settingFrom(options.env ?? process.env, "GITHUB_ENTERPRISE_API_URL")?.trim();
  if (!options.packaged && override) return override.replace(/\/+$/, "");
  return isGitHubEnterpriseCloud(host) ? `https://api.${host}` : `https://${host}/api/v3`;
}

/**
 * Where a release file goes (`docs/forge.md`, "Release files"): github.com's
 * `uploads.github.com`, a GitHub Enterprise Cloud host's `uploads.<name>.ghe.com`,
 * or a GitHub Enterprise Server's `/api/uploads`. An unpackaged API stand-in
 * is not this address; the forge sends the file to the stand-in instead.
 */
export function githubUploadOrigin(host: string): string {
  if (host === GITHUB_COM) return "https://uploads.github.com";
  if (isGitHubEnterpriseCloud(host)) return `https://uploads.${host}`;
  return `https://${host}/api/uploads`;
}

const RELEASE_ASSET = /^releases\/\d+\/assets$/;

/** GitHub's GraphQL address beside a REST API base: `/api/graphql` on a GitHub Enterprise Server. */
export function githubGraphqlUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return base.endsWith("/api/v3") ? `${base.slice(0, -"/v3".length)}/graphql` : `${base}/graphql`;
}

export type GitHubForgeOptions = {
  /** The active naming runbook's rule, read at each use; absent or null, no naming runbook is on. */
  namingRule?: () => NamingRule | null;
  /** The person's GitHub sign-in, read at call time; undefined = not signed in. */
  token: () => Promise<string | undefined>;
  /**
   * GitHub refused the sign-in (a 401). The sign-in service asks GitHub
   * again before anything says "sign in again": one refusal is a reason to
   * look, the health read is the proof.
   */
  onSignInRejected?: () => void;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  /** The wait between reads of an asynchronous merge's result; a test's stand-in skips it. */
  sleep?: (ms: number) => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type PullJson = {
  node_id?: string;
  draft?: boolean;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  head: { sha: string; ref: string; repo?: { full_name?: string; id?: number } | null };
  base?: { ref: string };
};

/** The fields of one pull request read by its number that say whether it may merge. */
type PullStateJson = PullJson & {
  updated_at?: string;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  draft?: boolean;
  base: { ref: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
};

/** GitHub's answer to an asynchronous merge, and to reading its result. */
type AsyncMergeJson = {
  status?: string;
  details?: { uuid?: string; message?: string; sha?: string };
};

/**
 * The most check pages a reading follows (100 per page). A suite past that
 * is not read as complete: one pending item stands for the rest, so a
 * reading the app could not finish never reads green.
 */
const MAX_CHECK_PAGES = 10;
/** The most repos one listing reads (100 a page). */
const MAX_LISTED_PROJECTS = 1000;

type CheckRunJson = {
  name: string;
  status: string;
  conclusion: string | null;
  check_suite?: { id: number } | null;
  started_at?: string | null;
  completed_at?: string | null;
};

/** A commit status: posted at `created_at`, last changed at `updated_at`. */
type StatusJson = {
  id?: number;
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string;
};
type WorkflowJson = { path?: string; state?: string };
type PauseIssueJson = {
  body?: string | null;
  html_url?: string;
  assignee?: { login?: string } | null;
  assignees?: { login?: string }[] | null;
};

/** The workflow run a check suite belongs to, as far as superseding needs it. */
type SuiteRunJson = {
  id?: number;
  name?: string;
  check_suite_id: number;
  workflow_id: number;
  event: string;
  run_number: number;
  status: string;
  run_started_at?: string | null;
};

export class GitHubForge implements Forge {
  readonly kind = "github" as const;
  readonly host: string | null;
  /** "GitHub", or a GitHub Enterprise host's own address. */
  readonly place: string;
  readonly hasChecks = true;
  readonly workflows: GitHubWorkflows;
  readonly attachments?: GitHubAttachments;
  readonly api: ForgeApi;
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(
    readonly location: ForgeLocation,
    private readonly options: GitHubForgeOptions,
  ) {
    this.host = location.host;
    this.place = forgePlace({ kind: "github", host: location.host ?? GITHUB_COM }) ?? "GitHub";
    this.api = {
      place: this.place,
      defaultPerPage: GITHUB_DEFAULT_PER_PAGE,
      route: (method, raw, bodyBytes) => parseApiRequest(method, raw, this.apiProject(), bodyBytes),
      nextPath: (link) => nextPagePath(link, this.base, this.apiProject()),
      call: (method, path, body) => this.apiCall(method, path, body),
      releaseUpload: (raw, filename) => this.releaseUploadRoute(raw, filename),
      upload: (route, file) => this.uploadRelease(route, file),
    };
    this.base = (options.apiBaseUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
    if (location.host === GITHUB_COM && location.owner && location.name) {
      this.attachments = new GitHubAttachments({
        fullName: `${location.owner}/${location.name}`,
        token: options.token,
        readRepository: async () => {
          const answer = await this.apiCall("GET", this.repoPath());
          if (answer.status !== 200)
            throw new ForgeError(
              answer.status === 401 ? "sign-in" : answer.status === 403 ? "permission" : "refused",
              `GitHub did not confirm the evidence destination (${answer.status}).`,
            );
          return JSON.parse(answer.body) as unknown;
        },
        uploadBaseUrl: this.uploadOrigin(),
        fetch: this.fetcher,
        // A key GitHub still answers for makes the upload's 401 a permission;
        // the read's own 401 asks the health service to look again.
        unauthorized: async () => {
          const answer = await this.apiCall("GET", "/user").catch(() => undefined);
          if (answer === undefined) options.onSignInRejected?.();
          return answer?.status === 200 ? "permission" : "sign-in";
        },
      });
    }
    this.workflows = new GitHubWorkflows(
      () => this.repoPath(),
      (path) => this.request("GET", path),
      (path, maxBytes) => this.downloadBytes(path, maxBytes),
      (path, size) => this.archiveRanges(path, size),
    );
  }

  get contributions() {
    return new GitHubContributions(this.repoPath(), async (method, path, body) => {
      if (method !== "POST") return this.request(method, path, body);
      let attempted = false;
      let refused = false;
      try {
        return await this.request(
          method,
          path,
          body,
          API_VERSION,
          () => {
            attempted = true;
          },
          undefined,
          (status) => {
            refused = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(status);
          },
        );
      } catch (error) {
        throw new ForgeWriteError(
          !attempted || refused ? "failed" : "uncertain",
          error instanceof ForgeError ? error.failure : "transient",
          error instanceof ForgeError
            ? error.message
            : `${this.place}'s fork-creation answer could not be read.`,
        );
      }
    });
  }

  private requireMaintainer(): void {
    if (this.location.source) throw new ForgeError("permission", CONTRIBUTION_MERGE_REFUSAL);
  }

  private sourcePath(): string {
    return this.location.source ? `/repos/${this.location.source.fullName}` : this.repoPath();
  }

  async storyDestination() {
    const fullName = `${this.location.owner}/${this.location.name}`;
    const destination = githubStoryDestination(
      await this.request("GET", this.repoPath()),
      fullName,
      this.host ?? GITHUB_COM,
      this.location.source ? "describe" : "upload",
    );
    return {
      ...destination,
      format: this.kind,
      ...(this.location.source ? { media: "card-only" as const } : {}),
    };
  }

  /**
   * Every repo the sign-in lists, newest change first, 100 a page up to
   * `MAX_LISTED_PROJECTS`; `complete` is false when GitHub had more.
   */
  async listProjects(): Promise<ForgeProject[]> {
    return (await this.listProjectsPaged()).projects;
  }

  async listProjectsPaged(): Promise<{ projects: ForgeProject[]; complete: boolean }> {
    const projects: ForgeProject[] = [];
    for (let page = 1; page <= MAX_LISTED_PROJECTS / 100; page++) {
      const repos = (await this.request(
        "GET",
        `/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`,
      )) as {
        full_name: string;
        clone_url: string;
        html_url?: string;
        updated_at?: string;
        private?: boolean;
      }[];
      projects.push(
        ...repos.map((repo) => ({
          fullName: repo.full_name,
          cloneUrl: repo.clone_url,
          url: repo.html_url ?? null,
          updatedAt: repo.updated_at ?? null,
          private: repo.private === true,
        })),
      );
      if (repos.length < 100) return { projects, complete: true };
    }
    return { projects, complete: false };
  }

  /** One repo by its exact owner/name, or null when the sign-in cannot see it. */
  async findProject(fullName: string): Promise<ForgeProject | null> {
    const [owner, name, ...extra] = fullName.split("/");
    if (!owner || !name || extra.length > 0) return null;
    try {
      const repo = (await this.request(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      )) as {
        full_name: string;
        clone_url: string;
        html_url?: string;
        updated_at?: string;
        private?: boolean;
      };
      return {
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        url: repo.html_url ?? null,
        updatedAt: repo.updated_at ?? null,
        private: repo.private === true,
      };
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return null;
      throw caught;
    }
  }

  async defaultBranch(): Promise<string> {
    const repo = (await this.request("GET", this.repoPath())) as { default_branch?: string };
    if (!repo.default_branch) throw new ForgeError("not-found", "GitHub named no default branch");
    return repo.default_branch;
  }

  async openChange(input: {
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
    base?: string;
  }): Promise<ForgeChange> {
    const base =
      input.base ??
      (await this.defaultBranch().catch((error: unknown) => {
        throw new ForgeWriteError(
          "failed",
          error instanceof ForgeError ? error.failure : "transient",
          "Could not read the base branch; no pull request was sent.",
        );
      }));
    const answer = await this.apiCall(
      "POST",
      `${this.repoPath()}/pulls`,
      JSON.stringify({
        title: input.title,
        head: this.location.source
          ? `${this.location.source.fullName.split("/")[0]}:${input.branch}`
          : input.branch,
        ...(this.location.source
          ? { head_repo: this.location.source.fullName.split("/").at(-1) }
          : {}),
        base,
        body: input.body,
        ...(input.draft ? { draft: true } : {}),
      }),
    );
    if (answer.status !== 201)
      throw changeWriteError(answer.status, "opening the pull request", answer.body);
    return changeOf(JSON.parse(answer.body) as PullJson, input.branch);
  }

  async branchChecks(): Promise<{ sha: string; checks: ForgeChecks }> {
    const branch = await this.defaultBranch();
    const sha = await this.readBranchHead(branch, this.repoPath());
    return { sha, checks: await this.checks({ branch, headSha: sha, url: null }) };
  }

  async branchHead(branch: string): Promise<string> {
    return this.readBranchHead(branch, this.sourcePath());
  }

  private async readBranchHead(branch: string, project: string): Promise<string> {
    const answer = await this.apiCall(
      "GET",
      `${project}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (answer.status !== 200)
      throw new ForgeError(
        "refused",
        "The story's branch has not been confirmed on GitHub. Push the reviewed version first.",
      );
    const value = JSON.parse(answer.body) as { object?: { type?: string; sha?: string } };
    if (value.object?.type !== "commit" || !/^[0-9a-f]{40,64}$/.test(value.object.sha ?? ""))
      throw new ForgeError("refused", "GitHub did not confirm the branch's code version.");
    return value.object.sha as string;
  }

  async updateChangeBody(change: ForgeChange, body: string, title?: string): Promise<void> {
    const path = `${this.repoPath()}/pulls/${numbered(change)}`;
    const fresh = await this.apiCall("GET", path).catch((error: unknown) => {
      throw new ForgeWriteError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        "Could not reread the pull request; no description was sent.",
      );
    });
    if (fresh.status !== 200)
      throw new ForgeWriteError(
        "failed",
        "refused",
        "Could not reread the pull request before replacing its description.",
      );
    let pull: PullStateJson;
    try {
      pull = JSON.parse(fresh.body) as PullStateJson;
    } catch {
      throw new ForgeWriteError(
        "failed",
        "refused",
        "GitHub did not return a readable pull request; no description was sent.",
      );
    }
    if (
      pull?.state !== "open" ||
      pull.head?.sha !== change.headSha ||
      (pull.body ?? "") !== (change.body ?? "") ||
      (title !== undefined && pull.title !== change.title)
    )
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The pull request changed after it was read, so its description was not replaced. Read it again before updating.",
      );
    const answer = await this.apiCall(
      "PATCH",
      path,
      JSON.stringify(title === undefined ? { body } : { title, body }),
    );
    if (answer.status !== 200)
      throw changeWriteError(answer.status, "replacing the description", answer.body);
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const head = encodeURIComponent(
      `${this.location.source?.fullName.split("/")[0] ?? this.owner()}:${branch}`,
    );
    const pulls = (await this.request(
      "GET",
      `${this.repoPath()}/pulls?head=${head}&state=open&per_page=1`,
    )) as PullJson[];
    const pull = this.location.source
      ? pulls.find((item) => item.head.repo?.full_name === this.location.source?.fullName)
      : pulls[0];
    return pull ? changeOf(pull, branch) : null;
  }

  async checks(change: ForgeChange, movedPast?: string) {
    const sha = encodeURIComponent(movedPast ?? change.headSha);
    const runs = await this.pages<CheckRunJson>(
      `${this.repoPath()}/commits/${sha}/check-runs`,
      (page) => (page as { check_runs?: CheckRunJson[] }).check_runs ?? [],
    );
    const statuses = await this.pages<StatusJson>(
      `${this.repoPath()}/commits/${sha}/status`,
      (page) => (page as { statuses?: StatusJson[] }).statuses ?? [],
    );
    // Waiting jobs can have no check yet. Read the workflow runs once for
    // both that gap and superseded cancellations. Preserve a refused side list's
    // reason with the partial facts; existing sign-in/transient boundaries stay intact.
    let workflowRuns: { total_count?: number; workflow_runs?: SuiteRunJson[] } | null = null;
    let problem: string | undefined;
    try {
      workflowRuns = (await this.request(
        "GET",
        `${this.repoPath()}/actions/runs?head_sha=${sha}&per_page=100`,
      )) as { total_count?: number; workflow_runs?: SuiteRunJson[] };
    } catch (caught) {
      // F25: a passing network error is not a lasting refusal, with or without cancellations.
      if (
        isSignInForgeFailure(caught) ||
        isTransientForgeFailure(caught) ||
        allowanceResetOf(caught) !== undefined
      )
        throw caught;
      const why = caught instanceof Error ? caught.message : String(caught);
      problem =
        caught instanceof ForgeError && caught.failure === "permission"
          ? `${this.place} refused access to the remaining checks. ${why}`
          : `${this.place} could not provide all check runs: ${why}`;
    }
    const workflows = workflowRuns?.workflow_runs ?? [];
    const read: ForgeCheck[] = [
      ...this.withoutSupersededCancellations(runs.items, workflows),
      ...statuses.items.map((status) => {
        const state = STATUS_STATES[status.state] ?? ("pending" as const);
        // A status starts when it was first posted; a settled one finished at its last change.
        return {
          name: status.context,
          state,
          ...checkTimes(status.created_at, state === "pending" ? null : status.updated_at),
          ...(typeof status.id === "number" ? { statusId: status.id } : {}),
          ...(status.description ? { detail: status.description } : {}),
          ...(status.target_url ? { link: status.target_url } : {}),
        };
      }),
    ];
    for (const run of workflows) {
      if (run.status !== "completed") {
        read.push({
          name: `${run.name ?? "workflow"} (run ${run.run_number})`,
          state: "pending",
          run: run.id,
          workflow: run.workflow_id,
          event: run.event,
          ...checkTimes(run.run_started_at, null),
        });
      }
    }
    // A pull request's checks are the runs it started (INF-1891), and a
    // batch's the runs its own pushed branch started too; a branch's own
    // checks, read with no number, keep every run at its version.
    const items =
      change.number !== undefined
        ? ownChecksOf(read, change.branch.startsWith(BATCH_BRANCH_PREFIX))
        : read;
    return {
      items,
      ...(problem ? { problem } : {}),
      complete:
        runs.complete &&
        statuses.complete &&
        workflowRuns !== null &&
        (workflowRuns.total_count ?? workflows.length) <= workflows.length,
    };
  }

  /** Captain F26: restore main's same-workflow/event cancellation filter, preserving available facts. */
  private withoutSupersededCancellations(
    runs: CheckRunJson[],
    workflowRuns: SuiteRunJson[],
  ): ForgeCheck[] {
    const read = runs.map((run) => {
      const workflow = workflowRuns.find((item) => item.check_suite_id === run.check_suite?.id);
      return {
        run,
        check: {
          name: run.name,
          state: runState(run),
          status: run.status,
          conclusion: run.conclusion,
          ...checkTimes(run.started_at, run.completed_at),
          ...(workflow
            ? { run: workflow.id, workflow: workflow.workflow_id, event: workflow.event }
            : {}),
        },
      };
    });
    if (!read.some(({ check }) => check.state === "cancelled")) {
      return read.map(({ check }) => check);
    }
    const bySuite = new Map(workflowRuns.map((run) => [run.check_suite_id, run]));
    const origin = (run: CheckRunJson) =>
      run.check_suite ? bySuite.get(run.check_suite.id) : undefined;
    return read.flatMap(({ run, check }): ForgeCheck[] => {
      const from = origin(run);
      if (check.state !== "cancelled" || !from) return [check];
      const later = workflowRuns.filter(
        (next) =>
          next.workflow_id === from.workflow_id &&
          next.event === from.event &&
          next.run_number > from.run_number,
      );
      if (later.length === 0) return [check];
      const decided = runs.some((other) => {
        const next = origin(other);
        return other.name === run.name && next !== undefined && later.includes(next);
      });
      if (decided) return [];
      // The later run holds no check of this name yet: pending until it
      // does, and still cancelled if it finished without one.
      return later.some((next) => next.status !== "completed")
        ? [{ name: check.name, state: "pending" }]
        : [check];
    });
  }

  /**
   * The Git database read answers only an exact full id: the commit reads
   * `checks` uses resolve a longer id to the commit its first 40 characters
   * name (INF-1184). GitHub answers 404 for a repository the sign-in cannot
   * see as well, so a 404 means no such commit only once the repository reads.
   */
  async holdsCommit(sha: string): Promise<boolean> {
    if (!isFullCommitId(sha)) return false;
    const path = `${this.repoPath()}/git/commits/${encodeURIComponent(sha)}`;
    try {
      const commit = (await this.request("GET", path)) as { sha?: string } | null;
      return commit?.sha === sha;
    } catch (caught) {
      if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
    }
    await this.request("GET", this.repoPath());
    return false;
  }

  /** GitHub's own list of the branches whose head is `sha`, which it answers whole. */
  async branchesAt(sha: string): Promise<string[]> {
    const listed = await this.request(
      "GET",
      `${this.repoPath()}/commits/${encodeURIComponent(sha)}/branches-where-head`,
    );
    if (!Array.isArray(listed)) {
      throw new ForgeError(
        "transient",
        `${this.place}'s list of the branches at ${sha} could not be read.`,
      );
    }
    return (listed as { name?: unknown }[]).flatMap((branch) =>
      typeof branch?.name === "string" ? [branch.name] : [],
    );
  }

  /**
   * Every page of a list GitHub answers 100 at a time, with its
   * `total_count`: read until the count is reached or a page comes back
   * short. `complete` is false when the count says more remain past the
   * last page the app reads.
   */
  private async pages<T>(
    path: string,
    itemsOf: (page: unknown) => T[],
  ): Promise<{ items: T[]; complete: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const answer = await this.request("GET", `${path}?per_page=100&page=${page}`);
      const listed = itemsOf(answer);
      items.push(...listed);
      const total = (answer as { total_count?: number } | null)?.total_count;
      if (listed.length < 100 || (total !== undefined && items.length >= total)) {
        return { items, complete: true };
      }
    }
    return { items, complete: false };
  }

  /**
   * GitHub's asynchronous merge (`PUT .../merge-async`) with the version
   * guard and GitHub's own choice of action: a branch with a merge queue
   * takes the pull request into it, and any other branch merges it directly.
   * A merge queue takes the version alone, so a request it refuses for
   * naming a merge method or commit words is followed by one that names
   * neither. A GitHub that does not know the call (an Enterprise Server
   * before it) answers 404 before anything is sent on, and gets the direct
   * merge.
   */
  async putIn(
    change: ForgeChange,
    headSha: string,
    way: MergeWay = "squash",
  ): Promise<MergeAnswer> {
    this.requireMaintainer();
    const path = `${this.repoPath()}/pulls/${numbered(change)}/merge`;
    // `sha` is GitHub's "match head commit" guard: the merge is refused if
    // the change moved on after its checks were read.
    const body = {
      sha: headSha,
      merge_method: way,
      // A rebase merge writes no commit of its own: each change keeps its own.
      ...(way === "rebase"
        ? {}
        : {
            commit_title: requireNamed(
              change.title ?? "",
              "pull request title",
              this.options.namingRule?.() ?? null,
            ),
            commit_message: change.squashMessage ?? change.body ?? "",
          }),
    };
    const first = await this.asyncMerge(`${path}-async`, body, {
      ordinary: true,
      direct: () => this.putInDirect(change, path, body),
    });
    if (first && "direct" in first) return first.direct;
    // A merge queue merges its own way and writes its own commit words, and
    // GitHub refuses a request to one that names either: a result that
    // failed, with nothing sent on. The version alone then goes to the
    // queue by name, an action that takes it into the queue or refuses it
    // and can never merge it another way.
    const reading =
      first?.status === "failed" && /\bmerge queue\b/i.test(first.details?.message ?? "")
        ? await this.asyncMerge(
            `${path}-async`,
            { sha: headSha, merge_action: "merge_queue" },
            { ordinary: true },
          )
        : first;
    if (reading?.status === "merged")
      return reading.details?.sha ? { sha: reading.details.sha } : {};
    if (reading?.status === "enqueued") return { queued: true };
    if (reading?.status === "failed") {
      const said = reading.details?.message ?? "";
      const what = `GitHub did not merge ${this.label(change)}${said ? `: ${said}` : ""}`;
      throw /^Base branch was modified\b/i.test(said)
        ? new ForgeBaseMoved(what)
        : new ForgeError("refused", what);
    }
    // Still running when the reads ended: unknown, so the pull request is read before anything else.
    throw new ForgeError(
      "transient",
      `${this.place} had not finished merging ${this.label(change)} when the app stopped reading`,
    );
  }

  /** The direct merge (`PUT .../merge`), for a GitHub without the asynchronous one. */
  private async putInDirect(change: ForgeChange, path: string, body: object): Promise<MergeAnswer> {
    const answer = (await this.request("PUT", path, body)) as {
      merged?: boolean;
      sha?: string;
      message?: string;
    } | null;
    // A 200 is not a merge on its own: GitHub says it merged, or it did not.
    if (answer?.merged !== true) {
      throw new ForgeError(
        "refused",
        `GitHub did not confirm the merge of ${this.label(change)}${answer?.message ? `: ${answer.message}` : ""}`,
      );
    }
    return answer.sha ? { sha: answer.sha } : {};
  }

  /**
   * Send one asynchronous merge and read its result by the id GitHub
   * returns until it is no longer pending or the reads end. Sent once: a
   * result the app could not read in time is unknown, never a reason to
   * send again. `ordinary` marks a merge within the rules, whose request
   * GitHub may answer with a merge of that pull request still running;
   * `direct` is the merge for a GitHub that does not know the call.
   */
  private async asyncMerge(
    path: string,
    body: object,
    how: { ordinary: true; direct: () => Promise<MergeAnswer> },
  ): Promise<AsyncMergeJson | { direct: MergeAnswer } | null>;
  private async asyncMerge(
    path: string,
    body: object,
    how?: { ordinary: true },
  ): Promise<AsyncMergeJson | null>;
  private async asyncMerge(
    path: string,
    body: object,
    how?: { ordinary: true; direct?: () => Promise<MergeAnswer> },
  ): Promise<AsyncMergeJson | { direct: MergeAnswer } | null> {
    let reading: AsyncMergeJson | null;
    try {
      reading = (await this.request("PUT", path, body, ASYNC_MERGE_API_VERSION)) as AsyncMergeJson;
    } catch (caught) {
      if (!(caught instanceof ForgeError)) throw caught;
      // A GitHub that does not know the call, or the version it is documented at, sent nothing on.
      const unknown =
        caught.failure === "not-found" ||
        /^GitHub answered 400 [^:]*: .*\bAPI version\b/i.test(caught.message);
      if (how?.direct && unknown) return { direct: await how.direct() };
      // A merge of this pull request is still running there: its outcome is
      // read, not sent again. A version that moved is GitHub's verdict instead.
      if (
        how?.ordinary &&
        /^GitHub answered 409 /.test(caught.message) &&
        !/: Head branch was modified\b/i.test(caught.message)
      )
        throw new ForgeError("transient", caught.message);
      throw caught;
    }
    for (const delay of ASYNC_MERGE_READ_DELAYS_MS) {
      const uuid = reading?.status === "pending" ? reading.details?.uuid : undefined;
      if (!uuid) break;
      await (this.options.sleep ?? sleep)(delay);
      try {
        reading = (await this.request(
          "GET",
          `${path}/${encodeURIComponent(uuid)}`,
          undefined,
          ASYNC_MERGE_API_VERSION,
        )) as AsyncMergeJson | null;
      } catch (caught) {
        // A result GitHub no longer keeps leaves the outcome unknown, like one still pending.
        if (caught instanceof ForgeError && caught.failure === "not-found") break;
        throw caught;
      }
    }
    return reading;
  }

  /** GitHub's own reading of its merge queue (`isInMergeQueue`), which its REST pull request does not carry. */
  async inHostQueue(number: number): Promise<boolean> {
    const answer = (await this.request(
      "POST",
      "",
      {
        query:
          "query Queued($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { isInMergeQueue } } }",
        variables: { owner: this.owner(), name: this.location.name as string, number },
      },
      API_VERSION,
      undefined,
      githubGraphqlUrl(this.base),
    )) as {
      errors?: unknown[];
      data?: { repository?: { pullRequest?: { isInMergeQueue?: boolean } | null } | null };
    } | null;
    const queued = answer?.data?.repository?.pullRequest?.isInMergeQueue;
    if (answer?.errors?.length || typeof queued !== "boolean")
      throw new ForgeError(
        "transient",
        `${this.place} did not say whether #${number} is in its merge queue`,
      );
    return queued;
  }

  async markReady(change: ForgeChange, beforeSend: () => void): Promise<ForgeChange> {
    const pull = (await this.request(
      "GET",
      `${this.repoPath()}/pulls/${change.number}`,
    )) as PullStateJson;
    if (
      pull.head.sha !== change.headSha ||
      pull.head.ref !== change.branch ||
      pull.state !== "open"
    )
      throw new ForgeError(
        "refused",
        "The prerequisite pull request changed; review its current version first.",
      );
    if (!pull.draft) return changeOf(pull, change.branch);
    if (!pull.node_id)
      throw new ForgeError("refused", "GitHub did not identify the draft pull request.");
    const answer = (await this.request(
      "POST",
      "",
      {
        query:
          "mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: pull.node_id },
      },
      API_VERSION,
      beforeSend,
      githubGraphqlUrl(this.base),
    )) as {
      errors?: unknown[];
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
    };
    if (
      answer.errors?.length ||
      answer.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false
    )
      throw new ForgeError(
        "refused",
        "GitHub did not confirm the draft is ready; read its state before another request.",
      );
    return { ...changeOf(pull, change.branch), draft: false };
  }

  async pull(number: number): Promise<ForgePull> {
    const pull = (await this.request("GET", `${this.repoPath()}/pulls/${number}`)) as PullStateJson;
    const merged = pull.merged === true;
    const headRepo = pull.head.repo?.full_name;
    return {
      number: pull.number,
      url: pull.html_url,
      state: pull.state === "open" ? "open" : "closed",
      merged,
      ...(merged && pull.merge_commit_sha ? { mergedSha: pull.merge_commit_sha } : {}),
      ...(pull.updated_at ? { updatedAt: pull.updated_at } : {}),
      headSha: pull.head.sha,
      base: pull.base.ref,
      ...(pull.head.ref ? { branch: pull.head.ref } : {}),
      ...(pull.title ? { title: pull.title } : {}),
      ...(headRepo ? { headRepo } : {}),
      ...(pull.head.repo?.id !== undefined ? { headRepoId: pull.head.repo.id } : {}),
      readiness: readinessOf(pull),
      mergeable: pull.mergeable ?? null,
      ...(pull.mergeable_state ? { mergeableState: pull.mergeable_state } : {}),
    };
  }

  /**
   * The active rule sets holding `branch` (`GET /rules/branches/{branch}`),
   * each read once for what this sign-in may skip (`current_user_can_bypass`).
   * A list longer than the app reads is refused, never read as complete.
   */
  async branchRules(branch: string): Promise<ForgeRuleset[]> {
    const found = new Map<number, { rules: Set<string>; mergeMethods?: string[] }>();
    const path = `${this.repoPath()}/rules/branches/${branch.split("/").map(encodeURIComponent).join("/")}`;
    for (let page = 1; ; page++) {
      if (page > MAX_RULE_PAGES) {
        throw new ForgeError(
          "refused",
          `${this.place} holds this branch to more rules than the app reads.`,
        );
      }
      const rules = (await this.request("GET", `${path}?per_page=100&page=${page}`)) as {
        type?: string;
        ruleset_id?: number;
        parameters?: { allowed_merge_methods?: string[]; merge_method?: string };
      }[];
      for (const rule of rules) {
        const id = typeof rule.ruleset_id === "number" ? rule.ruleset_id : 0;
        const entry = found.get(id) ?? { rules: new Set<string>() };
        if (rule.type) entry.rules.add(rule.type);
        const methods = rule.parameters?.allowed_merge_methods;
        // A merge queue merges every pull request its own one way, whatever a request names.
        const queueWay = rule.parameters?.merge_method;
        const named =
          rule.type === "pull_request" && Array.isArray(methods)
            ? methods
            : rule.type === "merge_queue" && typeof queueWay === "string"
              ? [queueWay.toLowerCase()]
              : undefined;
        if (named)
          entry.mergeMethods = entry.mergeMethods
            ? entry.mergeMethods.filter((method) => named.includes(method))
            : named;
        found.set(id, entry);
      }
      if (rules.length < 100) break;
    }
    const sets: ForgeRuleset[] = [];
    for (const [id, entry] of found) {
      // A rule GitHub names no rule set for cannot be read for a skip.
      const set =
        id === 0
          ? {}
          : ((await this.request("GET", `${this.repoPath()}/rulesets/${id}`)) as {
              name?: string;
              current_user_can_bypass?: string;
            });
      const bypass = set.current_user_can_bypass;
      sets.push({
        id,
        name: set.name ?? (id === 0 ? "an unnamed rule set" : `rule set ${id}`),
        bypass:
          bypass === "always" ||
          bypass === "pull_requests_only" ||
          bypass === "exempt" ||
          bypass === "never"
            ? bypass
            : null,
        rules: [...entry.rules],
        ...(entry.mergeMethods ? { mergeMethods: entry.mergeMethods } : {}),
      });
    }
    return sets;
  }

  /**
   * GitHub's asynchronous merge (`PUT .../merge-async`) with squash, the
   * version guard, a direct merge and `bypass_rules`, then its result by
   * the id GitHub returns. Sent once: a result the app could not read in
   * time is unknown, never a reason to send again.
   */
  async putInSkippingRules(change: ForgeChange, headSha: string): Promise<ForgeSkipMerge> {
    this.requireMaintainer();
    const reading = await this.asyncMerge(
      `${this.repoPath()}/pulls/${numbered(change)}/merge-async`,
      {
        sha: headSha,
        merge_method: "squash",
        merge_action: "direct_merge",
        bypass_rules: true,
        commit_title: requireNamed(
          change.title ?? "",
          "pull request title",
          this.options.namingRule?.() ?? null,
        ),
        commit_message: change.squashMessage ?? change.body ?? "",
      },
    );
    const message = reading?.details?.message ?? "";
    if (reading?.status === "merged") {
      return reading.details?.sha
        ? { status: "merged", sha: reading.details.sha }
        : { status: "merged" };
    }
    if (reading?.status === "failed") {
      return { status: "failed", message: message || `${this.place} did not merge it` };
    }
    return {
      status: "unknown",
      message:
        reading?.status === "enqueued"
          ? `${this.place} put it in a merge queue instead of merging it`
          : `${this.place} had not finished the merge when the app stopped reading`,
    };
  }

  /** GitHub's status event starts the shipped queue's workflow on each mark. */
  readonly markStartsQueue = true;

  async markQueued(sha: string, approval?: ForgeQueueApproval): Promise<ForgeQueueMark> {
    this.requireMaintainer();
    const checkApproval = () => {
      const why = approval?.beforeDispatch?.();
      if (why) throw new ForgeError("refused", why);
    };
    let approvalUrl: string | undefined;
    if (approval) {
      const pull = (await this.request("GET", `${this.repoPath()}/pulls/${approval.number}`)) as {
        head?: { sha?: string };
        body?: string | null;
        title?: string;
      };
      if (pull.head?.sha !== sha || pull.title !== (approval.requestTitle ?? approval.title))
        throw new ForgeError("refused", "The approved change moved before it could be queued.");
      checkApproval();
      const message = approval.message ?? pull.body ?? "";
      const comment = (await this.request(
        "POST",
        `${this.repoPath()}/issues/${approval.number}/comments`,
        {
          body: `Approved for the batch queue at this version.\n\n<!-- infinitary-merge-approval -->\n${commitEnvelope(sha, message, approval.title, { naming: approval.naming ? NAMING_DECISION.checked : NAMING_DECISION.off, requestTitle: approval.requestTitle ?? approval.title })}`,
        },
      )) as { html_url?: string };
      if (!comment.html_url)
        throw new ForgeError("refused", "The approved merge words have no confirmed comment link.");
      approvalUrl = comment.html_url;
    }
    checkApproval();
    const answer = (await this.request(
      "POST",
      `${this.repoPath()}/statuses/${encodeURIComponent(sha)}`,
      {
        state: "pending",
        context: QUEUE_STATUS,
        description: QUEUE_WAITING_WORDS,
        ...(approvalUrl ? { target_url: approvalUrl } : {}),
      },
    )) as { id?: unknown } | null;
    return typeof answer?.id === "number" ? { id: answer.id } : {};
  }

  private async queuePermission(login: string): Promise<string> {
    const role = (await this.request(
      "GET",
      `${this.repoPath()}/collaborators/${encodeURIComponent(login)}/permission`,
    ).catch((error) => {
      if (error instanceof ForgeError && error.failure === "not-found")
        return { permission: "none" };
      throw error;
    })) as { permission: string };
    return role.permission;
  }

  private async queueApproval(sha: string, number: number) {
    const listed = await this.pages<{ id: number; body?: string; user?: { login?: string } }>(
      `${this.repoPath()}/issues/${number}/comments`,
      (page) => page as { id: number; body?: string; user?: { login?: string } }[],
    );
    if (!listed.complete)
      throw new ForgeError("transient", "The merge approval history could not be read completely.");
    const roles = new Map<string, string>();
    return await newestTrustedApproval(listed.items, sha, async (comment) => {
      const login = comment.user?.login;
      if (!login) return false;
      if (!roles.has(login)) roles.set(login, await this.queuePermission(login));
      return MERGE_PERMISSIONS.includes(roles.get(login) ?? "");
    });
  }

  async removeQueued(sha: string, number: number): Promise<void> {
    this.requireMaintainer();
    const record = await this.queueApproval(sha, number);
    if (!record) return;
    if (record.kind === "approval") {
      const user = (await this.request("GET", "/user")) as { login?: string };
      if (!user.login || !MERGE_PERMISSIONS.includes(await this.queuePermission(user.login)))
        throw new ForgeError(
          "permission",
          "The current sign-in cannot withdraw this project's approved queue version.",
        );
      const posted = (await this.request("POST", `${this.repoPath()}/issues/${number}/comments`, {
        body: `Merge approval withdrawn for this version.\n\n${revocationEnvelope(sha)}`,
      })) as { id?: number };
      if (
        typeof posted?.id !== "number" ||
        (await this.queueApproval(sha, number))?.kind !== "revocation"
      )
        throw new ForgeError(
          "transient",
          "The host did not confirm a trusted approval revocation.",
        );
    }
    const statuses = (await this.request(
      "GET",
      `${this.repoPath()}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`,
    )) as { context?: string; description?: string }[];
    const current = statuses.find((status) => status.context === QUEUE_STATUS);
    if (!current || current.description === REMOVED) return;
    await this.request("POST", `${this.repoPath()}/statuses/${encodeURIComponent(sha)}`, {
      state: "error",
      context: QUEUE_STATUS,
      description: REMOVED,
    });
  }

  /**
   * The workflow files on the default branch whose text mentions the queue
   * status: GitHub's list of the project's workflows, then each file read
   * at the default branch. A listed file the default branch no longer has
   * is left out; any other refusal is the read's failure.
   */
  async queueWorkflows(options: { all?: boolean } = {}): Promise<QueueWorkflow[]> {
    const listed = await this.pages<WorkflowJson>(
      `${this.repoPath()}/actions/workflows`,
      (page) => (page as { workflows?: WorkflowJson[] }).workflows ?? [],
    );
    // The shipped queue's file first: its stamp is all a teammate's app
    // needs, and a project running it needs no other file read.
    const live = listed.items
      .filter((workflow) => workflow.path && workflow.state !== "deleted")
      .sort(
        (a, b) =>
          Number(b.path === GITHUB_QUEUE_PART.queueFile) -
          Number(a.path === GITHUB_QUEUE_PART.queueFile),
      );
    const found: QueueWorkflow[] = [];
    for (const workflow of live) {
      const path = workflow.path as string;
      if (path !== GITHUB_QUEUE_PART.queueFile && options.all === false) break;
      let file: { content?: string; encoding?: string } | null;
      try {
        file = (await this.request(
          "GET",
          `${this.repoPath()}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
        )) as { content?: string; encoding?: string } | null;
      } catch (caught) {
        if (caught instanceof ForgeError && caught.failure === "not-found") continue;
        throw caught;
      }
      const text =
        file?.encoding === "base64" && file.content
          ? Buffer.from(file.content, "base64").toString("utf8")
          : (file?.content ?? "");
      if (!text.includes(QUEUE_STATUS)) continue;
      const shipped = readQueueStamp(text);
      found.push({
        path,
        active: workflow.state === "active",
        ...(shipped !== undefined ? { shipped } : {}),
      });
      if (shipped !== undefined && workflow.state === "active") break;
    }
    return found;
  }

  /**
   * The shipped queue's open pause issue, read by its label: the run and
   * paused changes its marker names, and its assignee as who repairs it.
   * The earliest assignment holds the claim, and a later claimant removes
   * its own (the queue-repair skill), so the one assignee left is the claim.
   * An issue with no readable marker is not the queue's.
   */
  async queuePause(): Promise<ForgeQueuePause | null> {
    const issues = (await this.request(
      "GET",
      `${this.repoPath()}/issues?state=open&labels=${encodeURIComponent(PAUSE_LABEL)}&per_page=10`,
    )) as PauseIssueJson[] | null;
    for (const issue of issues ?? []) {
      const marker = readPauseMarker(issue.body);
      if (!marker || !issue.html_url) continue;
      const claimedBy = issue.assignees?.[0]?.login ?? issue.assignee?.login;
      return { ...marker, url: issue.html_url, ...(claimedBy ? { claimedBy } : {}) };
    }
    return null;
  }

  /** Start the shipped queue's workflow by hand on the default branch, with its inputs. */
  async startQueue(start: ForgeQueueStart): Promise<void> {
    this.requireMaintainer();
    const inputs: Record<string, string> = { action: start.action };
    if (start.action !== "form") inputs.reason = start.reason;
    if (start.action === "send-back") inputs.number = String(start.number);
    await this.request(
      "POST",
      `${this.repoPath()}/actions/workflows/${encodeURIComponent(QUEUE_WORKFLOW)}/dispatches`,
      { ref: await this.defaultBranch(), inputs },
    );
  }

  async close(change: ForgeChange): Promise<void> {
    await this.request("PATCH", `${this.repoPath()}/pulls/${numbered(change)}`, {
      state: "closed",
    });
  }

  /** The repository's own merge buttons, narrowed by its default branch's rules. */
  async mergeWays(): Promise<MergeWays> {
    const repo = (await this.request("GET", this.repoPath())) as {
      default_branch?: string;
      allow_squash_merge?: boolean;
      allow_merge_commit?: boolean;
      allow_rebase_merge?: boolean;
    };
    // GitHub leaves the three out for a sign-in that cannot push: unknown, never read as allowed.
    if (
      typeof repo.allow_squash_merge !== "boolean" ||
      typeof repo.allow_merge_commit !== "boolean" ||
      typeof repo.allow_rebase_merge !== "boolean" ||
      !repo.default_branch
    )
      throw new ForgeError(
        "permission",
        `${this.place} did not say which merges this project allows for this sign-in.`,
      );
    // A project with no rules, or a plan without them, answers none.
    const rules = await this.branchRules(repo.default_branch).catch((caught: unknown) => {
      if (
        caught instanceof ForgeError &&
        (caught.failure === "permission" || caught.failure === "not-found")
      )
        return [] as ForgeRuleset[];
      throw caught;
    });
    return waysUnderRules(
      {
        squash: repo.allow_squash_merge,
        merge: repo.allow_merge_commit,
        rebase: repo.allow_rebase_merge,
      },
      rules,
    );
  }

  async deleteBranch(branch: string): Promise<void> {
    const answer = await this.apiCall(
      "DELETE",
      `${this.repoPath()}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    );
    // 422 is GitHub's answer for a reference that does not exist.
    if (answer.status !== 204 && answer.status !== 404 && answer.status !== 422)
      throw changeWriteError(answer.status, "deleting the batch branch", answer.body);
  }

  async closeWithNote(change: ForgeChange, note: string): Promise<void> {
    await this.request("POST", `${this.repoPath()}/issues/${numbered(change)}/comments`, {
      body: note,
    });
    await this.close(change);
  }

  label(change: ForgeChange): string {
    return change.number !== undefined ? `#${change.number}` : change.branch;
  }

  url(change: ForgeChange): string | null {
    return change.url;
  }

  private owner(): string {
    if (!this.location.owner || !this.location.name) {
      throw new ForgeError("not-found", "the project's address on GitHub names no owner and name");
    }
    return this.location.owner;
  }

  /** The task's project as the gateway's policy reads it; null for the account-level reads. */
  private apiProject(): ApiProject | null {
    return this.location.owner && this.location.name
      ? { owner: this.location.owner, name: this.location.name }
      : null;
  }

  private repoPath(): string {
    const owner = this.owner();
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(this.location.name as string)}`;
  }

  /** Follow signed download redirects manually: the sign-in never leaves the API origin. */
  private async downloadBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    const token = await this.options.token();
    if (!token)
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return downloadAnswer(async () => {
      const { response } = await this.signedGet(
        { url: new URL(`${this.base}${path}`), authenticated: true },
        token,
        path,
        signal,
      );
      return await boundedBytes(response, maxBytes);
    });
  }

  /**
   * The archive behind `path` read in parts (`ArchiveRanges`): the first
   * part follows the redirects as a whole download does, later parts go
   * straight to the storage it reached, and each part has its own request
   * bound. A large file may take longer than a single request. Storage that
   * does not answer a part with exactly those bytes is refused, never read whole.
   */
  private async archiveRanges(path: string, size: number): Promise<ArchiveRanges> {
    const token = await this.options.token();
    if (!token)
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    let at = { url: new URL(`${this.base}${path}`), authenticated: true };
    const read = (start: number, end: number) =>
      downloadAnswer(async () => {
        if (!Number.isSafeInteger(start) || start < 0 || end > size || start >= end)
          throw new ForgeError("refused", "The archive part asked for is outside the archive.");
        const reached = await this.signedGet(
          at,
          token,
          path,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          `bytes=${start}-${end - 1}`,
        );
        at = { url: reached.url, authenticated: reached.authenticated };
        const { response } = reached;
        if (
          response.status !== 206 ||
          !samePart(response.headers.get("content-range"), start, end, size)
        ) {
          await response.body?.cancel();
          throw new ForgeError(
            "refused",
            "GitHub's storage did not send the part of the archive asked for, so the archive cannot be read in parts.",
          );
        }
        const bytes = await boundedBytes(response, end - start, "The archive part");
        if (bytes.byteLength !== end - start)
          throw new ForgeError(
            "transient",
            "GitHub's storage sent a part of the archive short; try a fresh read.",
          );
        return bytes;
      });
    return { size, read };
  }

  /**
   * One GET of a workflow download through GitHub's signed redirects: the
   * sign-in goes only with the request to the API, and a next address must
   * be GitHub's HTTPS storage. Answers the final response and where it came
   * from, so a later part can go straight there.
   */
  private async signedGet(
    from: { url: URL; authenticated: boolean },
    token: string,
    path: string,
    signal: AbortSignal,
    range?: string,
  ): Promise<{ response: Response; url: URL; authenticated: boolean }> {
    let { url, authenticated } = from;
    const apiOrigin = new URL(this.base).origin;
    for (let hops = 0; hops <= 3; hops++) {
      const response = await this.fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          ...(authenticated
            ? {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
              }
            : {}),
          ...(range ? { Range: range } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new ForgeError("refused", "GitHub supplied no download address.");
        const next = new URL(location, url);
        // Dev stubs can redirect within their own origin. Production only follows
        // GitHub's HTTPS storage; neither credentials nor a signed URL are returned.
        const storage =
          next.protocol === "https:" &&
          (next.hostname.endsWith(".githubusercontent.com") ||
            next.hostname.endsWith(".blob.core.windows.net"));
        if (next.username || next.password || (next.origin !== apiOrigin && !storage)) {
          throw new ForgeError("refused", "GitHub supplied an unsafe download address.");
        }
        url = next;
        authenticated = false;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (authenticated && response.status === 401) this.options.onSignInRejected?.();
        if (response.status === 410)
          throw new ForgeError("not-found", "The workflow evidence has expired on GitHub.");
        if (!authenticated)
          throw new ForgeError(
            "refused",
            `The workflow download answered ${response.status}; request a fresh download.`,
          );
        throw failureOf(response, "GET", path, "");
      }
      return { response, url, authenticated };
    }
    throw new ForgeError("refused", "GitHub redirected the workflow download too many times.");
  }

  /**
   * The release's own upload address, or a relative assets path, accepted
   * only on this host's upload origin. A stand-in's origin is the API base
   * the test pointed here, never uploads.github.com.
   */
  private releaseUploadRoute(raw: string, filename: string): ApiRoute {
    const relative = this.releaseAssetPath(raw, filename);
    const route = parseApiRequest("POST", relative, this.apiProject(), 0);
    const rest = route.rest
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/")
      .replace(/\/+$/, "");
    if (!RELEASE_ASSET.test(rest)) {
      throw new ForgeError(
        "refused",
        "A release file goes to the release's upload address, /repos/{owner}/{repo}/releases/{id}/assets, not this path.",
      );
    }
    return route;
  }

  private releaseAssetPath(raw: string, filename: string): string {
    const relative = /^https?:\/\//i.test(raw) ? this.uploadPath(raw) : raw;
    const queryAt = relative.indexOf("?");
    const base = queryAt === -1 ? relative : relative.slice(0, queryAt);
    const params = new URLSearchParams(queryAt === -1 ? "" : relative.slice(queryAt + 1));
    if (!params.get("name")) params.set("name", filename);
    const kept = new URLSearchParams();
    const name = params.get("name");
    const label = params.get("label");
    if (name) kept.set("name", name);
    if (label) kept.set("label", label);
    const query = kept.toString();
    return query ? `${base}?${query}` : base;
  }

  private uploadPath(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ForgeError("refused", "The upload address could not be read.");
    }
    if (url.username || url.password || url.origin !== new URL(this.uploadOrigin()).origin) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    if (/[{}]|%7[Bb]|%7[Dd]/.test(`${url.pathname}${url.search}`)) {
      throw new ForgeError(
        "refused",
        "Replace {?name,label} in the release's upload address with ?name= and the file's name.",
      );
    }
    const prefix = this.uploadPrefix();
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    const pathname = prefix ? url.pathname.slice(prefix.length) || "/" : url.pathname;
    if (!pathname.startsWith("/")) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
      );
    }
    return `${pathname}${url.search}`;
  }

  /** The path under the upload origin, such as `/api/uploads` on GitHub Enterprise Server. */
  private uploadPrefix(): string {
    const pathname = new URL(this.uploadOrigin()).pathname.replace(/\/+$/, "");
    return pathname === "" || pathname === "/" ? "" : pathname;
  }

  /** github.com's upload host, or the stand-in when this forge was pointed at one. */
  private uploadOrigin(): string {
    const canonical = githubApiBaseFor(this.host ?? GITHUB_COM, { packaged: true });
    if (this.base !== canonical) return this.base;
    return githubUploadOrigin(this.host ?? GITHUB_COM);
  }

  /** Stream the file to the upload origin. Redirects are never followed; the answer stays bounded. */
  private async uploadRelease(route: ApiRoute, file: ReleaseUpload): Promise<ForgeApiResponse> {
    const token = await this.options.token();
    if (!token) {
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    }
    const origin = this.uploadOrigin().replace(/\/+$/, "");
    const url = `${origin}${route.path}`;
    if (new URL(url).origin !== new URL(origin).origin) {
      throw new ForgeError(
        "refused",
        "A release file is accepted only on GitHub's upload address.",
        true,
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "Content-Type": file.contentType,
          "Content-Length": String(file.size),
        },
        // Node's fetch reads a stream and requires duplex; the DOM types name neither.
        body: file.stream,
        duplex: "half",
        signal: AbortSignal.timeout(RELEASE_UPLOAD_TIMEOUT_MS),
      } as unknown as RequestInit);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    return this.readAnswer(response);
  }

  /** The gateway's raw call: every status answers, redirects are never followed, the body is bounded. */
  private async apiCall(method: string, path: string, body?: string): Promise<ForgeApiResponse> {
    const token = await this.options.token();
    if (!token) {
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return await this.readAnswer(response);
    } catch (caught) {
      // A lost body is the same transport failure as lost headers. Definite
      // refusals, including an oversized answer used for paging, keep their type.
      if (caught instanceof ForgeError) throw caught;
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
  }

  /** Every status answers. A redirect is refused, and the answer stays within the JSON cap. */
  private async readAnswer(response: Response): Promise<ForgeApiResponse> {
    if (response.status === 401) this.options.onSignInRejected?.();
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ForgeError(
        "refused",
        "GitHub answered with a redirect, which the gateway does not follow.",
      );
    }
    const bytes = await gatewayAnswerBytes(response);
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      requestId: response.headers.get("x-github-request-id"),
      rateLimit:
        remaining === null
          ? null
          : {
              remaining: Number(remaining),
              resetAt:
                Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
            },
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      link: response.headers.get("link"),
      body: new TextDecoder().decode(bytes),
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    version = API_VERSION,
    beforeSend?: () => void,
    url = `${this.base}${path}`,
    observedStatus?: (status: number) => void,
  ): Promise<unknown> {
    const token = await this.options.token();
    if (!token) {
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    }
    beforeSend?.();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": version,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    observedStatus?.(response.status);
    const text = await response.text();
    if (response.status === 401) this.options.onSignInRejected?.();
    if (!response.ok) throw failureOf(response, method, path, text);
    return text ? (JSON.parse(text) as unknown) : null;
  }
}

function changeOf(pull: PullJson, branch: string): ForgeChange {
  return {
    number: pull.number,
    url: pull.html_url,
    branch,
    headSha: pull.head.sha,
    ...(pull.draft ? { draft: true } : {}),
    title: pull.title,
    body: pull.body ?? "",
    ...(pull.base?.ref ? { base: pull.base.ref } : {}),
  };
}

/**
 * GitHub's `mergeable_state` in the seam's terms. `clean`, `unstable` (a
 * check that is not required failed - the app's own all-checks rule
 * decides that) and `has_hooks` may merge only once GitHub has computed
 * `mergeable`; a state the app does not know reads `computing`.
 */
function readinessOf(pull: PullStateJson): ForgeReadiness {
  if (pull.draft === true || pull.mergeable_state === "draft") return "draft";
  switch (pull.mergeable_state) {
    case "dirty":
      return "conflict";
    case "behind":
      return "behind";
    case "blocked":
      return "blocked";
    case "clean":
    case "unstable":
    case "has_hooks":
      return pull.mergeable === true
        ? "clean"
        : pull.mergeable === false
          ? "conflict"
          : "computing";
    default:
      return pull.mergeable === false ? "conflict" : "computing";
  }
}

function numbered(change: ForgeChange): number {
  if (change.number === undefined) {
    throw new ForgeError("unsupported", `${change.branch} has no pull request number on GitHub`);
  }
  return change.number;
}

/** A check run: pending until completed, then its conclusion. */
function runState(run: { status: string; conclusion: string | null }): ForgeCheckState {
  if (run.status !== "completed") return "pending";
  return RUN_CONCLUSIONS[run.conclusion ?? ""] ?? "pending";
}

const RUN_CONCLUSIONS: Record<string, ForgeCheckState> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  timed_out: "timed_out",
  action_required: "action_required",
  startup_failure: "startup_failure",
  stale: "stale",
  skipped: "skipped",
  neutral: "neutral",
};

const STATUS_STATES: Record<string, ForgeCheckState> = {
  success: "success",
  failure: "failure",
  error: "error",
  pending: "pending",
};

function failureOf(response: Response, method: string, path: string, text: string): ForgeError {
  let said = "";
  try {
    said = (JSON.parse(text) as { message?: string }).message ?? "";
  } catch {
    said = cutText(text, 200);
  }
  const what = `GitHub answered ${response.status} to ${method} ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
  if (response.status === 401) return new ForgeError("sign-in", what);
  if (response.status === 403 || response.status === 429) {
    const spent = response.headers.get("x-ratelimit-remaining") === "0";
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (spent && Number.isFinite(reset) && reset > 0)
      return new ForgeAllowanceSpent(reset * 1000, `${what} (the hourly allowance is spent)`);
    if (response.status === 403)
      return new ForgeError("permission", spent ? `${what} (the hourly allowance is spent)` : what);
  }
  if (response.status === 404) return new ForgeError("not-found", what);
  // GitHub refuses a merge when the main branch moved while it merged: the
  // pull request may still merge once GitHub has read it again.
  if (
    response.status === 405 &&
    method === "PUT" &&
    /\/pulls\/\d+\/merge(?:-async)?(\?|$)/.test(path) &&
    /^Base branch was modified\b/i.test(said)
  )
    return new ForgeBaseMoved(what);
  // Any 5xx is the host's own failure, not a verdict on what was asked: a
  // read retries it quietly, and a write's outcome stays unknown (INF-2675
  // finding 7: a 500 on a commit's statuses ended two check watches).
  if (response.status >= 500) return new ForgeError("transient", what);
  return new ForgeError("refused", what);
}

/** A workflow download's answer: fetch failures may hold a signed storage URL, so they are never echoed. */
async function downloadAnswer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (caught) {
    if (caught instanceof ForgeError) throw caught;
    throw new ForgeError(
      "transient",
      "Could not finish the workflow download from GitHub; try a fresh read.",
    );
  }
}

/** Whether storage's Content-Range names exactly the part asked for, of an archive this size. */
function samePart(header: string | null, start: number, end: number, size: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
  return (
    !!match &&
    Number(match[1]) === start &&
    Number(match[2]) === end - 1 &&
    Number(match[3]) === size
  );
}

/** Bound the actual response, not only the host's size metadata. */
async function boundedBytes(
  response: Response,
  maxBytes: number,
  what = "The workflow evidence",
): Promise<Uint8Array> {
  const limit =
    maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MiB` : `${maxBytes / 1024} KiB`;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ForgeError("refused", `${what} exceeds the ${limit} read limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ForgeError("refused", `${what} exceeds the ${limit} read limit.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

function changeWriteError(status: number, operation: string, body: string): ForgeWriteError {
  const refused = [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(status);
  const messages: string[] = [];
  try {
    const answer: unknown = JSON.parse(body);
    if (answer && typeof answer === "object") {
      if ("message" in answer && typeof answer.message === "string") messages.push(answer.message);
      if ("errors" in answer && Array.isArray(answer.errors)) {
        for (const error of answer.errors) {
          if (error && typeof error.message === "string") messages.push(error.message);
        }
      }
    }
  } catch {
    // An unreadable answer does not change whether the write could have happened.
  }
  return new ForgeWriteError(
    refused ? "failed" : "uncertain",
    status === 401 ? "sign-in" : status === 403 ? "permission" : "refused",
    `GitHub answered ${status} when ${operation}${refused ? ". Nothing was written." : "; read it back before any retry."}${messages.length ? ` ${messages.join(" ")}` : ""}`,
  );
}
