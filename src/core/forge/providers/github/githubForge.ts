import { settingFrom } from "@shared/envSettings";
import { forgePlace, GITHUB_COM, isGitHubEnterpriseCloud } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { requireConventional } from "../../../workspace/conventional";
import {
  API_RESPONSE_MAX_BYTES,
  type ApiProject,
  type ApiRoute,
  type ForgeApi,
  type ForgeApiResponse,
  nextPagePath,
  parseApiRequest,
  type ReleaseUpload,
} from "../../api";
import {
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  type ForgeLocation,
  type ForgeProject,
  type ForgePull,
  type ForgeReadiness,
  type ForgeRuleset,
  type ForgeSkipMerge,
  ForgeWriteError,
  isSignInForgeFailure,
  isTransientForgeFailure,
  overallOfChecks,
} from "../../forge";
import { RELEASE_UPLOAD_TIMEOUT_MS } from "../../releaseFile";
import { GitHubAttachments } from "./attachments";
import { GitHubWorkflows } from "./workflows";

/**
 * GitHub over its REST API (git integration PR 1.1), with the app's own
 * GitHub sign-in as a bearer token (PR 1.2: the device flow in `./oauth.ts`,
 * the store in `../../signIns.ts`). The composition root binds every
 * project on GitHub to one of these; nothing else on this Mac - no other
 * program's sign-in - is ever read.
 *
 * The green rule is the seam's (`overallOfChecks`) over BOTH of GitHub's
 * check sources: every check run on the head must be completed and
 * successful or skipped - but for a cancellation a later run of its
 * workflow superseded (`withoutSupersededCancellations`) - and every
 * commit status context `success`. Every unfinished workflow run holds
 * the reading pending even before its waiting jobs create checks; zero reads
 * green only on a project that runs no checks on pull requests: where
 * GitHub already holds a workflow run for the version, or has run workflows
 * for the project's pull requests before, an empty list is checks that have
 * not started (or, on a conflicting change, never will), which reads
 * pending. A 401 is a sign-in fact, a 403 a permission fact, and neither is
 * retried; a 502/503/504 or a network failure is `transient`, which the
 * caller may retry quietly.
 */

export const GITHUB_API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** GitHub documents its asynchronous merge, the one call that can skip rules, at this version. */
const ASYNC_MERGE_API_VERSION = "2026-03-10";
/** How often the app reads an asynchronous merge's result, and how far apart, before it calls it unknown. */
const ASYNC_MERGE_READS = 5;
const ASYNC_MERGE_READ_DELAY_MS = 2000;
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
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  head: { sha: string; ref: string; repo?: { full_name?: string } | null };
};

/** The fields of one pull request read by its number that say whether it may merge. */
type PullStateJson = PullJson & {
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
};

