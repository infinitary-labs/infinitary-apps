import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import {
  FRESH_LOOK_WORDS,
  SAVED_SIGN_INS_PER_BROWSER,
  type SavedSignIn,
  TASK_BROWSER_PAGE,
  TASK_BROWSER_PAGES_MAX,
  type TaskBrowserCommandResult,
  type TaskBrowserControl,
  type TaskBrowserFact,
  type TaskBrowserHandle,
  type TaskBrowserInput,
  type TaskBrowserRequest,
  type TaskBrowserReturn,
  type TaskBrowserSize,
  type TaskBrowserStop,
} from "@shared/taskBrowser";
import {
  FORM_RESEND,
  type HostBrowserFrame,
  type HostBrowserPage,
  type HostBrowserRefusal,
  type HostBrowserViewport,
  type HostLoadOutcome,
  type HostOriginStorage,
  type HostPageEvents,
  type HostPopup,
  type HostTaskBrowser,
} from "../host";
import { changesOf } from "./changes";
import { browserCommand } from "./commandWords";
import {
  type ConnectionGuardHandle,
  type ConnectionGuardOptions,
  type GuardLookup,
  type GuardRefusalKind,
  startConnectionGuard,
} from "./connectionGuard";
import { type BlockKind, checkOpenable, decideRequest, originKey } from "./destinations";
import { type DiagnosticsList, PageDiagnostics } from "./diagnostics";
import { BROWSER_KEYS, type BrowserKey } from "./keys";
import {
  HIDDEN_VALUE_WORDS,
  marksById,
  type OutlineOptions,
  outlinePage,
  parseRef,
  passageOf,
  REF_PATTERN,
  RefBook,
  type RefEntry,
  type RefStanding,
  refusedRefWords,
} from "./outline";
import { type ProjectServer, serveProjectFolder } from "./projectServer";
import { isPageNoise } from "./reading";
import {
  cookiesOfSite,
  type HeldSignIn,
  liveCookies,
  type SavedSignInRecord,
  signInSite,
  siteOrigins,
  storageOfSite,
  type WebSignIns,
} from "./webSignIns";
import { foundWords, nextBlock, type WindowAsk, windowOf } from "./window";

/**
 * Where a computer's task browsers keep the website sign-ins the captain
 * saved (docs/task-browser.md, "Saved sign-ins"): this Mac's own store
 * (`WebSignIns`), or, on a computer that runs work for this Mac, the one
 * save at a time the home lends a browser there and takes back
 * ("On another computer").
 */
export type SignInStore = Pick<WebSignIns, "list" | "get" | "save" | "refresh" | "remove">;

/**
 * What of a saved sign-in a browser's page can use now: its cookies still
 * alive, and the page storage of the very origin the page is on, since a
 * page takes its own origin's storage alone.
 */
export function usableSignIn(record: SavedSignInRecord, address: string, now: number): HeldSignIn {
  const origin = originOf(address);
  return {
    cookies: liveCookies(record.cookies, now),
    storage: storageOfSite(record.storage, record.site).filter((held) => held.origin === origin),
  };
}

/**
 * The saved sign-in a request card may offer for the browser a fact reads
 * (docs/task-browser.md, "Saved sign-ins"): the one for the site that
 * browser is on, while it is open and holds nothing of the captain's yet -
 * neither a page the captain handed back nor a saved sign-in already in
 * use - and something of it is still usable there. Otherwise nothing, so a
 * site that turned a copied sign-in away leaves the captain to sign in.
 * The same rule wherever the browser runs: the fact is all it reads.
 */
export function offeredSignIn(
  fact: TaskBrowserFact | undefined,
  site: string,
  store: SignInStore | undefined,
  now: number,
): { record: SavedSignInRecord; usable: HeldSignIn } | undefined {
  if (fact?.state !== "open" || fact.returned || fact.saved) return undefined;
  if (siteNamed(site) !== fact.site.toLowerCase()) return undefined;
  const record = store?.get(fact.site);
  if (!record) return undefined;
  const usable = usableSignIn(record, fact.url, now);
  return holds(usable) ? { record, usable } : undefined;
}

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
 * words rather than holding the crewmate's turn.
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
 * (docs/task-browser.md, "Saved sign-ins"). A browser starts with none:
 * the captain's one click copies that one site's cookies and page storage
 * in and hands the page back, and the browser copies them back into the
 * save when it stops.
 * Removing a saved sign-in signs out every browser using it.
 */

/**
 * The page size every check is made at; the host keeps it whatever shows
 * it, except while the captain's maximized view gives the page its room.
 */
export const TASK_BROWSER_VIEWPORT = TASK_BROWSER_PAGE;
/** Task browsers this Mac runs at once. */
export const TASK_BROWSERS_MAX = 4;
/** A browser no command touched for this long stops, and says so on its task's record. */
export const TASK_BROWSER_IDLE_MS = 30 * 60 * 1000;
/** How long one command may take before its answer says it did not finish. */
export const TASK_BROWSER_COMMAND_MS = 30_000;
/** How long `wait_for` waits for its words. */
export const TASK_BROWSER_WAIT_MS = 10_000;
const WAIT_POLL_MS = 250;
/** After an action, a moment for the page to answer it before it is read again. */
const ACT_SETTLE_MS = 250;
/**
 * How long a click on a link, Enter, or a submitted field waits for the
 * address or title to change, including a move that does not load a new
 * document. Polled at `WAIT_POLL_MS`.
 */
const SOFT_NAV_POLLS = 16;
/** How long any other click waits for a move that starts after the first moment. */
const CLICK_NAV_POLLS = 8;
/** Polls after the address or title changes, for the page to finish drawing. */
const POST_NAV_POLLS = 2;
/** The window an answer shows when nothing chose another: the page from its top. */
const TOP: WindowAsk = { kind: "top" };
/** Page errors and dialogs one answer lists before it counts the rest. */
const NOTICES_SHOWN = 8;
const NOTICE_MAX = 300;
/** Notices kept between answers; older ones only count. */
const NOTICES_KEPT = 50;
/** How much of a picture's reason the captain's timeline line quotes. */
const CAPTURE_REASON_SHOWN = 120;

/**
 * Under an outline that held typed text back (docs/task-browser.md, "A
 * signed-in page"): why the crewmate cannot read it.
 */
/** A line of the outline that names a control's ref. */
const REF_IN_OUTLINE = new RegExp(` \\[${REF_PATTERN}\\]`);

const WITHHELD_WORDS = `What reads ${HIDDEN_VALUE_WORDS} holds a password, or text you did not type yourself since the captain handed this page back, which may be theirs - card details, a code: it is never read out.`;

/**
 * The captain's Reload on a page that answers a form (docs/task-browser.md,
 * "A final submission"): the browser never sends a form twice.
 */
export const FORM_RESEND_CAPTAIN_WORDS =
  "This page is the answer to a form that was sent, so reloading it would send the form again. The browser never sends a form twice: use the site's own links to see what became of it.";

/**
 * The facts a page answer opens with (docs/task-browser.md, "What a
 * crewmate reads"), typed for a command's aggregates (docs/axi-commands.md).
 */
export type BrowserPageFacts = {
  title: string;
  /** The address as the crewmate reads it: without its query and fragment once signed in. */
  url: string;
  /** The page's ref book (`g3`), or `none` before a read names a ref from it. */
  refs: string;
  /** How many controls on the page carry a ref, where the answer read the outline. */
  controls?: number;
  /** With two pages: which one this answer reads, and how many there are. */
  page?: { place: number; of: number };
  /** Errors the page logged since the crewmate's last answer. */
  errors: number;
  /** What the command did, in the words the crewmate reads. */
  did: string;
  /**
   * The captain handed this browser back, or it uses his saved sign-in, so
   * its pages may show his account (docs/task-browser.md, "A signed-in page").
   */
  signedIn?: true;
};

/** A page's console or network list (docs/task-browser.md, "Console and network lists"). */
export type BrowserDiagnostics = DiagnosticsList;

/**
 * A command's answer: its words, and what a command line prints from them.
 * `text` is the whole answer in words; a page answer also carries its facts
 * typed (`page`), what follows them (`body`) and how to read on (`next`), so
 * the command prints its aggregates first. A refusal is typed by the one
 * that refused, never read off its words: `refused` when nothing was done
 * on the page and the words say what to do instead, `invalid` when the ask
 * itself was malformed.
 */
export type BrowserAnswer = {
  text: string;
  image?: { data: string; mimeType: "image/png" };
  refused?: "refused" | "invalid";
  page?: BrowserPageFacts;
  body?: string;
  next?: string[];
  /** A picture the answer saved in the evidence folder. */
  picture?: { path: string; width: number; height: number; what: string };
  diagnostics?: BrowserDiagnostics;
  /** Every page the browser holds, for a crewmate that lists them. */
  pages?: { place: number; title: string; url: string; current: boolean }[];
};

/** A refusal: the words say why nothing was done, and what to do instead. */
function refused(text: string): BrowserAnswer {
  return { text, refused: "refused" };
}

/** An ask that cannot be carried out as given: the words say how to ask. */
function invalid(text: string): BrowserAnswer {
  return { text, refused: "invalid" };
}

export type BrowserNavigateInput = {
  url?: string;
  go?: "back" | "forward" | "reload";
  /** Switch to the browser's page with this place, from 1. */
  page?: number;
};
export type BrowserInspectInput = {
  show?: "console" | "network";
  waitFor?: string;
  ref?: string;
  /** Show the part of the page that holds these words. */
  find?: string;
  /** Show the page from this line of its outline on. */
  from?: number;
  /** Show every line, from the top or from `from`, with no window's bound. */
  full?: boolean;
};
export type BrowserActInput = {
  /**
   * `set` puts text in a field, replacing what it holds, or chooses the
   * option of that label when the element is a list.
   */
  action: "click" | "type" | "select" | "set" | "press" | "scroll" | "hover" | "fill" | "drag";
  ref?: string;
  text?: string;
  submit?: boolean;
  option?: string;
  key?: string;
  direction?: "up" | "down" | "top" | "bottom";
  to?: string;
  fields?: { ref: string; text: string }[];
};
export type BrowserCaptureInput = {
  ref?: string;
  name?: string;
  fullPage?: boolean;
  /** What the task needs the picture for; asked once the browser may hold the captain's sign-in. */
  reason?: string;
};
/** Stop the browser, or with `page` close only a page another page opened. */
export type BrowserCloseInput = { page?: number };

