import { randomUUID } from "node:crypto";
import type { WorkInvokeChannel } from "@shared/ipc";
import type { TaskBrowserCommandResult } from "@shared/taskBrowser";
import {
  type BrowserOrderChannel,
  type BrowserOrderRequest,
  browserOrders,
  isBrowserOrderChannel,
  workRequests,
} from "@shared/work";
import { AxiChannel, type TaskShell } from "../axi/channel";
import type { GuardLookup } from "../browser/connectionGuard";
import {
  type BrowserFrameSink,
  type CrewmateBrowser,
  type SignInStore,
  TaskBrowsers,
} from "../browser/taskBrowsers";
import {
  type HeldSignIn,
  type SavedSignInRecord,
  signInSite,
  storageOfSite,
} from "../browser/webSignIns";
import type { HostBrowserFrame, HostChildSpawner, HostTaskBrowser } from "../host";
import type { TaskIntegrations } from "../integrations";

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
 * computer that runs work"); none of them is here.
 *
 * The captain's side is the home's: it asks the orders in
 * `browserOrders` (src/shared/work.ts) - his view's pictures and room, his
 * Take control, input and Return control, Stop browser and Open again, a
 * request card's pause, a saved sign-in he lends or removes, the task's
 * close - and hears each browser's fact as it changes, and its pictures
 * while he watches, once each while it is in reach. What must reach the
 * home once - a timeline line, the crewmate's wake on a return, a saved
 * sign-in copied back - is asked until it answers.
 *
 * A saved sign-in stays the home's: the home lends one save to a browser
 * here on the captain's click, which holds it in its site data in memory
 * only and copies it back by the save's id as it stops, and the captain's
 * Remember tick sends what the browser holds of the site home in the
 * answer to his Return control. Nothing here writes a sign-in to a file.
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
  /** Told the shell a command came from once it reached this computer (`AxiChannelOptions.answering`). */
  answering?: (shell: string) => void;
  /** Where a task's pictures go: its evidence folder here. */
  evidenceDir: (task: string) => string;
  /** Asked once, while the home is in reach, and never again (`HomeLink.invoke`). */
  tell: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
  /** Asked until the home answers, under one call id (`HomeLink.ask`). */
  ask: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
  /** How a guard resolves a name; the system's resolver when absent. */
  lookup?: GuardLookup;
  log: (line: string) => void;
};

/**
 * The one save at a time the home lends a browser here, and what the
 * captain's Remember tick saves, as `TaskBrowsers` reads its store: nothing
 * is kept here past the call that needed it.
 */
class LentSignIns implements SignInStore {
  private readonly lent = new Map<string, SavedSignInRecord>();
  /** The save the captain's Remember tick makes now: the id the home chose, and what it took. */
  private saving: { id: string; taken?: { site: string; held: HeldSignIn } } | undefined;

  constructor(private readonly copyBack: (site: string, id: string, held: HeldSignIn) => void) {}

  list(): [] {
    return [];
  }

  get(site: string): SavedSignInRecord | undefined {
    return this.lent.get(signInSite(site));
  }

  save(site: string, held: HeldSignIn): SavedSignInRecord {
    const key = signInSite(site);
    const record: SavedSignInRecord = {
      site: key,
      savedAt: Date.now(),
      id: this.saving?.id ?? randomUUID(),
      cookies: [...held.cookies],
      storage: storageOfSite(held.storage, key),
    };
    if (this.saving)
      this.saving.taken = { site: key, held: { cookies: record.cookies, storage: record.storage } };
    return record;
  }

  refresh(site: string, id: string, held: HeldSignIn): boolean {
    if (this.saving?.id === id) this.saving.taken = { site: signInSite(site), held };
    else this.copyBack(signInSite(site), id, held);
    return true;
  }

  remove(): boolean {
    return false;
  }

  /** Lends one save for the run of one grant. */
  async lending<T>(record: SavedSignInRecord, run: () => Promise<T>): Promise<T> {
    const key = signInSite(record.site);
    this.lent.set(key, record);
    try {
      return await run();
    } finally {
      if (this.lent.get(key) === record) this.lent.delete(key);
    }
  }

