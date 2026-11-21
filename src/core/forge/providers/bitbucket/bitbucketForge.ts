import type { MergeWay } from "@shared/batches";
import { CONTRIBUTION_MERGE_REFUSAL } from "@shared/contributions";
import { branchComparePage, forgePlace } from "@shared/forge";
import type { ForgeProject } from "@shared/forges";
import type { PresentationDestination } from "@shared/presentationDestination";
import type { NamingRule } from "@shared/runbooks";
import { requireNamed } from "../../../workspace/naming";
import type { ForgeApi } from "../../api";
import type { ForgePullComment } from "../../forge";
import {
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
  ForgeMergeUnconfirmed,
  type ForgePull,
  type ForgeReadiness,
  ForgeWriteError,
  isFullCommitId,
  type MergeAnswer,
} from "../../forge";
import {
  BITBUCKET_PAGE_PARAM,
  bitbucketReleaseUpload,
  nextBitbucketPagePath,
  parseBitbucketApiRequest,
} from "./api";
import { BitbucketClient, type BitbucketOptions, BitbucketRefusal } from "./client";
import { readBitbucketPullComments } from "./comments";
import { BitbucketProjects } from "./projects";
import { BitbucketWorkflows } from "./workflows";

/**
 * Bitbucket Cloud over its REST API (`docs/forge.md`, "Bitbucket pull
 * requests"), with the API token the person made on their Atlassian
 * account (`./signIn.ts`). A proposed change is a pull request onto the
 * main branch, named `#N`; its checks are the build statuses on the
 * change's head, which every check service posts there, Bitbucket
 * Pipelines included; putting it in is Bitbucket's squash merge.
 *
 * Bitbucket's merge takes no version, so the app reads the branch just
 * before the merge and sends nothing if it moved; after the merge it reads
 * which version Bitbucket merged and says so plainly if a push landed in
 * between (`MergeAnswer.mergedHead`). Bitbucket names a pull request's
 * commits by a short id, so every version the app keeps is read back as
 * the full commit id.
 *
 * The crew reaches Bitbucket's REST API through the gateway (`api`, its
 * policy in `./api.ts`), reads Pipelines through `workflows`, and the
 * comment and main-failure wakes read through `pullComments` and
 * `branchChecks`. A contributor's fork, batches and Bitbucket's own merge
 * queue come later; this forge refuses a fork's merge.
 */

export type BitbucketForgeOptions = BitbucketOptions & {
  /** The active naming runbook's rule, read at each merge; null when none is on. */
  namingRule?: () => NamingRule | null;
};

type Endpoint = {
  branch?: { name?: string };
  commit?: { hash?: string } | null;
  repository?: { full_name?: string; uuid?: string } | null;
};

/** The pull request states Bitbucket names: open, merged, declined and superseded. */
const PULL_REQUEST_STATES = new Set(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);

type PullRequestJson = {
  id: number;
  title?: string;
  description?: string | null;
  summary?: { raw?: string | null } | null;
  /** `OPEN`, `MERGED`, `DECLINED` or `SUPERSEDED`. */
  state?: string;
  draft?: boolean;
  queued?: boolean;
  source?: Endpoint;
  destination?: Endpoint;
  merge_commit?: { hash?: string } | null;
  links?: { html?: { href?: string } };
};

type StatusJson = {
  key?: string;
  name?: string;
  state?: string;
  url?: string;
  description?: string;
  refname?: string;
  created_on?: string;
  updated_on?: string;
};

type MergeabilityJson = {
  type?: string;
  status?: string;
  required?: boolean;
  blocking?: boolean;
  reason?: string;
  check?: { kind?: string };
};

/** Bitbucket's largest page of a list read. */
const PAGE_LENGTH = 100;

/** The page size Bitbucket answers a list with when the read names none. */
const BITBUCKET_DEFAULT_PAGE_LENGTH = 10;

