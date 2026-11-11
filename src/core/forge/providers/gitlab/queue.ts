import type { QueueCredential } from "@shared/repos";
import { GITLAB_QUEUE_PART, readQueueStamp } from "../../../queue/shipped";
import type { GitLabQueueApi } from "../../../queue/shipped/gitlab.mjs";
import {
  answer,
  MAINTAINER,
  QUEUE_ENVIRONMENT,
  rulesState,
  startForm,
  TOKEN_VARIABLE,
} from "../../../queue/shipped/gitlab.mjs";
import {
  commitEnvelope,
  NAMING_DECISION,
  newestTrustedApproval,
  revocationEnvelope,
} from "../../../queue/shipped/message.mjs";
import { PAUSE_LABEL, REMOVED, readPauseMarker } from "../../../queue/shipped/rules.mjs";
import {
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  type ForgeQueueApproval,
  type ForgeQueueMark,
  type ForgeQueuePause,
  type ForgeQueueStart,
  ForgeWriteError,
  QUEUE_STATUS,
  QUEUE_WAITING_WORDS,
  type QueueWorkflow,
} from "../../forge";
import { GITLAB_READ_MAX_BYTES, type GitLabClient } from "./client";

/** The queue's project access token's name where the project lists its tokens. */
export const QUEUE_TOKEN_NAME = "Infinitary queue";
/** GitLab's longest project access token, in days, less one so a late clock still fits. */
const TOKEN_DAYS = 364;

type StatusJson = {
  id: number;
  name?: string;
  status: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  finished_at?: string | null;
};

type AccessTokenJson = {
  id: number;
  name: string;
  active?: boolean;
  revoked?: boolean;
  expires_at?: string | null;
  token?: string;
};

type PauseIssueJson = {
  description?: string | null;
  web_url?: string;
  assignees?: { username?: string }[];
  assignee?: { username?: string } | null;
};

/** One queue status's state in the app's terms: GitLab's finished `skipped` is the queue's waiting (gitlab.mjs). */
function queueCheckState(status: string): ForgeCheckState {
  const state = rulesState(status);
  if (state === "success") return "success";
  if (state === "failure") return "failure";
  if (state === "error") return "cancelled";
  return "pending";
}

/**
 * The shipped queue's GitLab part as the app reaches it with the person's
 * own sign-in (docs/forge.md, "The shipped queue on GitLab"): the waiting
 * mark, the queue status read back as a check, the queue's files on the
 * default branch, the pause's issue, a start by hand, and the project
 * access token the queue's jobs write with.
 */
export class GitLabQueue {
  constructor(
    private readonly client: GitLabClient,
    private readonly place: string,
    private readonly projectPath: () => string,
  ) {}

  /**
   * Mark the version waiting: a finished `skipped` status carrying the
   * waiting words, since GitLab refuses to set a waiting status waiting
   * again (gitlab.mjs). It starts nothing; the app starts the queue after.
   */
  async markQueued(sha: string, approval?: ForgeQueueApproval): Promise<ForgeQueueMark> {
    const checkApproval = () => {
      const why = approval?.beforeDispatch?.();
      if (why) throw new ForgeError("refused", why);
    };
    let approvalUrl: string | undefined;
    if (approval) {
      const pull = (await this.client.request(
        "GET",
        `${this.projectPath()}/merge_requests/${approval.number}`,
        undefined,
        GITLAB_READ_MAX_BYTES,
      )) as { sha?: string; description?: string; title?: string; web_url?: string };
      if (pull.sha !== sha || pull.title !== approval.title)
        throw new ForgeError("refused", "The approved change moved before it could be queued.");
      checkApproval();
      const comment = (await this.client.write(
        "POST",
        `${this.projectPath()}/merge_requests/${approval.number}/notes`,
        {
          body: `Approved for the batch queue at this version.\n\n<!-- infinitary-merge-approval -->\n${commitEnvelope(sha, approval.message ?? pull.description ?? "", approval.title, { naming: approval.naming ? NAMING_DECISION.checked : NAMING_DECISION.off })}`,
        },
        "publishing the approved merge words",
      )) as { id?: number };
      if (!comment.id || !pull.web_url)
        throw new ForgeError("refused", "The approved merge words have no confirmed comment link.");
      approvalUrl = `${pull.web_url}#note_${comment.id}`;
    }
    checkApproval();
    const answer = (await this.client.write(
      "POST",
      `${this.projectPath()}/statuses/${encodeURIComponent(sha)}`,
      {
        state: "skipped",
        name: QUEUE_STATUS,
        description: QUEUE_WAITING_WORDS,
        ...(approvalUrl ? { target_url: approvalUrl } : {}),
      },
      "marking the version for the project's queue",
    )) as { id?: unknown } | null;
    return typeof answer?.id === "number" ? { id: answer.id } : {};
  }