  /** Runs one Return control whose tick saves under `id`; what it took, if anything. */
  async remembering<T>(
    id: string,
    run: () => Promise<T>,
  ): Promise<{ result: T; taken?: { site: string; held: HeldSignIn } }> {
    this.saving = { id };
    try {
      const result = await run();
      const taken = this.saving?.taken;
      return { result, ...(taken ? { taken } : {}) };
    } finally {
      this.saving = undefined;
    }
  }
}

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
  /** Returns with the Remember tick, one at a time, so each takes its own save. */
  private remembered: Promise<unknown> = Promise.resolve();
  /** The task each save the home lent or made here belongs to, by the save's id. */
  private readonly owners = new Map<string, string>();
  private readonly lent: LentSignIns;
  private closed = false;
  readonly browsers: TaskBrowsers;

  private constructor(
    private readonly options: ComputerBrowsersOptions,
    private readonly channel: AxiChannel,
  ) {
    // A browser copies a save back once, as it stops; a fresh one holds none.
    this.lent = new LentSignIns((site, id, held) => {
      this.event(this.owners.get(id), { kind: "sign-in", site, id, held });
    });
    this.browsers = new TaskBrowsers({
      host: options.host,
      evidenceDir: options.evidenceDir,
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
      signIns: this.lent,
      automaticSignIn: async (task, site) => {
        const result = workRequests["inf:work:browser-sign-in"].response.parse(
          await options.tell("inf:work:browser-sign-in", [{ task, site }]),
        );
        if (result.signIn) this.owners.set(result.signIn.id, task);
        return result.signIn;
      },
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
   * it has one, and the integrations it reaches through the home, with what
   * its shell carries to reach them. A task granted again keeps its key, so
   * a shell already given it still answers, and takes the tools granted now.
   */
  grant(
    task: string,
    tools: { browser: boolean; integrations?: TaskIntegrations },
  ): { browser?: CrewmateBrowser; shell: TaskShell } {
    const browser = tools.browser ? this.browsers.forTask(task) : undefined;
    const shell = this.channel.grant(task, {
      ...(browser ? { browser } : {}),
      ...(tools.integrations ? { integrations: tools.integrations } : {}),
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

  /** This computer stops: every browser goes, with nothing copied back, and every key with it. */
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
        const [{ task, input }] = request as BrowserOrderRequest<"inf:task-browser:input">;
        return browsers.captainInput(task, input);
      }
      case "inf:task-browser:take": {
        const [{ task, handle }] = request as BrowserOrderRequest<"inf:task-browser:take">;
        return browsers.takeControl(task, handle);
      }
      case "inf:task-browser:return": {
        const [{ task, handle, remember }] =
          request as BrowserOrderRequest<"inf:task-browser:return">;
        if (!remember) return browsers.returnControl(task, handle);
        this.owners.set(remember.id, task);
        // One tick at a time, so the save each takes is its own.
        const run = this.remembered.then(() =>
          this.lent.remembering(remember.id, () =>
            browsers.returnControl(task, handle, {
              remember: !remember.refresh,
              ...(remember.site ? { site: remember.site } : {}),
              ...(remember.refresh ? { savedId: remember.id } : {}),
            }),
          ),
        );
        this.remembered = run.catch(() => undefined);
        const { result, taken } = await run;
        return result.ok && taken ? { ...result, remembered: taken } : result;
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
      case "inf:task-browser:grant": {
        const [{ task, handle, signIn }] = request as BrowserOrderRequest<"inf:task-browser:grant">;
        const record: SavedSignInRecord = {
          site: signInSite(signIn.site),
          savedAt: signIn.savedAt,
          id: signIn.id,
          cookies: signIn.cookies,
          storage: signIn.storage,
        };
        this.owners.set(record.id, task);
        return this.lent.lending(record, () =>
          browsers.grantSavedSignIn(task, handle),
        ) as Promise<TaskBrowserCommandResult>;
      }
      case "inf:task-browser:sign-out": {
        const [{ site }] = request as BrowserOrderRequest<"inf:task-browser:sign-out">;
        await browsers.removeSavedSignIn(site);
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
  | { kind: "returned"; site: string; after?: string; saved?: true; once: string }
  | { kind: "sign-in"; site: string; id: string; held: HeldSignIn };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
