import { randomUUID } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { Readable } from "node:stream";
import type { WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import {
  API_CALLS_PER_TASK,
  type ApiRoute,
  type Forge,
  type ForgeApi,
  type ForgeApiResponse,
  ForgeError,
  type ForgeRepo,
  type GithubReadInput,
  type GithubWriteInput,
  isSignInForgeFailure,
  type LocatedReleaseFile,
  PLACED_RELEASE_FILE_REFUSAL,
  type ReleaseUpload,
  releaseFileIn,
} from "../forge";
import { guardApiWrite } from "../forge/apiWriteGuard";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";

/** Thrown before a release file is sent, so an ask records it as nothing sent. */
const FILE_CHANGED_BEFORE_SEND = "The file changed before it was sent.";

/** An accepted start or rerun whose run the watch could not take up. */
const WATCH_NOT_STARTED =
  "The write was accepted, but its run watch could not start. Find the run with github_read, then call read_workflow with runId alone. Do not repeat the write.";
const NO_RUN_NUMBER =
  "The write was accepted, but it supplied no run number to watch. Find the run with github_read, then call read_workflow with runId alone. Do not repeat the write.";

/** The reading after a rerun may race GitHub queuing the job, so it tries a few times. */
const REREAD_ATTEMPTS = 3;
const REREAD_DELAY_MS = 2000;

/**
 * The crewmate's two API tools over the app's own sign-in (`github_read`,
 * `github_write`, `docs/forge.md`): JSON REST, plus a release file, to the host where the
 * task's project lives - GitHub, or GitLab with the key made there, and
 * the github.com sign-in for a task with no project or none the app has an
 * API for. A read reaches whatever the sign-in may read, past the host
 * policy's shape checks (`ForgeApi.route`), and the host's answer decides.
 * A write to the task's own project from a task that ships a change goes
 * at once; every other write is kept on the task as an ask (FI3-1571 piece
 * 4), which only the captain's click on its card sends, once
 * (`sendAsk`). The host caps request, answer and calls, and never lets the
 * caller name a host, token or header. A rerun of a workflow run or job - a
 * pipeline or job retry on GitLab - records an existing reservation and
 * takes a check reading when this task has a pull request. Accepted starts
 * and reruns also arm the independent run watch from their exact run number.
 */
/** Where a task's calls go, and whose sign-in sends them. */
type Target = { api: ForgeApi; forge: Forge; via: WriteAsk["via"] };

/** The host's address a forge with none of its own stands for. */
const GITHUB_HOST = "github.com";

/** What the captain's click on a kept write did (`GithubGatewayService.sendAsk`). */
export type WriteAskSent = {
  /** The host answered with a status under 300. */
  ok: boolean;
  /** The ask the click took; absent when it took none. */
  ask?: WriteAsk;
  /** `METHOD /path`, as it was kept. */
  call: string;
  place: string;
  outcome: WriteAskOutcome;
  /** The host's answer as github_write renders it, when it answered. */
  answer?: string;
};

export class GithubGatewayService {
  private readonly calls = new Map<string, number>();

  constructor(
    private readonly options: {
      tasks: TaskService;
      repos: RepoRegistry;
      forgeFor: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
      /** The github.com sign-in's forge, for a task whose project has no API, or none at all. */
      accountForge?: () => Forge;
      /** The crewmate's check reading (`check_change` with no declaration). */
      readChecks: (taskId: string) => Promise<string>;
      now: () => number;
      /** Arm the independent run watch from an accepted own-project start or rerun. */
      watchRun?: (taskId: string, runId: number) => string;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  read(taskId: string, input: GithubReadInput): Promise<string> {
    return this.answer(taskId, async ({ api }) => {
      const route = api.route(input.method ?? "GET", input.path);
      if (route.write) throw new ForgeError("refused", "github_read sends GET or HEAD only.");
      const response = await this.send(taskId, api, route.method, route.path);
      return render(response, api);
    });
  }

  write(taskId: string, input: GithubWriteInput): Promise<string> {
    return this.answer(taskId, async (target) => {
      const { api, forge } = target;
      if (input.file !== undefined) {
        return this.writeFile(taskId, target, input);
      }
      const body = input.body;
      let parsed: unknown;
      if (body !== undefined) {
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new ForgeError("refused", "body must be JSON text.");
        }
      }
      const route = api.route(
        input.method,
        input.path,
        body === undefined ? 0 : Buffer.byteLength(body),
      );
      if (!route.write)
        throw new ForgeError("refused", "github_write sends POST, PATCH, PUT or DELETE only.");
      // Merges and default-branch moves keep the merge card, asked or not (piece 1).
      if (route.own && (forge.kind === "github" || forge.kind === "gitlab")) {
        await guardApiWrite(forge.kind, route, parsed, () => forge.defaultBranch());
      }
      this.guardPresentationWrite(taskId, forge, route, parsed);
      const why = this.askReason(taskId, route, target);
      if (why) return this.keepAsk(taskId, target, route, body, why);
      const response = await this.send(taskId, api, route.method, route.path, body);
      const answered = render(response, api);
      return `${answered}${await this.afterWrite(taskId, target, route, response)}`;
    });
  }

  /**
   * A release file (`docs/forge.md`, "Release files"): a regular file in the
   * working copy, streamed to the host's upload address. The own-project and
   * ask rules are the same as a JSON write. An ask keeps the path, not the bytes.
   */
  private async writeFile(
    taskId: string,
    target: Target,
    input: GithubWriteInput,
  ): Promise<string> {
    const { api, forge } = target;
    if (input.body !== undefined) {
      throw new ForgeError("refused", "A release file is the request; leave body out.");
    }
    if (input.method !== "POST") {
      throw new ForgeError("refused", "A release file is sent with POST.");
    }
    if (this.options.tasks.get(taskId)?.deviceId) {
      throw new ForgeError("refused", PLACED_RELEASE_FILE_REFUSAL);
    }
    const located = this.locateFile(taskId, input.file ?? "");
    const route = this.releaseRoute(api, input.path, located.filename);
    if (route.own && (forge.kind === "github" || forge.kind === "gitlab")) {
      await guardApiWrite(forge.kind, route, undefined, () => forge.defaultBranch());
    }
    const why = this.askReason(taskId, route, target);
    if (why) return this.keepAsk(taskId, target, route, undefined, why, located.rel);
    const response = await this.sendFile(taskId, api, route, located);
    return `${render(response, api)}${await this.afterWrite(taskId, target, route, response)}`;
  }

  /**
   * The captain's click on a `request_write` card (FI3-1571 piece 4): take
   * the kept write once - marked taken before anything is sent - and send
   * exactly what was kept, through the sign-in it was asked through. A call
   * that may have reached the host without an answer is unknown, and like
   * every taken ask it is never sent again. Spends one call of the task's
   * budget only when it is sent.
   */
  async sendAsk(taskId: string, askId: string): Promise<WriteAskSent> {
    const taken = this.options.tasks.takeWriteAsk(taskId, askId);
    if ("refused" in taken) {
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why: taken.refused } };
    }
    const { ask } = taken;
    const done = (outcome: WriteAskOutcome, answer?: string): WriteAskSent => {
      this.options.tasks.recordWriteAskOutcome(taskId, ask.id, outcome);
      return {
        ok: outcome.kind === "answered" && outcome.status < 300,
        ask,
        call: `${ask.method} ${ask.path}`,
        place: ask.place,
        outcome,
        ...(answer !== undefined ? { answer } : {}),
      };
    };
    let target: Target;
    let route: ApiRoute;
    let located: LocatedReleaseFile | undefined;
    try {
      target = this.targetOf(taskId);
      if (
        target.via !== ask.via ||
        target.forge.kind !== ask.kind ||
        (target.forge.host ?? GITHUB_HOST) !== ask.host
      ) {
        return done({
          kind: "refused",
          why: `where it goes changed since it was asked (now ${target.api.place}), so it was not sent`,
        });
      }
      if (ask.file !== undefined) {
        if (this.options.tasks.get(taskId)?.deviceId) {
          throw new ForgeError("refused", PLACED_RELEASE_FILE_REFUSAL);
        }
        located = this.locateFile(taskId, ask.file);
        route = this.releaseRoute(target.api, ask.path, located.filename);
      } else {
        route = target.api.route(
          ask.method,
          ask.path,
          ask.body === undefined ? 0 : Buffer.byteLength(ask.body),
        );
      }
      if (!route.write) throw new ForgeError("refused", "only a write is asked for.");
      const { forge } = target;
      if (route.own && (forge.kind === "github" || forge.kind === "gitlab")) {
        await guardApiWrite(
          forge.kind,
          route,
          ask.body === undefined ? undefined : JSON.parse(ask.body),
          () => forge.defaultBranch(),
        );
      }
      this.guardPresentationWrite(
        taskId,
        forge,
        route,
        ask.body === undefined ? undefined : JSON.parse(ask.body),
      );
      this.spend(taskId, target.api);
    } catch (caught) {
      return done({ kind: "refused", why: messageOf(caught) });
    }
    let response: ForgeApiResponse;
    try {
      response = located
        ? await this.sendFile(taskId, target.api, route, located, { spent: true })
        : await target.api.call(route.method, route.path, ask.body);
    } catch (caught) {
      // beforeSend is set only when nothing was sent. A later refusal may already have reached the host.
      const beforeSend = caught instanceof ForgeError && caught.beforeSend;
      return isSignInForgeFailure(caught) || beforeSend
        ? done({ kind: "refused", why: messageOf(caught) })
        : done({ kind: "unknown", why: messageOf(caught) });
    }
    return done(
      { kind: "answered", status: response.status, requestId: response.requestId },
      `${render(response, target.api)}${await this.afterWrite(taskId, target, route, response)}`,
    );
  }

  /** Raw JSON writes cannot bypass this task's all-attachments-first publication barrier. */
  private guardPresentationWrite(
    taskId: string,
    forge: Forge,
    route: ApiRoute,
    body: unknown,
  ): void {
    // Only github.com and gitlab.com forges publish saved stories (INF-132).
    if (!route.own || !forge.attachments) return;
    const record = this.options.tasks.get(taskId);
    if (record?.shape?.deliverable === "answer") return;
    const rest = route.rest
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/")
      .replace(/\/+$/, "");
    const gitlab = forge.kind === "gitlab";
    if (route.method === "POST" && rest === (gitlab ? "merge_requests" : "pulls"))
      throw new ForgeError(
        "refused",
        `Use prepare_change and open_change to open this task's ${gitlab ? "merge request" : "pull request"} only after all selected attachments are confirmed.`,
      );
    const ledger = record?.delivery?.presentation;
    const number =
      ledger?.publication?.number ?? ledger?.published?.number ?? record?.delivery?.prNumber;
    // Compare by value: GitHub reads pulls/036 as pull request 36 (INF-285 G1). GitHub's
    // issues route is an alias for a pull request's description; GitLab's issues are their own.
    const named = (gitlab ? /^merge_requests\/(\d+)$/ : /^(?:pulls|issues)\/(\d+)$/).exec(rest);
    // GitLab also reads a field from the query string (INF-290 F1), so either place names it.
    const field = gitlab ? "description" : "body";
    const query = new URLSearchParams(route.path.split("?")[1] ?? "");
    if (
      ledger &&
      route.method === (gitlab ? "PUT" : "PATCH") &&
      named &&
      Number(named[1]) === number &&
      ((body !== null && typeof body === "object" && field in body) || query.has(field))
    )
      throw new ForgeError(
        "refused",
        "Update this task's description through its saved story with open_change; raw writes cannot replace its evidence region. To change only the words around the story, pass around to open_change.",
      );
  }

  /**
   * Why a write waits on the captain instead of going at once, or undefined
   * when it goes: it reaches past the task's own project, the task only
   * answers, or it goes through the github.com sign-in.
   */
  private askReason(taskId: string, route: ApiRoute, target: Target): string | undefined {
    if (target.via === "account") {
      return this.options.tasks.get(taskId)?.repoId
        ? "this task's project has no API where it lives, so its writes go through the captain's github.com sign-in, and each one asks the captain"
        : "this task has no project, so its writes go through the captain's github.com sign-in, and each one asks the captain";
    }
    if (this.options.tasks.get(taskId)?.shape?.deliverable === "answer") {
      return "this task only answers, so every write it makes asks the captain";
    }
    if (!route.own) return "it goes outside this task's own project, so it asks the captain";
    return undefined;
  }

  /** Keep a write for the captain's click and tell the crewmate how to ask. */
  private keepAsk(
    taskId: string,
    target: Target,
    route: ApiRoute,
    body: string | undefined,
    why: string,
    file?: string,
  ): string {
    const ask: WriteAsk = {
      id: `wa${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: target.forge.kind === "gitlab" ? "gitlab" : "github",
      host: target.forge.host ?? GITHUB_HOST,
      place: target.api.place,
      via: target.via,
      method: route.method as WriteAsk["method"],
      path: route.path,
      ...(body !== undefined ? { body } : {}),
      ...(file !== undefined ? { file } : {}),
      at: this.options.now(),
    };
    this.options.tasks.keepWriteAsk(taskId, ask);
    const byNumber =
      ask.kind === "gitlab" && target.via === "project" && /^\/projects\/\d+(?:\/|$)/.test(ask.path)
        ? " If it is your own project, name it by its URL-encoded path instead, and the write goes at once."
        : "";
    return [
      `Not sent: ${why}. Kept as ask ${ask.id}: ${ask.method} ${ask.path} on ${ask.place}.${byNumber}`,
      `To ask, emit_card with one action whose effect is {"kind":"request_write","ask":"${ask.id}"} and no label - the app adds the exact call and names the button - beside your own Not now, and say in the body why it is needed.`,
      `Only the captain's click sends it, once, and you then hear ${ask.place}'s answer. Never send it another way.`,
    ].join("\n");
  }

  /**
   * Where the task's calls go: the host where its project lives, or the
   * github.com sign-in for a task with no project or one whose project
   * lives where the app has no JSON API - kept on this computer, or on a
   * plain Git host (FI3-1571 pieces 3 and 4).
   */
  private targetOf(taskId: string): Target {
    const task = this.options.tasks.get(taskId);
    if (!task) throw new ForgeError("not-found", "The task is no longer available.");
    const repo = task.repoId ? this.options.repos.get(task.repoId) : undefined;
    if (task.repoId && !repo) {
      throw new ForgeError("not-found", "The task's project is no longer registered.");
    }
    const forge = repo ? this.options.forgeFor(repo, task.worktreeDir ?? undefined) : undefined;
    if (forge?.api) return { api: forge.api, forge, via: "project" };
    const account = this.options.accountForge?.();
    if (account?.api) return { api: account.api, forge: account, via: "account" };
    throw new ForgeError("unsupported", "This project's host has no JSON API the app can reach.");
  }

  private locateFile(taskId: string, file: string): LocatedReleaseFile {
    const located = releaseFileIn(this.options.tasks.get(taskId)?.worktreeDir, file);
    if ("refusal" in located) throw new ForgeError("refused", located.refusal);
    return located;
  }

  private releaseRoute(api: ForgeApi, rawPath: string, filename: string): ApiRoute {
    if (!api.releaseUpload || !api.upload) {
      throw new ForgeError("refused", "This host does not take a release file.");
    }
    return api.releaseUpload(rawPath, filename);
  }

  /** A file replaced after it was checked is not sent. This runs before the request. */
  private fileUnchanged(located: LocatedReleaseFile): void {
    const stat = lstatSync(located.path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size !== located.size) {
      throw new ForgeError("refused", FILE_CHANGED_BEFORE_SEND, true);
    }
  }

  /** Stream the file. The size is read again so a replaced file is not sent. */
  private async sendFile(
    taskId: string,
    api: ForgeApi,
    route: ApiRoute,
    located: LocatedReleaseFile,
    options: { spent?: boolean } = {},
  ): Promise<ForgeApiResponse> {
    if (!api.upload) throw new ForgeError("refused", "This host does not take a release file.");
    this.fileUnchanged(located);
    if (!options.spent) this.spend(taskId, api);
    const file: ReleaseUpload = {
      stream:
        located.size === 0
          ? Readable.from([])
          : createReadStream(located.path, { start: 0, end: located.size - 1 }),
      size: located.size,
      contentType: located.contentType,
      filename: located.filename,
    };
    try {
      return await api.upload(route, file);
    } finally {
      file.stream.destroy();
    }
  }

  private async send(
    taskId: string,
    api: ForgeApi,
    method: Parameters<ForgeApi["call"]>[0],
    path: string,
    body?: string,
  ): Promise<ForgeApiResponse> {
    this.spend(taskId, api);
    return api.call(method, path, body);
  }

  /** One call of the task's budget, or the refusal once it is spent. */
  private spend(taskId: string, api: ForgeApi): void {
    const used = this.calls.get(taskId) ?? 0;
    if (used >= API_CALLS_PER_TASK) {
      throw new ForgeError(
        "refused",
        `This task used its ${API_CALLS_PER_TASK} ${api.place} calls.`,
      );
    }
    this.calls.set(taskId, used + 1);
  }

  /** Watch only exact run identities from successful own-project writes, never guess by version. */
  private async afterWrite(
    taskId: string,
    target: Target,
    route: ApiRoute,
    response: ForgeApiResponse,
  ): Promise<string> {
    if (response.status >= 300 || !route.own || target.via !== "project") return "";
    const notes: string[] = [];
    const rest = route.rest.split("/").map(decodeURIComponent).join("/");
    const dispatch =
      target.forge.kind === "github" && /^actions\/workflows\/[^/]+\/dispatches$/.test(rest);
    const pipeline = target.forge.kind === "gitlab" && rest === "pipeline";
    const started = route.method === "POST" && (dispatch || pipeline || route.rerun);
    // A reservation bound to a workflow run is dated only by that run's rerun (INF-688).
    const bound = route.rerun
      ? this.options.tasks.get(taskId)?.delivery?.ciRepair?.rerun?.runId
      : undefined;
    let runId: unknown;
    let unread = false;
    if (started && (this.options.watchRun || bound !== undefined)) {
      try {
        const body = responseObject(response);
        if (dispatch) runId = body.workflow_run_id;
        else if (pipeline) runId = body.id;
        else {
          const run = rest.match(/^(?:actions\/runs|pipelines)\/(\d+)\//);
          if (run) runId = Number(run[1]);
          else if (target.forge.kind === "gitlab") runId = objectOf(body.pipeline).id;
          else {
            // GitHub's job rerun is empty: the job itself supplies the parent run number.
            const jobPath = route.path.split("?")[0]?.replace(/\/[^/]+$/, "");
            if (jobPath) {
              const job = await this.send(taskId, target.api, "GET", jobPath);
              if (job.status < 300) runId = responseObject(job).run_id;
            }
          }
        }
      } catch {
        unread = true;
      }
    }
    const known = typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0;
    if (this.options.watchRun && started) {
      let note = unread ? WATCH_NOT_STARTED : NO_RUN_NUMBER;
      if (known) {
        try {
          note = this.options.watchRun(taskId, runId as number);
        } catch {
          note = WATCH_NOT_STARTED;
        }
      }
      notes.push(note);
    }
    if (route.rerun) {
      this.spendRerun(taskId, known ? (runId as number) : undefined);
      // Non-PR reruns have no check reading to make; preserve the PR seam when a change exists.
      if (this.options.tasks.get(taskId)?.delivery?.prNumber || !this.options.watchRun)
        notes.push(await this.armWatch(taskId));
    }
    return notes.length ? `\n\n${notes.join("\n\n")}` : "";
  }

  /**
   * Date the task's one reservation when this rerun is the one it reserved:
   * a rerun of the run it names (INF-688), or else a rerun at the change's
   * current head.
   */
  private spendRerun(taskId: string, runId: number | undefined): void {
    const delivery = this.options.tasks.get(taskId)?.delivery;
    const ledger = structuredClone(delivery?.ciRepair);
    // Reservation is diagnosis bookkeeping, not permission to use the host's API.
    // Do not invent one, spend an old head's or another run's, or rewrite a prior receipt.
    const reserved = ledger?.rerun;
    if (
      !ledger ||
      !reserved ||
      reserved.startedAt !== undefined ||
      (reserved.runId !== undefined
        ? reserved.runId !== runId
        : reserved.headSha !== delivery?.headSha)
    )
      return;
    reserved.startedAt = this.options.now();
    this.options.tasks.recordDelivery(
      taskId,
      { ciRepair: ledger },
      { kind: "ci", text: "Failed-job rerun started", actor: "crewmate" },
    );
  }

  /** Read the checks until the rerun shows as running, which arms the host's watch. */
  private async armWatch(taskId: string): Promise<string> {
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    let reading = "";
    for (let attempt = 1; attempt <= REREAD_ATTEMPTS; attempt++) {
      reading = await this.options.readChecks(taskId);
      if (this.options.tasks.get(taskId)?.delivery?.ciWatch) return reading;
      if (attempt < REREAD_ATTEMPTS) await sleep(REREAD_DELAY_MS);
    }
    return `${reading}\nThe rerun was accepted, but the checks did not read as running yet; read them again with check_change once.`;
  }

  /** Run a call against the task's host; a failure is its answer, naming that host. */
  private async answer(taskId: string, run: (target: Target) => Promise<string>): Promise<string> {
    let place = "GitHub";
    try {
      const target = this.targetOf(taskId);
      place = target.api.place;
      return await run(target);
    } catch (caught) {
      if (caught instanceof ForgeError)
        return `Cannot call ${place} (${caught.failure}): ${caught.message}`;
      return `Cannot call ${place}: the request failed before ${place} answered.`;
    }
  }
}

/**
 * Query names GitHub (and the same shape on GitLab) uses for a temporary
 * credential on a link. A private file's `download_url` carries `token`.
 * Anything else in the answer, including the file's content, stays.
 */
const CREDENTIAL_QUERY = new Set(["token", "access_token"]);

/**
 * Field names GitHub uses for a credential in an answer's body. A private
 * repository's answer carries `temp_clone_token`, which clones it (INF-652).
 * An empty one, as a public repository's answer has, holds nothing and stays.
 */
const CREDENTIAL_FIELDS = new Set(["temp_clone_token"]);

/** What the crewmate is told when a download token was removed from a link. */
export const DOWNLOAD_TOKEN_NOTE = "Download tokens were removed from links.";

/** What the crewmate is told when a repository's clone token was left out. */
export const CLONE_TOKEN_NOTE = "Temporary clone tokens were removed.";

/** Status, ids and the bounded answer; a next page only as a path a read may reach. */
function render(response: ForgeApiResponse, api: ForgeApi): string {
  let body: unknown = response.body;
  if (response.body) {
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
  } else body = null;
  const removed = { links: false, fields: false };
  const cleaned = stripCredentials(body, removed);
  const notes = [
    response.status === 404 ? "404 can also mean the sign-in cannot see the route." : undefined,
    response.status === 403 && response.rateLimit?.remaining === 0
      ? "The hourly allowance is spent; retry after the reset time."
      : undefined,
    removed.links ? DOWNLOAD_TOKEN_NOTE : undefined,
    removed.fields ? CLONE_TOKEN_NOTE : undefined,
  ].filter((note) => note !== undefined);
  return JSON.stringify(
    {
      status: response.status,
      ok: response.status < 300,
      requestId: response.requestId,
      ...(response.rateLimit ? { rateLimit: response.rateLimit } : {}),
      ...(response.retryAfterSeconds ? { retryAfterSeconds: response.retryAfterSeconds } : {}),
      nextPath: api.nextPath(response.link),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      body: cleaned,
    },
    null,
    2,
  );
}

/**
 * Remove credentials from a parsed answer: credential query parameters from
 * every link, and every nonempty credential field at any depth. A value is a
 * link only when the whole string is one, so file content that mentions a
 * token is left as GitHub returned it.
 */
function stripCredentials(value: unknown, removed: { links: boolean; fields: boolean }): unknown {
  if (typeof value === "string") {
    const stripped = stripCredentialQuery(value);
    if (stripped === null) return value;
    removed.links = true;
    return stripped;
  }
  if (Array.isArray(value)) return value.map((item) => stripCredentials(item, removed));
  if (value !== null && typeof value === "object") {
    // fromEntries defines each key as its own field, so an answer's "__proto__" stays a field.
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (CREDENTIAL_FIELDS.has(key) && typeof item === "string" && item !== "") {
          removed.fields = true;
          return [];
        }
        return [[key, stripCredentials(item, removed)]];
      }),
    );
  }
  return value;
}

/** An absolute link without credential query parameters, or null when it had none. */
function stripCredentialQuery(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const drop = [...url.searchParams.keys()].filter((key) =>
    CREDENTIAL_QUERY.has(key.toLowerCase()),
  );
  if (drop.length === 0) return null;
  for (const key of drop) url.searchParams.delete(key);
  return url.toString();
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function responseObject(response: ForgeApiResponse): Record<string, unknown> {
  return response.body ? objectOf(JSON.parse(response.body)) : {};
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