  private async queueAccess(id: number): Promise<number> {
    const role = (await this.client
      .request("GET", `${this.projectPath()}/members/all/${id}`, undefined, GITLAB_READ_MAX_BYTES)
      .catch((error) => {
        if (error instanceof ForgeError && error.failure === "not-found")
          return { access_level: 0 };
        throw error;
      })) as { access_level: number };
    return role.access_level;
  }

  private async approvalRecord(sha: string, number: number) {
    const comments = (await this.list(
      `${this.projectPath()}/merge_requests/${number}/notes?per_page=100`,
    )) as { id: number; body?: string; system?: boolean; author?: { id?: number } }[];
    const roles = new Map<number, number>();
    return await newestTrustedApproval(comments, sha, async (comment) => {
      const id = comment.author?.id;
      if (!id) return false;
      if (!roles.has(id)) roles.set(id, await this.queueAccess(id));
      return (roles.get(id) ?? 0) >= MAINTAINER;
    });
  }

  async removeQueued(sha: string, number: number): Promise<void> {
    const record = await this.approvalRecord(sha, number);
    if (!record) return;
    if (record.kind === "approval") {
      const user = (await this.client.request(
        "GET",
        "/user",
        undefined,
        GITLAB_READ_MAX_BYTES,
      )) as { id?: number };
      if (!user.id || (await this.queueAccess(user.id)) < MAINTAINER)
        throw new ForgeError(
          "permission",
          "The current sign-in cannot withdraw this project's approved queue version.",
        );
      const posted = (await this.client.write(
        "POST",
        `${this.projectPath()}/merge_requests/${number}/notes`,
        { body: `Merge approval withdrawn for this version.\n\n${revocationEnvelope(sha)}` },
        "revoking the merge approval",
      )) as { id?: number };
      if (
        typeof posted?.id !== "number" ||
        (await this.approvalRecord(sha, number))?.kind !== "revocation"
      )
        throw unreadable(this.place, "a trusted approval revocation");
    }
    const current = await this.check(sha);
    if (!current || current.detail === REMOVED) return;
    await this.client.write(
      "POST",
      `${this.projectPath()}/statuses/${encodeURIComponent(sha)}`,
      { state: "failed", name: QUEUE_STATUS, description: REMOVED },
      "removing the queued approval",
    );
  }

  /**
   * The queue status on a version as one check, the newest status by id,
   * or nothing before any was written. GitLab lists it among the version's
   * statuses, not its pipelines' jobs.
   */
  async check(sha: string): Promise<ForgeCheck | undefined> {
    let statuses: StatusJson[] | null;
    try {
      statuses = (await this.client.request(
        "GET",
        `${this.projectPath()}/repository/commits/${encodeURIComponent(sha)}/statuses?name=${encodeURIComponent(QUEUE_STATUS)}&all=true&per_page=100`,
        undefined,
        GITLAB_READ_MAX_BYTES,
      )) as StatusJson[] | null;
    } catch (caught) {
      // A version GitLab does not hold yet has no status of any kind.
      if (caught instanceof ForgeError && caught.failure === "not-found") return undefined;
      throw caught;
    }
    if (!Array.isArray(statuses)) throw unreadable(this.place, "its queue status");
    const [latest] = statuses
      .filter((status) => status.name === undefined || status.name === QUEUE_STATUS)
      .sort((a, b) => b.id - a.id);
    if (!latest) return undefined;
    return {
      name: QUEUE_STATUS,
      state: queueCheckState(latest.status),
      status: latest.status,
      statusId: latest.id,
      ...(latest.description ? { detail: latest.description } : {}),
      ...(latest.target_url ? { link: latest.target_url } : {}),
    };
  }

