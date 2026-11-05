import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { Readable } from "node:stream";
import type { ValidationForgeWrite } from "@shared/liveValidation";
import type { ForgeWriteAsk, WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import {
  API_CALLS_PER_TASK,
  API_RESPONSE_MAX_BYTES,
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
  OversizedAnswer,
  PLACED_RELEASE_FILE_REFUSAL,
  type ReleaseUpload,
  releaseFileIn,
  smallerPage,
} from "../forge";
import { guardApiWrite } from "../forge/apiWriteGuard";
import { IntegrationOutcomeUnknown } from "../integrations";
import { storyLedgers } from "../storage/changeProjection";
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
 * at once, and so does a start or rerun of a run there from a task that only
 * answers (INF-729 way D); every other write is kept on the task as an ask
 * (FI3-1571 piece 4), which only the captain's click on its card sends, once
 * (`sendAsk`). The host caps request, answer and calls, and never lets the
 * caller name a host, token or header. A rerun of a workflow run or job - a
 * pipeline or job retry on GitLab - records an existing reservation and
 * takes a check reading when this task has a pull request. Accepted starts
 * and reruns also arm the independent run watch from their exact run number.
 */
/** Where a task's calls go, and whose sign-in sends them. */
type Target = {
  api: ForgeApi;
  forge: Forge;
  via: ForgeWriteAsk["via"];
  /** Asked through the GitHub integration (docs/integrations.md), whatever the task's project is. */
  integration?: true;
};

/** Whose allowance the first mate's own calls count against: it has no task. */
const SEAT_CALLS = "seat:firstmate";

/**
 * An Automation rule's look (`readForLook`): the host's own read on its
 * tick, as the run watch's is, so it spends no caller's allowance; the
 * event's cadence bounds how often it reads.
 */
const LOOK_CALLS = "look:automation";

/**
 * A panel's calls (docs/integrations.md, "Panels"): a panel is no task and
 * no seat, so its calls spend no allowance; the action's own rule and the
 * same shape checks and caps bound them.
 */
const PANEL_CALLS = "panel:";

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
      accountForge?: (host?: string) => Forge;
      /** The crewmate's check reading (`check_change` with no declaration). */
      readChecks: (taskId: string) => Promise<string>;
      now: () => number;
      /** Arm the independent run watch from an accepted own-project start or rerun. */
      watchRun?: (taskId: string, runId: number) => string;
      beforeValidationWrite?: (
        taskId: string,
        request: string,
        write: ValidationForgeWrite,
      ) => Promise<void>;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /**
   * One read, and an answer past the JSON cap read again at the largest page
   * of it that fits (`smallerPage`), each try one call of the task's
   * allowance. Every try asks for fewer items than the last, so the tries
   * end; an answer no smaller page would shrink is refused, saying why.
   */
  read(
    taskId: string,
    input: GithubReadInput,
    through?: "account" | { host: string },
  ): Promise<string> {
    return this.answer(taskId, ({ api }) => this.readOn(taskId, api, input), through);
  }

  /**
   * The first mate's read through the github.com sign-in (the GitHub
   * integration, docs/integrations.md): it has no task, so its calls count
   * against the seat's own allowance, under the same shape checks and caps.
   */
  readAsSeat(input: GithubReadInput, host?: string): Promise<string> {
    return this.answerWith(
      () => this.accountTarget(host),
      ({ api }) => this.readOn(SEAT_CALLS, api, input),
    );
  }

  /**
   * An Automation rule's look at GitHub's events through the same sign-in
   * (docs/integrations.md, "GitHub's events"): a read, under the same shape
   * checks and answer cap, that throws when it cannot read, so the rule
   * keeps its place and waits.
   */
  readForLook(input: GithubReadInput, host?: string): Promise<string> {
    return this.answerWith(
      () => this.accountTarget(host),
      ({ api }) => this.readOn(LOOK_CALLS, api, input),
      true,
    );
  }

  /**
   * The first mate's change through the same sign-ins (INF-1108): the
   * integration's approval rule let it run - Always allowed, or the
   * captain's click on its held call - so nothing here asks again. It has no
   * task, so its calls count against the seat's own allowance; merges and
   * default-branch moves keep the merge card, and an outcome lost after the
   * request left is unknown, never sent again.
   */
  writeAsSeat(input: GithubWriteInput, host?: string): Promise<string> {
    return this.writeAs(SEAT_CALLS, input, host);
  }

  /** A panel's read through the github.com sign-in: it spends no allowance (`PANEL_CALLS`). */
  readAsPanel(panel: string, input: GithubReadInput, host?: string): Promise<string> {
    return this.answerWith(
      () => this.accountTarget(host),
      ({ api }) => this.readOn(`${PANEL_CALLS}${panel}`, api, input),
    );
  }

  /** A panel's change, once its action's rule let it run, under the seat's own guards. */
  writeAsPanel(panel: string, input: GithubWriteInput, host?: string): Promise<string> {
    return this.writeAs(`${PANEL_CALLS}${panel}`, input, host);
  }

  private writeAs(calls: string, input: GithubWriteInput, host?: string): Promise<string> {
    return this.answerWith(
      () => this.accountTarget(host),
      async ({ api, forge }) => {
        if (input.file !== undefined)
          throw new ForgeError("refused", "A release file goes only through a task's own write.");
        if (input.validationEffect !== undefined)
          throw new ForgeError(
            "refused",
            "A validation effect binds a task's own write. Nothing was sent.",
          );
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
          throw new ForgeError("refused", "A change sends POST, PATCH, PUT or DELETE only.");
        if (forge.kind === "github" || forge.kind === "gitlab")
          await guardApiWrite(forge.kind, route, parsed, () => forge.defaultBranch());
        const response = await this.send(
          calls,
          api,
          route.method,
          route.path,
          body,
          undefined,
          forge.host ?? GITHUB_HOST,
          true,
        );
        if (response.status >= 500) throw new IntegrationOutcomeUnknown(render(response, api));
        if (response.status >= 300) throw new ForgeError("refused", render(response, api));
        return render(response, api);
      },
      true,
    );
  }

  private async readOn(caller: string, api: ForgeApi, input: GithubReadInput): Promise<string> {
    const route = api.route(input.method ?? "GET", input.path);
    if (route.write) throw new ForgeError("refused", "github_read sends GET or HEAD only.");
    let path = route.path;
    let served: number | undefined;
    for (;;) {
      try {
        const response = await this.send(caller, api, route.method, path);
        const asked = new URLSearchParams(route.path.split("?")[1]).get("per_page");
        const paged =
          served === undefined
            ? []
            : [
                `The answer ${asked === null ? "at the default page size" : `at per_page=${asked}`} exceeds the ${API_RESPONSE_MAX_BYTES / 1024} KiB read limit, so this is ${api.place}'s page at per_page=${served}; nextPath continues at that size.`,
              ];
        return render(response, api, paged);
      } catch (caught) {
        if (!(caught instanceof OversizedAnswer) || route.method !== "GET") throw caught;
        const smaller = smallerPage(path, caught, api.defaultPerPage);
        if ("refused" in smaller)
          throw new ForgeError("refused", `${caught.message} ${smaller.refused}`);
        path = api.route("GET", smaller.path).path;
        served = smaller.perPage;
      }
    }
  }

  write(
    taskId: string,
    input: GithubWriteInput,
    through?: "account" | { host: string },
    integrationAllowed = false,
  ): Promise<string> {
    return this.answer(
      taskId,
      async (target) => {
        const { api, forge } = target;
        if (input.file !== undefined) {
          if (input.validationEffect !== undefined)
            throw new ForgeError(
              "refused",
              "A validation effect binds a JSON request, not a release file. No file was sent.",
            );
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
        if (
          (route.own || target.via === "account") &&
          (forge.kind === "github" || forge.kind === "gitlab")
        ) {
          await guardApiWrite(forge.kind, route, parsed, () => forge.defaultBranch());
        }
        this.guardPresentationWrite(taskId, forge, route, parsed);
        const why =
          integrationAllowed && target.integration
            ? undefined
            : this.askReason(taskId, route, target);
        if (why)
          return this.keepAsk(taskId, target, route, body, why, undefined, input.validationEffect);
        const dispatched = await this.dispatchBaseline(taskId, target, route, parsed);
        const response = await this.send(
          taskId,
          api,
          route.method,
          route.path,
          body,
          input.validationEffect,
          forge.host ?? GITHUB_HOST,
          integrationAllowed,
        );
        if (integrationAllowed && response.status >= 500)
          throw new IntegrationOutcomeUnknown(render(response, api));
        if (integrationAllowed && response.status >= 300)
          throw new ForgeError("refused", render(response, api));
        const answered = render(response, api);
        return `${answered}${await this.afterWrite(taskId, target, route, response, dispatched)}`;
      },
      through,
      integrationAllowed,
    );
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
    if (
      (route.own || target.via === "account") &&
      (forge.kind === "github" || forge.kind === "gitlab")
    ) {
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
    const taken = this.options.tasks.delivery.takeWriteAsk(taskId, askId);
    if ("refused" in taken) {
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why: taken.refused } };
    }
    if (taken.ask.kind === "integration") {
      // An integration's ask runs through its binding (`IntegrationsService.sendAsk`).
      const why =
        "an integration's action is not a write where a project lives, so it was not sent";
      this.options.tasks.delivery.recordWriteAskOutcome(taskId, taken.ask.id, {
        kind: "refused",
        why,
      });
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why } };
    }
    const ask = taken.ask;
    const done = (outcome: WriteAskOutcome, answer?: string): WriteAskSent => {
      this.options.tasks.delivery.recordWriteAskOutcome(taskId, ask.id, outcome);
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
      // A write asked through the github.com sign-in goes through it, as
      // asked - the GitHub integration's included, whatever the task's
      // project became (docs/integrations.md).
      target = ask.via === "account" ? this.accountTarget(ask.host) : this.targetOf(taskId);
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
      if (
        (route.own || target.via === "account") &&
        (forge.kind === "github" || forge.kind === "gitlab")
      ) {
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
      await this.beforeValidationWrite(
        taskId,
        ask.validationEffect,
        ask.host,
        route.method,
        route.path,
        ask.body,
      );
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
    // Every description host uses the story owner, including servers without native uploads.
    if (!route.own || (!forge.storyDestination && !forge.attachments)) return;
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
        `Use prepare_change and open_change to publish this task's saved story with its ${gitlab ? "merge request" : "pull request"}. Native media hosts confirm every selected attachment first.`,
      );
    // Every change keeps its own story (INF-2490), so each one's description is guarded.
    const delivery = record?.delivery;
    const changes = record ? this.options.tasks.changesFor(taskId) : [];
    const guarded = storyLedgers(delivery).map(
      (ledger) =>
        ledger.publication?.number ??
        ledger.published?.number ??
        (ledger === delivery?.presentation
          ? delivery.prNumber
          : changes.find((change) => change.head.branch === (ledger.branch ?? record?.branch))
              ?.handle?.number),
    );
    // Compare by value: GitHub reads pulls/036 as pull request 36 (INF-285 G1). GitHub's
    // issues route is an alias for a pull request's description; GitLab's issues are their own.
    const named = (gitlab ? /^merge_requests\/(\d+)$/ : /^(?:pulls|issues)\/(\d+)$/).exec(rest);
    // GitLab also reads a field from the query string (INF-290 F1), so either place names it.
    const field = gitlab ? "description" : "body";
    const query = new URLSearchParams(route.path.split("?")[1] ?? "");
    if (
      route.method === (gitlab ? "PUT" : "PATCH") &&
      named &&
      guarded.includes(Number(named[1])) &&
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
   * answers and the write is not a run start or rerun on its own project
   * (INF-729 way D), or it goes through the github.com sign-in.
   */
  private askReason(taskId: string, route: ApiRoute, target: Target): string | undefined {
    if (target.integration) {
      return `it goes through the ${target.forge.kind === "gitlab" ? "GitLab" : target.forge.host && target.forge.host !== GITHUB_HOST ? "GitHub Enterprise" : "GitHub"} integration, and every change there asks the captain`;
    }
    if (target.via === "account") {
      return this.options.tasks.get(taskId)?.repoId
        ? "this task's project has no API where it lives, so its writes go through the captain's github.com sign-in, and each one asks the captain"
        : "this task has no project, so its writes go through the captain's github.com sign-in, and each one asks the captain";
    }
    if (
      this.options.tasks.get(taskId)?.shape?.deliverable === "answer" &&
      !startsRun(target.forge, route)
    ) {
      return "this task only answers, so every write it makes but a run start or rerun on its own project asks the captain";
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
    validationEffect?: string,
  ): string {
    const ask: ForgeWriteAsk = {
      id: `wa${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: target.forge.kind === "gitlab" ? "gitlab" : "github",
      host: target.forge.host ?? GITHUB_HOST,
      place: target.api.place,
      via: target.via,
      method: route.method as ForgeWriteAsk["method"],
      path: route.path,
      ...(body !== undefined ? { body } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(validationEffect ? { validationEffect } : {}),
      at: this.options.now(),
    };
    this.options.tasks.delivery.keepWriteAsk(taskId, ask);
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
  private targetOf(taskId: string, through?: "account" | { host: string }): Target {
    const task = this.options.tasks.get(taskId);
    if (!task) throw new ForgeError("not-found", "The task is no longer available.");
    // The GitHub integration reaches GitHub itself, whatever the task's project is.
    if (through)
      return {
        ...this.accountTarget(through === "account" ? undefined : through.host),
        integration: true,
      };
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

  /** The github.com sign-in's own target. */
  private accountTarget(host?: string): Target {
    const account = this.options.accountForge?.(host);
    if (account?.api) return { api: account.api, forge: account, via: "account" };
    throw new ForgeError("unsupported", "The app has no GitHub connection to call.");
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
      await closed(file.stream);
    }
  }

  private async send(
    taskId: string,
    api: ForgeApi,
    method: Parameters<ForgeApi["call"]>[0],
    path: string,
    body?: string,
    validationEffect?: string,
    host = GITHUB_HOST,
    integrationCall = false,
  ): Promise<ForgeApiResponse> {
    this.spend(taskId, api);
    await this.beforeValidationWrite(taskId, validationEffect, host, method, path, body);
    try {
      return await api.call(method, path, body);
    } catch (caught) {
      if (
        !integrationCall ||
        isSignInForgeFailure(caught) ||
        (caught instanceof ForgeError && caught.beforeSend)
      )
        throw caught;
      throw new IntegrationOutcomeUnknown(messageOf(caught));
    }
  }

  private async beforeValidationWrite(
    taskId: string,
    request: string | undefined,
    host: string,
    method: ApiRoute["method"],
    path: string,
    body?: string,
  ): Promise<void> {
    if (!request) return;
    if (!this.options.beforeValidationWrite)
      throw new ForgeError(
        "refused",
        "Validation approval cannot be checked here; nothing was sent.",
      );
    if (method === "GET" || method === "HEAD")
      throw new ForgeError("refused", "A validation write approval cannot authorize a read.");
    try {
      await this.options.beforeValidationWrite(taskId, request, {
        host,
        method,
        path,
        ...(body === undefined
          ? {}
          : { bodyDigest: createHash("sha256").update(body).digest("hex") }),
      });
    } catch (caught) {
      // This is the host's preflight, before the API has been called, not an unknown network outcome.
      throw new ForgeError(
        "refused",
        caught instanceof Error
          ? caught.message
          : "Validation approval could not be checked; nothing was sent.",
      );
    }
  }

  /** One call of the task's budget, or the refusal once it is spent. */
  private spend(taskId: string, api: ForgeApi): void {
    if (taskId === LOOK_CALLS || taskId.startsWith(PANEL_CALLS)) return;
    const used = this.calls.get(taskId) ?? 0;
    if (used >= API_CALLS_PER_TASK) {
      throw new ForgeError(
        "refused",
        `This task used its ${API_CALLS_PER_TASK} ${api.place} calls.`,
      );
    }
    this.calls.set(taskId, used + 1);
  }

  /**
   * The workflow's dispatched runs before a GitHub dispatch that will not
   * return its run's number (no `"return_run_details": true`), so the run
   * it starts can still be watched (INF-1428): afterwards, the one run of
   * that workflow on that ref missing here is its run. One budgeted call,
   * taken only while the dispatch itself still fits the budget; a failed
   * read only means no run is found.
   */
  private async dispatchBaseline(
    taskId: string,
    target: Target,
    route: ApiRoute,
    parsed: unknown,
  ): Promise<DispatchBaseline | undefined> {
    if (!this.options.watchRun || !route.own || target.via !== "project") return undefined;
    if (route.method !== "POST" || !isDispatch(target.forge, restOf(route))) return undefined;
    const body = objectOf(parsed);
    if (body.return_run_details === true) return undefined;
    if ((this.calls.get(taskId) ?? 0) + 2 > API_CALLS_PER_TASK) return undefined;
    const ref = typeof body.ref === "string" ? body.ref.replace(/^refs\/(heads|tags)\//, "") : "";
    try {
      const runs = await this.dispatchedRuns(taskId, target.api, route);
      return runs ? { ids: new Set(runs.map((run) => run.id)), ref } : undefined;
    } catch {
      return undefined;
    }
  }

  /** The newest dispatched runs of a dispatch route's workflow, or undefined when unreadable. */
  private async dispatchedRuns(
    taskId: string,
    api: ForgeApi,
    route: ApiRoute,
  ): Promise<{ id: number; ref: string }[] | undefined> {
    const path = `${route.path.split("?")[0]?.replace(/\/dispatches$/, "/runs")}?event=workflow_dispatch&per_page=20`;
    const response = await this.send(taskId, api, "GET", path);
    if (response.status >= 300) return undefined;
    const runs = responseObject(response).workflow_runs;
    if (!Array.isArray(runs)) return undefined;
    return runs.flatMap((run) => {
      const { id, head_branch: ref } = objectOf(run);
      return typeof id === "number" && Number.isSafeInteger(id)
        ? [{ id, ref: typeof ref === "string" ? ref : "" }]
        : [];
    });
  }

  /**
   * The run a dispatch with no run number started (INF-1428): the one
   * dispatched run of its workflow, on its ref, that was not there before
   * it was sent. Reread a few times while GitHub queues it; two new runs
   * are someone else's race, and the app never guesses between them.
   */
  private async findDispatchedRun(
    taskId: string,
    api: ForgeApi,
    route: ApiRoute,
    before: DispatchBaseline,
  ): Promise<number | undefined> {
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let attempt = 1; attempt <= REREAD_ATTEMPTS; attempt++) {
      await sleep(REREAD_DELAY_MS);
      let runs: { id: number; ref: string }[] | undefined;
      try {
        runs = await this.dispatchedRuns(taskId, api, route);
      } catch {
        return undefined;
      }
      if (!runs) return undefined;
      const fresh = runs.filter(
        (run) => !before.ids.has(run.id) && (!before.ref || run.ref === before.ref),
      );
      if (fresh.length > 1) return undefined;
      if (fresh[0]) return fresh[0].id;
    }
    return undefined;
  }

  /** Watch only exact run identities from successful own-project writes, never guess by version. */
  private async afterWrite(
    taskId: string,
    target: Target,
    route: ApiRoute,
    response: ForgeApiResponse,
    dispatched?: DispatchBaseline,
  ): Promise<string> {
    if (response.status >= 300 || !route.own || target.via !== "project") return "";
    const notes: string[] = [];
    const rest = route.rest.split("/").map(decodeURIComponent).join("/");
    const dispatch = isDispatch(target.forge, rest);
    const pipeline = isPipelineStart(target.forge, rest);
    const started = startsRun(target.forge, route);
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
    let found = false;
    if (dispatch && !isRunNumber(runId) && dispatched && this.options.watchRun) {
      runId = await this.findDispatchedRun(taskId, target.api, route, dispatched);
      found = isRunNumber(runId);
      if (found) unread = false;
    }
    const known = isRunNumber(runId);
    if (this.options.watchRun && started) {
      let note = unread ? WATCH_NOT_STARTED : NO_RUN_NUMBER;
      if (known) {
        try {
          note = `${found ? `The dispatch returned no run number; run ${runId} is the one new dispatched run of that workflow on that ref since it was sent. ` : ""}${this.options.watchRun(taskId, runId as number)}`;
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
    this.options.tasks.delivery.recordChangeEvidence(
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
  private answer(
    taskId: string,
    run: (target: Target) => Promise<string>,
    through?: "account" | { host: string },
    propagate = false,
  ): Promise<string> {
    return this.answerWith(() => this.targetOf(taskId, through), run, propagate);
  }

  private async answerWith(
    targetOf: () => Target,
    run: (target: Target) => Promise<string>,
    propagate = false,
  ): Promise<string> {
    let place = "GitHub";
    try {
      const target = targetOf();
      place = target.api.place;
      return await run(target);
    } catch (caught) {
      if (propagate) throw caught;
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

/**
 * Destroy a release file's stream and wait until it has closed. A stream the
 * host refused before reading (a missing release, a refused sign-in) may still
 * have its open queued; the upload's answer is already decided, so a late open
 * error is dropped rather than left with no listener (INF-773, INF-777).
 */
function closed(stream: Readable): Promise<void> {
  stream.on("error", () => {});
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}

/** Status, ids and the bounded answer; a next page only as a path a read may reach. */
function render(response: ForgeApiResponse, api: ForgeApi, said: string[] = []): string {
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
    ...said,
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

/** A GitHub workflow dispatch, by its path under the project. */
function isDispatch(forge: Forge, rest: string): boolean {
  return forge.kind === "github" && /^actions\/workflows\/[^/]+\/dispatches$/.test(rest);
}

/** A GitLab pipeline start, by its path under the project. */
function isPipelineStart(forge: Forge, rest: string): boolean {
  return forge.kind === "gitlab" && rest === "pipeline";
}

/**
 * A start or rerun of a run on the task's own project: a workflow dispatch
 * or a run or job rerun on GitHub, a pipeline start, a pipeline or job
 * retry or a manual job's play on GitLab. A task that only answers sends
 * these at once (INF-729).
 */
function startsRun(forge: Forge, route: ApiRoute): boolean {
  if (!route.own || route.method !== "POST") return false;
  const rest = route.rest.split("/").map(decodeURIComponent).join("/");
  return isDispatch(forge, rest) || isPipelineStart(forge, rest) || route.rerun;
}

/** A route's path under the project, decoded. */
function restOf(route: ApiRoute): string {
  return route.rest.split("/").map(decodeURIComponent).join("/");
}

function isRunNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A workflow's dispatched runs before a dispatch, and the ref it names (`dispatchBaseline`). */
type DispatchBaseline = { ids: Set<number>; ref: string };

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
