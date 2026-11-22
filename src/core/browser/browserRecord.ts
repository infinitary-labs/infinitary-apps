import type {
  TaskBrowserAskKind,
  TaskBrowserControl,
  TaskBrowserFact,
  TaskBrowserHandle,
  TaskBrowserRequest,
  TaskBrowserStop,
  TaskBrowserTold,
} from "@shared/taskBrowser";
import type {
  HostBrowserPage,
  HostBrowserViewport,
  HostFileChooser,
  HostLoadOutcome,
} from "../host";
import { hideKeys } from "../keyFormats";
import type { ConnectionGuardHandle } from "./connectionGuard";
import type { CrewmateCommands } from "./crewmateCommands";
import type { PageDiagnostics } from "./diagnostics";
import type { OutlineOptions, RefBook } from "./outline";
import type { PageNotices } from "./pageNotices";
import type { ProjectServer } from "./projectServer";
import type { SavedSignInGrants } from "./savedSignInGrants";
import type { BrowserReturned, TaskBrowsersOptions } from "./taskBrowsers";

/**
 * A task's browser as `TaskBrowsers` keeps it (docs/task-browser.md): its
 * pages, its connection guard, who holds it, what it keeps for its crewmate
 * and the saved sign-ins it uses, with the reads every owner of it shares.
 */

/** One page of a task's browser: its first, or one a page opened. */
export type PageEntry = {
  diagnostics: PageDiagnostics;
  page: HostBrowserPage;
  refs: RefBook;
  /** Set while the crewmate's own load runs, so its navigation is not reported as the page's. */
  loading: boolean;
  /** Last safe outline answered from this ref book; never survives a handback or move. */
  answered?: { refs: RefBook; lines: string[] };
  /** The page moved to a new document on its own since the last answer. */
  moved?: string;
  /** The last address it showed, kept for when its window has gone. */
  lastUrl?: string;
  /** The page's request for a file that its crewmate has not answered yet. */
  chooser?: HostFileChooser;
};

/**
 * A page's ask waiting on the captain (docs/task-browser.md, "A site's
 * asks"): a permission and a passkey wait for `answer`; a passkey the
 * captain let run with Use passkey (`shown`) then waits for the captain in
 * Chrome's own window, brought forward.
 */
export type PageAsk = {
  id: number;
  kind: TaskBrowserAskKind;
  site: string;
  entry: PageEntry;
  answer?: (allow: boolean) => void;
  shown?: boolean;
};

export type Browser = {
  /** Its pages in the order they opened: its own first, then one a page opened. */
  pages: PageEntry[];
  /** The size its pages lay out at now: the check's own, or the captain's maximized view's. */
  size: HostBrowserViewport;
  /** The page the crewmate's commands, the captain's input and the view go to. */
  current: PageEntry;
  /** The one way its pages reach the internet; it closes with the browser. */
  guard: ConnectionGuardHandle;
  /** Origins on this Mac the crewmate opened: the local servers every page of it reaches. */
  origins: Set<string>;
  /**
   * Origins on this Mac a page's own top-level move reached, such as a
   * sign-in's return to a program (docs/task-browser.md, "Where a page may
   * go"): only a page at one of them reaches it again, except a live socket
   * in an engine that sends loopback to the guard, which passes from any page.
   */
  reached: Set<string>;
  /** What it keeps to tell its crewmate at the head of the next answer. */
  notices: PageNotices;
  /** What the crewmate did last, as the captain reads it. */
  did?: string;
  /** Where it opened, for the captain until the page shows an address of its own. */
  firstUrl: string;
  /** Which of its task's browsers this is in this run: a card's attachment names it. */
  generation: number;
  /** The first book number its pages took: a lower one is an earlier browser's. */
  booksFrom: number;
  /** The first book number after the captain last handed it back: a lower one is from before. */
  handedBackFrom?: number;
  /** Who holds it besides its crewmate: paused for the captain, being taken, or his. */
  control: "crewmate" | TaskBrowserControl;
  /** The crewmate's request for the captain's help, while it stands. */
  request?: TaskBrowserRequest;
  /**
   * Whether the captain sits at the computer this browser runs on, as the
   * last Take control, input or answer came from (docs/task-browser.md, "A
   * site's asks"): only there can Chrome show the captain a passkey's prompt.
   */
  here?: boolean;
  /** What a page asks the captain now, while the captain holds it: one ask at a time. */
  asking?: PageAsk;
  /** The passkey request it last told a site no to while the captain held it. */
  told?: TaskBrowserTold;
  /** How many asks it put to the captain: the next one's number follows. */
  asks?: number;
  /** How many times the captain handed it back: the next return's wake is named by it. */
  returns: number;
  /** Handed back and not read since: the crewmate's next read is its fresh look. */
  freshLook?: boolean;
  /**
   * The signed-in sites it may use in the kept profile, by site, each with
   * the entry it came from (docs/task-browser.md, "Signed-in sites"). It
   * stays while the browser runs, in either profile.
   */
  saved: Map<string, string>;
  /** Its pages run in the computer's kept profile; absent while in its own empty context. */
  kept?: true;
  /**
   * The sites its pages may open in the kept profile beside `saved`: the
   * sign-in pages the captain passed through, or those a signed-in site's
   * entry names. They go when it leaves the kept profile.
   */
  passed?: Set<string>;
  automaticTried?: Set<string>;
  cancelIdle?: () => void;
  /** Stops the pictures the captain watches. */
  stopWatching?: () => void;
  /** The project folder it serves for a page the captain opened; it closes with the browser. */
  server?: ProjectServer;
  /**
   * Started by the captain's own click on a page from the project, with no
   * crewmate's browser to take: his from the start, and Return control
   * stops it rather than handing a browser its crewmate never opened.
   */
  captains?: true;
};

