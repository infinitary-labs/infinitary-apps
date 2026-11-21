import { randomUUID } from "node:crypto";
import type { WorkInvokeChannel } from "@shared/ipc";
import type { TaskBrowserCommandResult } from "@shared/taskBrowser";
import { workRequests } from "@shared/work";
import {
  type BrowserOrderChannel,
  type BrowserOrderRequest,
  browserOrders,
  isBrowserOrderChannel,
} from "@shared/workBrowsers";
import { AxiChannel, type TaskShell } from "../axi/channel";
import type { GuardLookup } from "../browser/connectionGuard";
import { type BrowserFrameSink, type CrewmateBrowser, TaskBrowsers } from "../browser/taskBrowsers";
import { WebSignIns } from "../browser/webSignIns";
import type { TaskFiles } from "../files/taskFiles";
import type { HostBrowserFrame, HostChildSpawner, HostTaskBrowser } from "../host";
import type { TaskIntegrations } from "../integrations";
import type { LoadLine } from "../placed/loadLine";
import type { SecretsCatalog, SecretsCommand } from "../secrets/requests";
import type { LeftBehindHere } from "../tasks/leftBehind";
import { keepsThere, taskStopsCommand } from "../tasks/taskStops";

/**
 * The browsers of the tasks a computer that runs work holds
 * (docs/task-browser.md, "On another computer"): each task's own browser
 * runs here, beside its crewmate's shell, so the pages it opens on this
 * computer's loopback are this computer's, its connection guard checks
 * every address from here, and its pictures land in the task's evidence
 * folder here. `TaskBrowsers` owns them here as it owns the home's own, with
 * every rule it keeps; the crewmate reaches its browser through this
 * computer's own task channel (`infinitary-browser-axi`, docs/axi-commands.md).
 * The same channel carries `infinitary-integrations-axi` to the home's
 * integrations, which the home answers (docs/integrations.md, "On a
 * computer that runs work"); none of them is here. It carries
 * `infinitary-secrets-axi` to the home's Secrets catalog too, which lists
 * metadata only: no use, value or custody is here (docs/secrets.md).
 *
 * The captain's side is the home's: it asks the orders in
 * `browserOrders` (src/shared/workBrowsers.ts) - his view's pictures and room, his
 * Take control, input and Return control, Stop browser and Open again, a
 * request card's pause, a saved sign-in he lends or removes, the task's
 * close - and hears each browser's fact as it changes, and its pictures
 * while he watches, once each while it is in reach. What must reach the
 * home once - a timeline line, the crewmate's wake on a return - is asked
 * until it answers.
 *
 * This computer keeps its own signed-in sites (docs/task-browser.md,
 * "Signed-in sites"): what the captain signs in to here stays in this
 * computer's kept profile, on its disk, as his own browser's profile rests
 * on his, and the list of those sites and his rule for each is this
 * computer's too. Nothing of a sign-in crosses to the home.
 */

export type ComputerBrowsersOptions = {
  /** This computer's browser engine (`src/main/host/taskBrowser.ts`). */
  host: HostTaskBrowser;
  /** Starts the process one command runs in (`src/main/host/axiProcess.ts`). */
  spawner: HostChildSpawner;
  /** The launcher's folder (`resources/axi-bin`). */
  binDir: string;
  /** The app's version, which `-v` prints. */
  version: string;
  /** This computer's folder for the tasks' keys, emptied when the channel opens and closes. */
  keysDir: string;
  load?: LoadLine;
  /** Told the shell a command came from once it reached this computer (`AxiChannelOptions.answering`). */
  answering?: (shell: string) => void;
  /** Where a task's pictures go: its evidence folder here. */
  evidenceDir: (task: string) => string;
  /** What this computer's finished tasks left, which a cleanup look acts on (docs/leftover-programs.md). */
  leftBehind?: LeftBehindHere;
  /** A task's own folder here, which keeps its registered stops (docs/leftover-programs.md). */
  taskFolder?: (task: string) => string;
  /** The task's working copy here: the only folder its crewmate attaches a page's file from. */
  workingCopy?: (task: string) => string | undefined;
  /** Asked once, while the home is in reach, and never again (`HomeLink.invoke`). */
  tell: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
  /** Asked until the home answers, under one call id (`HomeLink.ask`). */
  ask: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
  /** How a guard resolves a name; the system's resolver when absent. */
  lookup?: GuardLookup;
  /** Where this computer keeps its list of signed-in sites; with none, it keeps none. */
  signInsDir?: string;
  log: (line: string) => void;
};

