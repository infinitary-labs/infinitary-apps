import { HERE } from "@shared/deviceNames";
import type { InvokeRequest, InvokeResponse } from "@shared/ipc";
import type {
  ComputerSignIns,
  OfferedSignIn,
  SavedSignIn,
  SavedSignInsView,
  TaskBrowserAskAnswer,
  TaskBrowserCommandResult,
  TaskBrowserFact,
  TaskBrowserHandle,
  TaskBrowserInput,
  TaskBrowserPlaces,
  TaskBrowserRequest,
  TaskBrowserReturn,
  TaskBrowserSize,
} from "@shared/taskBrowser";
import {
  type BrowserOrderChannel,
  type BrowserOrderRequest,
  type BrowserOrderResponse,
  browserOrders,
} from "@shared/workBrowsers";
import { askingView } from "../askedFromAView";
import { siteNamed } from "../browser/browserRecord";
import type { BrowserAnswer } from "../browser/crewmateCommands";
import type { PrivateSites } from "../browser/privateSites";
import { offeredSignIn } from "../browser/savedSignInGrants";
import type {
  BrowserFrameSink,
  BrowserReturned,
  CrewmateBrowser,
  PageUnanswered,
  ProjectPage,
  TaskBrowsers,
} from "../browser/taskBrowsers";
import { signInSite } from "../browser/webSignIns";
import { DeviceOutOfReachError } from "../connection/connection";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { PlacedBrowserSink } from "./crewMachines";
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
 * - A signed-in site stays that computer's (docs/task-browser.md,
 *   "Signed-in sites"): the captain signs in in its kept profile, his rule
 *   for the site and its entry are kept there, and Settings asks it for its
 *   list, a rule or a Remove. Nothing of a sign-in crosses to this Mac.
 * - What that computer has this Mac do once - a timeline line, the
 *   crewmate's wake on a return - arrives as a work request the
 *   conversations' ledger answers once (`PlacedSessions`).
 */

/** A computer that keeps its own signed-in sites (`kept-sign-ins.md`). */
const KEPT_SIGN_INS = contractChange("kept-sign-ins");

/** A computer that puts a page's asks to the captain (`browser-asks.md`). */
const BROWSER_ASKS = contractChange("browser-asks");
/** A page's named places, for the captain's Point at (`card-note-places.md`). */
const CARD_NOTE_PLACES = contractChange("card-note-places");
/** A page's saved start there, which lives through its crewmate's turn (`page-start.md`). */
const PAGE_START = contractChange("page-start");

export type PlacedBrowsersOptions = {
  devices: Pick<WorkDevices, "ask" | "onWorkDevice" | "version">;
  /** The computer a task runs on, by its record; null or absent for this Mac. */
  deviceOf: (taskId: string) => string | null | undefined;
  /** A computer's name, as the captain reads it. */
  nameOf: (deviceId: string) => string;
  /** Every computer that runs work for this Mac, by id, for Settings' list of signed-in sites. */
  computers?: () => readonly string[];
  /** The captain's private sites list, lent whole to a browser there as it opens a page. */
  privateSites?: Pick<PrivateSites, "list">;
  /** One line on the task's own timeline. */
  note: (taskId: string, text: string) => void;
  /** A task's browser changed for the captain: its record and view read it again. */
  onChange: (taskId: string) => void;
  /** The captain returned a task's browser there: its crewmate's one wake. */
  onReturned: (taskId: string, returned: BrowserReturned) => void;
  /** Nothing answers at a task's page there: its crewmate's one wake for that outage. */
  onUnanswered?: (taskId: string, unanswered: PageUnanswered) => void;
  now?: () => number;
  log?: (line: string) => void;
};

/** One task's browser there, as this Mac last heard it. */
type Heard = { deviceId: string; fact: TaskBrowserFact; unstarted?: true };

