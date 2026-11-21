import { HERE } from "@shared/deviceNames";
import type { TaskBrowserBlock } from "@shared/taskBrowser";
import { isPublicAddress, literalAddress } from "./addresses";

/**
 * Where a task browser may go (docs/task-browser.md, "Where a page may go").
 *
 * A task's browser reaches public websites over https, and the pages a
 * project serves on this Mac: an address on loopback (`localhost`,
 * `*.localhost`, `127.0.0.0/8`, `[::1]`) that the crewmate itself opened
 * with `infinitary-browser-axi open`. Opening one registers its origin for the task,
 * so the page's own requests to it go through. Everything else is refused
 * before it leaves: another local service, an address on a private network,
 * a public website over plain http, a file, an app scheme. The crewmate's
 * own shell is not fenced by this; the page is, so a hostile page cannot
 * reach the rest of this Mac or its network through the task's browser.
 *
 * This is the address as written. A public name can still resolve to a
 * private address, so every connection to the internet also goes through
 * the connection guard (`connectionGuard.ts`), which resolves the name
 * itself and connects only to the public address it checked.
 *
 * A name on the captain's private sites list (`listed`, docs/task-browser.md,
 * "Private sites") is opened over https or http, by the crewmate and by any
 * page, as an ordinary browser allows; the guard still checks where it
 * leads. An address written out stays refused, listed or not.
 *
 * Pure: every caller hands in the task's registered origins.
 */

/** Schemes a page may use for content it makes itself; never a request off the page. */
const PAGE_LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

/** Schemes a request to a project's server travels over. */
const WEB_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/** The secure twin of a scheme shares its default port's role, not its number. */
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "ws:": "80",
  "https:": "443",
  "wss:": "443",
};

/** Whether a hostname, as `URL` parses it, names this Mac's loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]") return true;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
  return octets[0] === "127" && octets.every((part) => Number(part) <= 255);
}

/**
 * The origin key a registration and a request share: host and port, with
 * `ws` folded onto `http` and `wss` onto `https` (a dev server's live
 * reload rides a socket on its own port).
 */
export function originKey(url: URL): string {
  const scheme =
    url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  const port = url.port || DEFAULT_PORTS[url.protocol] || "";
  return `${scheme}//${url.hostname.toLowerCase()}:${port}`;
}

function parse(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Whether a name is on the captain's private sites list; none is when absent. */
export type ListedSite = (hostname: string) => boolean;

/** Why a crewmate's own address was not opened, in words its answer carries. */
export type OpenRefusal = { ok: false; reason: string };

/**
 * Check an address the crewmate asked to open: a public website over
 * https, or a page on this Mac's loopback over http or https, whose origin
 * the caller registers. Anything else is refused with the reason in plain
 * words.
 */
export function checkOpenable(
  value: string,
  listed: ListedSite = () => false,
): { ok: true; url: URL; origin?: string } | OpenRefusal {
  const url = parse(value.trim());
  if (!url) {
    return {
      ok: false,
      reason: `"${value}" is not a web address. Give the full address, such as https://example.com/ or http://localhost:5173/.`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `This browser opens web pages over http or https; ${url.protocol} addresses are not opened.`,
    };
  }
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") {
    return {
      ok: false,
      reason: `${url.hostname} is where a server listens, not an address to open. Open http://localhost:${url.port || DEFAULT_PORTS[url.protocol]}/ instead.`,
    };
  }
  if (isLoopbackHost(url.hostname)) return { ok: true, url, origin: originKey(url) };
  const literal = literalAddress(url.hostname);
  if (literal !== undefined && !isPublicAddress(literal)) {
    return {
      ok: false,
      reason: `${url.hostname} is an address on a private network or kept for special use. This browser opens public websites and the pages a project serves on ${HERE.this} (localhost, 127.0.0.1 or a name ending in .localhost), and a private site the captain allowed by its name, never an address on a network.`,
    };
  }
  if (literal === undefined && listed(url.hostname)) return { ok: true, url };
  if (url.protocol === "http:") {
    const secure = new URL(url.href);
    secure.protocol = "https:";
    return {
      ok: false,
      reason: `This browser opens a site over plain http only when it is a private site the captain allowed. Open ${secure.href} instead; if the task needs ${url.hostname} over http on an office, home or VPN network, ask the first mate in your report (needs_firstmate), naming ${url.hostname}.`,
    };
  }
  return { ok: true, url };
}

