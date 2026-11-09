import { mkdir } from "node:fs/promises";
import { HERE } from "@shared/deviceNames";
import { FRESH_LOOK_WORDS } from "@shared/taskBrowser";
import { FORM_RESEND, type HostLoadOutcome } from "../host";
import {
  addressOf,
  type Browser,
  type BrowsersCore,
  loadOwn,
  NUMBER_WORDS,
  outlineOptions,
  type PageEntry,
  quoted,
  shown,
  signedIn,
  siteOf,
} from "./browserRecord";
import { changesOf } from "./changes";
import { browserCommand } from "./commandWords";
import { checkOpenable } from "./destinations";
import type { DiagnosticsList } from "./diagnostics";
import { captureFileName, writePicture } from "./evidenceFiles";
import {
  HIDDEN_VALUE_WORDS,
  marksById,
  outlinePage,
  parseRef,
  passageOf,
  REF_PATTERN,
  type RefBook,
  type RefEntry,
  type RefStanding,
  refusedRefWords,
} from "./outline";
import { clip, guardRefusalLead } from "./pageNotices";
import { foundWords, nextBlock, type WindowAsk, windowOf } from "./window";

/**
 * A crewmate's browser commands (docs/task-browser.md, "What a crewmate
 * reads"): open, move and switch pages, read, wait, photograph, list and
 * close, each run within its bound, and the answer every command ends
 * with. `PageActions` acts on a page and answers the same way.
 */

/** How long one command may take before its answer says it did not finish. */
export const TASK_BROWSER_COMMAND_MS = 30_000;
/** How long `wait_for` waits for its words. */
const TASK_BROWSER_WAIT_MS = 10_000;
export const WAIT_POLL_MS = 250;
/** The window an answer shows when nothing chose another: the page from its top. */
export const TOP: WindowAsk = { kind: "top" };
/** How much of a picture's reason the captain's timeline line quotes. */
const CAPTURE_REASON_SHOWN = 120;

/** A line of the outline that names a control's ref. */
const REF_IN_OUTLINE = new RegExp(` \\[${REF_PATTERN}\\]`);

/**
 * Under an outline that held typed text back (docs/task-browser.md, "A
 * signed-in page"): why the crewmate cannot read it.
 */
const WITHHELD_WORDS = `What reads ${HIDDEN_VALUE_WORDS} holds a password, or text you did not type yourself since the captain handed this page back, which may be theirs - card details, a code: it is never read out.`;

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
  /** A page's console or network list (docs/task-browser.md, "Console and network lists"). */
  diagnostics?: DiagnosticsList;
  /** Every page the browser holds, for a crewmate that lists them. */
  pages?: { place: number; title: string; url: string; current: boolean }[];
};

/** A refusal: the words say why nothing was done, and what to do instead. */
export function refused(text: string): BrowserAnswer {
  return { text, refused: "refused" };
}

