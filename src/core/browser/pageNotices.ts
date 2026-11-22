import { HERE } from "@shared/deviceNames";
import type { TaskBrowserBlock } from "@shared/taskBrowser";
import { TASK_BROWSER_PAGES_MAX } from "@shared/taskBrowser";
import { cutText } from "@shared/textCut";
import type { HostBrowserRefusal } from "../host";
import { type AddressKind, neverReachable } from "./addresses";
import { quoted, siteOf } from "./browserRecord";
import { browserCommand } from "./commandWords";
import type { GuardAnswer, GuardRefusal, GuardRefusalKind } from "./connectionGuard";
import type { BlockKind } from "./destinations";

/** Page errors and dialogs one answer lists before it counts the rest. */
const NOTICES_SHOWN = 8;
const NOTICE_MAX = 300;
/** Notices kept between answers; older ones only count. */
const NOTICES_KEPT = 50;

/** How a crewmate asks for a private site, which only the captain's click allows. */
const ALLOW_WORDS =
  "The captain can allow a private site for task browsers by its name: if the task needs one, ask the first mate in your report (needs_firstmate), naming the site.";

/**
 * A host the page asked for and did not get: refused by policy, or by its
 * connection guard, `no-route` when the network had no way to its address.
 */
type Blocked = {
  count: number;
  kind: BlockKind | Exclude<GuardRefusalKind, "private"> | "no-route";
};

/**
 * What a failed connection the page made on its own says of the page: a
 * crewmate's own load that failed says so in its lead, so these are parts
 * the page asked for while it loaded or after.
 */
const PAGE_LOADED =
  "The page itself loaded; only these parts it asked for are missing, and a page often works without them.";

/**
 * What each kind of refused request reads as, in the order an answer lists
 * them: the words before the hosts, and the sentence after.
 */
