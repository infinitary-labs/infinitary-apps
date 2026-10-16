import { randomUUID } from "node:crypto";
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
} from "../forge";
import { guardApiWrite } from "../forge/apiWriteGuard";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";

/** The reading after a rerun may race GitHub queuing the job, so it tries a few times. */
const REREAD_ATTEMPTS = 3;
const REREAD_DELAY_MS = 2000;

/**
 * The crewmate's two API tools over the app's own sign-in (`github_read`,
 * `github_write`, `docs/forge.md`): JSON REST only, to the host where the
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
      const why = this.askReason(taskId, route, target);
      if (why) return this.keepAsk(taskId, target, route, body, why);
      const response = await this.send(taskId, api, route.method, route.path, body);
      const answered = render(response, api);
      return `${answered}${await this.afterWrite(taskId, target, route, response)}`;
    });
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
      route = target.api.route(
        ask.method,
        ask.path,
        ask.body === undefined ? 0 : Buffer.byteLength(ask.body),
      );
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
      this.spend(taskId, target.api);
    } catch (caught) {
      return done({ kind: "refused", why: messageOf(caught) });
    }
    let response: ForgeApiResponse;
    try {
      response = await target.api.call(route.method, route.path, ask.body);
    } catch (caught) {
      // A missing or refused sign-in sent nothing; anything else may have reached the host.
      return isSignInForgeFailure(caught)
        ? done({ kind: "refused", why: messageOf(caught) })
        : done({ kind: "unknown", why: messageOf(caught) });
    }
    return done(
      { kind: "answered", status: response.status, requestId: response.requestId },
      `${render(response, target.api)}${await this.afterWrite(taskId, target, route, response)}`,
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
    if (this.options.watchRun && route.method === "POST") {
      const rest = route.rest.split("/").map(decodeURIComponent).join("/");
      const dispatch =
        target.forge.kind === "github" && /^actions\/workflows\/[^/]+\/dispatches$/.test(rest);
      const pipeline = target.forge.kind === "gitlab" && rest === "pipeline";
      if (dispatch || pipeline || route.rerun) {
        try {
          const body = responseObject(response);
          let runId: unknown;
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
          if (typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0)
            notes.push(this.options.watchRun(taskId, runId));
          else
            notes.push(
              "The write was accepted, but it supplied no run number to watch. Find the run with github_read, then call read_workflow with runId alone. Do not repeat the write.",
            );
        } catch {
          notes.push(
            "The write was accepted, but its run watch could not start. Find the run with github_read, then call read_workflow with runId alone. Do not repeat the write.",
          );
        }
      }
    }
    if (route.rerun) {
      this.spendRerun(taskId);
      // Non-PR reruns have no check reading to make; preserve the PR seam when a change exists.
      if (this.options.tasks.get(taskId)?.delivery?.prNumber || !this.options.watchRun)
        notes.push(await this.armWatch(taskId));
    }
    return notes.length ? `\n\n${notes.join("\n\n")}` : "";
  }

  private spendRerun(taskId: string): void {
    const delivery = this.options.tasks.get(taskId)?.delivery;
    const ledger = structuredClone(delivery?.ciRepair);
    // Reservation is diagnosis bookkeeping, not permission to use the host's API.
    // Do not invent one, spend an old head's, or rewrite a prior receipt.
    if (
      !ledger?.rerun ||
      ledger.rerun.headSha !== delivery?.headSha ||
      ledger.rerun.startedAt !== undefined
    )
      return;
    ledger.rerun.startedAt = this.options.now();
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
  return JSON.stringify(
    {
      status: response.status,
      ok: response.status < 300,
      requestId: response.requestId,
      ...(response.rateLimit ? { rateLimit: response.rateLimit } : {}),
      ...(response.retryAfterSeconds ? { retryAfterSeconds: response.retryAfterSeconds } : {}),
      nextPath: api.nextPath(response.link),
      ...(response.status === 404
        ? { note: "404 can also mean the sign-in cannot see the route." }
        : {}),
      ...(response.status === 403 && response.rateLimit?.remaining === 0
        ? { note: "The hourly allowance is spent; retry after the reset time." }
        : {}),
      body,
    },
    null,
    2,
  );
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