type Watching = { sink: BrowserFrameSink; unwatch: () => void };

export class ComputerBrowsers {
  /** The tasks whose browser has said anything here: the facts the home asks for. */
  private readonly known = new Set<string>();
  /** The tasks the captain watches now, from the home. */
  private readonly watching = new Map<string, Watching>();
  /** A fact being told per task, and whether it changed again meanwhile. */
  private readonly telling = new Map<string, { again: boolean }>();
  /** A picture being sent per task, and the newest one that came meanwhile. */
  private readonly sending = new Map<string, { next?: HostBrowserFrame }>();
  private closed = false;
  readonly browsers: TaskBrowsers;

  private constructor(
    private readonly options: ComputerBrowsersOptions,
    private readonly channel: AxiChannel,
  ) {
    this.browsers = new TaskBrowsers({
      host: options.host,
      evidenceDir: options.evidenceDir,
      ...(options.workingCopy ? { workingCopy: options.workingCopy } : {}),
      ...(options.lookup ? { lookup: options.lookup } : {}),
      // What happens to a task's browser is news on its record at the home.
      note: (task, text) => this.event(task, { kind: "note", text }),
      onChange: (task) => {
        this.known.add(task);
        this.tellFact(task);
      },
      // The captain's Return control wakes its crewmate once, from the home.
      onReturned: (task, returned) =>
        this.event(task, {
          kind: "returned",
          site: returned.site,
          ...(returned.after ? { after: returned.after } : {}),
          ...(returned.saved ? { saved: true as const } : {}),
          once: returned.once,
        }),
      ...(options.signInsDir ? { signIns: new WebSignIns(options.signInsDir) } : {}),
      // The home's private sites list, included by every admitted work peer
      // and lent as each page opens; out of reach keeps the last read (none at first).
      privateSites: async (task) =>
        workRequests["inf:work:private-sites"].response.parse(
          await options.tell("inf:work:private-sites", [{ task }]),
        ).sites,
    });
  }

  /** The browsers and their channel, listening on this computer's loopback. */
  static async open(options: ComputerBrowsersOptions): Promise<ComputerBrowsers> {
    const channel = await AxiChannel.open({
      spawner: options.spawner,
      binDir: options.binDir,
      version: options.version,
      keysDir: options.keysDir,
      ...(options.answering ? { answering: options.answering } : {}),
    });
    return new ComputerBrowsers(options, channel);
  }

  /**
   * A task's crewmate is given its commands: its browser, when the home says
   * it has one, the integrations it reaches through the home, and the
   * home's Secrets catalog, with what its shell carries to reach them. A
   * task granted again keeps its key, so a shell already given it still
   * answers, and takes the tools granted now.
   */
  grant(
    task: string,
    tools: {
      browser: boolean;
      integrations?: TaskIntegrations;
      load?: boolean;
      files?: TaskFiles;
      secretsCatalog?: SecretsCatalog;
      /** Its uses, asked of the home and run here (docs/secrets.md, "On a computer that runs work"). */
      secrets?: SecretsCommand;
      stops?: boolean;
      /** Whether its crewmate may keep a job past the close: false for another user on the home's own computer. */
      keeps?: boolean | undefined;
    },
  ): { browser?: CrewmateBrowser; shell: TaskShell } {
    const browser = tools.browser ? this.browsers.forTask(task) : undefined;
    const shell = this.channel.grant(task, {
      ...(tools.load && this.options.load ? { load: this.options.load.forTask(task) } : {}),
      ...(browser ? { browser } : {}),
      ...(tools.integrations ? { integrations: tools.integrations } : {}),
      ...(tools.files ? { files: tools.files } : {}),
      ...(tools.secretsCatalog ? { secretsCatalog: tools.secretsCatalog } : {}),
      ...(tools.secrets ? { secrets: tools.secrets } : {}),
      // Its stops are kept in its folder here, beside its shell (docs/leftover-programs.md).
      ...(tools.stops && this.options.taskFolder
        ? {
            stops: taskStopsCommand(
              this.options.taskFolder(task),
              Date.now,
              this.options.leftBehind,
              keepsThere(tools.keeps),
            ),
          }
        : {}),
    });
    return { ...(browser ? { browser } : {}), shell };
  }