/**
 * One task's browser, as its crewmate's command reaches it
 * (`src/core/axi/browserCommands.ts`, through the task's channel).
 */
export type CrewmateBrowser = {
  navigate: (input: BrowserNavigateInput) => Promise<BrowserAnswer>;
  inspect: (input: BrowserInspectInput) => Promise<BrowserAnswer>;
  act: (input: BrowserActInput) => Promise<BrowserAnswer>;
  capture: (input: BrowserCaptureInput) => Promise<BrowserAnswer>;
  close: (input?: BrowserCloseInput) => Promise<BrowserAnswer>;
  /** Every page the browser holds, or that no browser is open; reads nothing on a page. */
  pages: () => Promise<BrowserAnswer>;
};

export type TaskBrowsersOptions = {
  host: HostTaskBrowser;
  /** Where a task's pictures go: its evidence folder, outside the working copy. */
  evidenceDir: (taskId: string) => string;
  /** One line on the task's own timeline. */
  note?: (taskId: string, text: string) => void;
  /** A task's browser changed for the captain: it opened, moved, acted or stopped. */
  onChange?: (taskId: string) => void;
  /**
   * The captain returned a task's browser: its crewmate's one wake, named
   * by `once` so the inbox queues it once (docs/task-browser.md, "Taking
   * control").
   */
  onReturned?: (taskId: string, returned: BrowserReturned) => void;
  max?: number;
  idleMs?: number;
  /** Runs `fn` after `ms` and answers its cancel; injected so a test drives the clock. */
  timer?: (ms: number, fn: () => void) => () => void;
  /** This run's name; a fresh one when absent. */
  session?: string;
  /** Starts a browser's connection guard; the real one on loopback when absent. */
  guard?: (options: ConnectionGuardOptions) => Promise<ConnectionGuardHandle>;
  /** How a guard resolves a name; the system's resolver when absent. */
  lookup?: GuardLookup;
  /** The website sign-ins saved on this Mac; with none, nothing is saved or offered. */
  signIns?: SignInStore;
  /** The time, injected so a test drives which cookies are still alive. */
  now?: () => number;
  /** Serves a project folder for a page the captain opens; the real loopback server when absent. */
  serve?: (folder: string) => Promise<ProjectServer>;
};

/**
 * A page from a task's project the captain opens in its browser
 * (docs/task-browser.md, "A page from the project"): the project folder and
 * the HTML file's path inside it.
 */
export type ProjectPage = { folder: string; path: string };

/** How long a stopping browser waits to copy its saved sign-ins back before it closes anyway. */
const COPY_BACK_MS = 3_000;

/** A host the page asked for and did not get: refused by policy, or by its connection guard. */
type Blocked = { count: number; kind: BlockKind | Exclude<GuardRefusalKind, "private"> };

/**
 * What each kind of refused request reads as, in the order an answer lists
 * them: the words before the hosts, and the sentence after.
 */
const BLOCKED_WORDS: readonly [Blocked["kind"], readonly [string, string]][] = [
  [
    "private",
    [
      `Blocked what the page asked for on ${HERE.this}'s network or another private one: `,
      `This browser reaches public websites and the pages on ${HERE.this} you open, never another device; a public name that leads to a private address is refused at the connection.`,
    ],
  ],
  [
    "insecure",
    [
      "Blocked what the page asked for from websites over plain http: ",
      "This browser reaches websites only over https.",
    ],
  ],
  [
    "local",
    [
      `Blocked what the page asked for from other servers on ${HERE.this}: `,
      `Open one with ${browserCommand("open <url>")} to let this task's pages reach it.`,
    ],
  ],
  [
    "scheme",
    [
      "Blocked what the page asked for that is not a web address: ",
      "This browser opens no other app, and never the captain's own browser.",
    ],
  ],
  ["unresolved", ["Could not find what the page asked for: ", "No such name was found."]],
  ["unreachable", ["Could not reach what the page asked for: ", "Its server did not answer."]],
];

/** What the browser refused of a site on its own, as the crewmate reads it. */
function refusalWords(refusal: HostBrowserRefusal): string {
  const site = siteOf(refusal.url);
  switch (refusal.kind) {
    case "certificate":
      return `${site}: its certificate did not verify (${refusal.code}), so nothing came from it. This browser never goes past a certificate error.`;
    case "sign-in-box":
      return `${site}: it asked for a browser sign-in box, which this browser does not answer. If the task needs that site, ask the captain on a card.`;
    case "client-certificate":
      return `${site}: it asked for a client certificate, which this browser never offers.`;
  }
}

/** The host an address names, lower case, for the guard's record of it. */
function hostnameOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("[") ? host.slice(1, -1) : host;
  } catch {
    return url;
  }
}

/** One page of a task's browser: its first, or one a page opened. */
type PageEntry = {
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
};

/** The captain handed a task's browser back: what its crewmate's one wake says. */
export type BrowserReturned = {
  /** The page's host and port, as the captain read it. */
  site: string;
  /** What the crewmate said it would do once control came back, when it asked. */
  after?: string;
  /** The captain let it use the saved sign-in for the site, rather than signing in. */
  saved?: true;
  /** This return's own name: the run, the browser and how many returns it has had. */
  once: string;
};