export class BitbucketForge implements Forge {
  readonly kind = "bitbucket" as const;
  readonly host: string;
  /** "Bitbucket" on bitbucket.org. */
  readonly place: string;
  readonly hasChecks = true;
  /** Bitbucket's merge names no version: the app reads readiness first and never resends. */
  readonly mergeNamesNoVersion = true as const;
  /** A Bitbucket repository is always `workspace/name`: nothing nests. */
  readonly nestedNamespace = false;
  /** The gateway's raw call under Bitbucket's policy for this repository. */
  readonly api: ForgeApi;
  /** Bitbucket Pipelines, read for the crewmate's evidence tools. */
  readonly workflows: BitbucketWorkflows;
  private readonly client: BitbucketClient;
  private readonly projects: BitbucketProjects;
  /** The signed-in account's `account_id`, read once for this forge. */
  private viewer: Promise<string> | undefined;

  constructor(
    readonly location: ForgeLocation,
    private readonly options: BitbucketForgeOptions,
  ) {
    this.host = location.host ?? "bitbucket.org";
    this.place = forgePlace({ kind: "bitbucket", host: this.host }) ?? this.host;
    this.client = new BitbucketClient(this.host, options);
    this.projects = new BitbucketProjects(this.host, options);
    this.workflows = new BitbucketWorkflows(
      this.client,
      () => this.repositoryPath(),
      () =>
        `https://${this.host}/${encodeURIComponent(location.owner ?? "")}/${encodeURIComponent(location.name ?? "")}`,
    );
    const project =
      location.owner && location.name ? { owner: location.owner, name: location.name } : null;
    this.api = {
      place: this.place,
      defaultPerPage: BITBUCKET_DEFAULT_PAGE_LENGTH,
      pageParam: BITBUCKET_PAGE_PARAM,
      route: (method, raw, bodyBytes) => parseBitbucketApiRequest(method, raw, project, bodyBytes),
      nextPath: (link) => nextBitbucketPagePath(link, options.apiBaseUrl, project),
      call: (method, path, body) => this.client.call(method, path, body),
      releaseUpload: (raw) => bitbucketReleaseUpload(raw, project),
      upload: (route, file) => this.client.upload(route.path, file),
    };
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

  /**
   * The story's place: the repository and who may read it. Bitbucket keeps
   * no pictures in a description, so every story's media stays on its card.
   * Bitbucket names a repository by a UUID, never a number: the number is
   * its first 52 bits, which is the same for the same repository each time.
   */
  async storyDestination(): Promise<PresentationDestination> {
    const repository = await this.read<{
      uuid?: unknown;
      full_name?: unknown;
      is_private?: unknown;
    }>(`${this.repositoryPath()}?fields=uuid,full_name,is_private`);
    const uuid = typeof repository?.uuid === "string" ? repository.uuid : "";
    const digits = uuid.replace(/[^0-9a-f]/gi, "").slice(0, 13);
    const projectId = digits.length === 13 ? Number.parseInt(digits, 16) : Number.NaN;
    if (!Number.isSafeInteger(projectId) || projectId <= 0)
      throw unreadableError(this.place, "the repository's identity");
    return {
      host: this.host,
      projectId,
      fullName:
        typeof repository?.full_name === "string"
          ? repository.full_name
          : `${this.location.owner}/${this.location.name}`,
      visibility: repository?.is_private === false ? "public" : "private",
      format: "bitbucket",
      media: "card-only",
    };
  }

  async defaultBranch(): Promise<string> {
    const repository = await this.read<{ mainbranch?: { name?: unknown } | null }>(
      `${this.repositoryPath()}?fields=mainbranch.name`,
    );
    const name = repository?.mainbranch?.name;
    if (typeof name !== "string" || !name)
      throw new ForgeError("not-found", `${this.place} named no main branch`);
    return name;
  }

  async openChange(input: {
    branch: string;
    title: string;
    body: string;
    draft?: boolean;
    base?: string;
  }): Promise<ForgeChange> {
    if (this.location.source)
      throw new ForgeWriteError(
        "failed",
        "unsupported",
        `${this.place} contributions from a fork are not supported yet; no pull request was sent.`,
      );
    const target =
      input.base ??
      (await this.defaultBranch().catch((error: unknown) => {
        throw new ForgeWriteError(
          "failed",
          error instanceof ForgeError ? error.failure : "transient",
          `Could not read the main branch on ${this.place}; no pull request was sent.${error instanceof Error ? ` ${error.message}` : ""}`,
        );
      }));
    const opened = await this.client.write(
      "POST",
      `${this.repositoryPath()}/pullrequests`,
      {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.branch } },
        destination: { branch: { name: target } },
        close_source_branch: false,
        ...(input.draft ? { draft: true } : {}),
      },
      // i18n-exempt: names the request in an error served to the crewmate
      "opening the pull request",
    );
    return this.changeOf(opened.body as PullRequestJson);
  }

  /** The main branch's head and the build statuses on it, for the main-failure wake. */
  async branchChecks(): Promise<{ sha: string; checks: ForgeChecks }> {
    const branch = await this.defaultBranch();
    const sha = await this.branchHead(branch);
    return { sha, checks: await this.checks({ branch, headSha: sha, url: null }) };
  }

  /** The pull request's comments changed since `since`, for the comment wake. */
  async pullComments(
    number: number,
    since?: string,
    seen?: ReadonlySet<number>,
  ): Promise<ForgePullComment[]> {
    return readBitbucketPullComments(
      (path) => this.read(path),
      this.repositoryPath(),
      number,
      () => this.viewerAccount(),
      since,
      seen,
    );
  }

  async branchHead(branch: string): Promise<string> {
    let found: { target?: { hash?: unknown } } | null;
    try {
      found = await this.read<{ target?: { hash?: unknown } } | null>(
        `${this.repositoryPath()}/refs/branches/${encodeURIComponent(branch)}?fields=target.hash`,
      );
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure !== "not-found") throw caught;
      throw new ForgeError(
        "refused",
        `The story's branch has not been confirmed on ${this.place}. Push the reviewed version first.`,
      );
    }
    const sha = found?.target?.hash;
    if (typeof sha !== "string" || !isFullCommitId(sha))
      throw new ForgeError("refused", `${this.place} did not confirm the branch's code version.`);
    return sha;
  }

  /** Bitbucket has no conditional description write: reread first, and the caller reads it back after. */
  async updateChangeBody(change: ForgeChange, body: string, title?: string): Promise<void> {
    const id = numbered(change, this.place);
    let fresh: ForgeChange;
    let request: PullRequestJson;
    try {
      request = await this.pullRequest(id);
      fresh = await this.changeOf(request);
    } catch (error) {
      throw new ForgeWriteError(
        "failed",
        error instanceof ForgeError ? error.failure : "transient",
        `Could not reread pull request #${id}; no description was sent.`,
      );
    }
    if (
      request.state !== "OPEN" ||
      fresh.headSha !== change.headSha ||
      (fresh.body ?? "") !== (change.body ?? "") ||
      (title !== undefined && fresh.title !== change.title)
    )
      throw new ForgeWriteError(
        "failed",
        "refused",
        "The pull request changed after it was read, so its description was not replaced. Read it again before updating.",
      );
    await this.client.write(
      "PUT",
      this.pullRequestPath(id),
      { ...(title !== undefined ? { title } : {}), description: body },
      // i18n-exempt: names the request in an error served to the crewmate
      "replacing the description",
    );
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const query = `source.branch.name="${branch.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const listed = await this.read<{ values?: PullRequestJson[] } | null>(
      `${this.repositoryPath()}/pullrequests?state=OPEN&pagelen=50&q=${encodeURIComponent(query)}`,
    );
    if (!Array.isArray(listed?.values)) throw unreadableError(this.place, "its pull requests");
    const own = `${this.location.owner}/${this.location.name}`.toLowerCase();
    // A fork's pull request from a branch of the same name is not this branch's.
    const open = listed.values.find(
      (request) =>
        request.source?.branch?.name === branch &&
        (request.source?.repository?.full_name === undefined ||
          request.source.repository.full_name.toLowerCase() === own),
    );
    return open ? this.changeOf(open) : null;
  }

  /**
   * The build statuses on one version, each a check: Bitbucket keeps one
   * per key, its newest. A status still running is pending; a stopped one
   * reads cancelled. An empty list is checks that have not started yet,
   * which the shared green rule keeps pending.
   */
  async checks(change: ForgeChange, movedPast?: string): Promise<ForgeChecks> {
    const head = movedPast ?? change.headSha;
    const items: ForgeCheck[] = [];
    let link: string | undefined =
      `${this.repositoryPath()}/commit/${encodeURIComponent(head)}/statuses?pagelen=${PAGE_LENGTH}`;
    for (let page = 0; link && page < 5; page++) {
      const read: { values?: StatusJson[]; next?: string } | null = await this.read(link);
      if (!Array.isArray(read?.values)) throw unreadableError(this.place, `the checks on ${head}`);
      for (const status of read.values) items.push(statusCheck(status));
      link = typeof read.next === "string" && read.next ? read.next : undefined;
    }
    return { items, complete: link === undefined };
  }

  /**
   * Bitbucket's commit read also resolves a short id or a branch, so its
   * answer must name `sha` itself; a 404 means no such commit only once the
   * repository reads.
   */
  async holdsCommit(sha: string): Promise<boolean> {
    if (!isFullCommitId(sha)) return false;
    try {
      const commit = await this.read<{ hash?: unknown } | null>(
        `${this.repositoryPath()}/commit/${encodeURIComponent(sha)}?fields=hash`,
      );
      return commit?.hash === sha;
    } catch (caught) {
      if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
    }
    await this.read(`${this.repositoryPath()}?fields=full_name`);
    return false;
  }

  /**
   * Bitbucket's merge names no version, so this reads the branch first and
   * sends nothing when it moved past `headSha`. Once merged, the answer
   * names the version Bitbucket merged (`mergedHead`): a push that landed
   * between the read and the merge is told, never hidden or retried.
   */
  async putIn(
    change: ForgeChange,
    headSha: string,
    way: MergeWay = "squash",
    beforeSend?: () => void,
  ): Promise<MergeAnswer | undefined> {
    if (this.location.source) throw new ForgeError("permission", CONTRIBUTION_MERGE_REFUSAL);
    const id = numbered(change, this.place);
    const title = requireNamed(
      change.title ?? "",
      // i18n-exempt: names the request in an error served to the crewmate
      "pull request title",
      this.options.namingRule?.() ?? null,
    );
    // A saved story squashes under its plain summary, never its rendered evidence (INF-228 F2).
    const body = (change.squashMessage ?? change.body)?.trim() ?? "";
    let answer: { status: number; body: unknown; location: string | null };
    // Whether the merge request left: a failure before it (the branch read,
    // the sign-in) sent nothing, and says so (`ForgeError.beforeSend`).
    let left = false;
    try {
      const now = await this.branchHead(change.branch);
      if (now !== headSha)
        throw new ForgeError(
          "refused",
          `${this.place} holds a newer version of ${change.branch} than the one whose checks were read, so nothing was merged. Read the pull request again.`,
          true,
        );
      answer = await this.client.request(
        "POST",
        `${this.pullRequestPath(id)}/merge`,
        {
          type: "pullrequest",
          message: body ? `${title}\n\n${body}` : title,
          // A batch keeps one commit per change; anything else is one squashed commit.
          merge_strategy: way === "squash" ? "squash" : "merge_commit",
          close_source_branch: false,
        },
        () => {
          // The caller's last check runs here, after the branch read and the
          // sign-in: a throw sends nothing.
          beforeSend?.();
          left = true;
        },
      );
    } catch (caught) {
      if (!left) throw sentNothing(caught);
      // A ref moved while Bitbucket merged: nothing merged, and the next read says why.
      if (caught instanceof BitbucketRefusal && caught.status === 409)
        throw new ForgeBaseMoved(caught.message);
      throw caught;
    }
    // Bitbucket's own reference to a merge still running (a 202), which a
    // later read asks how it ended: only one its Location names under this
    // pull request is kept.
    const task = answer.status === 202 ? this.mergeTaskOf(answer.location, id) : undefined;
    // Once the request went out, nothing read after it can say the merge
    // failed: a 202 (Bitbucket still merging in the background), a read
    // that fails or an answer that names no version is an outcome not yet
    // known, which only a later read of the pull request settles; nothing
    // is sent again.
    const unknown = (why: string) =>
      new ForgeMergeUnconfirmed(
        // i18n-exempt: served to the crewmate in the merge answer, stays English
        `${this.place} was asked to merge #${id} and ${why}; nothing is sent again until a read shows how it ended.`,
        task,
      );
    let merged = answer.status === 202 ? null : (answer.body as PullRequestJson | null);
    let sha: string | undefined;
    let mergedHead: string | undefined;
    try {
      // Only an answer naming this pull request confirms its merge.
      if (merged?.state !== "MERGED" || merged.id !== id) merged = await this.pullRequest(id);
      if (merged.state === "MERGED") {
        sha = await this.fullCommit(merged.merge_commit?.hash).catch(() => undefined);
        // The version merged is read, never assumed.
        mergedHead = await this.fullCommit(merged.source?.commit?.hash);
      }
    } catch {
      // i18n-exempt: served to the crewmate in the merge answer, stays English
      throw unknown("its answer could not be read");
    }
    // i18n-exempt: served to the crewmate in the merge answer, stays English
    if (merged.state !== "MERGED") throw unknown("has not finished it");
    // i18n-exempt: served to the crewmate in the merge answer, stays English
    if (!mergedHead) throw unknown("did not name the version it merged");
    return { ...(sha ? { sha } : {}), mergedHead };
  }

  /**
   * Bitbucket's word on a merge it took with a 202
   * (`GET /pullrequests/<N>/merge/task-status/<task>`). Bitbucket answers
   * 400 for a merge that failed or left its queue unmerged, and also for a
   * task of another pull request, with no typed fact telling them apart, so
   * a 400 is a refusal, never a confirmed failure; only a reference kept
   * from this pull request's own answer (`mergeTaskOf`) is asked about, and
   * anything else, pending and an unknown task included, is not refused.
   */
  async mergeTaskRefused(number: number, task: string): Promise<boolean> {
    const kept = /^(\d+)\/(.+)$/.exec(task);
    if (!kept || Number(kept[1]) !== number) return false;
    try {
      await this.client.request(
        "GET",
        `${this.pullRequestPath(number)}/merge/task-status/${encodeURIComponent(kept[2] ?? "")}`,
      );
      return false;
    } catch (caught) {
      if (caught instanceof BitbucketRefusal && caught.status === 400) return true;
      throw caught;
    }
  }

  async markReady(change: ForgeChange, beforeSend: () => void): Promise<ForgeChange> {
    const request = await this.pullRequest(numbered(change, this.place));
    const current = await this.changeOf(request);
    if (
      current.headSha !== change.headSha ||
      current.branch !== change.branch ||
      request.state !== "OPEN"
    )
      throw new ForgeError(
        "refused",
        "The prerequisite pull request changed; review its current version first.",
      );
    if (!current.draft) return current;
    const updated = await this.client.request(
      "PUT",
      this.pullRequestPath(request.id),
      { draft: false },
      beforeSend,
    );
    const ready = await this.changeOf(updated.body as PullRequestJson, request.id);
    if (ready.draft)
      throw new ForgeError(
        "refused",
        "Bitbucket did not confirm the draft is ready; read its state before another request.",
      );
    return ready;
  }

  async pull(number: number): Promise<ForgePull> {
    const request = await this.pullRequest(number);
    // Only a state Bitbucket names is a reading: an answer with none, or one
    // this app does not know, is unreadable, never closed, so it settles no
    // merge whose outcome is unknown (INF-5193).
    if (!request.state || !PULL_REQUEST_STATES.has(request.state))
      throw new ForgeError(
        "transient",
        `Bitbucket answered pull request ${number} without a state it names; read it again.`,
      );
    const merged = request.state === "MERGED";
    const open = request.state === "OPEN";
    const mergedSha = merged
      ? await this.fullCommit(request.merge_commit?.hash).catch(() => undefined)
      : undefined;
    const headRepo = request.source?.repository?.full_name;
    const readiness = open ? await this.readiness(request) : "computing";
    return {
      number: request.id,
      ...(request.links?.html?.href ? { url: request.links.html.href } : {}),
      state: open ? "open" : "closed",
      merged,
      ...(mergedSha ? { mergedSha } : {}),
      // No updatedAt: Bitbucket's `updated_on` stays put when someone
      // comments (measured on bitbucket.org), and the comment wake skips its
      // reading while a pull request's last-changed time is unchanged
      // (`docs/forge.md`, "Comments on a pull request").
      headSha: await this.headOf(request),
      base: request.destination?.branch?.name ?? "",
      ...(request.source?.branch?.name ? { branch: request.source.branch.name } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(headRepo ? { headRepo } : {}),
      readiness,
      mergeable: null,
      mergeableState: readiness,
      mergeNamesNoVersion: true,
    };
  }

  async close(change: ForgeChange): Promise<void> {
    await this.client.request(
      "POST",
      `${this.pullRequestPath(numbered(change, this.place))}/decline`,
    );
  }

  async closeWithNote(change: ForgeChange, note: string): Promise<void> {
    await this.client.request(
      "POST",
      `${this.pullRequestPath(numbered(change, this.place))}/comments`,
      { content: { raw: note } },
    );
    await this.close(change);
  }

  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.client.request(
        "DELETE",
        `${this.repositoryPath()}/refs/branches/${encodeURIComponent(branch)}`,
      );
    } catch (caught) {
      if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
    }
  }

  label(change: ForgeChange): string {
    return change.number !== undefined ? `#${change.number}` : change.branch;
  }

  url(change: ForgeChange): string | null {
    return change.url;
  }

  async branchPage(branch: string): Promise<string | null> {
    const { owner, name, source } = this.location;
    if (source || !owner || !name) return null;
    return branchComparePage({
      kind: "bitbucket",
      host: this.host,
      owner,
      name,
      base: await this.defaultBranch(),
      branch,
    });
  }

  /**
   * Whether Bitbucket would merge the pull request now, from its own
   * mergeability checks: a Git conflict, a branch rule asking the change
   * to be brought up to date, any other blocking rule, or Bitbucket not
   * able to say yet. Anything the app cannot place reads computing.
   */
  private async readiness(request: PullRequestJson): Promise<ForgeReadiness> {
    if (request.draft === true) return "draft";
    let checks: MergeabilityJson[];
    try {
      const read = await this.read<{ values?: MergeabilityJson[] } | null>(
        `${this.pullRequestPath(request.id)}/mergeability/checks`,
      );
      if (!Array.isArray(read?.values)) return "computing";
      checks = read.values;
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "sign-in") throw caught;
      return "computing";
    }
    const git = checks.find((check) => check.type === "git_mergeability_check");
    if (git?.reason === "conflicts") return "conflict";
    const blocking = checks.filter((check) => check.blocking === true);
    if (
      blocking.some(
        (check) =>
          check.type === "standard_merge_check" && check.check?.kind === "maximum_commits_behind",
      )
    )
      return "behind";
    if (blocking.length > 0) return "blocked";
    if (git?.status !== "PASSED") return "computing";
    if (checks.some((check) => check.status === "PENDING" || check.status === "UNKNOWN"))
      return "computing";
    return "clean";
  }

  /** `expected`: the pull request a write named, which its answer must be about. */
  private async changeOf(request: PullRequestJson | null, expected?: number): Promise<ForgeChange> {
    if (
      !request ||
      typeof request.id !== "number" ||
      (expected !== undefined && request.id !== expected)
    )
      throw unreadableError(this.place, "the pull request");
    return {
      number: request.id,
      ...(request.draft === true ? { draft: true } : {}),
      url: request.links?.html?.href ?? null,
      branch: request.source?.branch?.name ?? "",
      headSha: await this.headOf(request),
      title: request.title ?? "",
      body: request.description ?? request.summary?.raw ?? "",
      ...(request.destination?.branch?.name ? { base: request.destination.branch.name } : {}),
    };
  }

  /** The pull request's head as a full commit id: Bitbucket names it by a short one. */
  private async headOf(request: PullRequestJson): Promise<string> {
    const head = await this.fullCommit(request.source?.commit?.hash);
    if (!head)
      throw new ForgeError(
        "transient",
        `${this.place} has not read pull request #${request.id}'s head yet`,
      );
    return head;
  }

  /** A commit's full id from the short one Bitbucket gives, or undefined for none. */
  private async fullCommit(hash: string | undefined | null): Promise<string | undefined> {
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) return undefined;
    if (isFullCommitId(hash)) return hash;
    const commit = await this.read<{ hash?: unknown } | null>(
      `${this.repositoryPath()}/commit/${encodeURIComponent(hash)}?fields=hash`,
    );
    const full = commit?.hash;
    if (typeof full !== "string" || !isFullCommitId(full) || !full.startsWith(hash))
      throw unreadableError(this.place, `commit ${hash}`);
    return full;
  }

  private async pullRequest(id: number): Promise<PullRequestJson> {
    const request = await this.read<PullRequestJson | null>(this.pullRequestPath(id));
    // An answer about another pull request is no reading of this one: it
    // settles no merge and confirms none (INF-5193).
    if (!request || request.id !== id) throw unreadableError(this.place, `pull request #${id}`);
    return request;
  }

  /** The signed-in account's `account_id`; a failed read is asked again next time. */
  private viewerAccount(): Promise<string> {
    this.viewer ??= this.read<{ account_id?: unknown } | null>("/user?fields=account_id").then(
      (user) => {
        if (typeof user?.account_id !== "string" || !user.account_id)
          throw unreadableError(this.place, "the signed-in account");
        return user.account_id;
      },
    );
    this.viewer.catch(() => {
      this.viewer = undefined;
    });
    return this.viewer;
  }

  private async read<T>(path: string): Promise<T> {
    return this.client.get<T>(path);
  }

  private repositoryPath(): string {
    const { owner, name } = this.location;
    if (!owner || !name)
      throw new ForgeError(
        "not-found",
        `the project's address on ${this.place} names no workspace and name`,
      );
    return `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /**
   * The merge task a 202's Location names (`.../repositories/<workspace>/<name>/pullrequests/<N>/merge/task-status/<task>`),
   * kept as `<N>/<task>` only when it names this repository and pull request.
   */
  private mergeTaskOf(location: string | null, id: number): string | undefined {
    if (!location) return undefined;
    let path: string;
    try {
      path = new URL(location, this.options.apiBaseUrl).pathname;
    } catch {
      return undefined;
    }
    const named =
      /\/repositories\/([^/]+)\/([^/]+)\/pullrequests\/(\d+)\/merge\/task-status\/([^/]+)\/?$/.exec(
        path,
      );
    if (!named) return undefined;
    const [, owner, name, number, task] = named;
    const same = (a: string | undefined, b: string | undefined) =>
      decodeURIComponent(a ?? "").toLowerCase() === (b ?? "").toLowerCase();
    if (!same(owner, this.location.owner) || !same(name, this.location.name)) return undefined;
    if (Number(number) !== id || !task) return undefined;
    return `${id}/${decodeURIComponent(task)}`;
  }

  private pullRequestPath(id: number): string {
    return `${this.repositoryPath()}/pullrequests/${id}`;
  }
}

function numbered(change: ForgeChange, place: string): number {
  if (change.number === undefined)
    throw new ForgeError("unsupported", `${change.branch} has no pull request on ${place}`);
  return change.number;
}

/** A failure before the merge request left: nothing was sent, which a caller may retry. */
function sentNothing(caught: unknown): unknown {
  if (caught instanceof ForgeError && (caught.beforeSend || caught instanceof ForgeAllowanceSpent))
    return caught;
  const message = caught instanceof Error ? caught.message : String(caught);
  return new ForgeError(caught instanceof ForgeError ? caught.failure : "transient", message, true);
}

function unreadableError(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}

/** A build status's state as a check's: a stopped build reads cancelled. */
function statusState(state: string | undefined): ForgeCheckState {
  switch (state) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "STOPPED":
      return "cancelled";
    default:
      return "pending";
  }
}

/** One build status as a check, named as Bitbucket shows it. */
function statusCheck(status: StatusJson): ForgeCheck {
  const state = statusState(status.state);
  return {
    name: status.name || status.key || "build",
    state,
    ...checkTimes(status.created_on, state === "pending" ? undefined : status.updated_on),
    ...(status.state ? { status: status.state } : {}),
    ...(status.refname ? { ref: status.refname } : {}),
    ...(status.description ? { detail: status.description } : {}),
    ...(status.url ? { link: status.url } : {}),
  };
}
