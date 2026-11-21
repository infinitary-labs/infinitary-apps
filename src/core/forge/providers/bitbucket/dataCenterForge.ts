import type { MergeWay, MergeWays } from "@shared/batches";
import { forgePlace } from "@shared/forge";
import type { ForgeProject } from "@shared/forges";
import type { PresentationDestination } from "@shared/presentationDestination";
import type { NamingRule } from "@shared/runbooks";
import { requireNamed } from "../../../workspace/naming";
import {
  checkTimes,
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgeChecks,
  ForgeError,
  type ForgeLocation,
  type ForgePull,
  type ForgeReadiness,
  ForgeWriteError,
  isFullCommitId,
  type MergeAnswer,
} from "../../forge";
import { DataCenterClient, type DataCenterOptions, DataCenterRefusal } from "./dataCenterClient";
import {
  DataCenterProjects,
  type DataCenterRepository,
  dataCenterProjectKey,
  dataCenterRepositoryPath,
} from "./dataCenterProjects";

/**
 * Bitbucket Data Center 8.19 or newer over its REST API (`docs/forge.md`,
 * "Bitbucket Data Center"), with the HTTP access token the person made on
 * their own server (`./signIn.ts`). A proposed change is a pull request
 * onto the main branch, named `#N`; its checks are the build statuses on
 * the change's head; putting it in is the server's squash merge, or its
 * rebase or merge commit, as the repository's merge strategies allow.
 *
 * Data Center's merge names the pull request's version, which changes with
 * every push to its branch: the app reads the pull request, sends nothing
 * when its head is not the version whose checks were read, and merges at
 * the version it read, so a push that lands in between makes the server
 * refuse the merge and nothing goes in.
 *
 * Piece by piece, as GitHub and GitLab have them: the crew's gateway,
 * comments, forks and batches are not offered on Data Center yet.
 */
export type DataCenterForgeOptions = DataCenterOptions & {
  /** The active naming runbook's rule, read at each merge; null when none is on. */
  namingRule?: () => NamingRule | null;
};

type RefJson = {
  id?: string;
  displayId?: string;
  latestCommit?: string;
  repository?: DataCenterRepository | null;
};

/** The pull request states Data Center names. */
const PULL_REQUEST_STATES = new Set(["OPEN", "MERGED", "DECLINED"]);

type PullRequestJson = {
  id: number;
  version?: number;
  title?: string;
  description?: string | null;
  /** `OPEN`, `MERGED` or `DECLINED`. */
  state?: string;
  draft?: boolean;
  fromRef?: RefJson;
  toRef?: RefJson;
  reviewers?: { user?: { name?: unknown } | null }[];
  links?: { self?: { href?: unknown }[] };
  properties?: { mergeCommit?: { id?: unknown } | null } | null;
};

type BuildStatusJson = {
  key?: string;
  name?: string;
  state?: string;
  url?: string;
  description?: string;
  ref?: string;
  dateAdded?: number;
  createdDate?: number;
  updatedDate?: number;
};

/** Data Center's merge strategy for each merge the app sends. */
const MERGE_STRATEGY: Readonly<Record<MergeWay, string>> = {
  squash: "squash",
  rebase: "rebase-no-ff",
  merge: "no-ff",
};

/** The pages of build statuses read on one version: Data Center keeps the newest 100. */
const STATUS_PAGES = 5;

export class DataCenterForge implements Forge {
  readonly kind = "bitbucket" as const;
  readonly host: string;
  readonly place: string;
  readonly hasChecks = true;
  /** A Data Center repository is always `project/slug`: nothing nests. */
  readonly nestedNamespace = false;
  private readonly client: DataCenterClient;
  private readonly projects: DataCenterProjects;