const BLOCKED_WORDS: readonly [Blocked["kind"], readonly [string, string]][] = [
  [
    "private",
    [
      `Blocked what the page asked for on ${HERE.this}'s network or another private one: `,
      `This browser reaches public websites, the pages on ${HERE.this} you open and the private sites the captain allowed, never another device; a public name that leads to a private address is refused at the connection. ${ALLOW_WORDS}`,
    ],
  ],
  [
    "insecure",
    [
      "Blocked what the page asked for from websites over plain http: ",
      "This browser reaches public websites only over https; a private site the captain allowed opens over http too.",
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
  [
    "unresolved",
    ["Could not find what the page asked for: ", `No such name was found. ${PAGE_LOADED}`],
  ],
  [
    "unreachable",
    ["Could not reach what the page asked for: ", `Its server did not answer. ${PAGE_LOADED}`],
  ],
  [
    "no-route",
    [
      "Could not reach what the page asked for: ",
      `This computer's network has no route to its addresses, as when a name has only IPv6 addresses and the network has no IPv6, so no server was asked. ${PAGE_LOADED}`,
    ],
  ],
];

/**
 * What the crewmate's first look after the captain returned its browser
 * says when the page is on an address the browser refuses, so it shows the
 * browser engine's own refusal (docs/task-browser.md, "A page on a refused
 * address"). What the page asked for in the captain's time is his, but the
 * page it rests on is a fact of the page as it is now. It names the host and
 * port alone: the rest of the address may carry a sign-in's code.
 */
export function blockedPageWords(block: {
  kind: TaskBrowserBlock;
  host: string;
  origin: string;
}): string {
  // i18n-exempt: served only to the crewmate's model
  const lead = `This page is the browser's own refusal of ${block.host}`;
  // i18n-exempt: served only to the crewmate's model
  switch (block.kind) {
    case "local":
      return `${lead}, another server on ${HERE.this} that this task has not opened, so nothing from it loaded; a sign-in often ends at such an address. To let it load, open that server with ${browserCommand(`open ${block.origin}`)}, then go ${browserCommand("back")} to load this page again with its whole address, which you are not shown. If it still does not finish, ask the captain on a card to sign in again.`;
    case "private":
      return `${lead}, an address on ${HERE.this}'s network or another private one, so nothing from it loaded. ${ALLOW_WORDS}`;
    case "insecure":
      return `${lead}, a website over plain http, so nothing from it loaded. This browser reaches public websites only over https.`;
  }
}

/** What the browser refused of a site on its own, as the crewmate reads it. */
export function refusalWords(refusal: HostBrowserRefusal): string {
  const site = siteOf(refusal.url);
  switch (refusal.kind) {
    case "certificate":
      return `${site}: its certificate did not verify (${refusal.code}), so nothing came from it. This browser never goes past a certificate error.`;
    case "sign-in-box":
      return `${site}: it asked for a browser sign-in box, which this browser does not answer. If the task needs that site, ask the captain on a card.`;
    case "client-certificate":
      return `${site}: it asked for a client certificate, which this browser never offers.`;
    case "passkey":
      return `${site}: it asked for a passkey, which this browser does not have, so it told the site at once that none is available. Look on the page for another way, such as a password or a code; a sign-in is still the captain's to make (emit_card browser_handoff).`;
  }
}

/** Addresses one refusal lists before it counts the rest. */
const ANSWERS_SHOWN = 4;

/** Each non-public kind of answer, as one address and as several, and what to do about it. */
const ANSWER_WORDS: Record<Exclude<AddressKind, "public">, readonly [string, string, string]> = {
  private: [
    "an address on a private network such as an office or VPN network",
    "addresses on a private network such as an office or VPN network",
    `Task browsers reach public websites, the pages on ${HERE.this} you open and the private sites the captain allowed.`,
  ],
  "this-computer": [
    `an address on ${HERE.this}`,
    `addresses on ${HERE.this}`,
    `To open a page served on ${HERE.this}, open it by localhost instead, such as ${browserCommand("open http://localhost:<port>/")}.`,
  ],
  reserved: [
    "a reserved address that is not on the internet",
    "reserved addresses that are not on the internet",
    "A proxy app or DNS filter usually gives such an address in place of a site's own.",
  ],
};

const ANSWER_ORDER: readonly Exclude<AddressKind, "public">[] = [
  "private",
  "this-computer",
  "reserved",
];

function listed(addresses: readonly string[]): string {
  const shown = addresses.slice(0, ANSWERS_SHOWN);
  const more = addresses.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
    : (shown[0] ?? "");
}

/** The non-public answers by kind, each as "addresses, what they are", and the sentences after. */
function nonPublic(answers: readonly GuardAnswer[]): { named: string[]; after: string[] } {
  const named: string[] = [];
  const after: string[] = [];
  for (const kind of ANSWER_ORDER) {
    const addresses = answers.filter((answer) => answer.kind === kind).map((a) => a.address);
    if (addresses.length === 0) continue;
    const [one, many, then] = ANSWER_WORDS[kind];
    named.push(`${listed(addresses)}, ${addresses.length === 1 ? one : many}`);
    after.push(then);
  }
  return { named, after };
}

/**
 * The lead of a crewmate's own load the connection guard refused or could
 * not carry, naming what the name answered (docs/task-browser.md, "Where a
 * page may go"); nothing for a refusal these words do not cover.
 */
export function guardRefusalLead(site: string, refusal: GuardRefusal): string | undefined {
  // A listed name's private answers are dialed too, unless no allowance reaches them.
  const admitted = (answer: GuardAnswer): boolean =>
    answer.kind === "public" ||
    (refusal.listed === true && answer.kind === "private" && !neverReachable(answer.address));
  const skipped = refusal.answers.filter((answer) => !admitted(answer));
  const { named, after } = nonPublic(skipped);
  // An unlisted name with a private answer may be allowed by the captain.
  const allow =
    !refusal.listed && skipped.some((answer) => answer.kind === "private")
      ? ` The captain can allow it for task browsers: if the task needs ${refusal.host}, ask the first mate in your report (needs_firstmate), naming ${refusal.host}.`
      : "";
  switch (refusal.kind) {
    case "private": {
      if (named.length === 0) {
        return `${site} leads to an address that is not on the internet, so the browser refused it at the connection. ${ANSWER_WORDS.private[2]}`;
      }
      if (refusal.listed) {
        return `${site} is on the captain's private sites list, but leads only to ${named.join("; and to ")}, which no task browser reaches, so the browser refused it at the connection.`;
      }
      return `${site} leads to ${named.join("; and to ")}, so the browser refused it at the connection. ${after.join(" ")}${allow}`;
    }
    case "unresolved":
      return `${site} was not found. Check the address.`;
    case "unreachable": {
      if (refusal.noRoute) {
        return `${site} could not be reached: this computer's network has no route to its addresses, as when a name has only IPv6 addresses and the network has no IPv6. Try again on another network, or carry on without it.`;
      }
      const tried = refusal.answers.filter(admitted);
      if (named.length === 0)
        return `${site} did not answer. Try again later, or carry on without it.`;
      const where = refusal.listed
        ? listed(tried.map((a) => a.address))
        : `its public ${tried.length === 1 ? "address" : "addresses"}, ${listed(tried.map((a) => a.address))}`;
      return `${site} did not answer at ${where}. The browser skipped ${named.join("; and ")}, which it never dials. ${after.join(" ")}${allow}`;
    }
  }
}

export function clip(text: string, max = NOTICE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${cutText(flat, max - 1)}…` : flat;
}

/** The lists of what a page said that an answer reads out and empties. */
type KeptList = "dialogs" | "errors" | "popups" | "refusals" | "pageNotes";

/**
 * What a task's browser keeps to tell its crewmate at the head of its next
 * answer (docs/task-browser.md, "What a crewmate reads"): requests and
 * connections it refused, the page's dialogs and errors, downloads, refused
 * windows, a second page opening or closing, and the one notice told once.
 * While the captain holds the page, what it says is his and is kept for
 * nobody (`paused`); a download is told whoever drives next, since the file
 * is in the task's folder either way.
 */
export class PageNotices {
  /** Requests refused since the last answer, by host. */
  readonly blocked = new Map<string, Blocked>();
  /** Why the guard last carried no connection to each host, for a load's own words. */
  readonly tunnels = new Map<string, GuardRefusal>();
  readonly dialogs: string[] = [];
  readonly errors: string[] = [];
  /**
   * Downloads that ended since the last answer, in the crewmate's words:
   * told whoever held the page, since the file is now in its folder.
   */
  readonly downloads: string[] = [];
  /** Downloads still running, by the path they are saved at: the name the site gave. */
  readonly downloading = new Map<string, string>();
  /** A download started since the last load began: an address that was a file, not a page. */
  downloaded?: boolean;
  /** Windows a page tried to open past the browser's pages, refused. */
  readonly popups: string[] = [];
  /** Certificates, sign-in boxes and client certificates the browser refused. */
  readonly refusals: string[] = [];
  /** A second page opening or closing, in the words the crewmate reads. */
  readonly pageNotes: string[] = [];
  /** Notices past `NOTICES_KEPT` since the last answer: counted, not kept. */
  dropped = 0;
  /** Told to the crewmate once, at the head of its next answer. */
  notice?: string;

  constructor(private readonly paused: () => boolean) {}

  /** A page's notice, kept for the crewmate's next answer unless the captain holds the page. */
  keep(list: KeptList, text: string): void {
    if (this.paused()) return;
    if (this[list].length >= NOTICES_KEPT) {
      this.dropped += 1;
      return;
    }
    this[list].push(clip(text));
  }

  /** A download's line, for whoever drives next: past the kept count it is counted, not kept. */
  keepDownload(text: string): void {
    if (this.downloads.length >= NOTICES_KEPT) {
      this.dropped += 1;
      return;
    }
    this.downloads.push(text);
  }

  /** A request or connection the browser refused or could not make, counted by host for the next answer. */
  block(host: string, kind: Blocked["kind"]): void {
    if (this.paused()) return;
    const seen = this.blocked.get(host);
    this.blocked.set(host, { count: (seen?.count ?? 0) + 1, kind });
  }

  /** What the crewmate is told once about its browser, at the head of an answer. */
  take(): string {
    const notice = this.notice;
    this.notice = undefined;
    return notice ? `${notice}\n` : "";
  }

  /** Nothing the page said while the captain held it reaches the crewmate. */
  forget(): void {
    this.blocked.clear();
    this.tunnels.clear();
    this.dialogs.length = 0;
    this.errors.length = 0;
    this.popups.length = 0;
    this.refusals.length = 0;
    this.pageNotes.length = 0;
    this.dropped = 0;
  }

  /**
   * Every kept notice as an answer's lines, emptied as it is read. A page
   * that may show the captain's account (`signedIn`) keeps its error words
   * to itself.
   */
  drain(signedIn: boolean): string[] {
    const lines: string[] = [];
    const byKind = new Map<Blocked["kind"], string[]>();
    for (const [host, blocked] of this.blocked) {
      const entry = blocked.count > 1 ? `${host} (${blocked.count})` : host;
      byKind.set(blocked.kind, [...(byKind.get(blocked.kind) ?? []), entry]);
    }
    this.blocked.clear();
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
    listed("The browser refused what a site asked of it:", this.refusals);
    listed("The page showed dialogs, each dismissed:", this.dialogs);
    listed(
      "The browser downloaded files into the task's evidence folder, where you can read them and hand them on by path in your report:",
      this.downloads,
    );
    if (this.downloading.size > 0) {
      lines.push(
        `Still downloading: ${[...this.downloading.values()].map(quoted).join(", ")}. Read the page again shortly to see where it was saved.`,
      );
    }
    this.downloaded = false;
    listed(
      `The page tried to open another page, refused: this browser keeps ${TASK_BROWSER_PAGES_MAX} pages at most. Close one with ${browserCommand("closepage <n>")}, or open the address with ${browserCommand("open <url>")}:`,
      this.popups,
    );
    if (signedIn && this.errors.length > 0) {
      // A page that may show the captain's account keeps its error words to itself.
      const count = this.errors.length;
      lines.push(
        `The page logged ${count === 1 ? "an error" : `${count} errors`}; on a page that may show the captain's account their words are not passed on.`,
      );
      this.errors.length = 0;
    } else {
      listed("The page logged errors:", this.errors);
    }
    if (this.dropped > 0) {
      lines.push(`(${this.dropped} more page messages were not kept.)`);
      this.dropped = 0;
    }
    return lines;
  }
}