  /**
   * The CI files on the default branch that mention the queue status: the
   * shipped queue's own file first, turned on when the project's CI file
   * includes it, and with `all` the project's CI file itself when it names
   * the status (a queue of the project's own).
   */
  async workflows(options: { all?: boolean } = {}): Promise<QueueWorkflow[]> {
    const project = await this.project();
    const branch = project.default_branch;
    const configPath = project.ci_config_path || ".gitlab-ci.yml";
    // A CI file kept in another project (`path@group/project`) or at an
    // address cannot be read here: the queue's own file decides alone.
    const elsewhere = configPath.includes("@") || /^https?:/.test(configPath);
    const config = elsewhere ? null : await this.file(configPath, branch);
    const found: QueueWorkflow[] = [];
    const queue = await this.file(GITLAB_QUEUE_PART.queueFile, branch);
    if (queue?.includes(QUEUE_STATUS)) {
      const shipped = readQueueStamp(queue);
      const active = elsewhere || (config?.includes(GITLAB_QUEUE_PART.queueFile) ?? false);
      found.push({
        path: GITLAB_QUEUE_PART.queueFile,
        active,
        ...(shipped !== undefined ? { shipped } : {}),
      });
      if (shipped !== undefined && active) return found;
    }
    if (options.all !== false && config?.includes(QUEUE_STATUS))
      found.push({ path: configPath, active: true });
    return found;
  }

  /** The project's paused batch from its one open pause issue, and who took it; null while nothing is paused. */
  async pause(): Promise<ForgeQueuePause | null> {
    const issues = (await this.client.request(
      "GET",
      `${this.projectPath()}/issues?state=opened&labels=${encodeURIComponent(PAUSE_LABEL)}&per_page=10`,
      undefined,
      GITLAB_READ_MAX_BYTES,
    )) as PauseIssueJson[] | null;
    for (const issue of issues ?? []) {
      const marker = readPauseMarker(issue.description);
      if (!marker || !issue.web_url) continue;
      const claimedBy = issue.assignees?.[0]?.username ?? issue.assignee?.username;
      return { ...marker, url: issue.web_url, ...(claimedBy ? { claimedBy } : {}) };
    }
    return null;
  }

  /**
   * Start the queue by hand with the person's own sign-in: the next batch is
   * a pipeline on the default branch; a resume or a send-back writes its
   * statuses and closes the pause's issue here, then starts that pipeline.
   */
  async start(start: ForgeQueueStart): Promise<void> {
    const project = await this.project();
    const env = {
      // The queue's script encodes the project's path itself.
      project: decodeURIComponent(this.projectPath().slice("/projects/".length)),
      defaultBranch: project.default_branch,
      pipelineId: 0,
      pipelineUrl: `${project.web_url}/-/pipelines`,
    };
    const api = this.api();
    if (start.action === "form") {
      await startForm(api, env);
      return;
    }
    await answer({
      api,
      env,
      log: () => {},
      action: start.action,
      ...(start.action === "send-back" ? { number: start.number } : {}),
      reason: start.reason,
    });
  }

  /** Whether the project keeps the queue's token, and when it ends. */
  async credential(): Promise<QueueCredential> {
    let tokens: AccessTokenJson[];
    try {
      tokens = await this.tokens();
    } catch (caught) {
      if (caught instanceof ForgeError && ["permission", "not-found"].includes(caught.failure))
        return { state: "unreadable" };
      throw caught;
    }
    const kept = await this.variableExists();
    const [newest] = tokens;
    if (!kept || !newest) return { state: "missing" };
    return { state: "ready", ...(newest.expires_at ? { expiresAt: newest.expires_at } : {}) };
  }