/** The workflow run a check suite belongs to, as far as superseding needs it. */
type SuiteRunJson = {
  name?: string;
  check_suite_id: number;
  workflow_id: number;
  event: string;
  run_number: number;
  status: string;
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
    );
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

  async openChange(input: { branch: string; title: string; body: string }): Promise<ForgeChange> {
    const base = await this.defaultBranch().catch((error: unknown) => {
      throw new ForgeWriteError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        "Could not read the base branch; no pull request was sent.",
      );
    });
    const answer = await this.apiCall(
      "POST",
      `${this.repoPath()}/pulls`,
      JSON.stringify({
        title: input.title,
        head: input.branch,
        base,
        body: input.body,
      }),
    );
    if (answer.status !== 201)
      throw changeWriteError(answer.status, "opening the pull request", answer.body);
    return changeOf(JSON.parse(answer.body) as PullJson, input.branch);
  }

  async branchHead(branch: string): Promise<string> {
    const answer = await this.apiCall(
      "GET",
      `${this.repoPath()}/git/ref/heads/${encodeURIComponent(branch)}`,
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

  async updateChangeBody(change: ForgeChange, body: string): Promise<void> {
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
        "Could not reread the pull request before updating its story.",
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
      (pull.body ?? "") !== (change.body ?? "")
    )
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The pull request changed while preparing its story. Read it again before updating.",
      );
    const answer = await this.apiCall("PATCH", path, JSON.stringify({ body }));
    if (answer.status !== 200)
      throw changeWriteError(answer.status, "replacing the story", answer.body);
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const head = encodeURIComponent(`${this.owner()}:${branch}`);
    const pulls = (await this.request(
      "GET",
      `${this.repoPath()}/pulls?head=${head}&state=open&per_page=1`,
    )) as PullJson[];
    const pull = pulls[0];
    return pull ? changeOf(pull, branch) : null;
  }

  async checks(change: ForgeChange) {
    const sha = encodeURIComponent(change.headSha);
    const runs = await this.pages<CheckRunJson>(
      `${this.repoPath()}/commits/${sha}/check-runs`,
      (page) => (page as { check_runs?: CheckRunJson[] }).check_runs ?? [],
    );
    const statuses = await this.pages<{ context: string; state: string }>(
      `${this.repoPath()}/commits/${sha}/status`,
      (page) => (page as { statuses?: { context: string; state: string }[] }).statuses ?? [],
    );
    // Waiting jobs can have no check yet. Read the workflow runs once for
    // both that gap and superseded cancellations. An unreadable side list
    // leaves the old check reading, including its sign-in/transient refusals.
    let workflowRuns: { total_count?: number; workflow_runs?: SuiteRunJson[] } | null = null;
    try {
      workflowRuns = (await this.request(
        "GET",
        `${this.repoPath()}/actions/runs?head_sha=${sha}&per_page=100`,
      )) as { total_count?: number; workflow_runs?: SuiteRunJson[] };
    } catch (caught) {
      if (
        isSignInForgeFailure(caught) ||
        (runs.items.some((run) => runState(run) === "cancelled") && isTransientForgeFailure(caught))
      ) {
        throw caught;
      }
    }
    const workflows = workflowRuns?.workflow_runs ?? [];
    const items: ForgeCheck[] = [
      ...this.withoutSupersededCancellations(runs.items, workflows),
      ...statuses.items.map((status) => ({
        name: status.context,
        state: STATUS_STATES[status.state] ?? ("pending" as const),
      })),
    ];
    for (const run of workflows) {
      if (run.status !== "completed") {
        items.push({ name: `${run.name ?? "workflow"} (run ${run.run_number})`, state: "pending" });
      }
    }
    if (workflows.length === 100 && (workflowRuns?.total_count ?? 0) > workflows.length) {
      items.push({ name: "more workflow runs than the app reads", state: "pending" });
    }
    if (!runs.complete || !statuses.complete) {
      items.push({ name: "more checks than the app reads", state: "pending" });
    }
    let notStarted = false;
    if (items.length === 0) {
      const waiting = await this.notStarted(change, workflowRuns);
      if (waiting) {
        items.push({ name: waiting, state: "pending" });
        notStarted = waiting === "checks have not started yet";
      }
    }
    return {
      overall: overallOfChecks(items),
      items,
      ...(notStarted ? { notStarted: true } : {}),
    };
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
   * The check runs that still speak for the version. GitHub lists every
   * workflow run's checks on a commit, so when two runs of one workflow
   * start for one version - one push that GitHub answered with two pull
   * request runs, where `ci.yml`'s concurrency cancels the older before it
   * starts - the older run's cancelled check stays on the list beside the
   * newer run's own reading of the same check. Only that cancellation is
   * set aside: a cancelled check whose workflow run has a later run of the
   * same workflow, started by the same event, on this version. The later
   * run's check of the same name then decides; while that later run has not
   * created it yet, the check reads pending. Nothing else is ever set
   * aside: a failure, a time-out or a check still running counts whatever
   * ran after it, and a check the app cannot place in a workflow run counts
   * as it reads. A side read GitHub refuses leaves every check counted.
   */
  private withoutSupersededCancellations(
    runs: CheckRunJson[],
    workflowRuns: SuiteRunJson[],
  ): ForgeCheck[] {
    const read = runs.map((run) => ({ run, check: { name: run.name, state: runState(run) } }));
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
   * Why an empty check list is not "no checks": GitHub already has a
   * workflow run for the version, or has run workflows for this project's
   * pull requests before, so the checks are queued or blocked rather than
   * absent. Null (the list stays empty and reads green) for a project that
   * runs none. A failed side read is no evidence, never a failed check
   * read.
   */
  private async notStarted(
    change: ForgeChange,
    workflowRuns: { total_count?: number; workflow_runs?: SuiteRunJson[] } | null,
  ): Promise<string | null> {
    if (!workflowRuns) return null;
    try {
      const total = async (query: string): Promise<number> =>
        (
          (await this.request("GET", `${this.repoPath()}/actions/runs?${query}&per_page=1`)) as {
            total_count?: number;
          }
        ).total_count ?? 0;
      if (
        (workflowRuns.total_count ?? workflowRuns.workflow_runs?.length ?? 0) === 0 &&
        (await total("event=pull_request")) === 0
      ) {
        return null;
      }
      if (change.number !== undefined) {
        const pull = (await this.request("GET", `${this.repoPath()}/pulls/${change.number}`)) as {
          mergeable?: boolean | null;
          mergeable_state?: string;
        };
        if (pull.mergeable === false || pull.mergeable_state === "dirty") {
          return "checks have not started: the change conflicts with the default branch, and GitHub starts no checks until it is brought up to date";
        }
      }
      return "checks have not started yet";
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "sign-in") throw caught;
      return null;
    }
  }

  async putIn(change: ForgeChange, headSha: string): Promise<{ sha?: string }> {
    // `sha` is GitHub's "match head commit" guard: the merge is refused if
    // the change moved on after its checks were read.
    const answer = (await this.request(
      "PUT",
      `${this.repoPath()}/pulls/${numbered(change)}/merge`,
      {
        sha: headSha,
        merge_method: "squash",
        commit_title: requireConventional(change.title ?? "", "pull request title"),
        commit_message: change.squashMessage ?? change.body ?? "",
      },
    )) as { merged?: boolean; sha?: string; message?: string } | null;
    // A 200 is not a merge on its own: GitHub says it merged, or it did not.
    if (answer?.merged !== true) {
      throw new ForgeError(
        "refused",
        `GitHub did not confirm the merge of ${this.label(change)}${answer?.message ? `: ${answer.message}` : ""}`,
      );
    }
    return answer.sha ? { sha: answer.sha } : {};
  }

  async pull(number: number): Promise<ForgePull> {
    const pull = (await this.request("GET", `${this.repoPath()}/pulls/${number}`)) as PullStateJson;
    const merged = pull.merged === true;
    const headRepo = pull.head.repo?.full_name;
    return {
      number: pull.number,
      state: pull.state === "open" ? "open" : "closed",
      merged,
      ...(merged && pull.merge_commit_sha ? { mergedSha: pull.merge_commit_sha } : {}),
      headSha: pull.head.sha,
      base: pull.base.ref,
      ...(pull.head.ref ? { branch: pull.head.ref } : {}),
      ...(pull.title ? { title: pull.title } : {}),
      ...(headRepo ? { headRepo } : {}),
      readiness: readinessOf(pull),
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
        parameters?: { allowed_merge_methods?: string[] };
      }[];
      for (const rule of rules) {
        const id = typeof rule.ruleset_id === "number" ? rule.ruleset_id : 0;
        const entry = found.get(id) ?? { rules: new Set<string>() };
        if (rule.type) entry.rules.add(rule.type);
        const methods = rule.parameters?.allowed_merge_methods;
        if (rule.type === "pull_request" && Array.isArray(methods)) entry.mergeMethods = methods;
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
    const path = `${this.repoPath()}/pulls/${numbered(change)}/merge-async`;
    let reading = (await this.request(
      "PUT",
      path,
      {
        sha: headSha,
        merge_method: "squash",
        merge_action: "direct_merge",
        bypass_rules: true,
        commit_title: requireConventional(change.title ?? "", "pull request title"),
        commit_message: change.squashMessage ?? change.body ?? "",
      },
      ASYNC_MERGE_API_VERSION,
    )) as AsyncMergeJson | null;
    for (let read = 0; read < ASYNC_MERGE_READS && reading?.status === "pending"; read++) {
      const uuid = reading.details?.uuid;
      if (!uuid) break;
      await (this.options.sleep ?? sleep)(ASYNC_MERGE_READ_DELAY_MS);
      reading = (await this.request(
        "GET",
        `${path}/${encodeURIComponent(uuid)}`,
        undefined,
        ASYNC_MERGE_API_VERSION,
      )) as AsyncMergeJson | null;
    }
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

  async close(change: ForgeChange): Promise<void> {
    await this.request("PATCH", `${this.repoPath()}/pulls/${numbered(change)}`, {
      state: "closed",
    });
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
    let url = new URL(`${this.base}${path}`);
    const apiOrigin = url.origin;
    let authenticated = true;
    try {
      for (let hops = 0; hops <= 3; hops++) {
        const response = await this.fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: authenticated
            ? {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
              }
            : {},
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
        return await boundedBytes(response, maxBytes);
      }
      throw new ForgeError("refused", "GitHub redirected the workflow download too many times.");
    } catch (caught) {
      if (caught instanceof ForgeError) throw caught;
      // Fetch failures may contain a signed storage URL: never echo that error.
      throw new ForgeError(
        "transient",
        "Could not finish the workflow download from GitHub; try a fresh read.",
      );
    }
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
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new ForgeError("transient", `could not reach ${this.place}: ${message}`);
    }
    return this.readAnswer(response);
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
    const bytes = await boundedBytes(response, API_RESPONSE_MAX_BYTES, "The answer");
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
  ): Promise<unknown> {
    const token = await this.options.token();
    if (!token) {
      throw new ForgeError("sign-in", notSignedInText(this.place, this.host ?? GITHUB_COM));
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
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
    title: pull.title,
    body: pull.body ?? "",
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
    said = text.slice(0, 200);
  }
  const what = `GitHub answered ${response.status} to ${method} ${path.split("?")[0]}${said ? `: ${said}` : ""}`;
  if (response.status === 401) return new ForgeError("sign-in", what);
  if (response.status === 403) {
    const spent = response.headers.get("x-ratelimit-remaining") === "0";
    return new ForgeError("permission", spent ? `${what} (the hourly allowance is spent)` : what);
  }
  if (response.status === 404) return new ForgeError("not-found", what);
  if ([502, 503, 504].includes(response.status)) return new ForgeError("transient", what);
  return new ForgeError("refused", what);
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
