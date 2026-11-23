import { randomUUID } from "node:crypto";
import { HERE } from "@shared/deviceNames";
import { listsPrivateSite } from "@shared/privateSites";
import {
  FRESH_LOOK_WORDS,
  type OfferedSignIn,
  SAVED_SIGN_INS_PER_TASK,
  type SavedSignIn,
  TASK_BROWSER_PAGE,
  TASK_BROWSER_PAGES_MAX,
  type TaskBrowserAskAnswer,
  type TaskBrowserBlock,
  type TaskBrowserCommandResult,
  type TaskBrowserFact,
  type TaskBrowserHandle,
  type TaskBrowserInput,
  type TaskBrowserPlaces,
  type TaskBrowserRequest,
  type TaskBrowserReturn,
  type TaskBrowserSize,
  type TaskBrowserStop,
} from "@shared/taskBrowser";
import {
  FORM_RESEND,
  type HostBrowserAsk,
  type HostBrowserPage,
  type HostBrowserViewport,
  type HostFileChooser,
  type HostLoadOutcome,
  type HostPageEvents,
  type HostPopup,
} from "../host";
import { hideKeys } from "../keyFormats";
import {
  addressOf,
  type Browser,
  type BrowsersCore,
  bareAddress,
  type HandBack,
  loadOwn,
  NUMBER_WORDS,
  type PageAsk,
  type PageEntry,
  Queues,
  quoted,
  shown,
  signedIn,
  siteNamed,
  siteOf,
  titleOf,
} from "./browserRecord";
import { browserCommand } from "./commandWords";
import { type ConnectionGuardHandle, startConnectionGuard } from "./connectionGuard";
import { type BrowserAnswer, CrewmateCommands, refused } from "./crewmateCommands";
import {
  checkOpenable,
  decidePageRequest,
  decideRequest,
  originKey,
  pageBlock,
} from "./destinations";
import { PageDiagnostics } from "./diagnostics";
import { saveDownload } from "./evidenceFiles";
import { RefBook } from "./outline";
import { PageActions } from "./pageActions";
import { type AnswerTarget, answerTarget, probeLoopback } from "./pageAnswers";
import { blockedPageWords, clip, PageNotices, refusalWords } from "./pageNotices";
import { startAfterOpen, startBeforeOpen, startMissing } from "./pageStartSteps";
import type { PageStart } from "./pageStarts";
import { pagePlaces } from "./places";
import { type ProjectServer, serveProjectFolder } from "./projectServer";
import { isPageNoise } from "./reading";
import { SavedSignInGrants } from "./savedSignInGrants";
import type {
  BrowserFrameSink,
  CrewmateBrowser,
  ProjectPage,
  TaskBrowsersOptions,
} from "./taskBrowserOptions";
import { type SignedInSite, signInSite } from "./webSignIns";

export type {
  BrowserFrameSink,
  BrowserReturned,
  CrewmateBrowser,
  PageUnanswered,
  ProjectPage,
  TaskBrowsersOptions,
} from "./taskBrowserOptions";

/**
 * Each task's own browser (docs/task-browser.md): the one owner of every
 * task browser page this Mac runs, keyed by the task that opened it.
 *
 * A crewmate opens its task's browser on a public website or a page a
 * project serves on this Mac, reads it as an outline with refs, acts on it
 * with real input, photographs it into its evidence folder, and closes it.
 * The browser stays open across the crewmate's turns until it closes it,
 * its task closes, it sits unused for half an hour, or the app quits;
 * whatever stopped it is told to the crewmate once, and the next open is a
 * fresh browser with nothing signed in. At most `TASK_BROWSERS_MAX` run at
 * once: the next one is refused in words, never made room for by stopping
 * another.
 *
 * Policy lives here, effects in the host (`HostTaskBrowser`): which request
 * a page may make (`destinations.ts`), which address its connections may
 * reach (each browser's own connection guard, `connectionGuard.ts`), what
 * the crewmate reads (`outline.ts`), and every refusal's words. One command
 * runs at a time per task, each within a bound, so a stuck page answers in
 * words rather than holding the crewmate's turn. Its owners each hold one
 * typed view of it (`BrowsersCore`, `browserRecord.ts`): the crewmate's
 * commands (`crewmateCommands.ts`), its actions on a page
 * (`pageActions.ts`), the signed-in sites it allows and the kept profile
 * they live in (`savedSignInGrants.ts`), what a browser keeps to tell its crewmate
 * (`pageNotices.ts`) and the files it writes (`evidenceFiles.ts`).
 *
 * The captain reads each task's browser here too (docs/task-browser.md,
 * "The view"): its fact - the site, what the crewmate did last, or why it
 * stopped - and, while the view is shown, pictures of the page. Watching
 * keeps a browser from stopping for being unused. The captain may stop a
 * browser and open a stopped one again, fresh; its crewmate is told once.
 * Each fact names its browser by this run's `session` and the browser's
 * generation, which a card's attachment keeps (docs/task-browser.md, "From
 * a card").
 *
 * The captain may take control of a browser and hand it back
 * (docs/task-browser.md, "Taking control"), and a crewmate may ask him to
 * ("Asking for help"). While he holds it, its crewmate's commands refuse,
 * nothing the page says is kept for the crewmate, nothing he types is kept
 * anywhere, and it never stops for being unused. Returning it forgets every
 * ref and wakes the crewmate once, through its task's inbox.
 *
 * A page may open a second page - a sign-in, a bank's check - which opens
 * inside the same browser (docs/task-browser.md, "A second page"): the
 * crewmate's commands move to it, and the captain's view names each page
 * by its own site. Once the captain has handed a browser back it may hold
 * his sign-in, so it keeps only what the task needs ("A signed-in page"):
 * a picture needs the crewmate's reason, a page's error words and the
 * details of its addresses are not passed on.
 *
 * The captain may save a site's sign-in on this Mac while handing a browser
 * back, and let a later task's browser use it from its request card
 * (docs/task-browser.md, "Signed-in sites"). A browser starts with none:
 * the captain's one click copies that one site's cookies and page storage
 * in and hands the page back, and the browser copies them back into the
 * save when it stops.
 * Removing a saved sign-in signs out every browser using it.
 */

/** Task browsers this Mac runs at once. */
const TASK_BROWSERS_MAX = 4;
/** A browser no command touched for this long stops, and says so on its task's record. */
export const TASK_BROWSER_IDLE_MS = 30 * 60 * 1000;

/**
 * The captain's Reload on a page that answers a form (docs/task-browser.md,
 * "A final submission"): the browser never sends a form twice.
 */
export const FORM_RESEND_CAPTAIN_WORDS =
  "This page is the answer to a form that was sent, so reloading it would send the form again. The browser never sends a form twice: use the site's own links to see what became of it.";

/** The page's place as the crewmate names it, from 1. */
const PAGE_WORDS = ["", "first", "second"];

/** How the crewmate's first look after the captain returned its browser opens. */
export const RETURNED_NOTICE =
  "The captain returned control of this browser: this is a fresh look at the page as it is now, and refs from before are gone.";

const defaultTimer = (ms: number, fn: () => void): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

function sameSize(a: HostBrowserViewport, b: HostBrowserViewport): boolean {
  return a.width === b.width && a.height === b.height;
}

/**
 * Whether a browser's crewmate opened a loopback origin at this host and
 * port, or a page's own move reached it: the guard asks this for any page's
 * socket, since it never knows which page asked.
 */
function reachesOrigin(browser: Browser, host: string, port: number): boolean {
  // A name the address parser refuses is no origin anyone opened.
  return ["http:", "https:"].some((scheme) => {
    const url = URL.parse(`${scheme}//${host}:${port}`);
    return (
      url !== null && (browser.origins.has(originKey(url)) || browser.reached.has(originKey(url)))
    );
  });
}