export class PlacedBrowsers implements PlacedBrowserSink {
  private readonly facts = new Map<string, Heard>();
  private readonly watchers = new Map<string, Set<BrowserFrameSink>>();
  /** Tasks whose crewmate's turn that computer was last told runs. */
  private readonly turning = new Set<string>();
  /** The room a maximized view gives each task's page, with the view that asked. */
  private readonly sizes = new Map<string, { sink: BrowserFrameSink; size: TaskBrowserSize }>();
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

  /** A retired copy's lending: that computer keeps its own sign-ins, so this Mac lends none. */
  automaticSignIn(): InvokeResponse<"inf:work:browser-sign-in">["signIn"] {
    return undefined;
  }

  privateSiteList(): string[] {
    return this.options.privateSites?.list() ?? [];
  }

  heardFact(deviceId: string, task: string, fact: TaskBrowserFact | null, unstarted?: true): void {
    this.heard(deviceId, task, fact, unstarted);
  }

  /** Its page is served there with no saved start, as that computer last said. */
  unstarted(taskId: string): boolean {
    return this.facts.get(taskId)?.unstarted === true;
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
      case "unanswered":
        this.options.onUnanswered?.(task, {
          site: event.site,
          url: event.url,
          once: event.once,
          ...(event.start ? { start: event.start } : {}),
        });
        return;
      case "sign-in":
        // A retired copy from an older computer: nothing on this Mac keeps one.
        return;
    }
  }

  /** An open browser there carries that computer's name, so its kept-profile words name where a sign-in stays. */
  fact(taskId: string): TaskBrowserFact | undefined {
    const heard = this.facts.get(taskId);
    if (heard?.fact.state !== "open") return heard?.fact;
    return { ...heard.fact, computer: this.options.nameOf(heard.deviceId) };
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

  /** A turn of the task's crewmate began or ended; a computer without saved starts is not told. */
  turn(taskId: string, running: boolean): void {
    const deviceId = this.options.deviceOf(taskId);
    if (!deviceId || !listsChange(this.options.devices.version(deviceId)?.changes, PAGE_START))
      return;
    // An end is always said: one lost, or forgotten by a restart here, must not keep a build running.
    if (running && this.turning.has(taskId)) return;
    if (running) this.turning.add(taskId);
    else this.turning.delete(taskId);
    this.tell(taskId, "inf:task-browser:turn", { running });
  }

  takeControl(taskId: string, handle?: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:take", {
      ...(handle ? { handle } : {}),
      here: this.captainThere(taskId),
    });
  }

  captainInput(taskId: string, input: TaskBrowserInput): Promise<TaskBrowserCommandResult> {
    return this.command(taskId, "inf:task-browser:input", {
      input,
      here: this.captainThere(taskId),
    });
  }

  /** What the page there names on screen; a computer not yet updated answers that it cannot say. */
  async places(taskId: string): Promise<TaskBrowserPlaces> {
    const deviceId = this.options.deviceOf(taskId);
    if (
      !deviceId ||
      !listsChange(this.options.devices.version(deviceId)?.changes, CARD_NOTE_PLACES)
    ) {
      return { ok: false };
    }
    return this.order(taskId, "inf:task-browser:places", {});
  }

  /** The captain's answer to what a page there asks; a computer not yet updated never asks. */
  answerAsk(
    taskId: string,
    handle: TaskBrowserHandle,
    id: number,
    answer: TaskBrowserAskAnswer,
  ): Promise<TaskBrowserCommandResult> {
    const deviceId = this.options.deviceOf(taskId);
    if (!deviceId || !listsChange(this.options.devices.version(deviceId)?.changes, BROWSER_ASKS)) {
      return Promise.resolve({ ok: false, text: "The page no longer asks for that." });
    }
    return this.command(taskId, "inf:task-browser:ask", {
      handle,
      id,
      answer,
      here: this.captainThere(taskId),
    });
  }

  /**
   * Whether the window the captain uses now is on the computer the task
   * runs on: a paired view's request names its own computer
   * (docs/task-browser.md, "A site's asks").
   */
  private captainThere(taskId: string): boolean {
    const view = askingView();
    return view !== undefined && view === this.options.deviceOf(taskId);
  }

  /**
   * His Return control. From that computer's kept profile, his rule for the
   * site he signed in to goes with it, and that computer keeps both.
   */
  async returnControl(
    taskId: string,
    handle: TaskBrowserHandle,
    options: TaskBrowserReturn = {},
  ): Promise<TaskBrowserCommandResult> {
    const shown = this.fact(taskId);
    const site = options.site ?? (shown?.state === "open" ? signInSite(shown.site) : undefined);
    const rule =
      shown?.state === "open" && shown.kept && site && this.keeps(taskId)
        ? { rule: { site, automatic: options.automatic === true } }
        : {};
    const answer = await this.order(taskId, "inf:task-browser:return", { handle, ...rule });
    if (!answer.ok) return answer;
    return { ok: true, ...(answer.warning ? { warning: answer.warning } : {}) };
  }

  async requestHelp(
    taskId: string,
    request: TaskBrowserRequest & { site: string },
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    return this.order(taskId, "inf:task-browser:request", { request });
  }

  savedSignInFor(taskId: string, site: string): OfferedSignIn | undefined {
    return this.keeps(taskId) ? offeredSignIn(this.fact(taskId), site) : undefined;
  }

  /**
   * The crewmate said the signed-in site its browser there was given did
   * not sign the page in: that computer marks its own entry, while the
   * browser may use the site, and its own note puts the line on the task's
   * timeline, so the home writes none.
   */
  markSavedSignInFailed(taskId: string, site: string): boolean {
    const key = siteNamed(site);
    const fact = this.fact(taskId);
    if (fact?.state !== "open" || !fact.saved?.includes(key) || !this.keeps(taskId)) return false;
    this.tell(taskId, "inf:task-browser:sign-in-failed", { site: key });
    return true;
  }

  /** The captain's click on a request card's signed-in site: the browser there uses that computer's own. */
  grantSavedSignIn(taskId: string, handle: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    if (!this.keeps(taskId)) {
      return Promise.resolve({
        ok: false,
        text: `${this.where(taskId)} keeps no sign-ins until Infinitary there is updated.`,
      });
    }
    return this.command(taskId, "inf:task-browser:use-sign-in", { handle });
  }

  /** Each computer's signed-in sites, for Settings: one out of reach or not yet updated says so. */
  async signInsThere(): Promise<ComputerSignIns[]> {
    const ids = this.options.computers?.() ?? [];
    return Promise.all(
      ids
        .filter((deviceId) =>
          listsChange(this.options.devices.version(deviceId)?.changes, KEPT_SIGN_INS),
        )
        .map(async (deviceId): Promise<ComputerSignIns> => {
          const name = this.options.nameOf(deviceId);
          try {
            const answer = browserOrders["inf:task-browser:sign-ins"].response.parse(
              await this.options.devices.ask(deviceId, "inf:task-browser:sign-ins", []),
            );
            return { deviceId, name, signIns: answer.signIns };
          } catch {
            return { deviceId, name, signIns: [], unreachable: true };
          }
        }),
    );
  }

  /** The captain's rule for a site on that computer. */
  ruleThere(
    deviceId: string,
    site: string,
    id: string,
    automatic: boolean,
  ): Promise<TaskBrowserCommandResult> {
    return this.atComputer(deviceId, "inf:task-browser:sign-in-rule", [{ site, id, automatic }]);
  }

  /** The captain's Remove for a site on that computer: its kept profile signs the site out. */
  removeThere(deviceId: string, site: string): Promise<TaskBrowserCommandResult> {
    return this.atComputer(deviceId, "inf:task-browser:sign-in-remove", [{ site }]);
  }

  /** The captain's Remove all on that computer: its kept profile signs out of every site. */
  removeAllThere(deviceId: string): Promise<TaskBrowserCommandResult> {
    return this.atComputer(deviceId, "inf:task-browser:sign-in-remove-all", []);
  }

  /** Whether the computer a task runs on keeps its own signed-in sites. */
  private keeps(taskId: string): boolean {
    const deviceId = this.options.deviceOf(taskId);
    return (
      Boolean(deviceId) &&
      listsChange(this.options.devices.version(deviceId as string)?.changes, KEPT_SIGN_INS)
    );
  }

  /** One Settings order to a computer, answered or refused in words. */
  private async atComputer<
    C extends
      | "inf:task-browser:sign-in-rule"
      | "inf:task-browser:sign-in-remove"
      | "inf:task-browser:sign-in-remove-all",
  >(
    deviceId: string,
    channel: C,
    request: BrowserOrderRequest<C>,
  ): Promise<TaskBrowserCommandResult> {
    try {
      const answer = browserOrders[channel].response.parse(
        await this.options.devices.ask(deviceId, channel, request),
      ) as TaskBrowserCommandResult;
      return answer.ok ? { ok: true } : { ok: false, text: answer.text };
    } catch (caught) {
      return {
        ok: false,
        text:
          caught instanceof DeviceOutOfReachError
            ? `${this.options.nameOf(deviceId)} is out of reach right now. Try again once it is back.`
            : messageOf(caught),
      };
    }
  }

  /**
   * The captain changed the private sites list: each computer with an open
   * browser takes it at once (`inf:task-browser:private-sites`), and one
   * out of reach takes it when it is heard from again (`reached`); one that
   * opens later reads it then.
   */
  privateSitesChanged(sites: readonly string[]): void {
    const devices = new Set<string>();
    for (const { deviceId, fact } of this.facts.values())
      if (fact.state === "open") devices.add(deviceId);
    for (const deviceId of devices) this.lendSites(deviceId, sites);
  }

  private lendSites(deviceId: string, sites: readonly string[]): void {
    void this.options.devices
      .ask(deviceId, "inf:task-browser:private-sites", [{ sites: [...sites] }])
      .catch((caught: unknown) =>
        this.log(
          `could not give ${deviceId}'s browsers the private sites list: ${messageOf(caught)}`,
        ),
      );
  }

  /**
   * The task closed: its browser there goes, at once or once that computer
   * closes its conversation, and the captain reads it stopped now.
   */
  closeTask(taskId: string): void {
    this.turning.delete(taskId);
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

  private heard(
    deviceId: string,
    task: string,
    fact: TaskBrowserFact | null,
    unstarted?: true,
  ): void {
    // A computer speaks only for the tasks it holds.
    if (this.options.deviceOf(task) !== deviceId) return;
    if (fact) this.facts.set(task, { deviceId, fact, ...(unstarted ? { unstarted } : {}) });
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
    const said = new Map(answer.facts.map((entry) => [entry.task, entry]));
    for (const [task, heard] of [...this.facts])
      if (heard.deviceId === deviceId && !said.has(task)) this.heard(deviceId, task, null);
    for (const [task, { fact, unstarted }] of said) this.heard(deviceId, task, fact, unstarted);
    // A turn's begin or end said while it was out of reach, or before this Mac restarted, again.
    if (listsChange(this.options.devices.version(deviceId)?.changes, PAGE_START))
      for (const task of said.keys())
        this.tell(task, "inf:task-browser:turn", { running: this.turning.has(task) });
    // A change made while it was out of reach reaches its open browsers now.
    if (this.options.privateSites && answer.facts.some((entry) => entry.fact?.state === "open"))
      this.lendSites(deviceId, this.options.privateSites.list());
    for (const task of this.watchers.keys()) {
      if (this.options.deviceOf(task) !== deviceId) continue;
      this.tell(task, "inf:task-browser:watch", { watching: true });
      const size = this.sizes.get(task);
      if (size) this.tell(task, "inf:task-browser:size", { size: size.size });
    }
  }

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
/**
 * Whether the captain's window is this Mac's own: a paired view's request
 * comes from another computer (docs/task-browser.md, "A site's asks").
 */
function captainHere(): boolean {
  return askingView() === undefined;
}

export class HomeBrowsers {
  constructor(
    private readonly local: TaskBrowsers,
    /** The browsers of tasks on other computers, which hear what those computers say. */
    readonly there: PlacedBrowsers,
    /** The captain's private sites list, which every computer's task browsers read. */
    readonly privateSites: PrivateSites,
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
   * A page its computer serves with no saved start for it (emit_card's one
   * line); a task on another computer keeps its start there, which says so.
   */
  unstarted(taskId: string): boolean {
    return this.there.holds(taskId) ? this.there.unstarted(taskId) : this.local.unstarted(taskId);
  }

  /** A turn of the task's crewmate began or ended, told to the computer that holds its browser. */
  turn(taskId: string, running: boolean): void {
    if (this.there.holds(taskId)) this.there.turn(taskId, running);
    else this.local.turn(taskId, running);
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
    this.local.captainAt(taskId, captainHere());
    const opened = await this.local.openPage(taskId, page);
    // A browser the click started is new: it learns where the captain sits now.
    this.local.captainAt(taskId, captainHere());
    return opened;
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
    if (this.there.holds(taskId)) return this.there.takeControl(taskId, handle);
    this.local.captainAt(taskId, captainHere());
    return this.local.takeControl(taskId, handle);
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
    if (this.there.holds(taskId)) return this.there.captainInput(taskId, input);
    this.local.captainAt(taskId, captainHere());
    return this.local.captainInput(taskId, input);
  }

  /** What the task's page names on screen now (docs/task-browser.md, "Pointing at a page"). */
  places(taskId: string): Promise<TaskBrowserPlaces> {
    return this.there.holds(taskId) ? this.there.places(taskId) : this.local.places(taskId);
  }

  /** The captain's answer to what the task's page asks (docs/task-browser.md, "A site's asks"). */
  answerAsk(
    taskId: string,
    handle: TaskBrowserHandle,
    id: number,
    answer: TaskBrowserAskAnswer,
  ): Promise<TaskBrowserCommandResult> {
    if (this.there.holds(taskId)) return this.there.answerAsk(taskId, handle, id, answer);
    this.local.captainAt(taskId, captainHere());
    return this.local.answerAsk(taskId, handle, id, answer);
  }

  savedSignIns(): SavedSignIn[] {
    return this.local.savedSignIns();
  }

  /** Settings' list: this Mac's signed-in sites, and each computer's that runs work for it. */
  async signInsView(): Promise<SavedSignInsView> {
    const computers = await this.there.signInsThere();
    return {
      available: true,
      signIns: this.local.savedSignIns(),
      ...(computers.length > 0 ? { computers } : {}),
    };
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

  /** The captain's rule for a site: this Mac's, or, with `deviceId`, that computer's. */
  async allowAutomaticSignIn(
    site: string,
    id: string,
    automatic: boolean,
    deviceId?: string,
  ): Promise<TaskBrowserCommandResult> {
    return deviceId
      ? this.there.ruleThere(deviceId, site, id, automatic)
      : this.local.allowAutomaticSignIn(site, id, automatic);
  }

  /** Remove in Settings: the site goes from this Mac's kept profile, or, with `deviceId`, that computer's. */
  removeSavedSignIn(site: string, deviceId?: string): Promise<TaskBrowserCommandResult> {
    return deviceId ? this.there.removeThere(deviceId, site) : this.local.removeSavedSignIn(site);
  }

  /** Remove all in Settings: this Mac's kept profile signs out of every site, or, with `deviceId`, that computer's. */
  removeAllSavedSignIns(deviceId?: string): Promise<TaskBrowserCommandResult> {
    return deviceId ? this.there.removeAllThere(deviceId) : this.local.removeAllSavedSignIns();
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