  /** The task's conversation closed for good here: its browser goes, and its command answers nothing more. */
  close(task: string): void {
    this.unwatch(task);
    this.browsers.closeTask(task);
    this.channel.revoke(task);
  }

  /** The home is out of reach: nobody watches from there now, so an unused browser may stop. */
  dropped(): void {
    for (const task of [...this.watching.keys()]) this.unwatch(task);
  }

  /** This computer stops: every browser goes, and every key with it. */
  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of [...this.watching.keys()]) this.unwatch(task);
    this.browsers.closeAll();
    this.channel.close();
  }

  /** Answers one order about a task's browser (`browserOrders`), or throws why not. */
  async answer(channel: string, args: unknown): Promise<unknown> {
    if (this.closed) throw new Error("This computer is stopping.");
    if (!isBrowserOrderChannel(channel))
      throw new Error(`${channel} is not a request this computer answers.`);
    const parsed = browserOrders[channel].request.safeParse(args);
    if (!parsed.success) throw new Error(`Rejected ${channel}: malformed request`);
    return this.act(channel, parsed.data);
  }

  private async act(channel: BrowserOrderChannel, request: unknown): Promise<unknown> {
    const browsers = this.browsers;
    switch (channel) {
      case "inf:task-browser:facts":
        return {
          facts: [...this.known].flatMap((task) => {
            const fact = browsers.fact(task);
            return fact ? [{ task, fact }] : [];
          }),
        };
      case "inf:task-browser:watch": {
        const [{ task, watching }] = request as BrowserOrderRequest<"inf:task-browser:watch">;
        if (watching) this.watch(task);
        else this.unwatch(task);
        return { ok: true };
      }
      case "inf:task-browser:size": {
        const [{ task, size }] = request as BrowserOrderRequest<"inf:task-browser:size">;
        const watch = this.watching.get(task);
        if (watch) browsers.sizeView(task, watch.sink, size);
        return { ok: true };
      }
      case "inf:task-browser:input": {
        const [{ task, input, here }] = request as BrowserOrderRequest<"inf:task-browser:input">;
        browsers.captainAt(task, here === true);
        return browsers.captainInput(task, input);
      }
      case "inf:task-browser:places": {
        const [{ task }] = request as BrowserOrderRequest<"inf:task-browser:places">;
        return browsers.places(task);
      }
      case "inf:task-browser:take": {
        const [{ task, handle, here }] = request as BrowserOrderRequest<"inf:task-browser:take">;
        browsers.captainAt(task, here === true);
        return browsers.takeControl(task, handle);
      }
      case "inf:task-browser:ask": {
        const [{ task, handle, id, answer, here }] =
          request as BrowserOrderRequest<"inf:task-browser:ask">;
        browsers.captainAt(task, here);
        return browsers.answerAsk(task, handle, id, answer);
      }
      case "inf:task-browser:return": {
        const [{ task, handle, rule }] = request as BrowserOrderRequest<"inf:task-browser:return">;
        return browsers.returnControl(
          task,
          handle,
          rule ? { site: rule.site, automatic: rule.automatic } : {},
        );
      }
      case "inf:task-browser:stop": {
        const [{ task }] = request as BrowserOrderRequest<"inf:task-browser:stop">;
        return browsers.stopByCaptain(task);
      }
      case "inf:task-browser:reopen": {
        const [{ task }] = request as BrowserOrderRequest<"inf:task-browser:reopen">;
        return browsers.reopen(task);
      }
      case "inf:task-browser:request": {
        const [{ task, request: asked }] =
          request as BrowserOrderRequest<"inf:task-browser:request">;
        return browsers.requestHelp(task, asked);
      }
      // The retired copies: this computer keeps its own sign-ins.
      case "inf:task-browser:grant":
        return {
          ok: false,
          text: "That computer keeps its own sign-ins now. Update Infinitary on this computer to use them.",
        } satisfies TaskBrowserCommandResult;
      case "inf:task-browser:sign-out":
        return { ok: true };
      case "inf:task-browser:use-sign-in": {
        const [{ task, handle }] = request as BrowserOrderRequest<"inf:task-browser:use-sign-in">;
        return browsers.grantSavedSignIn(task, handle);
      }
      case "inf:task-browser:sign-in-failed": {
        const [{ task, site }] = request as BrowserOrderRequest<"inf:task-browser:sign-in-failed">;
        return { ok: browsers.markSavedSignInFailed(task, site) };
      }
      case "inf:task-browser:sign-ins":
        return { signIns: browsers.savedSignIns() };
      case "inf:task-browser:sign-in-rule": {
        const [{ site, id, automatic }] =
          request as BrowserOrderRequest<"inf:task-browser:sign-in-rule">;
        return browsers.allowAutomaticSignIn(site, id, automatic);
      }
      case "inf:task-browser:sign-in-remove": {
        const [{ site }] = request as BrowserOrderRequest<"inf:task-browser:sign-in-remove">;
        return browsers.removeSavedSignIn(site);
      }
      case "inf:task-browser:sign-in-remove-all":
        return browsers.removeAllSavedSignIns();
      case "inf:task-browser:private-sites": {
        const [{ sites }] = request as BrowserOrderRequest<"inf:task-browser:private-sites">;
        browsers.privateSitesChanged(sites);
        return { ok: true };
      }
      case "inf:task-browser:close": {
        const [{ task }] = request as BrowserOrderRequest<"inf:task-browser:close">;
        this.close(task);
        return { ok: true };
      }
    }
  }

  private watch(task: string): void {
    if (this.watching.has(task)) return;
    const sink: BrowserFrameSink = (frame) => this.sendFrame(task, frame);
    this.watching.set(task, { sink, unwatch: this.browsers.watch(task, sink) });
  }

  private unwatch(task: string): void {
    const watch = this.watching.get(task);
    if (!watch) return;
    this.watching.delete(task);
    watch.unwatch();
  }

  /**
   * One picture home, while the captain watches: one at a time per task,
   * and only the newest of those that came meanwhile, so a slow connection
   * shows the page as it is now rather than as it was.
   */
  private sendFrame(task: string, frame: HostBrowserFrame): void {
    const sending = this.sending.get(task);
    if (sending) {
      sending.next = frame;
      return;
    }
    const state: { next?: HostBrowserFrame } = {};
    this.sending.set(task, state);
    const send = (picture: HostBrowserFrame): void => {
      void this.options
        .tell("inf:work:browser-frame", [{ task, frame: picture }])
        .catch(() => undefined)
        .finally(() => {
          const next = state.next;
          state.next = undefined;
          if (next && this.watching.has(task)) send(next);
          else this.sending.delete(task);
        });
    };
    send(frame);
  }

  /** The browser's fact home, whole: one at a time per task, then once more if it changed meanwhile. */
  private tellFact(task: string): void {
    const telling = this.telling.get(task);
    if (telling) {
      telling.again = true;
      return;
    }
    const state = { again: false };
    this.telling.set(task, state);
    const tell = (): void => {
      void this.options
        .tell("inf:work:browser", [{ task, fact: this.browsers.fact(task) ?? null }])
        .catch(() => undefined)
        .finally(() => {
          if (state.again && !this.closed) {
            state.again = false;
            tell();
          } else this.telling.delete(task);
        });
    };
    tell();
  }

  /** Something the home does once for a task's browser, asked until it answers. */
  private event(task: string | undefined, event: BrowserOrderEvent): void {
    if (!task) return;
    void this.options
      .ask("inf:work:browser-event", [{ task, callId: randomUUID(), event }])
      .catch((error: unknown) =>
        this.options.log(`a browser's ${event.kind} did not reach the home: ${messageOf(error)}`),
      );
  }
}

type BrowserOrderEvent =
  | { kind: "note"; text: string }
  | { kind: "returned"; site: string; after?: string; saved?: true; once: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