export class TaskBrowsers {
  private readonly browsers = new Map<string, Browser>();
  /** Why a task's last browser stopped, told to its crewmate once. */
  private readonly stopped = new Map<string, string>();
  /** A task's last browser, stopped, as the captain reads it until the app quits. */
  private readonly ended = new Map<string, Extract<TaskBrowserFact, { state: "stopped" }>>();
  /** The project folder a task's stopped browser served, so Open again serves it afresh. */
  private readonly endedServers = new Map<
    string,
    Pick<ProjectServer, "folder" | "origin"> & { captains?: true }
  >();
  /**
   * The signed-in sites each task may use, site to entry id, kept from its
   * last browser's stop until the captain's Stop browser or the task's close
   * (docs/task-browser.md, "Signed-in sites"): its next browser starts with
   * those whose entry this computer still keeps.
   */
  private readonly allowed = new Map<string, Map<string, string>>();
  /** The tasks whose kept page this run has read, or no longer needs to. */
  private readonly restored = new Set<string>();
  /**
   * The loopback address nothing answered at, per task, until it answers
   * again: one outage, with the name its crewmate's one wake carries.
   */
  private readonly outages = new Map<string, { origin: string; once: string; failed?: true }>();
  /** How many outages this run has seen: each one's name follows. */
  private outageCount = 0;
  /** How many browsers each task has had in this run: the next one's generation follows. */
  private readonly generations = new Map<string, number>();
  /**
   * The last ref book each task's browsers numbered in this run: the next
   * page read takes the next number, so a ref from any earlier page, the
   * other page or an earlier browser never names an element on this one.
   */
  private readonly books = new Map<string, number>();
  /**
   * This run of the task browsers, new each time the app starts: with a
   * generation it names one browser, so a card emitted before a restart
   * never points at a browser opened after it.
   */
  readonly session: string;
  /** The captain's views of each task's browser, open or not. */
  private readonly watchers = new Map<string, Set<BrowserFrameSink>>();
  /**
   * The room a maximized view gives each task's page, with the view that
   * asked: its pages lay out at it, open now or later, until that view
   * restores or stops watching.
   */
  private readonly viewSizes = new Map<string, { sink: BrowserFrameSink; size: TaskBrowserSize }>();
  /** Browsers with a resize waiting: it takes the newest size when it runs. */
  private readonly resizing = new WeakSet<Browser>();
  /** One command at a time per task, in the order they came. */
  private readonly queues = new Queues<string>();
  /**
   * A click at a control's place, or a resize, one at a time per browser:
   * neither starts while the other runs, so a page never moves between a
   * command finding a control and pressing it.
   */
  private readonly steady = new Queues<Browser>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly timer: (ms: number, fn: () => void) => () => void;
  private readonly commands: CrewmateCommands;
  private readonly actions: PageActions;
  private readonly grants: SavedSignInGrants;
  /** The private sites list as last read: what the guard and the policy check a name against. */
  private sites: readonly string[] = [];
  /**
   * The kept profile's one connection guard (docs/task-browser.md,
   * "Signed-in sites"): every kept page shares the engine's one profile,
   * so they share its way to the internet. It starts with the first kept
   * page and closes as the app quits.
   */
  private keptGuard?: Promise<ConnectionGuardHandle | undefined>;

  constructor(private readonly options: TaskBrowsersOptions) {
    this.max = options.max ?? TASK_BROWSERS_MAX;
    this.idleMs = options.idleMs ?? TASK_BROWSER_IDLE_MS;
    this.timer = options.timer ?? defaultTimer;
    this.session = options.session ?? randomUUID();
    // The core exists before its owners; they read each other through it once built.
    const core: BrowsersCore = {
      options,
      session: this.session,
      browsers: this.browsers,
      stopped: this.stopped,
      max: this.max,
      timer: this.timer,
      lastBook: (taskId) => this.books.get(taskId) ?? 0,
      fact: (taskId) => this.fact(taskId),
      isHandled: (browser, handle) => this.isHandled(browser, handle),
      start: (taskId, url, opened, startOptions) => this.start(taskId, url, opened, startOptions),
      moveProfile: (taskId, browser, kept, url) => this.moveProfile(taskId, browser, kept, url),
      stop: (taskId, why) => this.stop(taskId, why),
      select: (taskId, browser, entry) => this.select(taskId, browser, entry),
      dropPage: (taskId, browser, entry) => this.dropPage(taskId, browser, entry),
      touch: (taskId, browser) => this.touch(taskId, browser),
      handBackBooks: (taskId, browser) => this.handBackBooks(taskId, browser),
      handBack: (taskId, browser, back) => this.handBack(taskId, browser, back),
      serial: (taskId, run) => this.queues.run(taskId, run),
      listed: (hostname) => listsPrivateSite(this.sites, hostname),
      readSites: (taskId) => this.readSites(taskId),
      steadily: (browser, run) => this.steady.run(browser, run),
      get commands() {
        return commands;
      },
      get grants() {
        return grants;
      },
    };
    const commands = new CrewmateCommands(core);
    const grants = new SavedSignInGrants(core);
    this.commands = commands;
    this.actions = new PageActions(core);
    this.grants = grants;
  }

  /**
   * Read the private sites list again; an unreadable one keeps the last read,
   * which a computer that runs work starts empty, so it refuses as before.
   */
  private async readSites(taskId: string): Promise<void> {
    if (!this.options.privateSites) return;
    try {
      this.sites = [...(await this.options.privateSites(taskId))];
    } catch {
      // The home out of reach, or one without the list: the last read stands.
    }
  }

  /**
   * The captain changed the private sites list: the guard and the policy
   * check every name against it from now on, and a connection a removed
   * site's listing let through ends at once.
   */
  privateSitesChanged(sites: readonly string[]): void {
    this.sites = [...sites];
    for (const browser of this.browsers.values()) browser.guard?.recheck?.();
    void this.keptGuard?.then((guard) => guard?.recheck?.());
  }

  get openCount(): number {
    return this.browsers.size;
  }

  isOpen(taskId: string): boolean {
    return this.browsers.has(taskId);
  }

  /** One task's browser as the captain reads it; absent while it never had one. */
  fact(taskId: string): TaskBrowserFact | undefined {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.endedOf(taskId);
    const url = addressOf(browser, browser.current);
    const many = browser.pages.length > 1;
    return {
      state: "open",
      site: siteOf(url),
      url,
      title: this.viewTitle(browser, browser.current),
      ...(many
        ? {
            pages: browser.pages.map((entry) => ({
              site: siteOf(addressOf(browser, entry)),
              title: this.viewTitle(browser, entry),
            })),
            page: browser.pages.indexOf(browser.current) + 1,
          }
        : {}),
      ...(browser.did ? { did: browser.did } : {}),
      ...(browser.control !== "crewmate" ? { control: browser.control } : {}),
      ...(browser.request ? { request: browser.request } : {}),
      ...(browser.returns > 0 ? { returned: true as const } : {}),
      ...(browser.captains ? { own: true as const } : {}),
      ...(browser.saved.size > 0
        ? { saved: [...browser.saved.keys()].slice(-SAVED_SIGN_INS_PER_TASK) }
        : {}),
      ...(browser.kept ? { kept: true as const } : {}),
      ...this.grants.ruleOf(browser),
      // What a request card would offer, read before the card pauses the browser.
      ...(browser.control === "crewmate" || browser.control === "waiting"
        ? this.grants.offerOf(browser)
        : {}),
      ...(browser.control === "captain" && browser.asking
        ? {
            ask: {
              id: browser.asking.id,
              kind: browser.asking.kind,
              site: browser.asking.site,
              ...(browser.asking.shown ? { allowed: true as const } : {}),
            },
          }
        : {}),
      ...(browser.control === "captain" && browser.told ? { told: browser.told } : {}),
      ...(this.isUnanswered(taskId, browser)
        ? {
            unanswered: true as const,
            ...(this.options.starts?.starting(taskId) ? { starting: true as const } : {}),
          }
        : {}),
      ...this.blockOf(browser),
      session: this.session,
      generation: browser.generation,
    };
  }

  /** The page's own address, when the browser refuses it, as the fact carries it. */
  private blockOf(browser: Browser): { blocked?: TaskBrowserBlock } {
    const block = this.pageBlockOf(browser);
    return block ? { blocked: block.kind } : {};
  }

  /** Why the current page's own address is refused, so it shows the browser's refusal; nothing otherwise. */
  private pageBlockOf(browser: Browser, entry = browser.current): ReturnType<typeof pageBlock> {
    return pageBlock(
      addressOf(browser, entry),
      new Set([...browser.origins, ...browser.reached]),
      (host) => listsPrivateSite(this.sites, host),
    );
  }

  /**
   * A page's title as the captain's view reads it. The browser's refusal of
   * an address has no title of its own and takes that address, whose query
   * may carry a sign-in's code: it reads as the refused host and port.
   */
  private viewTitle(browser: Browser, entry: PageEntry): string {
    const title = entry.page.title().trim();
    const block = this.pageBlockOf(browser, entry);
    return block && title && entry.page.url().includes(title) ? block.host : title;
  }

  /**
   * Whether a task's browser is in the captain's hands: paused for his
   * help, being taken, or his. Its return is the crewmate's next wake, so
   * the idle ladder reads the task as his turn.
   */
  withCaptain(taskId: string): boolean {
    const control = this.browsers.get(taskId)?.control;
    return control !== undefined && control !== "crewmate";
  }