/** An ask that cannot be carried out as given: the words say how to ask. */
export function invalid(text: string): BrowserAnswer {
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
  action:
    | "click"
    | "type"
    | "select"
    | "set"
    | "press"
    | "scroll"
    | "hover"
    | "fill"
    | "drag"
    | "upload";
  ref?: string;
  text?: string;
  submit?: boolean;
  option?: string;
  key?: string;
  direction?: "up" | "down" | "top" | "bottom";
  to?: string;
  fields?: { ref: string; text: string }[];
  /** `upload`: files from the task's working copy, by path in it, for the page's file request. */
  files?: string[];
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

class BoundExceeded extends Error {}

/** A page's ref book as its answer names it: `none` until a read has numbered it. */
function refsOf(book: RefBook): string {
  return book.number === undefined ? "none" : `g${book.number}`;
}

export function labelOf(entry: RefEntry): string {
  return entry.name
    ? `${entry.role} ${quoted(entry.name)} [${entry.ref}]`
    : `${entry.role} [${entry.ref}]`;
}

/** The longest control name the captain's line quotes. */
export const DID_NAME_MAX = 40;

/** A control in the captain's line: its name quoted, or its kind. */
export function nameOf(entry: RefEntry): string {
  return entry.name ? quoted(clip(entry.name, DID_NAME_MAX)) : `a ${entry.role || "control"}`;
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

/** Where the crewmate went, in the captain's line: a path on the same site, else the site too. */
function openedWords(url: URL, site: string | undefined): string {
  const path = `${url.pathname}${url.search}`;
  const where = path === "/" ? "" : clip(path, DID_NAME_MAX);
  if (site === undefined || site === url.host) return `opened ${where || "the page"}`;
  return `opened ${url.host}${where}`;
}

/** One page as the crewmate reads it: its title and address. */
function entryLine(browser: Browser, entry: PageEntry): string {
  const title = entry.page.title().trim();
  return `${title ? `${quoted(title)} at ` : ""}${shown(browser, entry.page.url())}`;
}

function pageLine(browser: Browser): string {
  return entryLine(browser, browser.current);
}

/** Every page the browser holds, by its place, for a crewmate that named one it does not. */
function pagesLine(browser: Browser): string {
  return `Its pages: ${browser.pages
    .map((entry, index) => `page ${index + 1}, ${entryLine(browser, entry)}`)
    .join("; ")}.`;
}

/**
 * The page the answer reads, and with two, which it is and what else is
 * open: its words, the page's place, and the line naming the others.
 */
function pageHead(browser: Browser): {
  lines: string[];
  place?: { place: number; of: number };
  also?: string;
} {
  if (browser.pages.length === 1) return { lines: [`Page: ${pageLine(browser)}`] };
  const place = browser.pages.indexOf(browser.current) + 1;
  const others = browser.pages
    .map((entry, index) =>
      entry === browser.current ? undefined : `page ${index + 1}, ${entryLine(browser, entry)}`,
    )
    .filter((line): line is string => line !== undefined);
  const also = `Also open: ${others.join("; ")}. ${browserCommand("selectpage <n>")} switches to it.`;
  return {
    lines: [`Page ${place} of ${browser.pages.length}: ${pageLine(browser)}`, also],
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
function factsOf(
  browser: Browser,
  did: string,
  errors: number,
  controls?: number,
): BrowserPageFacts {
  const entry = browser.current;
  const head = pageHead(browser);
  return {
    title: entry.page.title().trim(),
    url: shown(browser, entry.page.url()),
    refs: refsOf(entry.refs),
    ...(controls !== undefined ? { controls } : {}),
    ...(head.place ? { page: head.place } : {}),
    errors,
    did,
    ...(signedIn(browser) ? { signedIn: true as const } : {}),
  };
}

/**
 * The answer every command but capture ends with: the page, what it did,
 * and the window of its outline `ask` chooses (`window.ts`).
 */
export async function answer(
  browser: Browser,
  leadWords: string | (() => string),
  ask: WindowAsk = TOP,
  action?: { entry: PageEntry; refs: RefBook },
): Promise<BrowserAnswer> {
  const notice = browser.notices.take().trim();
  const entry = browser.current;
  const outline = outlinePage(await entry.page.nodes(), entry.refs, outlineOptions(browser));
  // A load's words are read once the page is, so a download it became has started by then.
  const lead = typeof leadWords === "function" ? leadWords() : leadWords;
  const window = windowOf(outline.lines, ask);
  const samePage = action?.entry === entry && action.refs === entry.refs;
  const head = pageHead(browser);
  const did = `${lead || "Read the page."}${action ? (samePage ? " The page did not move." : " The page changed; this is a fresh outline.") : ""}`;
  const facts = [...head.lines, `refs: ${refsOf(entry.refs)}`, `did: ${did}`];
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
  rest.push(...browser.notices.pageNotes);
  browser.notices.pageNotes.length = 0;
  if (entry.chooser) {
    rest.push(
      `The page asks for ${entry.chooser.multiple ? "files" : "a file"}: attach ${entry.chooser.multiple ? "them" : "one"} from your working copy with ${browserCommand(entry.chooser.multiple ? "upload <path>..." : "upload <path>")}, or ask the captain on a card for a file you do not have.`,
    );
  }
  // A new document the crewmate's own load did not ask for: a link, a form, a script.
  if (entry.moved) rest.push(`The page moved to ${shown(browser, entry.moved)}.`);
  entry.moved = undefined;
  const errors = browser.notices.errors.length;
  rest.push(...browser.notices.drain(signedIn(browser)));
  rest.push("");
  const previous = entry.answered;
  const view =
    samePage && ask.kind !== "screen" && previous?.refs === entry.refs
      ? changesOf(previous.lines, outline.lines)
      : window;
  rest.push(...view.lines);
  entry.answered = { refs: entry.refs, lines: outline.lines.map((line) => line.text) };
  const withheld = outline.withheld.length > 0 ? [WITHHELD_WORDS] : [];
  const controls = outline.lines.filter((line) => REF_IN_OUTLINE.test(line.text)).length;
  return {
    text: [...facts, ...rest, ...nextBlock(view.next), ...withheld].join("\n"),
    page: factsOf(browser, did, errors, controls),
    body: [...(head.also ? [head.also] : []), ...rest, ...withheld].join("\n").trim(),
    next: view.next,
  };
}

/** A load's lead words: what it did, or why the page did not load, in the crewmate's words. */
function loadLead(browser: Browser, outcome: HostLoadOutcome, done: string, href: string): string {
  if (outcome.ok) {
    return outcome.status !== undefined && outcome.status >= 400
      ? `${done} The server answered ${outcome.status}.`
      : done;
  }
  const notices = browser.notices;
  const host = siteOf(href);
  const hostname = hostnameOf(href);
  if (/^ERR_CERT_|^ERR_SSL_/.test(outcome.code)) {
    // The lead says it; the refusals below need not say it again.
    const own = notices.refusals.filter((line) => !line.startsWith(`${host}:`));
    notices.refusals.splice(0, notices.refusals.length, ...own);
    return `${host}'s certificate did not verify (${outcome.code}), so the browser did not open it. It never goes past a certificate error; if the task needs this site, say so in your report.`;
  }
  // A download ends the load it came from, in words of its own (docs/task-browser.md, "A download").
  if (notices.downloaded) {
    return "That address is a file to download, not a page, so the page did not change: see the download below.";
  }
  const tunnel = notices.tunnels.get(hostname);
  if (tunnel) notices.blocked.delete(hostname);
  switch (outcome.code) {
    case "ERR_CONNECTION_REFUSED":
      return `Nothing answered at ${href}. Start the project's server first (in the background), then run ${browserCommand("open <url>")} again.`;
    case "ERR_TUNNEL_CONNECTION_FAILED":
    case "ERR_PROXY_CONNECTION_FAILED":
      return (
        (tunnel && guardRefusalLead(host, tunnel)) ??
        `The page did not load: the connection where it led was refused or failed (${outcome.code}).`
      );
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

/**
 * Each task's crewmate commands but its actions on a page: they run one at
 * a time per task, through `TaskBrowsers.forTask`, once the captain does
 * not hold the browser.
 */
export class CrewmateCommands {
  constructor(private readonly core: BrowsersCore) {}

  async navigate(taskId: string, input: BrowserNavigateInput): Promise<BrowserAnswer> {
    const given = [input.url, input.go, input.page].filter((value) => value !== undefined).length;
    if (given !== 1) {
      return invalid(
        given === 0
          ? "Give url to open a page, go to move back, forward or reload, or page to switch to another of this browser's pages."
          : "Give one of url, go or page - not more than one.",
      );
    }
    if (input.page !== undefined) {
      const browser = this.core.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      const entry = browser.pages[input.page - 1];
      if (!entry) {
        return refused(
          `This browser has ${browser.pages.length === 1 ? "one page" : `${browser.pages.length} pages`}, so there is no page ${input.page}. ${pagesLine(browser)}`,
        );
      }
      const place = input.page;
      browser.did = `switched to ${siteOf(addressOf(browser, entry))}`;
      return this.guarded(taskId, browser, "switch pages", async () => {
        this.core.select(taskId, browser, entry);
        return answer(browser, `Switched to page ${place}.`);
      });
    }
    if (input.go !== undefined) {
      const browser = this.core.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      const go = input.go;
      const entry = browser.current;
      browser.did = go === "reload" ? "reloaded the page" : `went ${go}`;
      return this.guarded(taskId, browser, "move the page", async () => {
        const outcome = await loadOwn(
          entry,
          go === "reload" ? entry.page.reload() : entry.page.history(go),
        );
        if (!outcome.ok && outcome.code === FORM_RESEND) browser.did = "did not resend a form";
        const done = go === "reload" ? "Reloaded the page." : `Went ${go}.`;
        return answer(browser, () => loadLead(browser, outcome, done, entry.page.url()));
      });
    }
    const check = checkOpenable(input.url as string);
    if (!check.ok) return refused(check.reason);
    let browser = this.core.browsers.get(taskId);
    // The site the captain already reads, when this page is on another one.
    const site = browser ? siteOf(addressOf(browser, browser.current)) : undefined;
    let fresh = "";
    if (!browser) {
      if (this.core.browsers.size >= this.core.max) {
        return refused(
          `${NUMBER_WORDS[this.core.max] ?? this.core.max} task browsers are already open on ${HERE.this}, the most it runs at once. This task's opens once one of them closes: try again later, or carry on without it.`,
        );
      }
      const why = this.core.stopped.get(taskId);
      browser = await this.core.start(
        taskId,
        check.url.href,
        `opened its browser at ${check.url.origin}`,
      );
      if (!browser)
        return refused(`${HERE.This} could not open a browser for this task right now.`);
      this.core.stopped.delete(taskId);
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
      const outcome = await loadOwn(entry, entry.page.load(href));
      if (outcome.ok) await this.core.grants.applyAutomatic(taskId, opened);
      return answer(opened, () => `${fresh}${loadLead(opened, outcome, `Opened ${href}.`, href)}`);
    });
  }

  async inspect(taskId: string, input: BrowserInspectInput): Promise<BrowserAnswer> {
    const browser = this.core.browsers.get(taskId);
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
        const hidden = signedIn(browser);
        const text = browser.current.diagnostics.read(show, hidden);
        const head = pageHead(browser);
        const notice = browser.notices.take().trim();
        const did = `Read the ${show} list.`;
        return {
          text: [
            ...head.lines,
            `refs: ${refsOf(browser.current.refs)}`,
            `did: ${did}`,
            notice,
            text,
          ]
            .filter(Boolean)
            .join("\n"),
          page: factsOf(browser, did, 0),
          body: [head.also, notice].filter(Boolean).join("\n"),
          diagnostics: browser.current.diagnostics.list(show, hidden),
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
            outlineOptions(browser),
          );
          if (outline.words.toLowerCase().includes(wanted)) {
            found = true;
            break;
          }
          if (poll < polls) await this.sleep(WAIT_POLL_MS);
        }
        if (!found) {
          return answer(
            browser,
            `Waited ${TASK_BROWSER_WAIT_MS / 1000} seconds; ${quoted(waitFor)} did not appear.`,
            asked,
          );
        }
        // The answer shows the part that holds the words, not the top again.
        if (!ref) {
          return answer(browser, "", {
            kind: "find",
            words: waitFor,
            ...(from ? { from } : {}),
          });
        }
      }
      if (ref) return this.readPassage(taskId, browser, ref);
      return answer(browser, "", asked);
    });
  }

  async capture(taskId: string, input: BrowserCaptureInput): Promise<BrowserAnswer> {
    const browser = this.core.browsers.get(taskId);
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
    if (signedIn(browser) && !reason) {
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
      if (signedIn(browser)) {
        // A picture would show the typed text the outline holds back.
        const { withheld } = outlinePage(
          await browser.current.page.nodes(),
          browser.current.refs,
          outlineOptions(browser),
        );
        if (withheld.length > 0) {
          browser.did = "did not photograph the page";
          return refused(
            `${browser.notices.take()}Did not photograph the page: it holds text you did not type yourself since the captain handed it back, which may be theirs - ${clip(withheld.join(", "))}. A picture would show it. Read the page with ${browserCommand("snapshot")} instead, which says what is filled without its text, or ask the captain on a card.`,
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
      const dir = this.core.options.evidenceDir(taskId);
      await mkdir(dir, { recursive: true });
      const path = await writePicture(dir, captureFileName(input.name), shot.png);
      const what = entry
        ? `the visible part of ${labelOf(entry)}`
        : fullPage
          ? "the whole page"
          : "the visible page";
      if (signedIn(browser) && reason) {
        this.core.options.note?.(
          taskId,
          `photographed its browser's page at ${siteOf(addressOf(browser, browser.current))} ${browser.returns > 0 ? "after you returned control" : "while it used your saved sign-in"}: ${clip(reason, CAPTURE_REASON_SHOWN)}`,
        );
      }
      const notice = browser.notices.take();
      const did = `Saved ${what} as ${path} (${shot.width}×${shot.height}).`;
      return {
        text: `${notice}${did} A card can show it by this path. Page: ${pageLine(browser)}`,
        image: { data: Buffer.from(shot.png).toString("base64"), mimeType: "image/png" },
        page: factsOf(browser, did, 0),
        body: notice.trim(),
        picture: { path, width: shot.width, height: shot.height, what },
      };
    });
  }

  /** The crewmate stops its browser, or with `page` closes a page another page opened. */
  async close(taskId: string, page?: number): Promise<BrowserAnswer> {
    if (page !== undefined) {
      const browser = this.core.browsers.get(taskId);
      if (!browser) return this.noBrowser(taskId);
      if (page === 1) {
        return refused(
          `Page 1 is this browser's own page. Run ${browserCommand("stop")} to stop the whole browser.`,
        );
      }
      const entry = browser.pages[page - 1];
      if (!entry) return refused(`There is no page ${page}. ${pagesLine(browser)}`);
      const site = siteOf(addressOf(browser, entry));
      browser.did = `closed the page at ${site}`;
      this.core.dropPage(taskId, browser, entry);
      try {
        entry.page.close();
      } catch {
        // A page that is already gone has nothing left to close.
      }
      return this.guarded(taskId, browser, "read the page", async () =>
        answer(browser, `Closed page ${page} (${site}); your commands act on page 1.`),
      );
    }
    if (!this.core.browsers.has(taskId)) {
      this.core.stopped.delete(taskId);
      return { text: "No browser is open for this task." };
    }
    this.core.stop(taskId, "crewmate");
    this.core.stopped.delete(taskId);
    return {
      text: `Stopped this task's browser: its pages, history and site data are gone. ${browserCommand("open <url>")} opens a fresh one.`,
    };
  }

  /** Every page the browser holds, as the crewmate reads their addresses. */
  async pages(taskId: string): Promise<BrowserAnswer> {
    const browser = this.core.browsers.get(taskId);
    if (!browser) return this.noBrowser(taskId);
    const pages = browser.pages.map((entry, index) => ({
      place: index + 1,
      title: entry.page.title().trim(),
      url: shown(browser, addressOf(browser, entry)),
      current: entry === browser.current,
    }));
    return {
      text: `${browser.pages.length === 1 ? "One page is open" : `${browser.pages.length} pages are open`}; your commands act on page ${browser.pages.indexOf(browser.current) + 1}. ${pagesLine(browser)}`,
      pages,
    };
  }

  /** Run a command within its bound, answering in words for a stuck page or a failed effect. */
  async guarded(
    taskId: string,
    browser: Browser,
    what: string,
    run: () => Promise<BrowserAnswer>,
  ): Promise<BrowserAnswer> {
    this.core.touch(taskId, browser);
    // Whatever the crewmate does first after a handoff, it has looked anew.
    browser.freshLook = undefined;
    // The captain's line says what the crewmate is doing as it starts.
    this.core.options.onChange?.(taskId);
    let cancel: (() => void) | undefined;
    const bound = new Promise<never>((_, reject) => {
      cancel = this.core.timer(TASK_BROWSER_COMMAND_MS, () => reject(new BoundExceeded()));
    });
    const work = run();
    // A command past its bound may still settle; its outcome has no one left to tell.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, bound]);
    } catch (error) {
      if (this.core.browsers.get(taskId) !== browser) return this.noBrowser(taskId);
      if (error instanceof BoundExceeded) {
        return refused(
          `The browser did not ${what} within ${TASK_BROWSER_COMMAND_MS / 1000} seconds. The page may still be busy; run ${browserCommand("snapshot")} to see where it stands.`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return refused(`The browser could not ${what}: ${clip(message)}.`);
    } finally {
      cancel?.();
      if (this.core.browsers.get(taskId) === browser) this.core.options.onChange?.(taskId);
    }
  }

  noBrowser(taskId: string): BrowserAnswer {
    const why = this.core.stopped.get(taskId);
    return refused(
      why
        ? `This task's browser ${why}. Run ${browserCommand("open <url>")} to open a fresh one.`
        : `No browser is open for this task. Run ${browserCommand("open <url>")} to open one.`,
    );
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.core.timer(ms, resolve);
    });
  }

  /**
   * A ref the current page's book does not hold, refused in words that say
   * where it came from: a page that moved or closed, the other page, before
   * a handback, an earlier browser. It is never used on another element.
   */
  refusedRef(taskId: string, browser: Browser, ref: string): string {
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
      if (parsed.book > this.core.lastBook(taskId)) return { kind: "unknown" };
      if (parsed.book < browser.booksFrom) return { kind: "earlier-browser" };
      if (browser.handedBackFrom !== undefined && parsed.book < browser.handedBackFrom) {
        return { kind: "handed-back" };
      }
      return { kind: "earlier-page" };
    })();
    return refusedRefWords(ref, standing);
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
    const options = outlineOptions(browser);
    const passage = passageOf(node, browser.current.refs, options);
    if (passage.hidden) {
      return answer(browser, `${labelOf(entry)} ${HIDDEN_VALUE_WORDS}.`, {
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
    return answer(browser, `${lead}${more}`, { kind: "around", ref: entry.ref });
  }
}