  /**
   * Create the queue's project access token, keep it as the queue's CI
   * variable (masked, protected, and scoped to the queue's environment, so
   * only the queue's own jobs receive it), then revoke the queue's older
   * tokens. The token passes through here once and is never kept or shown.
   */
  async createCredential(now: Date = new Date()): Promise<QueueCredential> {
    const expiresAt = new Date(now.getTime() + TOKEN_DAYS * 86_400_000).toISOString().slice(0, 10);
    const older = await this.tokens().catch(() => [] as AccessTokenJson[]);
    let created: AccessTokenJson;
    try {
      created = (await this.client.write(
        "POST",
        `${this.projectPath()}/access_tokens`,
        {
          name: QUEUE_TOKEN_NAME,
          scopes: ["api"],
          access_level: MAINTAINER,
          expires_at: expiresAt,
        },
        "creating the queue's token",
      )) as AccessTokenJson;
    } catch (caught) {
      if (caught instanceof ForgeWriteError && caught.outcome === "failed")
        throw new ForgeWriteError(
          "failed",
          caught.failure,
          `${this.place} would not make the queue's key. It needs the Maintainer role on the project, and on gitlab.com a Premium or Ultimate plan. ${caught.message}`,
        );
      throw caught;
    }
    if (!created?.token) throw unreadable(this.place, "the queue's new token");
    const variable = {
      value: created.token,
      masked: true,
      protected: true,
      raw: true,
      environment_scope: QUEUE_ENVIRONMENT,
      description: "The Infinitary queue's token. Infinitary replaces it; do not edit.",
    };
    if (await this.variableExists())
      await this.client.write(
        "PUT",
        `${this.variablePath()}?filter[environment_scope]=${encodeURIComponent(QUEUE_ENVIRONMENT)}`,
        variable,
        "keeping the queue's token",
      );
    else
      await this.client.write(
        "POST",
        `${this.projectPath()}/variables`,
        { key: TOKEN_VARIABLE, ...variable },
        "keeping the queue's token",
      );
    for (const token of older)
      if (token.id !== created.id)
        await this.client
          .write(
            "DELETE",
            `${this.projectPath()}/access_tokens/${token.id}`,
            undefined,
            "revoking the queue's older token",
          )
          .catch(() => {});
    return { state: "ready", expiresAt: created.expires_at ?? expiresAt };
  }

  /** The project's default branch, CI file and page. */
  private async project(): Promise<{
    default_branch: string;
    ci_config_path?: string | null;
    web_url: string;
  }> {
    const project = (await this.client.request(
      "GET",
      this.projectPath(),
      undefined,
      GITLAB_READ_MAX_BYTES,
    )) as { default_branch?: string | null; ci_config_path?: string | null; web_url?: string };
    if (!project?.default_branch)
      throw new ForgeError("not-found", `${this.place} named no default branch`);
    return {
      default_branch: project.default_branch,
      ci_config_path: project.ci_config_path ?? null,
      web_url: project.web_url ?? "",
    };
  }

  /** The queue's live tokens, newest first. */
  private async tokens(): Promise<AccessTokenJson[]> {
    const listed = await this.list<AccessTokenJson>(
      `${this.projectPath()}/access_tokens?state=active`,
    );
    return listed
      .filter(
        (token) => token.name === QUEUE_TOKEN_NAME && token.active !== false && !token.revoked,
      )
      .sort((a, b) => b.id - a.id);
  }

  private variablePath(): string {
    return `${this.projectPath()}/variables/${TOKEN_VARIABLE}`;
  }

  private async variableExists(): Promise<boolean> {
    try {
      await this.client.request(
        "GET",
        `${this.variablePath()}?filter[environment_scope]=${encodeURIComponent(QUEUE_ENVIRONMENT)}`,
        undefined,
        GITLAB_READ_MAX_BYTES,
      );
      return true;
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return false;
      throw caught;
    }
  }

  /** One file's text on a branch, or null when the branch has none. */
  private async file(path: string, ref: string): Promise<string | null> {
    try {
      const file = (await this.client.request(
        "GET",
        `${this.projectPath()}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
        undefined,
        GITLAB_READ_MAX_BYTES,
      )) as { content?: string; encoding?: string } | null;
      return file?.encoding === "base64" && file.content
        ? Buffer.from(file.content, "base64").toString("utf8")
        : (file?.content ?? "");
    } catch (caught) {
      if (caught instanceof ForgeError && caught.failure === "not-found") return null;
      throw caught;
    }
  }

  /** Every page of a list, 100 rows at a time, until a page comes back short. */
  private async list<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    const sized = /[?&]per_page=/.test(path)
      ? path
      : `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 1; ; page++) {
      const listed = await this.client.request(
        "GET",
        `${sized}&page=${page}`,
        undefined,
        GITLAB_READ_MAX_BYTES,
      );
      if (!Array.isArray(listed)) throw unreadable(this.place, "a list");
      rows.push(...(listed as T[]));
      if (listed.length < 100) return rows;
    }
  }

  /** The queue script's view of GitLab's API, through the person's own sign-in. */
  private api(): GitLabQueueApi {
    const what = "answering the project's paused batch";
    return {
      get: (path) => this.client.request("GET", path, undefined, GITLAB_READ_MAX_BYTES),
      text: async () => {
        throw new ForgeError("unsupported", "a job's log is not read for an answer");
      },
      send: (method, path, body) => this.client.write(method, path, body, what),
      list: (path) => this.list(path),
    };
  }
}

function unreadable(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}