  /**
   * The captain watches a task's browser: `sink` gets a picture of its page
   * now and each time it changes, across a stop and an Open again, until
   * the answered unwatch. While anyone watches, the browser does not stop
   * for being unused; its half hour starts again when the last view goes.
   */
  watch(taskId: string, sink: BrowserFrameSink): () => void {
    let sinks = this.watchers.get(taskId);
    if (!sinks) {
      sinks = new Set();
      this.watchers.set(taskId, sinks);
    }
    sinks.add(sink);
    const browser = this.browsers.get(taskId);
    if (browser) {
      browser.cancelIdle?.();
      browser.cancelIdle = undefined;
      this.startWatching(taskId, browser);
      // The captain looks at its page: whether anything answers there.
      if (sinks.size === 1) void this.checkAnswers(taskId, browser, { wake: true });
    }
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      const current = this.watchers.get(taskId);
      current?.delete(sink);
      // A maximized view that goes gives the page back its own size.
      if (this.viewSizes.get(taskId)?.sink === sink) {
        this.viewSizes.delete(taskId);
        this.resizePages(taskId);
      }
      if (current && current.size > 0) return;
      this.watchers.delete(taskId);
      const open = this.browsers.get(taskId);
      if (!open) return;
      open.stopWatching?.();
      open.stopWatching = undefined;
      this.touch(taskId, open);
    };
  }

  /**
   * The captain's maximized view gives the page its room (docs/task-browser.md,
   * "The view"): every page of the task's browser lays out at `size`, and so
   * does a browser or page that opens while the view stays maximized; null,
   * once the view is restored, gives the pages back the check's own size, as
   * the view's unwatch does. Only a view that watches the task may ask. The
   * resize waits only for a click in progress, so it never moves the page
   * between a command finding a control and pressing it; a read, a wait or a
   * load goes on at the new size.
   */
  sizeView(taskId: string, sink: BrowserFrameSink, size: TaskBrowserSize | null): void {
    if (!this.watchers.get(taskId)?.has(sink)) return;
    if (size) {
      this.viewSizes.set(taskId, { sink, size: { width: size.width, height: size.height } });
    } else if (this.viewSizes.get(taskId)?.sink === sink) {
      this.viewSizes.delete(taskId);
    } else {
      return;
    }
    this.resizePages(taskId);
  }

  /** The captain's Stop browser: its pages, history and site data go at once. */
  stopByCaptain(taskId: string): TaskBrowserCommandResult {
    if (!this.browsers.has(taskId)) {
      return { ok: false, text: "This task's browser is not running." };
    }
    this.stop(taskId, "captain");
    this.stopped.set(taskId, "was stopped by the captain");
    this.options.note?.(taskId, "you stopped its browser");
    return { ok: true };
  }

  /**
   * The captain's Open again: a fresh browser, with nothing signed in, at
   * the page the stopped one was on. Its crewmate is told once.
   */
  reopen(taskId: string): Promise<TaskBrowserCommandResult> {
    return this.queues.run(taskId, () => this.reopenNow(taskId));
  }

  /**
   * The browser one task's crewmate drives. Each command asks, as it starts,
   * whether the captain holds the browser, so a command queued behind the
   * one running when he took it refuses too.
   */
  forTask(taskId: string): CrewmateBrowser {
    const commands = this.commands;
    return {
      navigate: async ({ start: asked, ...input }) => {
        const { starts, probe } = this.options;
        // A saved start runs before the queue: the captain's moves never wait behind a build.
        const before =
          asked && !this.held(taskId)
            ? await startBeforeOpen({ taskId, url: input.url, asked, starts, probe })
            : undefined;
        if (before && "refused" in before) return refused(before.refused);
        return this.queues
          .run(taskId, async () => {
            const answer = this.held(taskId) ?? (await commands.navigate(taskId, input));
            const open = this.browsers.has(taskId);
            return startAfterOpen(taskId, answer, before, open, this.options.starts);
          })
          .finally(() => this.answeredAgain(taskId));
      },
      inspect: (input) =>
        this.queues.run(taskId, async () => this.held(taskId) ?? commands.inspect(taskId, input)),
      act: (input) =>
        this.queues.run(taskId, async () => this.held(taskId) ?? this.actions.act(taskId, input)),
      capture: (input) =>
        this.queues.run(taskId, async () => this.held(taskId) ?? commands.capture(taskId, input)),
      // A crewmate whose request still waits may withdraw it, keeping the browser, or stop it.
      close: (input) =>
        this.queues.run(
          taskId,
          async () =>
            this.held(taskId, { waiting: false }) ??
            (input?.withdraw ? this.withdraw(taskId) : commands.close(taskId, input?.page)),
        ),
      pages: () => this.queues.run(taskId, async () => this.held(taskId) ?? commands.pages(taskId)),
    };
  }

  /**
   * The crewmate asks the captain to take over (docs/task-browser.md,
   * "Asking for help"), as its card declares: why, and what it does after.
   * Refused in words unless its browser is open on the site it names and
   * the captain does not hold it already. Its new commands refuse at once
   * and the one running finishes before this answers, so the card goes up
   * on a paused browser; the answer names that browser for the card.
   */
  async requestHelp(
    taskId: string,
    request: TaskBrowserRequest & { site: string },
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    const browser = this.browsers.get(taskId);
    if (!browser) {
      return {
        ok: false,
        text: `this task has no open browser to hand over. Open one with ${browserCommand("open <url>")} first.`,
      };
    }
    if (browser.control === "taking" || browser.control === "captain") {
      return { ok: false, text: "the captain already has control of this task's browser." };
    }
    const site = siteOf(addressOf(browser, browser.current));
    if (siteNamed(request.site) !== site.toLowerCase()) {
      return {
        ok: false,
        text: `browser_handoff names ${request.site}, but this task's browser is on ${site}. Name the site it is on.`,
      };
    }
    const asked = browser.control === "crewmate";
    browser.control = "waiting";
    browser.request = {
      reason: request.reason,
      after: request.after,
      ...(request.signIn ? { signIn: true as const } : {}),
    };
    browser.cancelIdle?.();
    browser.cancelIdle = undefined;
    if (asked) this.options.note?.(taskId, `asked you to take over its browser at ${site}`);
    this.options.onChange?.(taskId);
    await this.queues.run(taskId, async () => undefined);
    return { ok: true, handle: { session: this.session, generation: browser.generation } };
  }

  /**
   * The crewmate takes back its waiting request (docs/task-browser.md,
   * "Asking for help"): the browser is its own again, every page, sign-in
   * and ref as it was, and its unused half hour starts again. Refused once
   * the captain has taken control (`held`), and said plainly when nothing
   * waits. Its card is its own to close.
   */
  private withdraw(taskId: string): BrowserAnswer {
    const browser = this.browsers.get(taskId);
    if (!browser) return refused("No browser is open for this task, so no request waits.");
    if (browser.control !== "waiting") {
      return refused(
        "No request for the captain's help waits on this browser: it is yours to use as it is.",
      );
    }
    const site = siteOf(addressOf(browser, browser.current));
    browser.control = "crewmate";
    browser.request = undefined;
    this.touch(taskId, browser);
    this.options.note?.(taskId, `withdrew its request for you to take over its browser at ${site}`);
    this.options.onChange?.(taskId);
    return {
      text: `Withdrew your request: the browser is yours again at ${site}, with its pages, history and sign-ins as they were. Close your request card with close_card if it is still up, and run ${browserCommand("snapshot")} to read the page.`,
    };
  }

  /**
   * The captain's Take control (docs/task-browser.md, "Taking control"):
   * the crewmate's new commands refuse at once, the one running finishes
   * or fails within its bound, and then the page is his. `handle` names the
   * browser he was shown; a newer or older one is refused.
   */
  async takeControl(taskId: string, handle?: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    const browser = this.browsers.get(taskId);
    if (!browser || !this.isHandled(browser, handle)) {
      return { ok: false, text: "This browser is no longer running, so there is nothing to take." };
    }
    if (browser.control === "captain") return { ok: true };
    if (browser.control !== "taking") {
      browser.control = "taking";
      browser.cancelIdle?.();
      browser.cancelIdle = undefined;
      this.options.onChange?.(taskId);
    }
    return this.queues.run(taskId, async () => {
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before you had control." };
      }
      if (browser.control === "captain") return { ok: true };
      browser.control = "captain";
      browser.told = undefined;
      this.forget(browser);
      // A sign-in the crewmate asked for happens in the kept profile, where it stays.
      if (browser.request?.signIn && !browser.kept)
        await this.grants.openForSignIn(taskId, browser);
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before you had control." };
      }
      this.options.note?.(taskId, "you took control of its browser");
      this.options.onChange?.(taskId);
      return { ok: true };
    });
  }

  /**
   * The captain's Return control: a load he started finishes first, then
   * every ref goes, nothing from his time is kept, and the crewmate is woken
   * once to take a fresh look. It grants the task the page as it is, never
   * authority to spend.
   */
  async returnControl(
    taskId: string,
    handle: TaskBrowserHandle,
    options: TaskBrowserReturn = {},
  ): Promise<TaskBrowserCommandResult> {
    const browser = this.browsers.get(taskId);
    if (!browser || !this.isHandled(browser, handle)) {
      return {
        ok: false,
        text: "This browser is no longer running, so there is nothing to return.",
      };
    }
    if (browser.control !== "captain") {
      return { ok: false, text: "You do not have control of this browser." };
    }
    // A browser his own click started has no crewmate to go back to.
    if (browser.captains) {
      this.stop(taskId, "captain");
      this.options.note?.(taskId, "you closed the page you opened in its browser");
      return { ok: true };
    }
    const shownSite = options.site ?? signInSite(siteOf(addressOf(browser, browser.current)));
    return this.queues.run(taskId, async () => {
      if (this.browsers.get(taskId) !== browser || browser.control !== "captain") {
        return { ok: false, text: "This browser stopped before control went back." };
      }
      // A reload or a sign-in's redirect the captain started is his: the
      // crewmate's first look is of the page it ends on.
      await browser.current.page.settle().catch(() => undefined);
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before control went back." };
      }
      // From the kept profile, the site signed in to stays, by the captain's rule.
      const warning = browser.kept
        ? await this.grants.keep(browser, shownSite, options.automatic === true)
        : undefined;
      // Whatever a site was let use while the captain held it goes back at the return.
      await this.endAsks(browser);
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before control went back." };
      }
      const after = browser.request?.after;
      // A page left on an address the browser refuses, such as a sign-in's
      // return to a program on this computer, says why in the first look.
      const block = this.pageBlockOf(browser);
      browser.control = "crewmate";
      browser.request = undefined;
      browser.returns += 1;
      this.handBack(taskId, browser, {
        notice: `${RETURNED_NOTICE}${block ? `\n${blockedPageWords(block)}` : ""}`,
        note: "you returned control of its browser",
        returned: {
          site: siteOf(addressOf(browser, browser.current)),
          ...(after ? { after } : {}),
          once: `browser-returned:${this.session}:${browser.generation}:${browser.returns}`,
        },
      });
      return { ok: true, ...(warning ? { warning } : {}) };
    });
  }

  /**
   * The captain's own input while he has control: sent to the page as it
   * came and recorded nowhere - no line, no fact, no notice. Refused in
   * words while he does not hold it.
   */
  async captainInput(taskId: string, input: TaskBrowserInput): Promise<TaskBrowserCommandResult> {
    const browser = this.browsers.get(taskId);
    if (browser?.control !== "captain") {
      return { ok: false, text: "You do not have control of this browser." };
    }
    try {
      if (input.kind === "page") {
        const entry = browser.pages[input.page - 1];
        if (!entry) return { ok: false, text: "That page is no longer open." };
        this.select(taskId, browser, entry);
        return { ok: true };
      }
      const page = browser.current.page;
      if (input.kind === "go") {
        const outcome = await (input.go === "reload" ? page.reload() : page.history(input.go));
        if (!outcome.ok && outcome.code === FORM_RESEND) {
          return { ok: false, text: FORM_RESEND_CAPTAIN_WORDS };
        }
      } else {
        await page.input(input);
      }
      return { ok: true };
    } catch {
      return { ok: false, text: "The page did not take that." };
    }
  }

  /**
   * What the outline of the task's page names on screen now (docs/task-browser.md,
   * "Pointing at a page"): read once when the captain's Point at holds the page's
   * picture, through the same read the crewmate's outline takes. Names only, with a
   * key hidden where the crewmate's own reads hide it; nothing is recorded.
   */
  async places(taskId: string): Promise<TaskBrowserPlaces> {
    const browser = this.browsers.get(taskId);
    if (!browser) return { ok: false };
    try {
      const nodes = await browser.current.page.nodes();
      const size = { width: browser.size.width, height: browser.size.height };
      // A mark made while the captain holds the browser reads as its crewmate's next read will.
      const held = browser.control === "captain";
      return {
        ok: true,
        ...size,
        // The address and title as the crewmate's own reads give them (`shown`, `titleOf`).
        url: shown(browser, addressOf(browser, browser.current), held).slice(0, 2_048),
        title: titleOf(browser, browser.current, held).slice(0, 240),
        places: pagePlaces(nodes, size, { hideKeys: held || signedIn(browser) }),
      };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Where the captain sits when taking, drives or answers the task's
   * browser (docs/task-browser.md, "A site's asks"): at the computer it runs
   * on, or away from it. Only there can Chrome show the captain a passkey's prompt.
   */
  captainAt(taskId: string, here: boolean): void {
    const browser = this.browsers.get(taskId);
    if (browser) browser.here = here;
  }

  /**
   * The captain's answer to what the page asks the captain now (docs/task-browser.md,
   * "A site's asks"): Allow once lets the page's call run, its permission
   * granted for that site until the captain returns control; Not now ends it as not
   * allowed. A passkey waits for Use passkey, which lets it run in Chrome and
   * brings Chrome's window forward for the system's prompt, or Not now; once
   * let run, Show Chrome window brings that window forward again. Refused in
   * words for an ask that is no longer there.
   */
  async answerAsk(
    taskId: string,
    handle: TaskBrowserHandle,
    id: number,
    answer: TaskBrowserAskAnswer,
  ): Promise<TaskBrowserCommandResult> {
    const browser = this.browsers.get(taskId);
    if (!browser || !this.isHandled(browser, handle)) {
      return { ok: false, text: "This browser is no longer running." };
    }
    if (browser.control !== "captain") {
      return { ok: false, text: "You do not have control of this browser." };
    }
    const asking = browser.asking;
    if (!asking || asking.id !== id) {
      return { ok: false, text: "The page no longer asks for that." };
    }
    if (asking.kind === "passkey") {
      if (answer === "not-now" && !asking.shown) {
        asking.answer?.(false);
        return { ok: true };
      }
      // Use passkey (sent as show, which a view without ask-first offers too), or Allow once.
      if (answer === "not-now" || !asking.entry.page.showWindow) {
        return { ok: false, text: "Answer the passkey's prompt in Chrome's own window." };
      }
      if (!asking.shown) {
        asking.shown = true;
        asking.answer?.(true);
        this.options.onChange?.(taskId);
      }
      await asking.entry.page.showWindow(true).catch(() => undefined);
      return { ok: true };
    }
    if (answer === "show") return { ok: false, text: "That page asks for no passkey." };
    asking.answer?.(answer === "allow");
    return { ok: true };
  }

  /**
   * One ask of a page (docs/task-browser.md, "A site's asks"). While the
   * crewmate drives, every ask is no, and a passkey's is told to it. While
   * the captain holds the browser, a permission waits for the captain's Allow once or
   * Not now, one ask at a time; a passkey is asked only in Chrome with the captain at
   * its computer, where Use passkey lets Chrome ask in its own window, and is otherwise told
   * no at once and told to the captain, so the site offers its other ways.
   * Chrome's window goes back to the Dock when the request ends, whatever
   * brought it out.
   */
  private async pageAsked(
    taskId: string,
    browser: Browser,
    entry: PageEntry,
    ask: HostBrowserAsk,
  ): Promise<boolean> {
    if (this.browsers.get(taskId) !== browser) return false;
    const holds = browser.control === "captain";
    const chrome = entry.page.showWindow !== undefined;
    if (ask.kind === "platform") return holds && chrome && browser.here === true;
    if (!holds) {
      if (ask.kind === "passkey") {
        const words = refusalWords({ kind: "passkey", url: ask.url });
        if (!browser.notices.refusals.includes(words)) browser.notices.keep("refusals", words);
      }
      return false;
    }
    const site = siteOf(ask.url);
    if (ask.kind === "passkey" && !(chrome && browser.here === true)) {
      browser.told = { kind: "passkey", site, where: chrome ? "away" : "engine" };
      this.options.onChange?.(taskId);
      return false;
    }
    // One ask at a time: a second while the first waits is no.
    if (browser.asking) return false;
    browser.asks = (browser.asks ?? 0) + 1;
    const asking: PageAsk = { id: browser.asks, kind: ask.kind, site, entry };
    const settle = (): void => {
      if (browser.asking !== asking) return;
      browser.asking = undefined;
      if (this.browsers.get(taskId) === browser) this.options.onChange?.(taskId);
    };
    browser.asking = asking;
    browser.told = undefined;
    this.options.onChange?.(taskId);
    if (ask.kind === "passkey") {
      // Use passkey lets it run and Chrome's own prompt answers it; its window
      // goes back to the Dock when it ends, even one that came out by itself.
      return new Promise<boolean>((resolve) => {
        asking.answer = (allow) => {
          asking.answer = undefined;
          if (!allow) settle();
          resolve(allow);
        };
        void ask.ended.then(() => {
          asking.answer?.(false);
          settle();
          void entry.page.showWindow?.(false).catch(() => undefined);
        });
      });
    }
    return new Promise<boolean>((resolve) => {
      asking.answer = (allow) => {
        settle();
        resolve(allow);
      };
      void ask.ended.then(() => asking.answer?.(false));
    });
  }

  /**
   * The captain lets the browser go: an ask still waiting is no, every
   * Chrome window of its pages goes back to the Dock - a passkey's, or one
   * Chrome brought out by itself - and every permission a site was let use
   * is taken back.
   */
  private async endAsks(browser: Browser): Promise<void> {
    const asking = browser.asking;
    browser.asking = undefined;
    browser.told = undefined;
    asking?.answer?.(false);
    await Promise.all(
      browser.pages.map((entry) =>
        Promise.all([
          entry.page.showWindow?.(false).catch(() => undefined),
          entry.page.revokeAsks().catch(() => undefined),
        ]),
      ),
    );
  }

  /**
   * The captain's click on a page from the task's project
   * (docs/task-browser.md, "A page from the project"): the page opens in the
   * task's own browser with him in control. A browser its crewmate has open
   * is taken first, as Take control takes it; with none open - stopped,
   * never opened, or its task closed - a fresh one starts that is his from
   * the start. The project folder is served on a loopback address of its own
   * whose origin the browser registers, and that server closes with it. The
   * answer names the browser, for the view to open on.
   */
  async openPage(
    taskId: string,
    page: ProjectPage,
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    const open = this.browsers.get(taskId);
    if (open) {
      const taken = await this.takeControl(taskId);
      if (!taken.ok) return taken;
      return this.queues.run(taskId, () => this.loadPage(taskId, open, page));
    }
    return this.queues.run(taskId, async () => {
      if (this.browsers.has(taskId)) {
        return { ok: false, text: "This task's browser opened meanwhile; press the button again." };
      }
      if (this.browsers.size >= this.max) {
        return {
          ok: false,
          text: `${NUMBER_WORDS[this.max] ?? this.max} task browsers are already open on ${HERE.this}. Stop one, then press the button again.`,
        };
      }
      const server = await this.serveFolder(page.folder);
      if (!server) return { ok: false, text: `${HERE.This} could not serve this project's files.` };
      const browser = await this.start(
        taskId,
        `${server.origin}/${page.path}`,
        `you opened ${page.path} from its project in its browser`,
        { captains: true },
      );
      if (!browser) {
        server.close();
        return {
          ok: false,
          text: `${HERE.This} could not open a browser for this task right now.`,
        };
      }
      return this.loadPage(taskId, browser, page, server);
    });
  }

  private async serveFolder(folder: string): Promise<ProjectServer | undefined> {
    try {
      return await (this.options.serve ?? serveProjectFolder)(folder);
    } catch {
      return undefined;
    }
  }

  private async loadPage(
    taskId: string,
    browser: Browser,
    page: ProjectPage,
    given?: ProjectServer,
  ): Promise<{ ok: true; handle: TaskBrowserHandle } | { ok: false; text: string }> {
    if (this.browsers.get(taskId) !== browser || browser.control !== "captain") {
      given?.close();
      return { ok: false, text: "This task's browser stopped before the page opened." };
    }
    let server = given;
    if (!server) {
      if (browser.server?.folder === page.folder) server = browser.server;
      else server = await this.serveFolder(page.folder);
    }
    if (!server) return { ok: false, text: `${HERE.This} could not serve this project's files.` };
    if (browser.server !== server) {
      browser.server?.close();
      browser.server = server;
    }
    browser.origins.add(originKey(new URL(server.origin)));
    const url = `${server.origin}/${page.path}`;
    browser.firstUrl = url;
    const entry = browser.current;
    await loadOwn(entry, entry.page.load(url));
    this.options.onChange?.(taskId);
    return { ok: true, handle: { session: this.session, generation: browser.generation } };
  }

  /** The signed-in sites this computer keeps, by site, as Settings lists them. */
  savedSignIns(): SavedSignIn[] {
    return this.grants.list();
  }

  /** The signed-in site a request card may offer for the site the task's browser is on. */
  savedSignInFor(taskId: string, site: string): OfferedSignIn | undefined {
    return this.grants.offerFor(taskId, site);
  }

  /** The crewmate said the signed-in site its browser was given did not sign the page in. */
  markSavedSignInFailed(taskId: string, site: string): boolean {
    return this.grants.markFailed(taskId, site);
  }

  /** The captain's rule for a signed-in site: later tasks use it without asking, or ask him. */
  allowAutomaticSignIn(site: string, id: string, automatic: boolean): TaskBrowserCommandResult {
    return this.grants.allowAutomatic(site, id, automatic);
  }

  /** The captain's click on a request card's signed-in site. */
  grantSavedSignIn(taskId: string, handle: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    return this.grants.grant(taskId, handle);
  }

  /** The captain's Remove in Settings: the kept profile signs the site out. */
  removeSavedSignIn(site: string): Promise<TaskBrowserCommandResult> {
    return this.grants.remove(site);
  }

  /** The captain's Remove all in Settings: this computer signs out of every site (docs/task-browser.md, "Signed-in sites"). */
  removeAllSavedSignIns(): Promise<TaskBrowserCommandResult> {
    return this.grants.removeAll();
  }

  /** A command's refusal while the captain holds the browser, or nothing. */
  private held(taskId: string, options?: { waiting: boolean }): BrowserAnswer | undefined {
    const control = this.browsers.get(taskId)?.control;
    if (control === undefined || control === "crewmate") return undefined;
    if (control === "waiting") {
      if (options?.waiting === false) return undefined;
      return refused(
        `You asked the captain to take over this task's browser, so it is paused: your browser commands refuse until the captain takes control and returns it, and then you are woken once to take a fresh look. Do other work that does not need the browser, or end your turn. ${browserCommand("withdraw")} takes the request back and keeps the browser as it is; ${browserCommand("stop")} takes it back and stops the browser.`,
      );
    }
    return refused(
      "The captain has control of this task's browser: you cannot see or use the page until the captain returns it, and then you are woken once to take a fresh look. Do other work that does not need the browser, or end your turn.",
    );
  }

  /** Whether the captain's handle names this browser; no handle is the one there is. */
  private isHandled(browser: Browser, handle: TaskBrowserHandle | undefined): boolean {
    return (
      handle === undefined ||
      (handle.session === this.session && handle.generation === browser.generation)
    );
  }

  /** Nothing the page said, or where it moved, while the captain held it reaches the crewmate. */
  private forget(browser: Browser): void {
    browser.notices.forget();
    for (const entry of browser.pages) {
      entry.diagnostics.clear();
      entry.moved = undefined;
      entry.answered = undefined;
    }
  }

  /**
   * The browser goes back to its crewmate: every page starts a new ref
   * book, nothing from the captain's time is kept, its next read is its
   * fresh look, and it is woken once (docs/task-browser.md, "Taking
   * control" and "Signed-in sites").
   */
  private handBack(taskId: string, browser: Browser, back: HandBack): void {
    this.handBackBooks(taskId, browser);
    this.forget(browser);
    browser.did = FRESH_LOOK_WORDS;
    browser.freshLook = true;
    browser.notices.notice = back.notice;
    this.touch(taskId, browser);
    this.options.note?.(taskId, back.note);
    this.options.onChange?.(taskId);
    this.options.onReturned?.(taskId, back.returned);
  }

  /** A page this computer serves with no saved start for it: emit_card says so in one line. */
  unstarted(taskId: string): boolean {
    const served = this.browsers.get(taskId)?.server ?? this.endedServers.get(taskId);
    return !served && startMissing(this.options.starts, taskId, this.fact(taskId)?.url);
  }

  /** A turn of the task's crewmate began or ended: a build the host started lives through it. */
  turn(taskId: string, running: boolean): void {
    this.options.starts?.turn(taskId, running, this.browsers.has(taskId));
  }

  /** The task closed: its browser goes, with nothing kept and nothing to tell. */
  closeTask(taskId: string, options: { gone?: boolean } = {}): void {
    // A closed task's build is never started again, and one the host started stops.
    this.options.starts?.forget(taskId);
    // A page from the project the captain opened is his own: the task's
    // close leaves it running, and only the task's removal stops it.
    if (this.browsers.get(taskId)?.captains && !options.gone) return;
    if (this.browsers.has(taskId)) this.stop(taskId, "task-closed");
    else {
      const ended = this.endedOf(taskId);
      if (ended && ended.stopped !== "task-closed") {
        const { quit: _quit, ...rest } = ended;
        this.ended.set(taskId, { ...rest, stopped: "task-closed" });
        this.options.onChange?.(taskId);
      }
    }
    // A closed task's build is not brought back: nothing is kept for it.
    this.restored.add(taskId);
    this.options.kept?.remove(taskId);
    this.allowed.delete(taskId);
    this.outages.delete(taskId);
    this.stopped.delete(taskId);
  }

  /**
   * The app quits: every task browser goes. Each one's page is kept with its
   * task, so after the restart it reads as stopped by the quit and Open
   * again starts it there (docs/task-browser.md, "After a restart").
   */
  closeAll(): void {
    for (const [taskId, browser] of [...this.browsers]) {
      const fact = this.fact(taskId);
      if (fact) {
        this.options.kept?.write(taskId, {
          fact: {
            state: "stopped",
            site: fact.site,
            url: signedIn(browser)
              ? bareAddress(this.pageAddress(browser))
              : this.pageAddress(browser),
            stopped: "gone",
            at: Date.now(),
            quit: true,
            session: this.session,
            generation: browser.generation,
          },
          ...(browser.server ? { served: this.servedOf(browser) } : {}),
          ...(browser.saved.size > 0 ? { saved: Object.fromEntries(browser.saved) } : {}),
        });
      }
      this.stop(taskId);
    }
    this.options.starts?.stopAll();
    const guard = this.keptGuard;
    this.keptGuard = undefined;
    void guard?.then((handle) => handle?.close());
  }

  /**
   * A fresh browser for the task, about to load `url`; `opened` is its
   * timeline line. With `kept` its first page opens in the kept profile.
   */
  private async start(
    taskId: string,
    url: string,
    opened: string,
    options: { captains?: boolean; kept?: boolean } = {},
  ): Promise<Browser | undefined> {
    const saved = this.allowanceOf(taskId);
    const first = this.newEntry(taskId);
    const browser: Browser = {
      pages: [first],
      size: this.pageSize(taskId),
      current: first,
      guard: undefined as unknown as ConnectionGuardHandle,
      firstUrl: url,
      generation: (this.generations.get(taskId) ?? 0) + 1,
      booksFrom: (this.books.get(taskId) ?? 0) + 1,
      origins: new Set(),
      reached: new Set(),
      // While the captain holds the page, what it says is his and is kept for nobody.
      notices: new PageNotices(() => browser.control === "captain"),
      // His own from the start, before anything hears it opened.
      control: options.captains ? "captain" : "crewmate",
      returns: 0,
      saved,
      ...(options.captains ? { captains: true as const } : {}),
    };
    const notices = browser.notices;
    try {
      browser.guard = await (this.options.guard ?? startConnectionGuard)({
        onRefused: (refusal) => {
          if (browser.control === "captain") return;
          notices.tunnels.set(refusal.host, refusal);
          notices.block(refusal.host, refusal.noRoute ? "no-route" : refusal.kind);
        },
        ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
        listed: (host) => listsPrivateSite(this.sites, host),
        // An engine that sends loopback here reaches only the origins its
        // crewmate opened, a live-reload socket on the same port included.
        local: (host, port) => reachesOrigin(browser, host, port),
      });
    } catch {
      return undefined;
    }
    const page = await this.openPageIn(taskId, browser, first, options.kept === true);
    if (!page) {
      browser.guard.close();
      return undefined;
    }
    first.page = page;
    if (options.kept) browser.kept = true;
    this.generations.set(taskId, browser.generation);
    this.browsers.set(taskId, browser);
    // A view maximized or restored while it opened: the page follows.
    if (!sameSize(browser.size, this.pageSize(taskId))) this.resizePages(taskId);
    this.ended.delete(taskId);
    // An open browser is this run's to tell: the page kept from a stop goes.
    this.restored.add(taskId);
    this.options.kept?.remove(taskId);
    this.options.note?.(taskId, opened);
    // A view already watching this task sees the new page from its start.
    if (this.watchers.has(taskId)) this.startWatching(taskId, browser);
    this.options.onChange?.(taskId);
    return browser;
  }

  /** A page entry not yet opened, with its own new ref book. */
  private newEntry(taskId: string): PageEntry {
    return {
      diagnostics: new PageDiagnostics(),
      page: undefined as unknown as HostBrowserPage,
      refs: this.newBook(taskId),
      loading: false,
    };
  }

  /**
   * The kept profile's connection guard, started with the first kept page
   * (docs/task-browser.md, "Signed-in sites"). A loopback origin is reached
   * when a kept browser's crewmate opened it, and a refusal is told to each
   * kept browser its crewmate holds.
   */
  private keptGuardFor(): Promise<ConnectionGuardHandle | undefined> {
    const kept = (): Browser[] => [...this.browsers.values()].filter((browser) => browser.kept);
    this.keptGuard ??= (this.options.guard ?? startConnectionGuard)({
      onRefused: (refusal) => {
        for (const browser of kept()) {
          if (browser.control === "captain") continue;
          browser.notices.tunnels.set(refusal.host, refusal);
          browser.notices.block(refusal.host, refusal.noRoute ? "no-route" : refusal.kind);
        }
      },
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      listed: (host) => listsPrivateSite(this.sites, host),
      local: (host, port) => kept().some((browser) => reachesOrigin(browser, host, port)),
    }).catch(() => {
      this.keptGuard = undefined;
      return undefined;
    });
    return this.keptGuard;
  }

  /**
   * Open one of the browser's first pages: in its own empty context behind
   * its own guard, or in the kept profile behind the kept guard. Nothing
   * when the engine or the guard could not.
   */
  private async openPageIn(
    taskId: string,
    browser: Browser,
    entry: PageEntry,
    kept: boolean,
  ): Promise<HostBrowserPage | undefined> {
    const guard = kept ? await this.keptGuardFor() : browser.guard;
    if (!guard) return undefined;
    const notices = browser.notices;
    try {
      return await this.options.host.open({
        viewport: { ...browser.size },
        proxy: {
          host: guard.host,
          port: guard.port,
          username: guard.username,
          password: guard.password,
        },
        ...(kept ? { kept: true as const } : {}),
        allow: (request) => {
          const decision = decidePageRequest(request, browser.origins, browser.reached, (host) =>
            listsPrivateSite(this.sites, host),
          );
          if (!decision.allowed) {
            if (browser.control !== "captain") notices.block(decision.host, decision.kind);
            return false;
          }
          // A page of the kept profile goes only to the sites its task may use there.
          if (kept && request.topLevel && !this.grants.keptMayOpen(taskId, browser, request.url)) {
            return false;
          }
          if ("reach" in decision) browser.reached.add(decision.reach);
          return true;
        },
        // A site's every picture may fail its certificate: it is said once.
        onRefused: (refusal) => {
          const words = refusalWords(refusal);
          if (!notices.refusals.includes(words)) notices.keep("refusals", words);
        },
        onDownload: (offer) =>
          saveDownload(this.options.evidenceDir(taskId), offer, notices, {
            saved: (line) => this.options.note?.(taskId, line),
            ended: () => {
              if (this.browsers.get(taskId) === browser) this.options.onChange?.(taskId);
            },
          }),
        ...this.pageEvents(taskId, browser, entry),
      });
    } catch {
      return undefined;
    }
  }

  /**
   * The browser's pages reopen in the other profile at `url`
   * (docs/task-browser.md, "Signed-in sites"): into the kept profile, or
   * out of it into a fresh empty context of its own. Its pages there close,
   * its refs start again, and its allowance, generation and holder stay.
   * The load's outcome, or nothing when the new page could not open; the
   * browser then stays as it was.
   */
  private async moveProfile(
    taskId: string,
    browser: Browser,
    kept: boolean,
    url: string,
  ): Promise<HostLoadOutcome | undefined> {
    const entry = this.newEntry(taskId);
    const page = await this.openPageIn(taskId, browser, entry, kept);
    if (!page) return undefined;
    if (this.browsers.get(taskId) !== browser) {
      page.close();
      return undefined;
    }
    entry.page = page;
    const before = browser.pages;
    browser.pages = [entry];
    browser.current = entry;
    browser.firstUrl = url;
    if (kept) browser.kept = true;
    else {
      browser.kept = undefined;
      browser.passed = undefined;
    }
    browser.stopWatching?.();
    browser.stopWatching = undefined;
    if (this.watchers.has(taskId)) this.startWatching(taskId, browser);
    // A second page first; the first page's close ends an empty context's site data.
    for (const old of [...before].reverse()) {
      try {
        old.page.close();
      } catch {
        // A page that is already gone has nothing left to close.
      }
    }
    const outcome = await loadOwn(entry, page.load(url)).catch(
      (): HostLoadOutcome => ({ ok: false, code: "ERR_FAILED" }),
    );
    this.options.onChange?.(taskId);
    return outcome;
  }

  /**
   * A page the captain holds asked for a file: the app's own picker opens
   * over the app's window, and the page gets what the captain picks. On a
   * computer with no window of the app's, the request waits for the
   * crewmate, which may attach a file from its working copy.
   */
  private async captainFiles(
    taskId: string,
    browser: Browser,
    entry: PageEntry,
    chooser: HostFileChooser,
  ): Promise<void> {
    const choose = this.options.host.chooseFiles;
    if (!choose) {
      entry.chooser = chooser;
      this.options.note?.(
        taskId,
        "its page asked for a file, which you cannot attach to a browser on another computer; return control and its crewmate can attach one from its working copy",
      );
      return;
    }
    const paths = await choose({ multiple: chooser.multiple }).catch(() => []);
    if (paths.length === 0 || this.browsers.get(taskId) !== browser) return;
    if (!browser.pages.includes(entry)) return;
    await entry.page
      .setFiles(chooser.target, chooser.multiple ? paths : paths.slice(0, 1))
      .catch(() => undefined);
  }

  /** One page's doings, kept for the crewmate's next answer unless the captain holds the page. */
  private pageEvents(taskId: string, browser: Browser, entry: PageEntry): HostPageEvents {
    const live = (): boolean => this.browsers.get(taskId) === browser;
    const notices = browser.notices;
    return {
      onNavigated: (url) => {
        entry.refs = this.newBook(taskId);
        entry.answered = undefined;
        // A new document has none of the old one's file fields.
        entry.chooser = undefined;
        entry.lastUrl = url;
        if (!entry.loading && browser.control !== "captain") entry.moved = url;
        // A sign-in page the captain passes through in the kept profile is the task's to open too.
        if (browser.kept && browser.control === "captain") this.grants.passedThrough(browser, url);
        if (live()) this.options.onChange?.(taskId);
      },
      onLoadFailed: () => {
        // The captain's view reads the page's address again, and says why it is blocked.
        if (live()) this.options.onChange?.(taskId);
      },
      onConsole: (level, text) => {
        if (live() && browser.control === "crewmate")
          entry.diagnostics.log(level, text, signedIn(browser));
      },
      onNetwork: (event) => {
        if (live() && browser.control === "crewmate") entry.diagnostics.request(event);
      },
      // A key hidden before the message is cut, so no piece of one is left to read.
      onDialog: (kind, message) =>
        notices.keep(
          "dialogs",
          `${kind} ${quoted(clip(signedIn(browser) ? hideKeys(message) : message))}`,
        ),
      onFileChooser: (chooser) => {
        if (!live()) return;
        if (browser.control === "captain" || browser.control === "taking") {
          void this.captainFiles(taskId, browser, entry, chooser);
          return;
        }
        // The crewmate's next answer says so, until it attaches a file or the page moves.
        entry.chooser = chooser;
      },
      onPicker: (kind) =>
        notices.keep(
          "dialogs",
          kind === "print"
            ? `print: this browser never prints; photograph the page with ${browserCommand("screenshot")} instead`
            : "color picker: this browser never shows one",
        ),
      onPopup: (url) => this.popup(taskId, browser, url),
      onPageError: (text) => {
        // A refused request or connection logs its own error; the summary already says it.
        // A signed-out site's own navigation payload 404 is noise, not the page's.
        if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED/.test(text)) return;
        if (isPageNoise(text)) return;
        notices.keep("errors", text);
      },
      onGone: (reason) => {
        if (!live()) return;
        if (entry === browser.pages[0]) {
          this.stop(taskId, "gone");
          this.stopped.set(taskId, `stopped working (${reason})`);
          this.options.note?.(taskId, "its browser stopped working and was closed");
          return;
        }
        this.leave(taskId, browser, entry, "stopped working and was closed");
        try {
          entry.page.close();
        } catch {
          // A page that is already gone has nothing left to close.
        }
      },
      onClosed: () => {
        if (live()) this.leave(taskId, browser, entry, "closed itself");
      },
      onAsk: (ask) => this.pageAsked(taskId, browser, entry, ask),
    };
  }

  /**
   * A page asked to open another window: it opens as this browser's next
   * page while there is room and it goes somewhere a page may, and the
   * crewmate's commands move to it; otherwise it is refused and said so.
   */
  private popup(taskId: string, browser: Browser, url: string): HostPopup | undefined {
    if (this.browsers.get(taskId) !== browser) return undefined;
    if (browser.pages.length >= TASK_BROWSER_PAGES_MAX) {
      browser.notices.keep("popups", url ? shown(browser, url) : "a blank page");
      return undefined;
    }
    if (url && url !== "about:blank") {
      const decision = decideRequest(url, browser.origins, (host) =>
        listsPrivateSite(this.sites, host),
      );
      if (!decision.allowed) {
        if (browser.control !== "captain") browser.notices.block(decision.host, decision.kind);
        return undefined;
      }
      if (browser.kept && !this.grants.allows(browser, url)) {
        browser.notices.keep("popups", shown(browser, url));
        return undefined;
      }
    }
    const entry: PageEntry = {
      diagnostics: new PageDiagnostics(),
      page: undefined as unknown as HostBrowserPage,
      refs: this.newBook(taskId),
      loading: false,
      ...(url && url !== "about:blank" ? { lastUrl: url } : {}),
    };
    const viewport = { ...browser.size };
    return {
      events: this.pageEvents(taskId, browser, entry),
      viewport,
      opened: (page) => {
        if (
          this.browsers.get(taskId) !== browser ||
          browser.pages.length >= TASK_BROWSER_PAGES_MAX
        ) {
          page.close();
          return;
        }
        entry.page = page;
        browser.pages.push(entry);
        // A resize while it opened went to the pages it found; this one follows.
        if (!sameSize(viewport, browser.size)) {
          void page.resize({ ...browser.size }).catch(() => undefined);
        }
        const place = browser.pages.length;
        const site = url && url !== "about:blank" ? ` at ${siteOf(url)}` : "";
        browser.notices.keep(
          "pageNotes",
          `The page opened a ${PAGE_WORDS[place] ?? "new"} page${site}, page ${place}, and your commands act on it now. ${browserCommand("selectpage 1")} goes back to the first page; ${browserCommand(`closepage ${place}`)} closes this one.`,
        );
        this.select(taskId, browser, entry);
        this.options.onChange?.(taskId);
      },
    };
  }

  /** A page another page opened goes: closed by itself, stopped, or by the crewmate. */
  private leave(taskId: string, browser: Browser, entry: PageEntry, how: string): void {
    const place = browser.pages.indexOf(entry) + 1;
    if (place <= 1) return;
    const current = browser.current === entry;
    const site = siteOf(addressOf(browser, entry));
    this.dropPage(taskId, browser, entry);
    browser.notices.keep(
      "pageNotes",
      `Page ${place} (${site}) ${how}${current ? "; your commands act on page 1 again" : ""}.`,
    );
  }

  /** Take a page another page opened off the browser; the first page goes only with it. */
  private dropPage(taskId: string, browser: Browser, entry: PageEntry): void {
    const index = browser.pages.indexOf(entry);
    if (index <= 0) return;
    browser.pages.splice(index, 1);
    if (browser.current === entry) this.select(taskId, browser, browser.pages[0] as PageEntry);
    this.options.onChange?.(taskId);
  }

  /** The page the crewmate's commands, the captain's input and every view go to. */
  private select(taskId: string, browser: Browser, entry: PageEntry): void {
    if (browser.current === entry) return;
    browser.current = entry;
    browser.stopWatching?.();
    browser.stopWatching = undefined;
    if (this.watchers.has(taskId)) this.startWatching(taskId, browser);
    this.options.onChange?.(taskId);
  }

  /**
   * The browser goes: its pages, history and site data, and its connection
   * guard. With a reason the captain keeps reading why, and Open again
   * starts from its last page; without one (the app quits) nothing is kept.
   */
  private stop(taskId: string, why?: TaskBrowserStop): void {
    const browser = this.browsers.get(taskId);
    if (!browser) return;
    const fact = why ? this.fact(taskId) : undefined;
    this.browsers.delete(taskId);
    // The captain's Stop browser and the task's close end what it may use; any other stop keeps it.
    if (why === "captain" || why === "task-closed" || browser.saved.size === 0) {
      this.allowed.delete(taskId);
    } else this.allowed.set(taskId, new Map(browser.saved));
    // A build the host started stops with its browser, after a running turn; a crewmate's own never does.
    this.options.starts?.stopWithBrowser(taskId);
    browser.cancelIdle?.();
    browser.stopWatching?.();
    browser.stopWatching = undefined;
    if (browser.server) {
      browser.server.close();
      if (why) this.endedServers.set(taskId, this.servedOf(browser));
    } else if (why) this.endedServers.delete(taskId);
    // A second page first; the first page's close ends an empty context's
    // site data, while a kept page's close leaves the kept profile as it is.
    for (const entry of [...browser.pages].reverse()) {
      try {
        entry.page.close();
      } catch {
        // A page that is already gone has nothing left to close.
      }
    }
    browser.guard.close();
    if (why && fact) {
      const ended: Extract<TaskBrowserFact, { state: "stopped" }> = {
        state: "stopped",
        site: fact.site,
        // Open again starts fresh, so it carries nothing of a sign-in's address.
        url: signedIn(browser) ? bareAddress(fact.url) : fact.url,
        stopped: why,
        at: Date.now(),
        session: this.session,
        generation: browser.generation,
      };
      this.ended.set(taskId, ended);
      // Kept with the task, so a restart can still open it again; never once it closed.
      if (why === "task-closed") this.options.kept?.remove(taskId);
      else {
        const served = this.endedServers.get(taskId);
        const saved = this.allowed.get(taskId);
        this.options.kept?.write(taskId, {
          fact: ended,
          ...(served ? { served } : {}),
          ...(saved ? { saved: Object.fromEntries(saved) } : {}),
        });
      }
      this.options.onChange?.(taskId);
    }
  }

  /** The project folder a browser's page serves, as Open again needs it. */
  private servedOf(browser: Browser): Pick<ProjectServer, "folder" | "origin"> & {
    captains?: true;
  } {
    const server = browser.server as ProjectServer;
    return {
      folder: server.folder,
      origin: server.origin,
      ...(browser.captains ? { captains: true as const } : {}),
    };
  }

  /**
   * A task's stopped browser: this run's, or the page kept with the task,
   * read once per run after a restart (docs/task-browser.md, "After a
   * restart").
   */
  private endedOf(taskId: string): Extract<TaskBrowserFact, { state: "stopped" }> | undefined {
    const ended = this.ended.get(taskId);
    if (ended || this.restored.has(taskId)) return ended;
    this.restored.add(taskId);
    const page = this.options.kept?.read(taskId);
    if (!page || page.fact.stopped === "task-closed") return undefined;
    this.ended.set(taskId, page.fact);
    if (page.served) this.endedServers.set(taskId, page.served);
    if (page.saved) this.allowed.set(taskId, new Map(Object.entries(page.saved)));
    return page.fact;
  }

  /**
   * The signed-in sites a task's new browser may use: those its last one
   * could, whose entry this computer still keeps by its id - a removed one
   * is gone - by the site the entry names now.
   */
  private allowanceOf(taskId: string): Map<string, string> {
    if (!this.restored.has(taskId)) this.endedOf(taskId);
    const allowed = this.allowed.get(taskId);
    if (!allowed?.size) return new Map();
    let records: SignedInSite[];
    try {
      records = this.options.signIns?.records() ?? [];
    } catch {
      return new Map();
    }
    const ids = new Set(allowed.values());
    return new Map(
      records
        .filter((record) => ids.has(record.id))
        .map((record) => [record.site, record.id] as const)
        .slice(-SAVED_SIGN_INS_PER_TASK),
    );
  }

  /** The address a browser's current page is on, its last one while it shows an error page. */
  private pageAddress(browser: Browser): string {
    const entry = browser.current;
    const shown = addressOf(browser, entry);
    if (/^https?:/.test(shown)) return shown;
    return entry.lastUrl ?? (entry === browser.pages[0] ? browser.firstUrl : shown);
  }

  /**
   * Whether anything answers at the loopback address a task's page is on
   * (docs/task-browser.md, "When nothing answers"): only an address its
   * crewmate opened, never a project folder the host serves itself. A
   * refused connection starts an outage and, with `wake`, tells its
   * crewmate's wake; an answer ends it. Any other reading changes nothing.
   */
  private async checkAnswers(
    taskId: string,
    browser: Browser,
    options: { wake: boolean },
  ): Promise<void> {
    const address = this.pageAddress(browser);
    const target = answerTarget(address);
    if (!target || !browser.origins.has(target.origin)) return;
    if (browser.server && address.startsWith(`${browser.server.origin}/`)) return;
    const reading = await (this.options.probe ?? probeLoopback)(target.host, target.port).catch(
      () => "unknown" as const,
    );
    if (this.browsers.get(taskId) !== browser) return;
    const outage = this.outages.get(taskId);
    if (reading === "answered") {
      if (outage) {
        this.outages.delete(taskId);
        this.options.onChange?.(taskId);
      }
      return;
    }
    if (reading !== "refused") return;
    let current: { origin: string; once: string; failed?: true } | undefined = outage;
    if (!current || current.origin !== target.origin) {
      this.outageCount += 1;
      current = {
        origin: target.origin,
        once: `page-unanswered:${this.session}:${taskId}:${this.outageCount}`,
      };
      this.outages.set(taskId, current);
      this.options.onChange?.(taskId);
    }
    if (!options.wake) return;
    // A saved start runs first; its crewmate is woken only once it failed.
    const start = current.failed ? undefined : this.options.starts?.kept(taskId, target.origin);
    if (start) this.startPage(taskId, browser, start, target, current);
    else {
      this.options.onUnanswered?.(taskId, {
        site: siteOf(address),
        url: bareAddress(address),
        once: current.once,
      });
    }
  }

  /**
   * Run a task's saved start while the captain waits at its page
   * (docs/task-browser.md, "Starting a page again"): the page loads again
   * once its address answers; when the program exits first or its wait
   * runs out, its crewmate gets the outage's one wake, with how it failed.
   */
  private startPage(
    taskId: string,
    browser: Browser,
    start: PageStart,
    target: AnswerTarget,
    outage: { origin: string; once: string; failed?: true },
  ): void {
    const starts = this.options.starts as NonNullable<TaskBrowsersOptions["starts"]>;
    const fresh = !starts.starting(taskId);
    const address = this.pageAddress(browser);
    void starts.run(taskId, start, target).then(async (outcome) => {
      if (this.browsers.get(taskId) !== browser || outcome.kind === "stopped") return;
      if (outcome.kind === "answered") {
        // Only the press that started it loads the page again, and only one still on its origin.
        if (!fresh) return;
        await this.queues.run(taskId, async () => {
          const now = this.pageAddress(browser);
          if (this.browsers.get(taskId) !== browser) return;
          if (answerTarget(now)?.origin !== outage.origin) return;
          const entry = browser.current;
          const loaded = await loadOwn(entry, entry.page.load(now));
          if (!loaded.ok) entry.moved = undefined;
        });
        await this.checkAnswers(taskId, browser, { wake: false });
        this.options.onChange?.(taskId);
        return;
      }
      outage.failed = true;
      this.options.onChange?.(taskId);
      this.options.onUnanswered?.(taskId, {
        site: siteOf(address),
        url: bareAddress(address),
        once: outage.once,
        start: {
          command: start.command,
          ...(outcome.ranOut ? { ranOut: true as const } : { exit: outcome.exit ?? null }),
          log: outcome.log,
        },
      });
    });
    if (fresh) this.options.onChange?.(taskId);
  }

  /** Whether the task's current page is on the origin of its running outage; no outage, no notice. */
  private isUnanswered(taskId: string, browser: Browser): boolean {
    const outage = this.outages.get(taskId);
    return (
      outage !== undefined && outage.origin === answerTarget(this.pageAddress(browser))?.origin
    );
  }

  /** A crewmate's command moved the page: an outage ends once its address answers again. */
  private answeredAgain(taskId: string): void {
    const browser = this.browsers.get(taskId);
    if (!browser || !this.outages.has(taskId)) return;
    void this.checkAnswers(taskId, browser, { wake: false });
  }

  /** Pictures of the task's current page to everyone watching it, once per page. */
  private startWatching(taskId: string, browser: Browser): void {
    if (browser.stopWatching) return;
    const entry = browser.current;
    browser.stopWatching = entry.page.watch((frame) => {
      if (this.browsers.get(taskId) !== browser || browser.current !== entry) return;
      for (const sink of this.watchers.get(taskId) ?? []) sink(frame);
    });
  }

  private async reopenNow(taskId: string): Promise<TaskBrowserCommandResult> {
    if (this.browsers.has(taskId)) return { ok: true };
    const ended = this.endedOf(taskId);
    if (!ended || ended.stopped === "task-closed") {
      return { ok: false, text: "This task has no browser to open again." };
    }
    // A page from the project opens again from a fresh server for its folder.
    const served = this.endedServers.get(taskId);
    const server =
      served && ended.url.startsWith(`${served.origin}/`)
        ? await this.serveFolder(served.folder)
        : undefined;
    if (served && ended.url.startsWith(`${served.origin}/`) && !server) {
      return { ok: false, text: `${HERE.This} could not serve this project's files.` };
    }
    const address =
      served && server ? `${server.origin}${ended.url.slice(served.origin.length)}` : ended.url;
    await this.readSites(taskId);
    const check = checkOpenable(address, (host) => listsPrivateSite(this.sites, host));
    if (!check.ok) {
      server?.close();
      return { ok: false, text: check.reason };
    }
    if (this.browsers.size >= this.max) {
      server?.close();
      return {
        ok: false,
        text: `${NUMBER_WORDS[this.max] ?? this.max} task browsers are already open on ${HERE.this}. Stop one, then open this again.`,
      };
    }
    const why = this.stopped.get(taskId);
    const browser = await this.start(
      taskId,
      check.url.href,
      `you opened its browser again at ${check.url.origin}`,
      // A browser his own click started opens again as his.
      { captains: Boolean(server && served?.captains) },
    );
    if (!browser) {
      server?.close();
      return { ok: false, text: `${HERE.This} could not open a browser for this task right now.` };
    }
    this.stopped.delete(taskId);
    if (server) browser.server = server;
    if (check.origin) browser.origins.add(check.origin);
    browser.notices.notice = `${why ? `Your earlier browser ${why}. ` : ""}The captain opened this task's browser again at ${check.url.href}: a fresh one, with nothing signed in.`;
    this.touch(taskId, browser);
    const entry = browser.current;
    const outcome = await loadOwn(entry, entry.page.load(check.url.href));
    if (!outcome.ok) entry.moved = undefined;
    this.options.onChange?.(taskId);
    // The captain waits at its page: whether anything answers there.
    await this.checkAnswers(taskId, browser, { wake: true });
    return { ok: true };
  }

  /**
   * A command touched the browser: its half hour starts again, unless the
   * captain watches it or holds it - a browser in his hands never stops for
   * being unused.
   */
  private touch(taskId: string, browser: Browser): void {
    browser.cancelIdle?.();
    browser.cancelIdle = undefined;
    if (this.watchers.has(taskId) || browser.control !== "crewmate") return;
    browser.cancelIdle = this.timer(this.idleMs, () => {
      if (this.browsers.get(taskId) !== browser) return;
      this.stop(taskId, "idle");
      const minutes = Math.round(this.idleMs / 60_000);
      this.stopped.set(taskId, `was stopped after ${minutes} minutes unused`);
      this.options.note?.(taskId, `its browser stopped after ${minutes} minutes unused`);
    });
  }

  /** The size a task's pages lay out at: its maximized view's room, or the check's own. */
  private pageSize(taskId: string): HostBrowserViewport {
    const size = this.viewSizes.get(taskId)?.size ?? TASK_BROWSER_PAGE;
    return { width: size.width, height: size.height };
  }

  /**
   * Lay the task's pages out at the size its view asks for now, once a
   * click in progress has landed. One resize waits at a time, and it takes
   * the newest size when it runs. A task with no browser has nothing to
   * resize: its next one opens at the size.
   */
  private resizePages(taskId: string): void {
    const browser = this.browsers.get(taskId);
    if (!browser || this.resizing.has(browser)) return;
    this.resizing.add(browser);
    void this.steady.run(browser, async () => {
      this.resizing.delete(browser);
      if (this.browsers.get(taskId) !== browser) return;
      const size = this.pageSize(taskId);
      if (sameSize(browser.size, size)) return;
      browser.size = size;
      await Promise.all(
        browser.pages.map((entry) => entry.page.resize({ ...size }).catch(() => undefined)),
      );
    });
  }

  /** A new page's book of refs, numbered after every book its task has had in this run. */
  private newBook(taskId: string): RefBook {
    return new RefBook(() => {
      const next = (this.books.get(taskId) ?? 0) + 1;
      this.books.set(taskId, next);
      return next;
    });
  }

  /** The captain handed the browser back: every page starts a new book, and older refs are refused. */
  private handBackBooks(taskId: string, browser: Browser): void {
    browser.handedBackFrom = (this.books.get(taskId) ?? 0) + 1;
    for (const entry of browser.pages) {
      entry.refs = this.newBook(taskId);
      entry.answered = undefined;
    }
  }
}