  constructor(
    readonly location: ForgeLocation,
    private readonly options: DataCenterForgeOptions,
  ) {
    if (!location.host)
      throw new ForgeError("not-found", "a Bitbucket Data Center project names its server");
    this.host = location.host;
    this.place = forgePlace({ kind: "bitbucket", host: this.host }) ?? this.host;
    this.client = new DataCenterClient(this.host, options);
    this.projects = new DataCenterProjects(this.host, options);
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
   * The story's place: the repository and who may read it. Data Center
   * keeps no pictures the app uploads in a description, so every story's
   * media stays on its card.
   */
  async storyDestination(): Promise<PresentationDestination> {
    const repository = await this.read<DataCenterRepository | null>(this.repositoryPath());
    const id = repository?.id;
    const key = repository?.project?.key;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw unreadableError(this.place, "the repository's identity");
    return {
      host: this.host,
      projectId: id,
      fullName:
        typeof key === "string" && typeof repository?.slug === "string"
          ? `${key}/${repository.slug}`
          : `${this.projectKey()}/${this.location.name}`,
      visibility: repository?.public === true ? "public" : "private",
      format: "bitbucket",
      media: "card-only",
    };
  }

  async defaultBranch(): Promise<string> {
    const branch = await this.read<{ displayId?: unknown } | null>(
      `${this.repositoryPath()}/default-branch`,
    );
    const name = branch?.displayId;
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
    const target =
      input.base ??
      (await this.defaultBranch().catch((error: unknown) => {
        throw new ForgeWriteError(
          "failed",
          error instanceof ForgeError ? error.failure : "transient",
          `Could not read the main branch on ${this.place}; no pull request was sent.${error instanceof Error ? ` ${error.message}` : ""}`,
        );
      }));
    const repository = {
      slug: this.slug(),
      project: { key: this.projectKey() },
    };
    const opened = await this.client.write(
      "POST",
      `${this.repositoryPath()}/pull-requests`,
      {
        title: input.title,
        description: input.body,
        fromRef: { id: `refs/heads/${input.branch}`, repository },
        toRef: { id: `refs/heads/${target}`, repository },
        ...(input.draft ? { draft: true } : {}),
      },
      // i18n-exempt: names the request in an error served to the crewmate
      "opening the pull request",
    );
    return this.changeOf(opened.body as PullRequestJson | null);
  }

  async branchHead(branch: string): Promise<string> {
    const listed = await this.read<{ values?: RefJson[] } | null>(
      `${this.repositoryPath()}/branches?filterText=${encodeURIComponent(branch)}&boostMatches=true&limit=25`,
    );
    const found = listed?.values?.find((ref) => ref.id === `refs/heads/${branch}`);
    if (!found)
      throw new ForgeError(
        "refused",
        `The story's branch has not been confirmed on ${this.place}. Push the reviewed version first.`,
      );
    const sha = found.latestCommit;
    if (typeof sha !== "string" || !isFullCommitId(sha))
      throw new ForgeError("refused", `${this.place} did not confirm the branch's code version.`);
    return sha;
  }

  /**
   * Replace the description at the version read: Data Center refuses an
   * update naming an older version, so a push or edit in between changes
   * nothing.
   */
  async updateChangeBody(change: ForgeChange, body: string, title?: string): Promise<void> {
    const id = numbered(change, this.place);
    let request: PullRequestJson;
    let fresh: ForgeChange;
    try {
      request = await this.pullRequest(id);
      fresh = this.changeOf(request);
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
      this.update(request, { title: title ?? request.title ?? "", description: body }),
      // i18n-exempt: names the request in an error served to the crewmate
      "replacing the description",
    );
  }

  async changeFor(branch: string): Promise<ForgeChange | null> {
    const listed = await this.read<{ values?: PullRequestJson[] } | null>(
      `${this.repositoryPath()}/pull-requests?state=OPEN&direction=OUTGOING&at=${encodeURIComponent(`refs/heads/${branch}`)}&limit=50`,
    );
    if (!Array.isArray(listed?.values)) throw unreadableError(this.place, "its pull requests");
    // Another repository's pull request from a branch of the same name is not this branch's.
    const open = listed.values.find(
      (request) =>
        request.fromRef?.id === `refs/heads/${branch}` && this.isThisRepository(request.fromRef),
    );
    return open ? this.changeOf(open) : null;
  }

  /**
   * The build statuses on one version, each a check: the newest per key.
   * A build still running is pending; a cancelled one reads cancelled. An
   * empty list is checks that have not started yet, which the shared green
   * rule keeps pending.
   */
  async checks(change: ForgeChange, movedPast?: string): Promise<ForgeChecks> {
    const head = movedPast ?? change.headSha;
    if (!isFullCommitId(head)) throw unreadableError(this.place, `the checks on ${head}`);
    const listed = await this.client.list<BuildStatusJson>(
      `/rest/build-status/latest/commits/${encodeURIComponent(head)}?orderBy=NEWEST`,
      STATUS_PAGES,
    );
    const newest = new Map<string, BuildStatusJson>();
    for (const status of listed.values) {
      const key = status.key ?? status.name ?? "build";
      const kept = newest.get(key);
      if (!kept || updatedOf(status) > updatedOf(kept)) newest.set(key, status);
    }
    return { items: [...newest.values()].map(statusCheck), complete: listed.complete };
  }

  /** Whether the repository holds this exact commit; a 404 means no only once the repository reads. */
  async holdsCommit(sha: string): Promise<boolean> {
    if (!isFullCommitId(sha)) return false;
    try {
      const commit = await this.read<{ id?: unknown } | null>(
        `${this.repositoryPath()}/commits/${encodeURIComponent(sha)}`,
      );
      return commit?.id === sha;
    } catch (caught) {
      if (!(caught instanceof ForgeError && caught.failure === "not-found")) throw caught;
    }
    await this.read(this.repositoryPath());
    return false;
  }

  /**
   * The merges the repository allows, from its own pull request merge
   * strategies: a squash, a rebase merge (`rebase-no-ff`) or a merge commit
   * (`no-ff`). The fast-forward strategies are none of them.
   */
  async mergeWays(): Promise<MergeWays> {
    const settings = await this.read<{
      mergeConfig?: { strategies?: { id?: unknown; enabled?: unknown }[] } | null;
    } | null>(`${this.repositoryPath()}/settings/pull-requests`);
    const strategies = settings?.mergeConfig?.strategies;
    if (!Array.isArray(strategies)) throw unreadableError(this.place, "the repository's merges");
    const enabled = (id: string) =>
      strategies.some((strategy) => strategy.id === id && strategy.enabled === true);
    return {
      squash: enabled(MERGE_STRATEGY.squash),
      rebase: enabled(MERGE_STRATEGY.rebase),
      merge: enabled(MERGE_STRATEGY.merge),
    };
  }

  /**
   * Merge at the version read. The pull request is read first and nothing
   * is sent when its head is not `headSha`; the merge names that read's
   * version, so the server refuses it (409) when anything changed since,
   * and nothing goes in.
   */
  async putIn(
    change: ForgeChange,
    headSha: string,
    way: MergeWay | undefined,
    beforeSend?: () => void,
  ): Promise<MergeAnswer | undefined> {
    const id = numbered(change, this.place);
    // The merge is read from the repository's strategies right before the call, never assumed.
    if (!way)
      throw new ForgeError(
        "refused",
        `No merge strategy was read for #${id} on ${this.place}, so nothing was sent.`,
        true,
      );
    const title = requireNamed(
      change.title ?? "",
      // i18n-exempt: names the request in an error served to the crewmate
      "pull request title",
      this.options.namingRule?.() ?? null,
    );
    // A saved story squashes under its plain summary, never its rendered evidence (INF-228 F2).
    const body = (change.squashMessage ?? change.body)?.trim() ?? "";
    let request: PullRequestJson;
    try {
      request = await this.pullRequest(id);
    } catch (caught) {
      throw sentNothing(caught);
    }
    const version = request.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
      throw new ForgeError(
        "transient",
        `${this.place} did not name #${id}'s version, so nothing was sent.`,
        true,
      );
    if (request.fromRef?.latestCommit !== headSha)
      throw new ForgeError(
        "refused",
        `${this.place} holds a newer version of ${change.branch} than the one whose checks were read, so nothing was merged. Read the pull request again.`,
        true,
      );
    let answer: PullRequestJson | null;
    // Whether the merge request left: a failure before it (the sign-in, the
    // caller's last check) sent nothing, and says so (`ForgeError.beforeSend`).
    let left = false;
    try {
      answer = (
        await this.client.request(
          "POST",
          `${this.pullRequestPath(id)}/merge?version=${version}`,
          {
            version,
            message: body ? `${title}\n\n${body}` : title,
            strategyId: MERGE_STRATEGY[way],
            autoSubject: false,
          },
          () => {
            beforeSend?.();
            left = true;
          },
        )
      ).body as PullRequestJson | null;
    } catch (caught) {
      if (!left) throw sentNothing(caught);
      // A 409 is the server's refusal: an older version, a veto, a conflict
      // or a pull request no longer open. Nothing went in.
      if (caught instanceof DataCenterRefusal && caught.status === 409)
        throw new ForgeError("refused", `${caught.message} Nothing was merged.`);
      throw caught;
    }
    if (answer?.state !== "MERGED" || answer.id !== id) {
      // A 200 is not a merge on its own: the server says merged, or it did not.
      const after = await this.pullRequest(id);
      if (after.state !== "MERGED")
        throw new ForgeError("refused", `${this.place} did not confirm the merge of #${id}.`);
      answer = after;
    }
    const sha = answer.properties?.mergeCommit?.id;
    return typeof sha === "string" && isFullCommitId(sha) ? { sha } : {};
  }

  async markReady(change: ForgeChange, beforeSend: () => void): Promise<ForgeChange> {
    const request = await this.pullRequest(numbered(change, this.place));
    const current = this.changeOf(request);
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
      this.update(request, { draft: false }),
      beforeSend,
    );
    const ready = this.changeOf(updated.body as PullRequestJson | null, request.id);
    if (ready.draft)
      throw new ForgeError(
        "refused",
        "Bitbucket did not confirm the draft is ready; read its state before another request.",
      );
    return ready;
  }