/**
 * How the captain handed a browser back to its crewmate: the notice its
 * next answer opens with, the task's timeline line, and its one wake.
 */
export type HandBack = { notice: string; note: string; returned: BrowserReturned };

/**
 * What the task browsers' owners share: `CrewmateCommands`, `PageActions`
 * and `SavedSignInGrants` each hold this one typed view of `TaskBrowsers`,
 * and reach its browsers, its lifecycle and each other through it.
 */
export type BrowsersCore = {
  readonly options: TaskBrowsersOptions;
  /** This run of the task browsers: with a generation it names one browser. */
  readonly session: string;
  /** Each task's open browser. */
  readonly browsers: Map<string, Browser>;
  /** Why a task's last browser stopped, told to its crewmate once. */
  readonly stopped: Map<string, string>;
  /** Task browsers this Mac runs at once. */
  readonly max: number;
  /** Runs `fn` after `ms` and answers its cancel. */
  readonly timer: (ms: number, fn: () => void) => () => void;
  /** The last ref book a task's browsers numbered in this run, or 0. */
  lastBook(taskId: string): number;
  /** One task's browser as the captain reads it. */
  fact(taskId: string): TaskBrowserFact | undefined;
  /** Whether the captain's handle names this browser; no handle is the one there is. */
  isHandled(browser: Browser, handle: TaskBrowserHandle | undefined): boolean;
  /** A fresh browser for the task, about to load `url`; `opened` is its timeline line. */
  start(
    taskId: string,
    url: string,
    opened: string,
    options?: { captains?: boolean; kept?: boolean },
  ): Promise<Browser | undefined>;
  /** The browser's pages reopen at `url` in the kept profile, or out of it; false when they could not. */
  moveProfile(
    taskId: string,
    browser: Browser,
    kept: boolean,
    url: string,
  ): Promise<HostLoadOutcome | undefined>;
  /** The browser goes; with a reason the captain keeps reading why. */
  stop(taskId: string, why?: TaskBrowserStop): void;
  /** The page the crewmate's commands, the captain's input and every view go to. */
  select(taskId: string, browser: Browser, entry: PageEntry): void;
  /** Take a page another page opened off the browser. */
  dropPage(taskId: string, browser: Browser, entry: PageEntry): void;
  /** A command touched the browser: its half hour starts again. */
  touch(taskId: string, browser: Browser): void;
  /** Every page starts a new ref book, and older refs are refused. */
  handBackBooks(taskId: string, browser: Browser): void;
  /** The browser goes back to its crewmate, woken once to take a fresh look. */
  handBack(taskId: string, browser: Browser, back: HandBack): void;
  /** One command at a time per task, in the order they came. */
  serial<T>(taskId: string, run: () => Promise<T>): Promise<T>;
  /** Whether a name is on the captain's private sites list, as last read. */
  listed(hostname: string): boolean;
  /** Read the private sites list again, before a crewmate's open is checked. */
  readSites(taskId: string): Promise<void>;
  /** One click or resize at a time per browser, in the order they came. */
  steadily<T>(browser: Browser, run: () => Promise<T>): Promise<T>;
  readonly commands: CrewmateCommands;
  readonly grants: SavedSignInGrants;
};