/**
 * Why a request a task page made was refused: `local`, another service on
 * this Mac the crewmate did not open; `private`, an address on a private
 * network or kept for special use (the connection guard refuses a name
 * that leads to one with the same kind); `insecure`, a public website over
 * plain http or ws; `scheme`, not a web address at all.
 */
export type BlockKind = "local" | "private" | "insecure" | "scheme";

/** What became of one request a task page made. */
export type RequestDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** The host the request named, for the blocked summary; the scheme when it named none. */
      host: string;
      kind: BlockKind;
    };

/**
 * Decide one request a task page made, top level or not: content the page
 * makes itself goes through, a request to an origin the crewmate opened
 * goes through, a public website over https or wss, or a listed private
 * site over any of the four, goes on to the connection guard, and
 * everything else is refused.
 */
export function decideRequest(
  value: string,
  origins: ReadonlySet<string>,
  listed: ListedSite = () => false,
): RequestDecision {
  const url = parse(value);
  if (!url) return { allowed: false, host: "an unreadable address", kind: "scheme" };
  if (PAGE_LOCAL_SCHEMES.has(url.protocol)) return { allowed: true };
  if (!WEB_SCHEMES.has(url.protocol)) {
    return { allowed: false, host: url.protocol.replace(/:$/, ""), kind: "scheme" };
  }
  if (isLoopbackHost(url.hostname)) {
    return origins.has(originKey(url))
      ? { allowed: true }
      : { allowed: false, host: url.host, kind: "local" };
  }
  const literal = literalAddress(url.hostname);
  if (literal !== undefined && !isPublicAddress(literal)) {
    return { allowed: false, host: url.hostname, kind: "private" };
  }
  if (literal === undefined && listed(url.hostname)) return { allowed: true };
  if (url.protocol === "http:" || url.protocol === "ws:") {
    return { allowed: false, host: url.hostname, kind: "insecure" };
  }
  return { allowed: true };
}

/** One request a task page made, as its engine reports it. */
export type PageRequest = {
  url: string;
  /** Whether it loads a page's own top-level document: a link, a redirect, a typed address. */
  topLevel: boolean;
  /** The address of the top-level document that asked, when the engine knows it. */
  page?: string;
};

/**
 * Decide one request a task page made (docs/task-browser.md, "Where a page
 * may go"), as `decideRequest` does, with one more way to another server
 * on this Mac: a page's own top-level move to it, such as a sign-in's
 * return to a program, goes through, and `reach` names its origin for the
 * caller to keep in `reached`. Then that page's own requests to the same
 * origin go through too, while a request from any other page to it - a
 * website's hidden request to this Mac - stays refused.
 */
export function decidePageRequest(
  request: PageRequest,
  origins: ReadonlySet<string>,
  reached: ReadonlySet<string>,
  listed: ListedSite = () => false,
): RequestDecision | { allowed: true; reach: string } {
  const decision = decideRequest(request.url, origins, listed);
  if (decision.allowed || decision.kind !== "local") return decision;
  const url = parse(request.url);
  if (!url) return decision;
  const key = originKey(url);
  if (request.topLevel && (url.protocol === "http:" || url.protocol === "https:")) {
    return { allowed: true, reach: key };
  }
  const page = request.page ? parse(request.page) : undefined;
  if (page && reached.has(key) && isLoopbackHost(page.hostname) && originKey(page) === key) {
    return { allowed: true };
  }
  return decision;
}

/**
 * Why a page's own address is one its browser refuses, so the page shows
 * the browser engine's own refusal (docs/task-browser.md, "A page on a
 * refused address"): the address's host and port and its scheme's origin,
 * never its path or query, which may carry a sign-in's code. Nothing for an
 * address the browser reaches, or one that is not a web address, since no
 * page commits there.
 */
export function pageBlock(
  value: string,
  origins: ReadonlySet<string>,
  listed: ListedSite = () => false,
): { kind: TaskBrowserBlock; host: string; origin: string } | undefined {
  const decision = decideRequest(value, origins, listed);
  if (decision.allowed || decision.kind === "scheme") return undefined;
  const url = parse(value);
  if (!url) return undefined;
  return { kind: decision.kind, host: url.host, origin: `${url.protocol}//${url.host}/` };
}