  async pull(number: number): Promise<ForgePull> {
    const request = await this.pullRequest(number);
    // Only a state Data Center names is a reading: an answer with none is unreadable, never closed.
    if (!request.state || !PULL_REQUEST_STATES.has(request.state))
      throw new ForgeError(
        "transient",
        `Bitbucket answered pull request ${number} without a state it names; read it again.`,
      );
    const merged = request.state === "MERGED";
    const open = request.state === "OPEN";
    const mergedSha = request.properties?.mergeCommit?.id;
    const from = request.fromRef?.repository;
    const readiness = open ? await this.readiness(request) : "computing";
    const change = this.changeOf(request);
    return {
      number: request.id,
      ...(change.url ? { url: change.url } : {}),
      state: open ? "open" : "closed",
      merged,
      ...(merged && typeof mergedSha === "string" && isFullCommitId(mergedSha)
        ? { mergedSha }
        : {}),
      headSha: change.headSha,
      base: change.base ?? "",
      ...(change.branch ? { branch: change.branch } : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(typeof from?.project?.key === "string" && typeof from.slug === "string"
        ? { headRepo: `${from.project.key}/${from.slug}` }
        : {}),
      ...(typeof from?.id === "number" ? { headRepoId: from.id } : {}),
      readiness,
      mergeable: null,
      mergeableState: readiness,
    };
  }

  /** Decline the pull request at the version read. */
  async close(change: ForgeChange): Promise<void> {
    const request = await this.pullRequest(numbered(change, this.place));
    await this.client.request(
      "POST",
      `${this.pullRequestPath(request.id)}/decline?version=${request.version ?? 0}`,
      { version: request.version ?? 0 },
    );
  }

  async closeWithNote(change: ForgeChange, note: string): Promise<void> {
    await this.client.request(
      "POST",
      `${this.pullRequestPath(numbered(change, this.place))}/comments`,
      { text: note },
    );
    await this.close(change);
  }

  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.client.request(
        "DELETE",
        `/rest/branch-utils/latest/projects/${encodeURIComponent(this.projectKey())}/repos/${encodeURIComponent(this.slug())}/branches`,
        { name: `refs/heads/${branch}`, dryRun: false },
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

  /**
   * Whether the server would merge the pull request now, from its own merge
   * check: a draft, a conflict, any veto (a merge check such as approvals
   * or builds), or the server not able to say yet.
   */
  private async readiness(request: PullRequestJson): Promise<ForgeReadiness> {
    if (request.draft === true) return "draft";
    let read: {
      canMerge?: unknown;
      conflicted?: unknown;
      outcome?: unknown;
      vetoes?: unknown;
    } | null;
    try {
      read = await this.read(`${this.pullRequestPath(request.id)}/merge`);
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "sign-in") throw caught;
      return "computing";
    }
    if (read?.conflicted === true || read?.outcome === "CONFLICTED") return "conflict";
    if (Array.isArray(read?.vetoes) && read.vetoes.length > 0) return "blocked";
    if (read?.canMerge === true && read.outcome === "CLEAN") return "clean";
    return "computing";
  }

  /** `expected`: the pull request a write named, which its answer must be about. */
  private changeOf(request: PullRequestJson | null, expected?: number): ForgeChange {
    if (
      !request ||
      typeof request.id !== "number" ||
      (expected !== undefined && request.id !== expected)
    )
      throw unreadableError(this.place, "the pull request");
    const head = request.fromRef?.latestCommit;
    if (typeof head !== "string" || !isFullCommitId(head))
      throw new ForgeError(
        "transient",
        `${this.place} has not read pull request #${request.id}'s head yet`,
      );
    const page = request.links?.self?.[0]?.href;
    const base = branchOf(request.toRef);
    return {
      number: request.id,
      ...(request.draft === true ? { draft: true } : {}),
      url: typeof page === "string" && page ? page : null,
      branch: branchOf(request.fromRef) ?? "",
      headSha: head,
      title: request.title ?? "",
      body: request.description ?? "",
      ...(base ? { base } : {}),
    };
  }

  /**
   * An update's body at the version read, keeping the reviewers: Data
   * Center replaces the reviewer list with the one an update names.
   */
  private update(
    request: PullRequestJson,
    fields: { title?: string; description?: string; draft?: boolean },
  ): Record<string, unknown> {
    return {
      version: request.version ?? 0,
      title: fields.title ?? request.title ?? "",
      ...(fields.description !== undefined
        ? { description: fields.description }
        : request.description
          ? { description: request.description }
          : {}),
      ...(fields.draft !== undefined ? { draft: fields.draft } : {}),
      reviewers: (request.reviewers ?? []).flatMap((reviewer) =>
        typeof reviewer.user?.name === "string" ? [{ user: { name: reviewer.user.name } }] : [],
      ),
    };
  }

  private async pullRequest(id: number): Promise<PullRequestJson> {
    const request = await this.read<PullRequestJson | null>(this.pullRequestPath(id));
    // An answer about another pull request is no reading of this one.
    if (!request || request.id !== id) throw unreadableError(this.place, `pull request #${id}`);
    return request;
  }

  private isThisRepository(ref: RefJson | undefined): boolean {
    const repository = ref?.repository;
    if (!repository) return true;
    const key = repository.project?.key;
    return (
      typeof key === "string" &&
      typeof repository.slug === "string" &&
      key.toLowerCase() === this.projectKey().toLowerCase() &&
      repository.slug.toLowerCase() === this.slug()
    );
  }

  private async read<T>(path: string): Promise<T> {
    return this.client.get<T>(path);
  }

  private projectKey(): string {
    const { owner } = this.location;
    if (!owner)
      throw new ForgeError(
        "not-found",
        `the project's address on ${this.place} names no project and repository`,
      );
    return dataCenterProjectKey(owner);
  }

  private slug(): string {
    const { name } = this.location;
    if (!name)
      throw new ForgeError(
        "not-found",
        `the project's address on ${this.place} names no project and repository`,
      );
    return name.toLowerCase();
  }

  private repositoryPath(): string {
    const { owner, name } = this.location;
    if (!owner || !name)
      throw new ForgeError(
        "not-found",
        `the project's address on ${this.place} names no project and repository`,
      );
    return dataCenterRepositoryPath(owner, name);
  }

  private pullRequestPath(id: number): string {
    return `${this.repositoryPath()}/pull-requests/${id}`;
  }
}

function numbered(change: ForgeChange, place: string): number {
  if (change.number === undefined)
    throw new ForgeError("unsupported", `${change.branch} has no pull request on ${place}`);
  return change.number;
}

function unreadableError(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}

/** A failure before a write left: nothing was sent, which a caller may retry. */
function sentNothing(caught: unknown): unknown {
  if (caught instanceof ForgeError && caught.beforeSend) return caught;
  const message = caught instanceof Error ? caught.message : String(caught);
  return new ForgeError(caught instanceof ForgeError ? caught.failure : "transient", message, true);
}

/** A ref's branch name: its display id, else its id without `refs/heads/`. */
function branchOf(ref: RefJson | undefined): string | undefined {
  if (ref?.displayId) return ref.displayId;
  return ref?.id?.startsWith("refs/heads/") ? ref.id.slice("refs/heads/".length) : undefined;
}

function updatedOf(status: BuildStatusJson): number {
  return status.updatedDate ?? status.dateAdded ?? status.createdDate ?? 0;
}

/** A build status's state as a check's: a cancelled build reads cancelled. */
function statusState(state: string | undefined): ForgeCheckState {
  switch (state) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    default:
      return "pending";
  }
}

/** One build status as a check, named as Data Center shows it. */
function statusCheck(status: BuildStatusJson): ForgeCheck {
  const state = statusState(status.state);
  const started = status.createdDate ?? status.dateAdded;
  return {
    name: status.name || status.key || "build",
    state,
    ...checkTimes(
      started ? new Date(started).toISOString() : undefined,
      state === "pending" || !status.updatedDate
        ? undefined
        : new Date(status.updatedDate).toISOString(),
    ),
    ...(status.state ? { status: status.state } : {}),
    ...(status.ref ? { ref: status.ref } : {}),
    ...(status.description ? { detail: status.description } : {}),
    ...(status.url ? { link: status.url } : {}),
  };
}