/**
 * One run at a time per key, in the order they came: a task's commands, or
 * a browser's clicks and resizes, so a page never moves between a command
 * finding a control and pressing it. A key's queue goes once it is empty.
 */
export class Queues<K> {
  private readonly tails = new Map<K, Promise<unknown>>();

  run<T>(key: K, run: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}

export const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

export function quoted(text: string): string {
  return JSON.stringify(text);
}

/** The host and port an address names: the site the captain reads. */
export function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

/** The site a crewmate named, as `siteOf` would read it: its host and port, lower case. */
export function siteNamed(named: string): string {
  const text = named.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return new URL(text).host;
  } catch {
    // Not an address: the words as they are.
  }
  return text.replace(/\/+$/, "");
}

/**
 * An address without its query and fragment, where a site keeps tokens
 * and codes: how a browser that may hold the captain's sign-in passes an
 * address on (docs/task-browser.md, "A signed-in page").
 */
export function bareAddress(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.search && !parsed.hash) return url;
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Whether the captain has handed this browser back since it opened, or it
 * runs in the kept profile: then it may hold his sign-in, and it keeps
 * only what the task needs.
 */
export function signedIn(browser: Browser): boolean {
  return browser.returns > 0 || browser.saved.size > 0 || browser.kept === true;
}

/**
 * An address as the crewmate reads it: once signed in, without its query
 * and fragment, and with a key in a known format hidden.
 *
 * `held` is for what is read for the crewmate while the captain holds the
 * browser, which its own reads never are: a sign-in may be under way, and its
 * next read comes after the return, so this one reads as that one will.
 */
export function shown(browser: Browser, url: string, held = false): string {
  return held || signedIn(browser) ? hideKeys(bareAddress(url)) : url;
}

/** Words the page shows, as the crewmate reads them: with a key in a known format hidden once signed in (`held`: see `shown`). */
export function pageWords(browser: Browser, text: string, held = false): string {
  return held || signedIn(browser) ? hideKeys(text) : text;
}

/**
 * A page's title as the crewmate reads it (`pageWords`). A page with no
 * title of its own, such as the browser's refusal of an address, takes its
 * address as its title, so that title reads as the address does (`shown`):
 * once signed in, without the query that may carry a sign-in's code.
 */
export function titleOf(browser: Browser, entry: PageEntry, held = false): string {
  const title = entry.page.title().trim();
  const address = entry.page.url();
  const bare = address.replace(/^https?:\/\//i, "");
  if (title && (title === address || title === bare)) {
    const read = shown(browser, address, held);
    return title === bare ? read.replace(/^https?:\/\//i, "") : read;
  }
  return pageWords(browser, title, held);
}

/** A page's address, or where the browser opened while its first page shows none. */
export function addressOf(browser: Browser, entry: PageEntry): string {
  const shown = entry.page.url();
  if (shown && shown !== "about:blank") return shown;
  if (entry.lastUrl) return entry.lastUrl;
  return entry === browser.pages[0] ? browser.firstUrl : shown || "about:blank";
}

export function outlineOptions(browser: Browser): OutlineOptions {
  const withheld = signedIn(browser);
  return {
    pageUrl: browser.current.page.url(),
    withholdQueries: withheld,
    // What the captain typed - a card number, a code - stays on the page,
    // sent or not: the crewmate reads only the text it typed itself.
    typedOnly: withheld,
    // A key the page shows - one the captain just made - never reaches it.
    hideKeys: withheld,
  };
}

/** A load the crewmate's command started, so its navigation is not reported as the page's own. */
export async function loadOwn(
  entry: PageEntry,
  load: Promise<HostLoadOutcome>,
): Promise<HostLoadOutcome> {
  entry.loading = true;
  try {
    return await load;
  } finally {
    entry.loading = false;
  }
}
