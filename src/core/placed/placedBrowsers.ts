import { randomUUID } from "node:crypto";
import { HERE } from "@shared/deviceNames";
import type { InvokeRequest, InvokeResponse } from "@shared/ipc";
import type {
  OfferedSignIn,
  SavedSignIn,
  TaskBrowserCommandResult,
  TaskBrowserFact,
  TaskBrowserHandle,
  TaskBrowserInput,
  TaskBrowserRequest,
  TaskBrowserReturn,
  TaskBrowserSize,
} from "@shared/taskBrowser";
import {
  type BrowserOrderChannel,
  type BrowserOrderRequest,
  type BrowserOrderResponse,
  browserOrders,
} from "@shared/work";
import {
  type BrowserAnswer,
  type BrowserFrameSink,
  type BrowserReturned,
  type CrewmateBrowser,
  failedSignInNote,
  offeredOf,
  offeredSignIn,
  type ProjectPage,
  siteNamed,
  type TaskBrowsers,
} from "../browser/taskBrowsers";
import {
  cookiesOfSite,
  liveCookies,
  signInSite,
  storageOfSite,
  type WebSignIns,
} from "../browser/webSignIns";
import { DeviceOutOfReachError } from "../connection/connection";
import type { PlacedBrowserSink } from "./placedSessions";
import type { WorkDevices } from "./workDevices";

/**
 * The captain's side of the browsers of tasks that run on another computer
 * (docs/task-browser.md, "On another computer"). Each such browser runs on
 * its task's computer, owned there by that computer's own `TaskBrowsers`
 * (`src/core/helper/browsers.ts`); this Mac keeps what the captain reads of
 * it and asks that computer for everything he does to it.
 *
 * - Its fact is the one that computer last said, kept until it says
 *   another, and asked for whole each time it comes back into reach; what
 *   the record's Browser line, a card's door, the idle ladder and the view
 *   read is that fact, as for a browser here.
 * - The view's pictures come from there while any view here watches, the
 *   newest one at a time; the room a maximized view gives the page goes
 *   there, and goes back when that view restores or stops watching.
 * - Take control, his input, Return control, Stop browser and Open again,
 *   a request card's pause and the task's close are orders to that
 *   computer, answered there by the same rules a browser here keeps; out
 *   of reach, each is refused in words and nothing is done.
 * - A saved sign-in stays this Mac's: the captain's click lends that one
 *   site's save to the browser there, which copies it back by its id as it
 *   stops, and his Remember tick brings what the browser holds of the site
 *   here, saved under an id this Mac chose first.
 * - What that computer has this Mac do once - a timeline line, the
 *   crewmate's wake on a return, a copy back - arrives as a work request
 *   the conversations' ledger answers once (`PlacedSessions`).
 */

export type PlacedBrowsersOptions = {
  devices: Pick<WorkDevices, "ask" | "onWorkDevice">;
  /** The computer a task runs on, by its record; null or absent for this Mac. */
  deviceOf: (taskId: string) => string | null | undefined;
  /** A computer's name, as the captain reads it. */
  nameOf: (deviceId: string) => string;
  /** The website sign-ins saved on this Mac; with none, nothing is lent or saved. */
  signIns?: WebSignIns;
  /** One line on the task's own timeline. */
  note: (taskId: string, text: string) => void;
  /** A task's browser changed for the captain: its record and view read it again. */
  onChange: (taskId: string) => void;
  /** The captain returned a task's browser there: its crewmate's one wake. */
  onReturned: (taskId: string, returned: BrowserReturned) => void;
  now?: () => number;
  log?: (line: string) => void;
};

/** One task's browser there, as this Mac last heard it. */
type Heard = { deviceId: string; fact: TaskBrowserFact };