type Browser = {
  /** Its pages in the order they opened: its own first, then one a page opened. */
  pages: PageEntry[];
  /** The size its pages lay out at now: the check's own, or the captain's maximized view's. */
  size: HostBrowserViewport;
  /**
   * A click at a control's place, or a resize, in progress: neither starts
   * while the other runs, so a page never moves between a command finding
   * a control and pressing it.
   */
  steady?: Promise<void>;
  /** The page the crewmate's commands, the captain's input and the view go to. */
  current: PageEntry;
  /** The one way its pages reach the internet; it closes with the browser. */
  guard: ConnectionGuardHandle;
  /** Origins on this Mac the crewmate opened: the only local servers the page reaches. */
  origins: Set<string>;
  /** Requests refused since the last answer, by host. */
  blocked: Map<string, Blocked>;
  /** Why the guard last carried no connection to each host, for a load's own words. */
  tunnels: Map<string, GuardRefusalKind>;
  dialogs: string[];
  errors: string[];
  /** Windows a page tried to open past the browser's pages, refused. */
  popups: string[];
  /** Certificates, sign-in boxes and client certificates the browser refused. */
  refusals: string[];
  /** A second page opening or closing, in the words the crewmate reads. */
  pageNotes: string[];
  /** Notices past `NOTICES_KEPT` since the last answer: counted, not kept. */
  dropped: number;
  /** Told to the crewmate once, at the head of its next answer. */
  notice?: string;
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
  /** How many times the captain handed it back: the next return's wake is named by it. */
  returns: number;
  /** Handed back and not read since: the crewmate's next read is its fresh look. */
  freshLook?: boolean;
  /**
   * The saved sign-ins it uses, by site, each with the save it came from:
   * it copies them back into that save when it stops.
   */
  saved: Map<string, string>;
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

/** A watcher's sink: one picture of the page each time it changes. */
export type BrowserFrameSink = (frame: HostBrowserFrame) => void;

class BoundExceeded extends Error {}

const defaultTimer = (ms: number, fn: () => void): (() => void) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

function quoted(text: string): string {
  return JSON.stringify(text);
}

function labelOf(entry: RefEntry): string {
  return entry.name
    ? `${entry.role} ${quoted(entry.name)} [${entry.ref}]`
    : `${entry.role} [${entry.ref}]`;
}

function clip(text: string, max = NOTICE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The longest control name the captain's line quotes. */
const DID_NAME_MAX = 40;

/** A control in the captain's line: its name quoted, or its kind. */
function nameOf(entry: RefEntry): string {
  return entry.name ? quoted(clip(entry.name, DID_NAME_MAX)) : `a ${entry.role || "control"}`;
}

function sameSize(a: HostBrowserViewport, b: HostBrowserViewport): boolean {
  return a.width === b.width && a.height === b.height;
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

/** An address's origin (`http://127.0.0.1:5173`), or nothing for one with none of its own. */
function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Whether a browser holds anything of a site's sign-in: a cookie, or page storage. */
function holds(held: HeldSignIn): boolean {
  return held.cookies.length > 0 || held.storage.length > 0;
}

/** The site a crewmate named, as `siteOf` would read it: its host and port, lower case. */
function siteNamed(named: string): string {
  const text = named.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return new URL(text).host;
  } catch {
    // Not an address: the words as they are.
  }
  return text.replace(/\/+$/, "");
}

/** Where the crewmate went, in the captain's line: a path on the same site, else the site too. */
function openedWords(url: URL, site: string | undefined): string {
  const path = `${url.pathname}${url.search}`;
  const where = path === "/" ? "" : clip(path, DID_NAME_MAX);
  if (site === undefined || site === url.host) return `opened ${where || "the page"}`;
  return `opened ${url.host}${where}`;
}

/**
 * An address without its query and fragment, where a site keeps tokens
 * and codes: how a browser that may hold the captain's sign-in passes an
 * address on (docs/task-browser.md, "A signed-in page").
 */
function bareAddress(url: string): string {
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

/** The page's place as the crewmate names it, from 1. */
const PAGE_WORDS = ["", "first", "second"];

/** A picture's file name from the crewmate's own: letters, digits and dashes. */
export function captureFileName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\.png$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base ? `${base}.png` : undefined;
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
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly timer: (ms: number, fn: () => void) => () => void;

  constructor(private readonly options: TaskBrowsersOptions) {
    this.max = options.max ?? TASK_BROWSERS_MAX;
    this.idleMs = options.idleMs ?? TASK_BROWSER_IDLE_MS;
    this.timer = options.timer ?? defaultTimer;
    this.session = options.session ?? randomUUID();
  }

  /** How many task browsers run now. */
  get openCount(): number {
    return this.browsers.size;
  }

  isOpen(taskId: string): boolean {
    return this.browsers.has(taskId);
  }

  /** One task's browser as the captain reads it; absent while it never had one. */
  fact(taskId: string): TaskBrowserFact | undefined {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.ended.get(taskId);
    const url = this.addressOf(browser, browser.current);
    const many = browser.pages.length > 1;
    return {
      state: "open",
      site: siteOf(url),
      url,
      title: browser.current.page.title().trim(),
      ...(many
        ? {
            pages: browser.pages.map((entry) => ({
              site: siteOf(this.addressOf(browser, entry)),
              title: entry.page.title().trim(),
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
        ? { saved: [...browser.saved.keys()].slice(-SAVED_SIGN_INS_PER_BROWSER) }
        : {}),
      session: this.session,
      generation: browser.generation,
    };
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
    return this.serial(taskId, () => this.reopenNow(taskId));
  }

  /**
   * The browser one task's crewmate drives. Each command asks, as it starts,
   * whether the captain holds the browser, so a command queued behind the
   * one running when he took it refuses too.
   */
  forTask(taskId: string): CrewmateBrowser {
    return {
      navigate: (input) =>
        this.serial(taskId, async () => this.held(taskId) ?? this.navigate(taskId, input)),
      inspect: (input) =>
        this.serial(taskId, async () => this.held(taskId) ?? this.inspect(taskId, input)),
      act: (input) => this.serial(taskId, async () => this.held(taskId) ?? this.act(taskId, input)),
      capture: (input) =>
        this.serial(taskId, async () => this.held(taskId) ?? this.capture(taskId, input)),
      // A crewmate whose request still waits may withdraw it by closing.
      close: (input) =>
        this.serial(
          taskId,
          async () =>
            this.held(taskId, { waiting: false }) ?? this.closeByCrewmate(taskId, input?.page),
        ),
      pages: () => this.serial(taskId, async () => this.held(taskId) ?? this.pagesOf(taskId)),
    };
  }

  // ---- the handoff -------------------------------------------------------

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
    const site = siteOf(this.addressOf(browser, browser.current));
    if (siteNamed(request.site) !== site.toLowerCase()) {
      return {
        ok: false,
        text: `browser_handoff names ${request.site}, but this task's browser is on ${site}. Name the site it is on.`,
      };
    }
    const asked = browser.control === "crewmate";
    browser.control = "waiting";
    browser.request = { reason: request.reason, after: request.after };
    browser.cancelIdle?.();
    browser.cancelIdle = undefined;
    if (asked) this.options.note?.(taskId, `asked you to take over its browser at ${site}`);
    this.options.onChange?.(taskId);
    await this.serial(taskId, async () => undefined);
    return { ok: true, handle: { session: this.session, generation: browser.generation } };
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
    return this.serial(taskId, async () => {
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before you had control." };
      }
      if (browser.control === "captain") return { ok: true };
      browser.control = "captain";
      this.forget(browser);
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
    return this.serial(taskId, async () => {
      if (this.browsers.get(taskId) !== browser || browser.control !== "captain") {
        return { ok: false, text: "This browser stopped before control went back." };
      }
      // A reload or a sign-in's redirect the captain started is his: the
      // crewmate's first look is of the page it ends on.
      await browser.current.page.settle().catch(() => undefined);
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before control went back." };
      }
      // The captain's tick saves the site's sign-in on this Mac, before the
      // crewmate has the page; nothing is saved without it.
      if (options.remember) await this.rememberSignIn(browser);
      const after = browser.request?.after;
      browser.control = "crewmate";
      browser.request = undefined;
      this.handBackBooks(taskId, browser);
      this.forget(browser);
      browser.returns += 1;
      browser.did = FRESH_LOOK_WORDS;
      browser.freshLook = true;
      browser.notice =
        "The captain returned control of this browser: this is a fresh look at the page as it is now, and refs from before are gone.";
      this.touch(taskId, browser);
      this.options.note?.(taskId, "you returned control of its browser");
      this.options.onChange?.(taskId);
      this.options.onReturned?.(taskId, {
        site: siteOf(this.addressOf(browser, browser.current)),
        ...(after ? { after } : {}),
        once: `browser-returned:${this.session}:${browser.generation}:${browser.returns}`,
      });
      return { ok: true };
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

  // ---- a page from the project -------------------------------------------

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
      return this.serial(taskId, () => this.loadPage(taskId, open, page));
    }
    return this.serial(taskId, async () => {
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

  /** Serves a project folder, or nothing when the server could not start. */
  private async serveFolder(folder: string): Promise<ProjectServer | undefined> {
    try {
      return await (this.options.serve ?? serveProjectFolder)(folder);
    } catch {
      return undefined;
    }
  }

  /** Loads a project page in a browser the captain holds, serving its folder. */
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
    await this.loadOwn(entry, entry.page.load(url));
    this.options.onChange?.(taskId);
    return { ok: true, handle: { session: this.session, generation: browser.generation } };
  }

  // ---- saved sign-ins ----------------------------------------------------

  /** The website sign-ins saved on this Mac, by site, as Settings lists them. */
  savedSignIns(): SavedSignIn[] {
    return this.options.signIns?.list() ?? [];
  }

  /**
   * The saved sign-in a request card may offer (docs/task-browser.md, "Saved
   * sign-ins"): the one for the site the task's browser is on, while that
   * browser holds nothing of the captain's yet - neither a page the captain
   * handed back nor a saved sign-in already in use. Otherwise nothing, so a
   * site that turned a copied sign-in away leaves the captain to sign in.
   */
  savedSignInFor(taskId: string, site: string): SavedSignIn | undefined {
    const offer = offeredSignIn(this.fact(taskId), site, this.options.signIns, this.now());
    return offer ? { site: offer.record.site, savedAt: offer.record.savedAt } : undefined;
  }

  /**
   * The captain's click on a request card's saved sign-in: the site's saved
   * cookies and its page's own storage are copied into the browser the card
   * names, its page reloads with them, and the browser goes back to its
   * crewmate, woken once to take a fresh look. It grants the task that one
   * site, never authority to spend. Refused in words unless that browser still waits for the
   * captain on a site with a saved sign-in.
   */
  async grantSavedSignIn(
    taskId: string,
    handle: TaskBrowserHandle,
  ): Promise<TaskBrowserCommandResult> {
    const browser = this.browsers.get(taskId);
    if (!browser || !this.isHandled(browser, handle)) {
      return {
        ok: false,
        text: "This browser is no longer running, so it cannot use your saved sign-in.",
      };
    }
    return this.serial(taskId, async () => {
      if (this.browsers.get(taskId) !== browser || browser.control !== "waiting") {
        return { ok: false, text: "This browser is no longer waiting for your sign-in." };
      }
      const entry = browser.current;
      const site = siteOf(this.addressOf(browser, entry));
      const record = this.options.signIns?.get(site);
      const usable = record ? this.usable(record, this.addressOf(browser, entry)) : undefined;
      if (!record || !usable || !holds(usable)) {
        return { ok: false, text: `No sign-in for ${site} is saved on ${HERE.this}.` };
      }
      try {
        await entry.page.cookies.set(usable.cookies);
        // The page takes its own origin's storage alone, and refuses once it moved on.
        for (const storage of usable.storage) await entry.page.storage.write(storage);
      } catch {
        return { ok: false, text: `${HERE.This} could not use your saved sign-in right now.` };
      }
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before it could use your saved sign-in." };
      }
      const after = browser.request?.after;
      browser.saved.set(signInSite(site), record.id);
      browser.control = "crewmate";
      browser.request = undefined;
      // The site reads its sign-in on the next load: the page reloads with
      // it, unless it answers a form, which a reload would send again.
      const reloaded = await this.loadOwn(entry, entry.page.reload()).catch(() => undefined);
      const resent = reloaded?.ok === false && reloaded.code === FORM_RESEND;
      if (this.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before it could use your saved sign-in." };
      }
      this.handBackBooks(taskId, browser);
      this.forget(browser);
      browser.did = FRESH_LOOK_WORDS;
      browser.freshLook = true;
      browser.notice = resent
        ? `The captain let this task use the sign-in saved for ${site} on ${HERE.this}. The page answers a form that was sent, so it was not reloaded and may not show the sign-in yet: open the site's address with ${browserCommand("open <url>")} to see it signed in. Refs from before are gone.`
        : `The captain let this task use the sign-in saved for ${site} on ${HERE.this}, and the page reloaded with it: this is a fresh look at the page as it is now, and refs from before are gone.`;
      this.touch(taskId, browser);
      this.options.note?.(taskId, `you let it use your saved sign-in at ${site}`);
      this.options.onChange?.(taskId);
      this.options.onReturned?.(taskId, {
        site,
        ...(after ? { after } : {}),
        saved: true,
        once: `browser-saved-sign-in:${this.session}:${browser.generation}:${signInSite(site)}`,
      });
      return { ok: true };
    });
  }

  /**
   * The captain's Remove in Settings: the site's saved sign-in goes from
   * this Mac, and every browser using it is signed out of that site at
   * once - its cookies there and its own origins' page storage go, and
   * nothing is copied back - and its crewmate is told on its next command.
   */
  async removeSavedSignIn(site: string): Promise<TaskBrowserCommandResult> {
    const key = signInSite(site);
    const removed = this.options.signIns?.remove(key) ?? false;
    const using = [...this.browsers].filter(([, browser]) => browser.saved.has(key));
    for (const [taskId, browser] of using) {
      browser.saved.delete(key);
      try {
        const first = browser.pages[0]?.page;
        const cookies = await first?.cookies.all();
        if (cookies) await first?.cookies.remove(cookiesOfSite(cookies, key));
        for (const origin of siteOrigins(key)) await first?.storage.clear(origin);
      } catch {
        // A browser that stopped meanwhile has nothing left to sign out.
      }
      if (this.browsers.get(taskId) === browser) {
        browser.notice = `${browser.notice ? `${browser.notice} ` : ""}The captain removed the sign-in saved for ${key} from ${HERE.this}, so this browser is no longer signed in there. Reload the page to see it signed out, and ask on a card if the task still needs that site.`;
        this.options.note?.(
          taskId,
          `your saved sign-in at ${key} was removed, and its browser signed out of it`,
        );
        this.options.onChange?.(taskId);
      }
    }
    if (!removed && using.length === 0) {
      return { ok: false, text: `No sign-in for ${key} is saved on ${HERE.this}.` };
    }
    return { ok: true };
  }

  /**
   * Save the current page's site's sign-in from this browser: the captain's
   * tick on Return control. The browser uses that save from then on, and
   * copies back into it when it stops. A site that holds neither cookies
   * nor page storage saves nothing.
   */
  private async rememberSignIn(browser: Browser): Promise<void> {
    const store = this.options.signIns;
    if (!store) return;
    const site = signInSite(siteOf(this.addressOf(browser, browser.current)));
    try {
      const held: HeldSignIn = {
        cookies: cookiesOfSite(await browser.current.page.cookies.all(), site),
        storage: storageOfSite(await this.storageOn(browser, new Set([site])), site),
      };
      if (!holds(held)) return;
      const record = store.save(site, held);
      browser.saved.set(site, record.id);
    } catch {
      // A page that went away keeps nothing to save.
    }
  }

  /**
   * Copy each saved sign-in a stopping browser uses back into its save, so
   * a session the site refreshed stays current: the site's cookies, and the
   * page storage of each of its origins a page is on now. A save the
   * captain removed or replaced since is left alone, and what the site
   * holds nothing of now copies nothing back over the save it came from.
   */
  private async copyBack(browser: Browser): Promise<void> {
    const store = this.options.signIns;
    if (!store || browser.saved.size === 0) return;
    const first = browser.pages[0]?.page;
    if (!first) return;
    const cookies = await first.cookies.all();
    const storage = await this.storageOn(browser, new Set(browser.saved.keys()));
    for (const [site, id] of browser.saved) {
      const held = { cookies: cookiesOfSite(cookies, site), storage: storageOfSite(storage, site) };
      if (holds(held)) store.refresh(site, id, held);
    }
  }

  /**
   * What of a saved sign-in a browser's page can use now: its cookies still
   * alive, and the page storage of the very origin the page is on, since a
   * page takes its own origin's storage alone.
   */
  private usable(record: SavedSignInRecord, address: string): HeldSignIn {
    return usableSignIn(record, address, this.now());
  }

  /**
   * The page storage a browser's pages on these sites hold for their own
   * origins, one per origin, the current page's first. A page on any other
   * site is never read.
   */
  private async storageOn(browser: Browser, sites: Set<string>): Promise<HostOriginStorage[]> {
    const held = new Map<string, HostOriginStorage>();
    for (const entry of new Set([browser.current, ...browser.pages])) {
      if (!sites.has(signInSite(siteOf(this.addressOf(browser, entry))))) continue;
      const storage = await entry.page.storage.read().catch(() => undefined);
      if (storage && !held.has(storage.origin)) held.set(storage.origin, storage);
    }
    return [...held.values()];
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** A command's refusal while the captain holds the browser, or nothing. */
  private held(taskId: string, options?: { waiting: boolean }): BrowserAnswer | undefined {
    const control = this.browsers.get(taskId)?.control;
    if (control === undefined || control === "crewmate") return undefined;
    if (control === "waiting") {
      if (options?.waiting === false) return undefined;
      return refused(
        `You asked the captain to take over this task's browser, so it is paused: your browser commands refuse until the captain takes control and returns it, and then you are woken once to take a fresh look. Do other work that does not need the browser, or end your turn. ${browserCommand("stop")} withdraws the request and stops the browser.`,
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
    browser.blocked.clear();
    browser.tunnels.clear();
    browser.dialogs.length = 0;
    browser.errors.length = 0;
    browser.popups.length = 0;
    browser.refusals.length = 0;
    browser.pageNotes.length = 0;
    browser.dropped = 0;
    for (const entry of browser.pages) {
      entry.diagnostics.clear();
      entry.moved = undefined;
      entry.answered = undefined;
    }
  }

  /** The task closed: its browser goes, with nothing kept and nothing to tell. */
  closeTask(taskId: string, options: { gone?: boolean } = {}): void {
    // A page from the project the captain opened is his own: the task's
    // close leaves it running, and only the task's removal stops it.
    if (this.browsers.get(taskId)?.captains && !options.gone) return;
    if (this.browsers.has(taskId)) this.stop(taskId, "task-closed");
    else {
      const ended = this.ended.get(taskId);
      if (ended && ended.stopped !== "task-closed") {
        this.ended.set(taskId, { ...ended, stopped: "task-closed" });
        this.options.onChange?.(taskId);
      }
    }
    this.stopped.delete(taskId);
  }

  /** The app quits: every task browser goes. */
  closeAll(): void {
    for (const taskId of [...this.browsers.keys()]) this.stop(taskId);
  }

  // ---- commands ----------------------------------------------------------

  private async navigate(taskId: string, input: BrowserNavigateInput): Promise<BrowserAnswer> {
    const given = [input.url, input.go, input.page].filter((value) => value !== undefined).length;
    if (given !== 1) {
      return invalid(
        given === 0
          ? "Give url to open a page, go to move back, forward or reload, or page to switch to another of this browser's pages."
          : "Give one of url, go or page - not more than one.",
      );
    }
    if (input.page !== undefined) {
      const browser = this.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      const entry = browser.pages[input.page - 1];
      if (!entry) {
        return refused(
          `This browser has ${browser.pages.length === 1 ? "one page" : `${browser.pages.length} pages`}, so there is no page ${input.page}. ${this.pagesLine(browser)}`,
        );
      }
      const place = input.page;
      browser.did = `switched to ${siteOf(this.addressOf(browser, entry))}`;
      return this.guarded(taskId, browser, "switch pages", async () => {
        this.select(taskId, browser, entry);
        return this.answer(browser, `Switched to page ${place}.`);
      });
    }
    if (input.go !== undefined) {
      const browser = this.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      const go = input.go;
      const entry = browser.current;
      browser.did = go === "reload" ? "reloaded the page" : `went ${go}`;
      return this.guarded(taskId, browser, "move the page", async () => {
        const outcome = await this.loadOwn(
          entry,
          go === "reload" ? entry.page.reload() : entry.page.history(go),
        );
        if (!outcome.ok && outcome.code === FORM_RESEND) browser.did = "did not resend a form";
        const done = go === "reload" ? "Reloaded the page." : `Went ${go}.`;
        return this.answer(browser, this.loadLead(browser, outcome, done, entry.page.url()));
      });
    }
    const check = checkOpenable(input.url as string);
    if (!check.ok) return refused(check.reason);
    let browser = this.browsers.get(taskId);
    // The site the captain already reads, when this page is on another one.
    const site = browser ? siteOf(this.addressOf(browser, browser.current)) : undefined;
    let fresh = "";
    if (!browser) {
      if (this.browsers.size >= this.max) {
        return refused(
          `${NUMBER_WORDS[this.max] ?? this.max} task browsers are already open on ${HERE.this}, the most it runs at once. This task's opens once one of them closes: try again later, or carry on without it.`,
        );
      }
      const why = this.stopped.get(taskId);
      browser = await this.start(
        taskId,
        check.url.href,
        `opened its browser at ${check.url.origin}`,
      );
      if (!browser)
        return refused(`${HERE.This} could not open a browser for this task right now.`);
      this.stopped.delete(taskId);
      fresh = why
        ? `Your earlier browser ${why}, so this is a fresh one with nothing signed in. `
        : "";
    }
    browser.did = openedWords(check.url, site);
    // A page on this Mac is reachable once opened; a public website always is.
    if (check.origin) browser.origins.add(check.origin);
    const opened = browser;
    const entry = opened.current;
    const href = check.url.href;
    return this.guarded(taskId, opened, "load the page", async () => {
      const outcome = await this.loadOwn(entry, entry.page.load(href));
      return this.answer(
        opened,
        `${fresh}${this.loadLead(opened, outcome, `Opened ${href}.`, href)}`,
      );
    });
  }

  private async inspect(taskId: string, input: BrowserInspectInput): Promise<BrowserAnswer> {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.noBrowser(taskId);
    if (input.show) {
      if (
        input.ref !== undefined ||
        input.find !== undefined ||
        input.from !== undefined ||
        input.waitFor !== undefined
      ) {
        return invalid(
          "Give show alone to read console or network, without outline search, lines, ref or wait.",
        );
      }
      const show = input.show;
      browser.did = `read the ${show} list`;
      return this.guarded(taskId, browser, "read diagnostics", async () => {
        const signedIn = this.signedIn(browser);
        const text = browser.current.diagnostics.read(show, signedIn);
        const head = this.pageHead(browser);
        const notice = this.takeNotice(browser).trim();
        const did = `Read the ${show} list.`;
        return {
          text: [
            ...head.lines,
            `refs: g${browser.current.refs.number}`,
            `did: ${did}`,
            notice,
            text,
          ]
            .filter(Boolean)
            .join("\n"),
          page: this.factsOf(browser, did, 0),
          body: [head.also, notice].filter(Boolean).join("\n"),
          diagnostics: browser.current.diagnostics.list(show, signedIn),
        };
      });
    }
    const waitFor = input.waitFor?.trim();
    const ref = input.ref?.trim();
    const find = input.find?.trim();
    const from = input.from !== undefined && input.from >= 1 ? Math.floor(input.from) : undefined;
    if (input.full && (find || waitFor || ref)) {
      return invalid(
        "A full read shows every line from the top or from a line; it takes no words or ref.",
      );
    }
    // Its first read after the captain handed the page back is its fresh look.
    browser.did = browser.freshLook
      ? FRESH_LOOK_WORDS
      : waitFor
        ? `waited for ${quoted(clip(waitFor, DID_NAME_MAX))}`
        : ref
          ? "read a passage"
          : find
            ? `looked for ${quoted(clip(find, DID_NAME_MAX))}`
            : from
              ? `read from line ${from}`
              : "read the page";
    // Which part of the page the answer shows: around the words, from a line, or the top.
    const full = input.full === true ? { full: true as const } : {};
    const asked: WindowAsk = find
      ? { kind: "find", words: find, ...(from ? { from } : {}) }
      : from
        ? { kind: "from", line: from, ...full }
        : { kind: "top", ...full };
    return this.guarded(taskId, browser, "read the page", async () => {
      if (waitFor) {
        const wanted = waitFor.toLowerCase();
        const polls = Math.ceil(TASK_BROWSER_WAIT_MS / WAIT_POLL_MS);
        let found = false;
        for (let poll = 0; poll <= polls; poll += 1) {
          const entry = browser.current;
          const outline = outlinePage(
            await entry.page.nodes(),
            entry.refs,
            this.outlineOptions(browser),
          );
          if (outline.words.toLowerCase().includes(wanted)) {
            found = true;
            break;
          }
          if (poll < polls) await this.sleep(WAIT_POLL_MS);
        }
        if (!found) {
          return this.answer(
            browser,
            `Waited ${TASK_BROWSER_WAIT_MS / 1000} seconds; ${quoted(waitFor)} did not appear.`,
            asked,
          );
        }
        // The answer shows the part that holds the words, not the top again.
        if (!ref) {
          return this.answer(browser, "", {
            kind: "find",
            words: waitFor,
            ...(from ? { from } : {}),
          });
        }
      }
      if (ref) return this.readPassage(taskId, browser, ref);
      return this.answer(browser, "", asked);
    });
  }

  private async act(taskId: string, input: BrowserActInput): Promise<BrowserAnswer> {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.noBrowser(taskId);
    const actedPage = browser.current;
    const page = actedPage.page;
    const needsRef = ["click", "type", "select", "set", "hover", "drag"].includes(input.action);
    if (needsRef && !input.ref)
      return invalid(`${input.action} needs the ref of what to ${input.action}.`);
    let entry: RefEntry | undefined;
    // The book the ref came from: what the crewmate types is noted there, and goes with it.
    const refs = browser.current.refs;
    if (input.ref) {
      entry = refs.resolve(input.ref);
      if (!entry) return refused(this.refusedRef(taskId, browser, input.ref));
    }
    let destination: RefEntry | undefined;
    if (input.action === "drag") {
      if (!input.to) return invalid("drag needs to: the destination element's ref.");
      destination = refs.resolve(input.to);
      if (!destination) return refused(this.refusedRef(taskId, browser, input.to));
    }
    const fields: { entry: RefEntry; text: string }[] = [];
    if (input.action === "fill") {
      if (!input.fields?.length || input.fields.length > 50)
        return invalid(
          "fill needs fields: between 1 and 50 fields, each with ref and text. It never submits a form.",
        );
      // Resolve every ref before sending any input, so a stale later field changes nothing.
      for (const field of input.fields) {
        const target = refs.resolve(field.ref);
        if (!target) return refused(this.refusedRef(taskId, browser, field.ref));
        if (typeof field.text !== "string")
          return invalid("Each field needs text; empty text clears it.");
        fields.push({ entry: target, text: field.text });
      }
    }
    return this.guarded(taskId, browser, `${input.action} on the page`, async () => {
      const gone = (): BrowserAnswer =>
        refused(
          `${entry ? labelOf(entry) : "That element"} is not on the page now (hidden or removed); run ${browserCommand("snapshot")} to see the page as it is.`,
        );
      let lead: string;
      const before = { url: page.url(), title: page.title() };
      switch (input.action) {
        case "hover": {
          const target = entry as RefEntry;
          const box = await page.box(target.target);
          if (!box) return gone();
          browser.did = `hovered over ${nameOf(target)}`;
          await page.hover({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
          lead = `Hovered over ${labelOf(target)}.`;
          break;
        }
        case "drag": {
          const target = entry as RefEntry;
          const to = destination as RefEntry;
          if (!(await page.drag(target.target, to.target)))
            return refused(
              `Did not drag: both elements must be visible together. Read the page with ${browserCommand("snapshot")}.`,
            );
          browser.did = `dragged ${nameOf(target)} onto ${nameOf(to)}`;
          lead = `Dragged ${labelOf(target)} onto ${labelOf(to)}.`;
          break;
        }
        case "fill": {
          const nodes = await page.nodes();
          for (const field of fields) {
            const node = nodes.find((node) => node.target === field.entry.target);
            if (
              !node ||
              !(
                node.properties.editable ||
                ["textbox", "searchbox", "spinbutton"].includes(node.role)
              )
            )
              return refused(
                `${labelOf(field.entry)} is not an editable text field; no fields were filled.`,
              );
          }
          // Preflight visibility; no input is sent when a field is absent.
          for (const field of fields) {
            if (!(await page.box(field.entry.target)))
              return refused(
                `${labelOf(field.entry)} is not on the page now; no fields were filled.`,
              );
          }
          browser.did = `filled ${fields.length} fields`;
          let filled = 0;
          for (const field of fields) {
            if (
              browser.current !== actedPage ||
              browser.current.refs !== refs ||
              page.url() !== before.url
            )
              return this.answer(
                browser,
                `Stopped after filling ${filled} fields: the page moved. Read it before filling more.`,
              );
            if (!(await page.box(field.entry.target)))
              return this.answer(
                browser,
                `Stopped after filling ${filled} fields: ${labelOf(field.entry)} is no longer visible.`,
              );
            await page.focus(field.entry.target, { selectAll: true });
            if (field.text) await page.insertText(field.text);
            else await page.press("Backspace");
            refs.noteTyped(field.entry.target, field.text);
            filled++;
          }
          lead = `Filled ${filled} fields without submitting a form.`;
          break;
        }
        case "click": {
          const target = entry as RefEntry;
          const clicked = await this.clickAt(browser, page, target.target, () => {
            browser.did = `clicked ${nameOf(target)}`;
          });
          if (!clicked) return gone();
          lead = `Clicked ${labelOf(target)}.`;
          break;
        }
        case "set":
        case "type": {
          const target = entry as RefEntry;
          if (input.text === undefined)
            return invalid(`${input.action} needs text: what to enter.`);
          const text = input.text;
          // A list takes the option of that label; anything else is typed into.
          if (input.action === "set" && text) {
            const chosen = await page.choose(target.target, text);
            if (chosen.kind === "no-match") {
              return refused(
                `${labelOf(target)} has no option ${quoted(text)}. Its options: ${chosen.options.map(quoted).join(", ") || "none"}.`,
              );
            }
            if (chosen.kind === "chosen") {
              browser.did = `chose ${quoted(clip(text, DID_NAME_MAX))} in ${nameOf(target)}`;
              lead = `Chose ${quoted(text)} in ${labelOf(target)}.`;
              break;
            }
          }
          const clicked = await this.clickAt(browser, page, target.target, () => {
            // What was typed never reaches the captain's line, only where.
            browser.did = `${text ? "typed into" : "cleared"} ${nameOf(target)}${input.submit ? " and pressed Enter" : ""}`;
            refs.noteTyped(target.target, text);
          });
          if (!clicked) return gone();
          await page.focus(target.target, { selectAll: true });
          if (text) await page.insertText(text);
          else await page.press("Backspace");
          if (input.submit) await page.press("Enter");
          lead = text
            ? `Typed into ${labelOf(target)}${input.submit ? " and pressed Enter" : ""}.`
            : `Cleared ${labelOf(target)}${input.submit ? " and pressed Enter" : ""}.`;
          break;
        }
        case "select": {
          const target = entry as RefEntry;
          if (!input.option)
            return invalid("select needs option: the label of the option to choose.");
          const chosen = await page.choose(target.target, input.option);
          if (chosen.kind === "not-a-list") {
            return refused(
              `${labelOf(target)} is not a list of options; click it, then click the option you want.`,
            );
          }
          if (chosen.kind === "no-match") {
            return refused(
              `${labelOf(target)} has no option ${quoted(input.option)}. Its options: ${chosen.options.map(quoted).join(", ") || "none"}.`,
            );
          }
          browser.did = `chose ${quoted(clip(input.option, DID_NAME_MAX))} in ${nameOf(target)}`;
          lead = `Chose ${quoted(input.option)} in ${labelOf(target)}.`;
          break;
        }
        case "press": {
          const key = BROWSER_KEYS.find(
            (known) => known.toLowerCase() === input.key?.toLowerCase(),
          );
          if (!key) return invalid(`press needs key, one of: ${BROWSER_KEYS.join(", ")}.`);
          browser.did = `pressed ${key}`;
          if (entry) await page.focus(entry.target);
          await page.press(key as BrowserKey);
          lead = entry ? `Pressed ${key} on ${labelOf(entry)}.` : `Pressed ${key}.`;
          break;
        }
        case "scroll": {
          if (entry) {
            if (!(await page.box(entry.target))) return gone();
            browser.did = `scrolled to ${nameOf(entry)}`;
            lead = `Scrolled ${labelOf(entry)} into view.`;
            break;
          }
          if (!["up", "down", "top", "bottom"].includes(input.direction ?? "")) {
            return invalid(
              "scroll needs a ref to bring into view, or direction up, down, top or bottom.",
            );
          }
          browser.did = `scrolled ${input.direction}`;
          await page.scroll(input.direction as "up" | "down" | "top" | "bottom");
          lead = `Scrolled ${input.direction}.`;
          break;
        }
        default:
          return invalid(
            "action is one of click, type, select, set, press, scroll, hover, fill or drag.",
          );
      }
      await this.awaitAction(page, before, input, entry);
      // A scroll answers with what the page's window shows now.
      return this.answer(browser, lead, input.action === "scroll" ? { kind: "screen" } : TOP, {
        entry: actedPage,
        refs,
      });
    });
  }

  private async capture(taskId: string, input: BrowserCaptureInput): Promise<BrowserAnswer> {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.noBrowser(taskId);
    let entry: RefEntry | undefined;
    if (input.ref) {
      if (input.fullPage) return invalid("Give an element's ref or the whole page, not both.");
      entry = browser.current.refs.resolve(input.ref);
      if (!entry) return refused(this.refusedRef(taskId, browser, input.ref));
    }
    // A page that may show the captain's account is photographed only for a
    // reason the task has, and his record says so (docs/task-browser.md,
    // "A signed-in page").
    const reason = input.reason?.trim();
    if (this.signedIn(browser) && !reason) {
      const why =
        browser.returns > 0
          ? "The captain handed this browser back"
          : "This browser uses a sign-in the captain saved";
      return refused(
        `${why}, so its pages may show the captain's account: a picture is taken only when the task needs one. Run ${browserCommand("screenshot")} again with --reason, saying what the task needs this picture for, or read the page with ${browserCommand("snapshot")} instead.`,
      );
    }
    browser.did = input.fullPage === true ? "photographed the whole page" : "photographed the page";
    return this.guarded(taskId, browser, "photograph the page", async () => {
      if (this.signedIn(browser)) {
        // A picture would show the typed text the outline holds back.
        const { withheld } = outlinePage(
          await browser.current.page.nodes(),
          browser.current.refs,
          this.outlineOptions(browser),
        );
        if (withheld.length > 0) {
          browser.did = "did not photograph the page";
          return refused(
            `${this.takeNotice(browser)}Did not photograph the page: it holds text you did not type yourself since the captain handed it back, which may be theirs - ${clip(withheld.join(", "))}. A picture would show it. Read the page with ${browserCommand("snapshot")} instead, which says what is filled without its text, or ask the captain on a card.`,
          );
        }
      }
      const fullPage = input.fullPage === true;
      const shot = await browser.current.page.capture({
        fullPage,
        ...(entry ? { target: entry.target } : {}),
      });
      if (!shot)
        return refused(
          `Did not photograph: that element is hidden or removed. Read the page with ${browserCommand("snapshot")}.`,
        );
      const dir = this.options.evidenceDir(taskId);
      await mkdir(dir, { recursive: true });
      const path = await this.writePicture(dir, captureFileName(input.name), shot.png);
      const what = entry
        ? `the visible part of ${labelOf(entry)}`
        : fullPage
          ? "the whole page"
          : "the visible page";
      if (this.signedIn(browser) && reason) {
        this.options.note?.(
          taskId,
          `photographed its browser's page at ${siteOf(this.addressOf(browser, browser.current))} ${browser.returns > 0 ? "after you returned control" : "while it used your saved sign-in"}: ${clip(reason, CAPTURE_REASON_SHOWN)}`,
        );
      }
      const notice = this.takeNotice(browser);
      const did = `Saved ${what} as ${path} (${shot.width}×${shot.height}).`;
      return {
        text: `${notice}${did} A card can show it by this path. Page: ${this.pageLine(browser)}`,
        image: { data: Buffer.from(shot.png).toString("base64"), mimeType: "image/png" },
        page: this.factsOf(browser, did, 0),
        body: notice.trim(),
        picture: { path, width: shot.width, height: shot.height, what },
      };
    });
  }

  private async closeByCrewmate(taskId: string, page?: number): Promise<BrowserAnswer> {
    if (page !== undefined) {
      const browser = this.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      if (page === 1) {
        return refused(
          `Page 1 is this browser's own page. Run ${browserCommand("stop")} to stop the whole browser.`,
        );
      }
      const entry = browser.pages[page - 1];
      if (!entry) return refused(`There is no page ${page}. ${this.pagesLine(browser)}`);
      const site = siteOf(this.addressOf(browser, entry));
      browser.did = `closed the page at ${site}`;
      this.dropPage(taskId, browser, entry);
      try {
        entry.page.close();
      } catch {
        // A page that is already gone has nothing left to close.
      }
      return this.guarded(taskId, browser, "read the page", async () =>
        this.answer(browser, `Closed page ${page} (${site}); your commands act on page 1.`),
      );
    }
    if (!this.browsers.has(taskId)) {
      this.stopped.delete(taskId);
      return { text: "No browser is open for this task." };
    }
    this.stop(taskId, "crewmate");
    this.stopped.delete(taskId);
    return {
      text: `Stopped this task's browser: its pages, history and site data are gone. ${browserCommand("open <url>")} opens a fresh one.`,
    };
  }

  /** Every page the browser holds, as the crewmate reads their addresses. */
  private async pagesOf(taskId: string): Promise<BrowserAnswer> {
    const browser = this.browsers.get(taskId);
    if (!browser) return this.noBrowser(taskId);
    const pages = browser.pages.map((entry, index) => ({
      place: index + 1,
      title: entry.page.title().trim(),
      url: this.shown(browser, this.addressOf(browser, entry)),
      current: entry === browser.current,
    }));
    return {
      text: `${browser.pages.length === 1 ? "One page is open" : `${browser.pages.length} pages are open`}; your commands act on page ${browser.pages.indexOf(browser.current) + 1}. ${this.pagesLine(browser)}`,
      pages,
    };
  }

  // ---- lifecycle ---------------------------------------------------------

  /** A fresh browser for the task, about to load `url`; `opened` is its timeline line. */
  private async start(
    taskId: string,
    url: string,
    opened: string,
    options: { captains?: boolean } = {},
  ): Promise<Browser | undefined> {
    const first: PageEntry = {
      diagnostics: new PageDiagnostics(),
      page: undefined as unknown as HostBrowserPage,
      refs: this.newBook(taskId),
      loading: false,
    };
    const browser: Browser = {
      pages: [first],
      size: this.pageSize(taskId),
      current: first,
      guard: undefined as unknown as ConnectionGuardHandle,
      firstUrl: url,
      generation: (this.generations.get(taskId) ?? 0) + 1,
      booksFrom: (this.books.get(taskId) ?? 0) + 1,
      origins: new Set(),
      blocked: new Map(),
      tunnels: new Map(),
      dialogs: [],
      errors: [],
      popups: [],
      refusals: [],
      pageNotes: [],
      dropped: 0,
      // His own from the start, before anything hears it opened.
      control: options.captains ? "captain" : "crewmate",
      returns: 0,
      saved: new Map(),
      ...(options.captains ? { captains: true as const } : {}),
    };
    // While the captain holds the page, what it says is his and is kept for nobody.
    const captains = (): boolean => browser.control === "captain";
    try {
      browser.guard = await (this.options.guard ?? startConnectionGuard)({
        onRefused: ({ host, kind }) => {
          if (captains()) return;
          browser.tunnels.set(host, kind);
          this.block(browser, host, kind);
        },
        ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      });
    } catch {
      return undefined;
    }
    let page: HostBrowserPage;
    try {
      page = await this.options.host.open({
        viewport: { ...browser.size },
        proxy: {
          host: browser.guard.host,
          port: browser.guard.port,
          username: browser.guard.username,
          password: browser.guard.password,
        },
        allow: ({ url }) => {
          const decision = decideRequest(url, browser.origins);
          if (decision.allowed) return true;
          if (!captains()) this.block(browser, decision.host, decision.kind);
          return false;
        },
        // A site's every picture may fail its certificate: it is said once.
        onRefused: (refusal) => {
          const words = refusalWords(refusal);
          if (!browser.refusals.includes(words)) this.keep(browser, browser.refusals, words);
        },
        ...this.pageEvents(taskId, browser, first),
      });
    } catch {
      browser.guard.close();
      return undefined;
    }
    first.page = page;
    this.generations.set(taskId, browser.generation);
    this.browsers.set(taskId, browser);
    // A view maximized or restored while it opened: the page follows.
    if (!sameSize(browser.size, this.pageSize(taskId))) this.resizePages(taskId);
    this.ended.delete(taskId);
    this.options.note?.(taskId, opened);
    // A view already watching this task sees the new page from its start.
    if (this.watchers.has(taskId)) this.startWatching(taskId, browser);
    this.options.onChange?.(taskId);
    return browser;
  }

  /** One page's doings, kept for the crewmate's next answer unless the captain holds the page. */
  private pageEvents(taskId: string, browser: Browser, entry: PageEntry): HostPageEvents {
    const live = (): boolean => this.browsers.get(taskId) === browser;
    return {
      onNavigated: (url) => {
        entry.refs = this.newBook(taskId);
        entry.answered = undefined;
        entry.lastUrl = url;
        if (!entry.loading && browser.control !== "captain") entry.moved = url;
        if (live()) this.options.onChange?.(taskId);
      },
      onConsole: (level, text) => {
        if (live() && browser.control === "crewmate")
          entry.diagnostics.log(level, text, this.signedIn(browser));
      },
      onNetwork: (event) => {
        if (live() && browser.control === "crewmate") entry.diagnostics.request(event);
      },
      onDialog: (kind, message) =>
        this.keep(browser, browser.dialogs, `${kind} ${quoted(clip(message))}`),
      onPopup: (url) => this.popup(taskId, browser, url),
      onPageError: (text) => {
        // A refused request or connection logs its own error; the summary already says it.
        // A signed-out site's own navigation payload 404 is noise, not the page's.
        if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED/.test(text)) return;
        if (isPageNoise(text)) return;
        this.keep(browser, browser.errors, text);
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
      this.keep(browser, browser.popups, url ? this.shown(browser, url) : "a blank page");
      return undefined;
    }
    if (url && url !== "about:blank") {
      const decision = decideRequest(url, browser.origins);
      if (!decision.allowed) {
        if (browser.control !== "captain") this.block(browser, decision.host, decision.kind);
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
        this.keep(
          browser,
          browser.pageNotes,
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
    const site = siteOf(this.addressOf(browser, entry));
    this.dropPage(taskId, browser, entry);
    this.keep(
      browser,
      browser.pageNotes,
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
    browser.cancelIdle?.();
    browser.stopWatching?.();
    browser.stopWatching = undefined;
    if (browser.server) {
      browser.server.close();
      if (why) {
        this.endedServers.set(taskId, {
          folder: browser.server.folder,
          origin: browser.server.origin,
          ...(browser.captains ? { captains: true as const } : {}),
        });
      }
    } else if (why) this.endedServers.delete(taskId);
    const close = (): void => {
      // A second page first; the first page's close ends the browser's site data.
      for (const entry of [...browser.pages].reverse()) {
        try {
          entry.page.close();
        } catch {
          // A page that is already gone has nothing left to close.
        }
      }
      browser.guard.close();
    };
    // A browser using a saved sign-in copies it back before its site data
    // goes, within a bound; the app's quit (no reason) closes at once.
    if (why && browser.saved.size > 0) {
      let closed = false;
      const once = (): void => {
        if (closed) return;
        closed = true;
        close();
      };
      const cancel = this.timer(COPY_BACK_MS, once);
      void this.copyBack(browser)
        .catch(() => undefined)
        .finally(() => {
          cancel();
          once();
        });
    } else {
      close();
    }
    if (why && fact) {
      this.ended.set(taskId, {
        state: "stopped",
        site: fact.site,
        // Open again starts fresh, so it carries nothing of a sign-in's address.
        url: this.signedIn(browser) ? bareAddress(fact.url) : fact.url,
        stopped: why,
        at: Date.now(),
        session: this.session,
        generation: browser.generation,
      });
      this.options.onChange?.(taskId);
    }
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
    const ended = this.ended.get(taskId);
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
    const check = checkOpenable(address);
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
    browser.notice = `${why ? `Your earlier browser ${why}. ` : ""}The captain opened this task's browser again at ${check.url.href}: a fresh one, with nothing signed in.`;
    this.touch(taskId, browser);
    const entry = browser.current;
    const outcome = await this.loadOwn(entry, entry.page.load(check.url.href));
    if (!outcome.ok) entry.moved = undefined;
    this.options.onChange?.(taskId);
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

  // ---- helpers -----------------------------------------------------------

  /** The size a task's pages lay out at: its maximized view's room, or the check's own. */
  private pageSize(taskId: string): HostBrowserViewport {
    const size = this.viewSizes.get(taskId)?.size ?? TASK_BROWSER_VIEWPORT;
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
    void this.steadily(browser, async () => {
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

  /**
   * Click a control at its place on the page, with no resize between
   * finding it and pressing it. `found` runs once it has a place, before
   * the press; false when it has none.
   */
  private clickAt(
    browser: Browser,
    page: HostBrowserPage,
    target: number,
    found: () => void,
  ): Promise<boolean> {
    return this.steadily(browser, async () => {
      const box = await page.box(target);
      if (!box) return false;
      found();
      await page.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      return true;
    });
  }

  /** One click or resize at a time per browser, in the order they came. */
  private steadily<T>(browser: Browser, run: () => Promise<T>): Promise<T> {
    const next = (browser.steady ?? Promise.resolve()).then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    browser.steady = settled;
    void settled.then(() => {
      if (browser.steady === settled) browser.steady = undefined;
    });
    return next;
  }

  /** One command at a time per task, in the order they came. */
  private serial<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const before = this.queues.get(taskId) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(taskId, settled);
    void settled.then(() => {
      if (this.queues.get(taskId) === settled) this.queues.delete(taskId);
    });
    return next;
  }

  /** Run a command within its bound, answering in words for a stuck page or a failed effect. */
  private async guarded(
    taskId: string,
    browser: Browser,
    what: string,
    run: () => Promise<BrowserAnswer>,
  ): Promise<BrowserAnswer> {
    this.touch(taskId, browser);
    // Whatever the crewmate does first after a handoff, it has looked anew.
    browser.freshLook = undefined;
    // The captain's line says what the crewmate is doing as it starts.
    this.options.onChange?.(taskId);
    let cancel: (() => void) | undefined;
    const bound = new Promise<never>((_, reject) => {
      cancel = this.timer(TASK_BROWSER_COMMAND_MS, () => reject(new BoundExceeded()));
    });
    const work = run();
    // A command past its bound may still settle; its outcome has no one left to tell.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, bound]);
    } catch (error) {
      if (this.browsers.get(taskId) !== browser) return this.noBrowser(taskId);
      if (error instanceof BoundExceeded) {
        return refused(
          `The browser did not ${what} within ${TASK_BROWSER_COMMAND_MS / 1000} seconds. The page may still be busy; run ${browserCommand("snapshot")} to see where it stands.`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return refused(`The browser could not ${what}: ${clip(message)}.`);
    } finally {
      cancel?.();
      if (this.browsers.get(taskId) === browser) this.options.onChange?.(taskId);
    }
  }

  /** What the crewmate is told once about its browser, at the head of an answer. */
  private takeNotice(browser: Browser): string {
    const notice = browser.notice;
    browser.notice = undefined;
    return notice ? `${notice}\n` : "";
  }

  private async loadOwn(
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

  private loadLead(browser: Browser, outcome: HostLoadOutcome, done: string, href: string): string {
    if (outcome.ok) {
      return outcome.status !== undefined && outcome.status >= 400
        ? `${done} The server answered ${outcome.status}.`
        : done;
    }
    const host = siteOf(href);
    const hostname = hostnameOf(href);
    if (/^ERR_CERT_|^ERR_SSL_/.test(outcome.code)) {
      // The lead says it; the refusals below need not say it again.
      const own = browser.refusals.filter((line) => !line.startsWith(`${host}:`));
      browser.refusals.splice(0, browser.refusals.length, ...own);
      return `${host}'s certificate did not verify (${outcome.code}), so the browser did not open it. It never goes past a certificate error; if the task needs this site, say so in your report.`;
    }
    const tunnel = browser.tunnels.get(hostname);
    if (tunnel) browser.blocked.delete(hostname);
    switch (outcome.code) {
      case "ERR_CONNECTION_REFUSED":
        return `Nothing answered at ${href}. Start the project's server first (in the background), then run ${browserCommand("open <url>")} again.`;
      case "ERR_TUNNEL_CONNECTION_FAILED":
      case "ERR_PROXY_CONNECTION_FAILED":
        switch (tunnel) {
          case "private":
            return `${host} leads to an address on ${HERE.this} or a private network, so the browser refused it at the connection. It reaches public websites and the pages on ${HERE.this} you open, never another device.`;
          case "unresolved":
            return `${host} was not found. Check the address.`;
          case "unreachable":
            return `${host} did not answer. Try again later, or carry on without it.`;
          default:
            return `The page did not load: the connection where it led was refused or failed (${outcome.code}).`;
        }
      case "ERR_BLOCKED_BY_CLIENT":
        return `The browser refused to load ${href}, or where it led: see what it blocked below.`;
      case "ERR_ABORTED":
        return "That load was replaced by another before it finished.";
      case "no-history":
        return "There is no page to go to in that direction.";
      // The browser never sends a form twice (docs/task-browser.md, "A final submission").
      case FORM_RESEND:
        return `Did not reload: this page is the answer to a form that was sent, and reloading it would send the form again. This browser never sends a form twice. Read the page again with ${browserCommand("snapshot")}, and to learn what became of what was sent, open the page where the site lists it, such as its orders or bookings.`;
      case "ERR_CACHE_MISS":
        return "That page was the answer to a form that was sent, and going to it again would send the form again, so the browser showed nothing: it never sends a form twice. Go the other way, or open the page where the site lists what was sent, such as its orders or bookings.";
      default:
        return `The page did not load (${outcome.code}).`;
    }
  }

  private noBrowser(taskId: string): BrowserAnswer {
    const why = this.stopped.get(taskId);
    return refused(
      why
        ? `This task's browser ${why}. Run ${browserCommand("open <url>")} to open a fresh one.`
        : `No browser is open for this task. Run ${browserCommand("open <url>")} to open one.`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer(ms, resolve);
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

  /**
   * A ref the current page's book does not hold, refused in words that say
   * where it came from: a page that moved or closed, the other page, before
   * a handback, an earlier browser. It is never used on another element.
   */
  private refusedRef(taskId: string, browser: Browser, ref: string): string {
    const parsed = parseRef(ref);
    const standing = ((): RefStanding => {
      if (!parsed) return { kind: "not-a-ref" };
      if (parsed.book === browser.current.refs.number) return { kind: "this-page" };
      const other = browser.pages.findIndex((entry) => entry.refs.number === parsed.book);
      if (other >= 0) {
        return {
          kind: "other-page",
          page: other + 1,
          current: browser.pages.indexOf(browser.current) + 1,
        };
      }
      if (parsed.book > (this.books.get(taskId) ?? 0)) return { kind: "unknown" };
      if (parsed.book < browser.booksFrom) return { kind: "earlier-browser" };
      if (browser.handedBackFrom !== undefined && parsed.book < browser.handedBackFrom) {
        return { kind: "handed-back" };
      }
      return { kind: "earlier-page" };
    })();
    return refusedRefWords(ref, standing);
  }

  /**
   * How many times to look for a same-document move. A link, Enter and a
   * submitted field look the longest; any other click looks too, so a move
   * that starts after the first moment is still the answer's page. Typing,
   * choosing and scrolling look once, and look further only if the address
   * or title has already changed.
   */
  private navPolls(input: BrowserActInput, entry?: RefEntry): number {
    if (
      (input.action === "click" && (entry?.role === "link" || entry?.role === "menuitem")) ||
      (input.action === "press" && input.key?.toLowerCase() === "enter") ||
      (input.action === "type" && input.submit === true)
    ) {
      return SOFT_NAV_POLLS;
    }
    // Any other click can open a page without a full load too, a little sooner.
    if (input.action === "click") return CLICK_NAV_POLLS;
    return 1;
  }

  /**
   * Wait for a same-document move to commit, then for the page to settle,
   * before the answer reads the address and the outline. A move that never
   * comes ends after its bound, so a click that only acts on this page does
   * not wait the whole bound.
   */
  private async awaitAction(
    page: HostBrowserPage,
    before: { url: string; title: string },
    input: BrowserActInput,
    entry: RefEntry | undefined,
  ): Promise<void> {
    const polls = this.navPolls(input, entry);
    const read = (fn: () => string): string => {
      try {
        return fn();
      } catch {
        // The page closed itself during the wait. The click already happened.
        return "";
      }
    };
    try {
      for (let poll = 0; poll < polls; poll += 1) {
        await this.sleep(poll === 0 && polls === 1 ? ACT_SETTLE_MS : WAIT_POLL_MS);
        const url = read(() => page.url());
        const title = read(() => page.title());
        // An empty address is a page that closed itself. The click already landed.
        if (url === "") return;
        if (url === before.url && title === before.title) continue;
        await page.settle();
        for (let quiet = 0; quiet < POST_NAV_POLLS; quiet += 1) await this.sleep(WAIT_POLL_MS);
        await page.settle();
        return;
      }
      await page.settle();
    } catch {
      // A page that closed itself has already been acted on.
    }
  }

  /** The full text of one outline line, still hiding what the captain typed. */
  private async readPassage(taskId: string, browser: Browser, ref: string): Promise<BrowserAnswer> {
    const entry = browser.current.refs.resolve(ref);
    if (!entry) return refused(this.refusedRef(taskId, browser, ref));
    const nodes = await browser.current.page.nodes();
    const node = nodes.find((item) => item.target === entry.target);
    if (!node) {
      return refused(
        `${labelOf(entry)} is not on the page now (hidden or removed); run ${browserCommand("snapshot")} to see the page as it is.`,
      );
    }
    const options = this.outlineOptions(browser);
    const passage = passageOf(node, browser.current.refs, options);
    if (passage.hidden) {
      return this.answer(browser, `${labelOf(entry)} ${HIDDEN_VALUE_WORDS}.`, {
        kind: "around",
        ref: entry.ref,
      });
    }
    const mark = marksById(nodes).get(node.id);
    const extra = [
      mark?.datetime ? `time: ${mark.datetime}` : undefined,
      mark?.title ? `title: ${quoted(mark.title)}` : undefined,
    ].filter((line): line is string => line !== undefined);
    const more = passage.omitted > 0 ? `\n(${passage.omitted} more characters not shown.)` : "";
    const lead = [
      `Full text of ${labelOf(entry)}:`,
      passage.text || "(This line has no text.)",
      ...extra,
    ].join("\n");
    return this.answer(browser, `${lead}${more}`, { kind: "around", ref: entry.ref });
  }

  /**
   * Whether the captain has handed this browser back since it opened: then
   * it may hold his sign-in, and it keeps only what the task needs.
   */
  private signedIn(browser: Browser): boolean {
    return browser.returns > 0 || browser.saved.size > 0;
  }

  /** An address as the crewmate reads it: without its query and fragment once signed in. */
  private shown(browser: Browser, url: string): string {
    return this.signedIn(browser) ? bareAddress(url) : url;
  }

  /** A page's address, or where the browser opened while its first page shows none. */
  private addressOf(browser: Browser, entry: PageEntry): string {
    const shown = entry.page.url();
    if (shown && shown !== "about:blank") return shown;
    if (entry.lastUrl) return entry.lastUrl;
    return entry === browser.pages[0] ? browser.firstUrl : shown || "about:blank";
  }

  private outlineOptions(browser: Browser): OutlineOptions {
    const signedIn = this.signedIn(browser);
    return {
      pageUrl: browser.current.page.url(),
      withholdQueries: signedIn,
      // What the captain typed - a card number, a code - stays on the page,
      // sent or not: the crewmate reads only the text it typed itself.
      typedOnly: signedIn,
    };
  }

  /** One page as the crewmate reads it: its title and address. */
  private entryLine(browser: Browser, entry: PageEntry): string {
    const title = entry.page.title().trim();
    return `${title ? `${quoted(title)} at ` : ""}${this.shown(browser, entry.page.url())}`;
  }

  private pageLine(browser: Browser): string {
    return this.entryLine(browser, browser.current);
  }

  /** Every page the browser holds, by its place, for a crewmate that named one it does not. */
  private pagesLine(browser: Browser): string {
    return `Its pages: ${browser.pages
      .map((entry, index) => `page ${index + 1}, ${this.entryLine(browser, entry)}`)
      .join("; ")}.`;
  }

  /**
   * The page the answer reads, and with two, which it is and what else is
   * open: its words, the page's place, and the line naming the others.
   */
  private pageHead(browser: Browser): {
    lines: string[];
    place?: { place: number; of: number };
    also?: string;
  } {
    if (browser.pages.length === 1) return { lines: [`Page: ${this.pageLine(browser)}`] };
    const place = browser.pages.indexOf(browser.current) + 1;
    const others = browser.pages
      .map((entry, index) =>
        entry === browser.current
          ? undefined
          : `page ${index + 1}, ${this.entryLine(browser, entry)}`,
      )
      .filter((line): line is string => line !== undefined);
    const also = `Also open: ${others.join("; ")}. ${browserCommand("selectpage <n>")} switches to it.`;
    return {
      lines: [`Page ${place} of ${browser.pages.length}: ${this.pageLine(browser)}`, also],
      place: { place, of: browser.pages.length },
      also,
    };
  }

  /**
   * The facts a page answer opens with, typed: the page, its ref book and,
   * where the answer read the outline, how many controls carry a ref; its
   * place among two, the errors it logged since the last answer and what
   * the command did. It reads nothing of the page itself, so it never
   * numbers a book the crewmate has not read.
   */
  private factsOf(
    browser: Browser,
    did: string,
    errors: number,
    controls?: number,
  ): BrowserPageFacts {
    const entry = browser.current;
    const head = this.pageHead(browser);
    return {
      title: entry.page.title().trim(),
      url: this.shown(browser, entry.page.url()),
      refs: entry.refs.number === undefined ? "none" : `g${entry.refs.number}`,
      ...(controls !== undefined ? { controls } : {}),
      ...(head.place ? { page: head.place } : {}),
      errors,
      did,
      ...(this.signedIn(browser) ? { signedIn: true as const } : {}),
    };
  }

  /**
   * The answer every command but capture ends with: the page, what it did,
   * and the window of its outline `ask` chooses (`window.ts`).
   */
  private async answer(
    browser: Browser,
    lead: string,
    ask: WindowAsk = TOP,
    action?: { entry: PageEntry; refs: RefBook },
  ): Promise<BrowserAnswer> {
    const notice = this.takeNotice(browser).trim();
    const entry = browser.current;
    const outline = outlinePage(await entry.page.nodes(), entry.refs, this.outlineOptions(browser));
    const window = windowOf(outline.lines, ask);
    const samePage = action?.entry === entry && action.refs === entry.refs;
    const head = this.pageHead(browser);
    const refs = entry.refs.number === undefined ? "none" : `g${entry.refs.number}`;
    const did = `${lead || "Read the page."}${action ? (samePage ? " The page did not move." : " The page changed; this is a fresh outline.") : ""}`;
    const facts = [...head.lines, `refs: ${refs}`, `did: ${did}`];
    const rest: string[] = [];
    if (notice) rest.push(notice);
    if (ask.kind === "find" && window.found) {
      // Words a wait saw that no line names, such as a list's option, are still on the page.
      rest.push(
        window.found.length === 0 && outline.words.toLowerCase().includes(ask.words.toLowerCase())
          ? `Found ${quoted(ask.words)} on the page.`
          : foundWords(ask.words, window.found, ask.from),
      );
    }
    // A second page opening or closing changes which page this answer reads.
    rest.push(...browser.pageNotes);
    browser.pageNotes.length = 0;
    // A new document the crewmate's own load did not ask for: a link, a form, a script.
    if (entry.moved) rest.push(`The page moved to ${this.shown(browser, entry.moved)}.`);
    entry.moved = undefined;
    const errors = browser.errors.length;
    rest.push(...this.drainNotices(browser));
    rest.push("");
    const previous = entry.answered;
    const shown =
      samePage && ask.kind !== "screen" && previous?.refs === entry.refs
        ? changesOf(previous.lines, outline.lines)
        : window;
    rest.push(...shown.lines);
    entry.answered = { refs: entry.refs, lines: outline.lines.map((line) => line.text) };
    const withheld = outline.withheld.length > 0 ? [WITHHELD_WORDS] : [];
    const controls = outline.lines.filter((line) => REF_IN_OUTLINE.test(line.text)).length;
    return {
      text: [...facts, ...rest, ...nextBlock(shown.next), ...withheld].join("\n"),
      page: this.factsOf(browser, did, errors, controls),
      body: [...(head.also ? [head.also] : []), ...rest, ...withheld].join("\n").trim(),
      next: shown.next,
    };
  }

  /** A page's notice, kept for the crewmate's next answer unless the captain holds the page. */
  private keep(browser: Browser, list: string[], text: string): void {
    if (browser.control === "captain") return;
    if (list.length >= NOTICES_KEPT) {
      browser.dropped += 1;
      return;
    }
    list.push(clip(text));
  }

  /** A request or connection the browser refused, counted by host for the next answer. */
  private block(browser: Browser, host: string, kind: Blocked["kind"]): void {
    if (browser.control === "captain") return;
    const seen = browser.blocked.get(host);
    browser.blocked.set(host, { count: (seen?.count ?? 0) + 1, kind });
  }

  private drainNotices(browser: Browser): string[] {
    const lines: string[] = [];
    const byKind = new Map<Blocked["kind"], string[]>();
    for (const [host, blocked] of browser.blocked) {
      const entry = blocked.count > 1 ? `${host} (${blocked.count})` : host;
      byKind.set(blocked.kind, [...(byKind.get(blocked.kind) ?? []), entry]);
    }
    browser.blocked.clear();
    for (const [kind, words] of BLOCKED_WORDS) {
      const hosts = byKind.get(kind);
      if (hosts) lines.push(`${words[0]}${hosts.join(", ")}. ${words[1]}`);
    }
    const listed = (label: string, list: string[]): void => {
      if (list.length === 0) return;
      const shown = list.slice(0, NOTICES_SHOWN).map((item) => `- ${item}`);
      const more = list.length > NOTICES_SHOWN ? [`- and ${list.length - NOTICES_SHOWN} more`] : [];
      lines.push(label, ...shown, ...more);
      list.length = 0;
    };
    listed("The browser refused what a site asked of it:", browser.refusals);
    listed("The page showed dialogs, each dismissed:", browser.dialogs);
    listed(
      `The page tried to open another page, refused: this browser keeps ${TASK_BROWSER_PAGES_MAX} pages at most. Close one with ${browserCommand("closepage <n>")}, or open the address with ${browserCommand("open <url>")}:`,
      browser.popups,
    );
    if (this.signedIn(browser) && browser.errors.length > 0) {
      // A page that may show the captain's account keeps its error words to itself.
      const count = browser.errors.length;
      lines.push(
        `The page logged ${count === 1 ? "an error" : `${count} errors`}; on a page that may show the captain's account their words are not passed on.`,
      );
      browser.errors.length = 0;
    } else {
      listed("The page logged errors:", browser.errors);
    }
    if (browser.dropped > 0) {
      lines.push(`(${browser.dropped} more page messages were not kept.)`);
      browser.dropped = 0;
    }
    return lines;
  }

  /** Write a picture: under its own name, or the first free `page-N.png`. */
  private async writePicture(
    dir: string,
    name: string | undefined,
    png: Uint8Array,
  ): Promise<string> {
    if (name) {
      const path = join(dir, name);
      await writeFile(path, png);
      return path;
    }
    for (let n = 1; n < 10_000; n += 1) {
      const path = join(dir, `page-${n}.png`);
      try {
        await writeFile(path, png, { flag: "wx" });
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("the evidence folder has no free picture name left");
  }
}