export class PlacedBrowsers implements PlacedBrowserSink {
  private readonly facts = new Map<string, Heard>();
  /** The views here that watch each task's browser there. */
  private readonly watchers = new Map<string, Set<BrowserFrameSink>>();
  /** The room a maximized view gives each task's page, with the view that asked. */
  private readonly sizes = new Map<string, { sink: BrowserFrameSink; size: TaskBrowserSize }>();
  /** The save this Mac lent or made for each task's browser there, by site: the one a failure marks. */
  private readonly lent = new Map<string, Map<string, string>>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: PlacedBrowsersOptions) {
    this.log = options.log ?? ((line) => console.warn(`[placed-browsers] ${line}`));
    options.devices.onWorkDevice((contact) => {
      if (contact.contact === "in-reach") void this.reached(contact.deviceId);
    });
  }

  /** Whether a task runs on another computer, so its browser is there. */
  holds(taskId: string): boolean {
    return Boolean(this.options.deviceOf(taskId));
  }

  // ---- what that computer says -------------------------------------------------

  automaticSignIn(
    task: string,
    site: string,
  ): InvokeResponse<"inf:work:browser-sign-in">["signIn"] {
    if (!this.holds(task)) return undefined;
    const record = this.options.signIns?.get(site);
    if (!record?.automatic) return undefined;
    this.lend(task, record.site, record.id);
    const { failedAt: _failedAt, ...lent } = record;
    return { ...lent, automatic: true, cookies: liveCookies(record.cookies, this.now()) };
  }

  heardFact(deviceId: string, task: string, fact: TaskBrowserFact | null): void {
    this.heard(deviceId, task, fact);
  }

  heardFrame(task: string, frame: InvokeRequest<"inf:work:browser-frame">[0]["frame"]): void {
    for (const sink of this.watchers.get(task) ?? []) sink(frame);
  }

  heardEvent(
    _deviceId: string,
    task: string,
    event: InvokeRequest<"inf:work:browser-event">[0]["event"],
  ): void {
    switch (event.kind) {
      case "note":
        this.options.note(task, event.text);
        return;
      case "returned":
        this.options.onReturned(task, {
          site: event.site,
          ...(event.after ? { after: event.after } : {}),
          ...(event.saved ? { saved: true as const } : {}),
          once: event.once,
        });
        return;
      case "sign-in":
        // Only into the save it was lent or made from, by its id - one
        // removed or replaced since is left alone - and only that site's own.
        this.options.signIns?.refresh(event.site, event.id, {
          cookies: cookiesOfSite(event.held.cookies, event.site),
          storage: storageOfSite(event.held.storage, event.site),
          ...(event.held.session ? { session: storageOfSite(event.held.session, event.site) } : {}),
        });
        return;
    }
  }

  // ---- the captain's side -------------------------------------------------------

  fact(taskId: string): TaskBrowserFact | undefined {
    return this.facts.get(taskId)?.fact;
  }

  isOpen(taskId: string): boolean {
    return this.fact(taskId)?.state === "open";
  }

  withCaptain(taskId: string): boolean {
    const fact = this.fact(taskId);
    return fact?.state === "open" && fact.control !== undefined;
  }

  watch(taskId: string, sink: BrowserFrameSink): () => void {
    let sinks = this.watchers.get(taskId);
    if (!sinks) {
      sinks = new Set();
      this.watchers.set(taskId, sinks);
    }
    const first = sinks.size === 0;
    sinks.add(sink);
    if (first) this.tell(taskId, "inf:task-browser:watch", { watching: true });
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      const current = this.watchers.get(taskId);
      current?.delete(sink);
      // A maximized view that goes gives the page back its own size.
      if (this.sizes.get(taskId)?.sink === sink) {
        this.sizes.delete(taskId);
        this.tell(taskId, "inf:task-browser:size", { size: null });
      }
      if (current && current.size > 0) return;
      this.watchers.delete(taskId);
      this.tell(taskId, "inf:task-browser:watch", { watching: false });
    };
  }

  sizeView(taskId: string, sink: BrowserFrameSink, size: TaskBrowserSize | null): void {
    if (!this.watchers.get(taskId)?.has(sink)) return;
    if (size) {
      this.sizes.set(taskId, { sink, size: { width: size.width, height: size.height } });
    } else if (this.sizes.get(taskId)?.sink === sink) {
      this.sizes.delete(taskId);
    } else {
      return;
    }
    this.tell(taskId, "inf:task-browser:size", { size });
  }

  stopByCaptain(taskId: string): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:stop", {});
  }

  reopen(taskId: string): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:reopen", {});
  }

  takeControl(taskId: string, handle?: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:take", handle ? { handle } : {});
  }

  captainInput(taskId: string, input: TaskBrowserInput): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:input", { input });
  }

  /**
   * His Return control. With the Remember tick, this Mac chooses the save's
   * id first, so the browser there copies back into it as it stops, and
   * saves what that browser holds of the site once it answers.
   */
  async returnControl(
    taskId: string,
    handle: TaskBrowserHandle,
    options: TaskBrowserReturn = {},
  ): Promise<TaskBrowserCommandResult> {
    const store = this.options.signIns;
    // The site his tick named: the one the browser's fact shows him.
    const shown = this.fact(taskId);
    const site = options.site ?? (shown?.state === "open" ? signInSite(shown.site) : undefined);
    const id =
      store && site
        ? (options.savedId ?? (options.remember ? randomUUID() : undefined))
        : undefined;
    const answer = await this.order(taskId, "inf:task-browser:return", {
      handle,
      ...(id ? { remember: { id, site, ...(options.savedId ? { refresh: true } : {}) } } : {}),
    });
    if (!answer.ok) return answer;
    const remembered = answer.remembered;
    let warning = answer.warning;
    if (id && store && site && remembered && signInSite(remembered.site) === site) {
      const held = {
        cookies: cookiesOfSite(remembered.held.cookies, site),
        storage: remembered.held.storage,
        ...(remembered.held.session ? { session: remembered.held.session } : {}),
      };
      try {
        if (options.savedId) {
          if (!store.refresh(site, id, held))
            warning =
              "Control returned, but that saved sign-in was removed or replaced. It was not changed.";
          else this.lend(taskId, site, id);
        } else if (!store.get(site)) this.lend(taskId, store.save(site, held, id).site, id);
        else
          warning = "Control returned, but this site's saved sign-in changed. It was not replaced.";
      } catch {
        warning = "Control returned, but the sign-in could not be saved. It was not retried.";
      }
    } else if (id && !warning)
      warning = "Control returned, but no sign-in was saved for the site you selected.";
    return { ok: true, ...(warning ? { warning } : {}) };
  }

  async requestHelp(
    taskId: string,
    request: TaskBrowserRequest & { site: string },
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    return this.order(taskId, "inf:task-browser:request", { request });
  }

  savedSignInFor(taskId: string, site: string): OfferedSignIn | undefined {
    const offer = offeredSignIn(this.fact(taskId), site, this.options.signIns, this.now());
    return offer ? offeredOf(offer.record) : undefined;
  }

  /**
   * The crewmate said the saved sign-in its browser there was given did not
   * sign the page in: the save this Mac lent or made for it keeps the mark,
   * while that browser still uses it.
   */
  markSavedSignInFailed(taskId: string, site: string): boolean {
    const key = siteNamed(site);
    const fact = this.fact(taskId);
    const id = this.lent.get(taskId)?.get(key);
    if (fact?.state !== "open" || !fact.saved?.includes(key) || !id) return false;
    if (!this.options.signIns?.markFailed(key, id)) return false;
    this.options.note(taskId, failedSignInNote(key));
    return true;
  }

  private lend(taskId: string, site: string, id: string): void {
    let sites = this.lent.get(taskId);
    if (!sites) {
      sites = new Map();
      this.lent.set(taskId, sites);
    }
    sites.set(signInSite(site), id);
  }

  /**
   * The captain's click on a request card's saved sign-in: this Mac lends
   * that one site's save - its cookies still alive and its own origins'
   * page storage - to the browser there, which uses what its page can and
   * copies back into the save, by its id, as it stops.
   */
  async grantSavedSignIn(
    taskId: string,
    handle: TaskBrowserHandle,
  ): Promise<TaskBrowserCommandResult> {
    const fact = this.fact(taskId);
    const record = fact ? this.options.signIns?.get(fact.site) : undefined;
    if (!fact || !record) {
      return {
        ok: false,
        text: `No sign-in for ${fact?.site ?? "that site"} is saved on ${HERE.this}.`,
      };
    }
    const answer = await this.command(taskId, "inf:task-browser:grant", {
      handle,
      signIn: {
        site: record.site,
        id: record.id,
        savedAt: record.savedAt,
        cookies: liveCookies(record.cookies, this.now()),
        storage: storageOfSite(record.storage, record.site),
        session: storageOfSite(record.session, record.site),
      },
    });
    if (answer.ok) this.lend(taskId, record.site, record.id);
    return answer;
  }

  /**
   * The captain removed a site's saved sign-in: each computer whose task's
   * browser uses it signs it out of that site. Whether any did.
   */
  signOut(site: string): boolean {
    const key = site.trim().toLowerCase();
    const devices = new Set<string>();
    for (const { deviceId, fact } of this.facts.values())
      if (fact.state === "open" && fact.saved?.includes(key)) devices.add(deviceId);
    for (const deviceId of devices)
      void this.options.devices
        .ask(deviceId, "inf:task-browser:sign-out", [{ site: key }])
        .catch((caught: unknown) =>
          this.log(`could not sign ${deviceId}'s browsers out of ${key}: ${messageOf(caught)}`),
        );
    return devices.size > 0;
  }

  /**
   * The task closed: its browser there goes, at once or once that computer
   * closes its conversation, and the captain reads it stopped now.
   */
  closeTask(taskId: string): void {
    this.lent.delete(taskId);
    const heard = this.facts.get(taskId);
    if (heard) {
      const { fact } = heard;
      if (fact.state === "open") {
        this.facts.set(taskId, {
          ...heard,
          fact: {
            state: "stopped",
            site: fact.site,
            url: fact.url,
            stopped: "task-closed",
            at: this.now(),
            ...(fact.session ? { session: fact.session } : {}),
            ...(fact.generation ? { generation: fact.generation } : {}),
          },
        });
        this.options.onChange(taskId);
      } else if (fact.stopped !== "task-closed") {
        this.facts.set(taskId, { ...heard, fact: { ...fact, stopped: "task-closed" } });
        this.options.onChange(taskId);
      }
    }
    this.tell(taskId, "inf:task-browser:close", {});
  }

  /**
   * What its crewmate's commands reach - nothing here: its crewmate drives
   * it through its own shell on that computer.
   */
  forTask(taskId: string): CrewmateBrowser {
    const refuse = async (): Promise<BrowserAnswer> => ({
      text: `This task's browser runs on ${this.where(taskId)}, where its crewmate drives it.`,
      refused: "refused",
    });
    return {
      navigate: refuse,
      inspect: refuse,
      act: refuse,
      capture: refuse,
      close: refuse,
      pages: refuse,
    };
  }

  // ---- in between ---------------------------------------------------------------

  private heard(deviceId: string, task: string, fact: TaskBrowserFact | null): void {
    // A computer speaks only for the tasks it holds.
    if (this.options.deviceOf(task) !== deviceId) return;
    if (fact) this.facts.set(task, { deviceId, fact });
    else this.facts.delete(task);
    this.options.onChange(task);
  }

  /**
   * Back in reach: every fact it keeps, whole, in place of what this Mac
   * last heard of its tasks, and what the views here watch, asked again.
   */
  private async reached(deviceId: string): Promise<void> {
    let answer: BrowserOrderResponse<"inf:task-browser:facts">;
    try {
      answer = browserOrders["inf:task-browser:facts"].response.parse(
        await this.options.devices.ask(deviceId, "inf:task-browser:facts", []),
      );
    } catch {
      // A computer that keeps no browsers, or speaks an older contract, has none to say.
      return;
    }
    const said = new Map(answer.facts.map((entry) => [entry.task, entry.fact]));
    for (const [task, heard] of [...this.facts])
      if (heard.deviceId === deviceId && !said.has(task)) this.heard(deviceId, task, null);
    for (const [task, fact] of said) this.heard(deviceId, task, fact);
    for (const task of this.watchers.keys()) {
      if (this.options.deviceOf(task) !== deviceId) continue;
      this.tell(task, "inf:task-browser:watch", { watching: true });
      const size = this.sizes.get(task);
      if (size) this.tell(task, "inf:task-browser:size", { size: size.size });
    }
  }

  /** One order about a task's browser there, answered or refused in words. */
  private async order<C extends BrowserOrderChannel>(
    taskId: string,
    channel: C,
    fields: Omit<BrowserOrderRequest<C>[0], "task">,
  ): Promise<BrowserOrderResponse<C> | { ok: false; text: string }> {
    const deviceId = this.options.deviceOf(taskId);
    if (!deviceId) return { ok: false, text: "This task's browser is not running." };
    try {
      const answer = await this.options.devices.ask(deviceId, channel, [
        { task: taskId, ...fields },
      ]);
      return browserOrders[channel].response.parse(answer) as BrowserOrderResponse<C>;
    } catch (caught) {
      return {
        ok: false,
        text:
          caught instanceof DeviceOutOfReachError
            ? `${this.options.nameOf(deviceId)} is out of reach right now, so this task's browser there cannot be reached.`
            : messageOf(caught),
      };
    }
  }

  private async command<C extends BrowserOrderChannel>(
    taskId: string,
    channel: C,
    fields: Omit<BrowserOrderRequest<C>[0], "task">,
  ): Promise<TaskBrowserCommandResult> {
    const answer = (await this.order(taskId, channel, fields)) as TaskBrowserCommandResult;
    return answer.ok ? { ok: true } : { ok: false, text: answer.text };
  }

  /** An order whose answer nobody waits for: what a view watches, and a close. */
  private tell<C extends BrowserOrderChannel>(
    taskId: string,
    channel: C,
    fields: Omit<BrowserOrderRequest<C>[0], "task">,
  ): void {
    const deviceId = this.options.deviceOf(taskId);
    if (!deviceId) return;
    void this.options.devices
      .ask(deviceId, channel, [{ task: taskId, ...fields }])
      .catch((caught: unknown) => {
        // Out of reach, what a view watches is asked again once it is back.
        if (!(caught instanceof DeviceOutOfReachError))
          this.log(`${channel} for ${taskId} was refused: ${messageOf(caught)}`);
      });
  }

  private where(taskId: string): string {
    const deviceId = this.options.deviceOf(taskId);
    return deviceId ? this.options.nameOf(deviceId) : "another computer";
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/**
 * Every task browser the captain reads and drives from this Mac
 * (docs/task-browser.md): this Mac's own, and, for a task that runs on
 * another computer, its browser there (`PlacedBrowsers`). Each call goes to
 * the one that holds the task's browser; the rules stay with each
 * computer's own `TaskBrowsers`.
 */
export class HomeBrowsers {
  constructor(
    private readonly local: TaskBrowsers,
    /** The browsers of tasks on other computers, which hear what those computers say. */
    readonly there: PlacedBrowsers,
  ) {}

  isOpen(taskId: string): boolean {
    return this.there.holds(taskId) ? this.there.isOpen(taskId) : this.local.isOpen(taskId);
  }

  fact(taskId: string): TaskBrowserFact | undefined {
    return this.there.holds(taskId) ? this.there.fact(taskId) : this.local.fact(taskId);
  }

  withCaptain(taskId: string): boolean {
    return this.there.holds(taskId)
      ? this.there.withCaptain(taskId)
      : this.local.withCaptain(taskId);
  }

  watch(taskId: string, sink: BrowserFrameSink): () => void {
    return this.there.holds(taskId)
      ? this.there.watch(taskId, sink)
      : this.local.watch(taskId, sink);
  }

  sizeView(taskId: string, sink: BrowserFrameSink, size: TaskBrowserSize | null): void {
    if (this.there.holds(taskId)) this.there.sizeView(taskId, sink, size);
    else this.local.sizeView(taskId, sink, size);
  }

  async stopByCaptain(taskId: string): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId)
      ? this.there.stopByCaptain(taskId)
      : this.local.stopByCaptain(taskId);
  }

  reopen(taskId: string): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId) ? this.there.reopen(taskId) : this.local.reopen(taskId);
  }

  /**
   * The captain's click on a page from the task's project
   * (docs/task-browser.md, "A page from the project"): the project folder is
   * this Mac's, so only a browser here opens it.
   */
  async openPage(
    taskId: string,
    page: ProjectPage,
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    if (this.there.holds(taskId)) {
      return {
        ok: false,
        text: `This task runs on another computer, so its project's page does not open on ${HERE.this}.`,
      };
    }
    return this.local.openPage(taskId, page);
  }

  forTask(taskId: string): CrewmateBrowser {
    return this.there.holds(taskId) ? this.there.forTask(taskId) : this.local.forTask(taskId);
  }

  requestHelp(
    taskId: string,
    request: TaskBrowserRequest & { site: string },
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    return this.there.holds(taskId)
      ? this.there.requestHelp(taskId, request)
      : this.local.requestHelp(taskId, request);
  }

  takeControl(taskId: string, handle?: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId)
      ? this.there.takeControl(taskId, handle)
      : this.local.takeControl(taskId, handle);
  }

  returnControl(
    taskId: string,
    handle: TaskBrowserHandle,
    options?: TaskBrowserReturn,
  ): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId)
      ? this.there.returnControl(taskId, handle, options)
      : this.local.returnControl(taskId, handle, options);
  }

  captainInput(taskId: string, input: TaskBrowserInput): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId)
      ? this.there.captainInput(taskId, input)
      : this.local.captainInput(taskId, input);
  }

  /** The website sign-ins saved on this Mac, wherever the browsers that use them run. */
  savedSignIns(): SavedSignIn[] {
    return this.local.savedSignIns();
  }

  savedSignInFor(taskId: string, site: string): OfferedSignIn | undefined {
    return this.there.holds(taskId)
      ? this.there.savedSignInFor(taskId, site)
      : this.local.savedSignInFor(taskId, site);
  }

  markSavedSignInFailed(taskId: string, site: string): boolean {
    return this.there.holds(taskId)
      ? this.there.markSavedSignInFailed(taskId, site)
      : this.local.markSavedSignInFailed(taskId, site);
  }

  grantSavedSignIn(taskId: string, handle: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    return this.there.holds(taskId)
      ? this.there.grantSavedSignIn(taskId, handle)
      : this.local.grantSavedSignIn(taskId, handle);
  }

  allowAutomaticSignIn(site: string, id: string, automatic: boolean): TaskBrowserCommandResult {
    return this.local.allowAutomaticSignIn(site, id, automatic);
  }

  /** Remove in Settings: the save goes from this Mac, and every browser using it signs out, here or there. */
  async removeSavedSignIn(site: string): Promise<TaskBrowserCommandResult> {
    const there = this.there.signOut(site);
    const here = await this.local.removeSavedSignIn(site);
    return there && !here.ok ? { ok: true } : here;
  }

  closeTask(taskId: string, options: { gone?: boolean } = {}): void {
    if (this.there.holds(taskId)) this.there.closeTask(taskId);
    else this.local.closeTask(taskId, options);
  }

  /** This app quits: its own browsers go; a browser on another computer goes with that computer's run. */
  closeAll(): void {
    this.local.closeAll();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
