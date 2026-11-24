import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { pipeline } from "node:stream";
import { rootCertificates } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { settingFrom } from "@shared/envSettings";
import { addressKind, literalAddress } from "../browser/addresses";
import { pageText } from "./pageText";

/** What a reader's `web_read` asks for: one address, and which part of its text. */
export type WebReadInput = { url: string; part?: number };

/**
 * A public web page as an unsafe data reader reads it (docs/agents-reach.md,
 * "An unsafe data reader", "Web pages"): one GET over https to an address on
 * the public internet, signed out, and its words turned to text.
 *
 * The name is resolved here, every answer must be public, and the request
 * connects only to the answers checked, on a fresh connection with the
 * normal certificate roots, so a name cannot lead to this computer, a
 * private network or a cloud's metadata service between the check and the
 * connection. A redirect is followed only to another https address that
 * passes the same check. No cookie, sign-in or header of the app's goes
 * with a request, and a cookie a page sets is never sent back.
 */

/** Why a page was not read, in words a crewmate is served. */
export class PageRefusal extends Error {
  constructor(
    message: string,
    /** True when nothing was sent to any address. */
    readonly beforeSend: boolean,
  ) {
    super(message);
    this.name = "PageRefusal";
  }
}

/** One reply's head and body, before its words are read. */
export type PageReply = { status: number; headers: IncomingHttpHeaders; body: IncomingMessage };

/**
 * How pages are reached: the system's resolver and an https request pinned
 * to the checked answers, or, in an unpackaged run that names them, stand-in
 * pages a test serves (`webReadNetwork`).
 */
export type WebReadNetwork = {
  resolve: (hostname: string) => Promise<readonly string[]>;
  send: (url: URL, addresses: readonly string[], signal: AbortSignal) => Promise<PageReply>;
  /**
   * A test's stand-in origin for a name, over plain http on this computer;
   * the name is then never resolved. Absent in a packaged app.
   */
  standIn?: (hostname: string) => string | undefined;
};

/** A page read whole: where it ended after redirects, its title and its text. */
export type ReadPage = { address: string; title: string; text: string; status: number };

/** The most bytes one page may send, after it is unpacked. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The redirects one read follows before it stops. */
const MAX_REDIRECTS = 5;
/** How long one read may take, start to end. */
const READ_MS = 30_000;

// i18n-exempt: served to the crewmate as a tool answer
const ONLY_PUBLIC_HTTPS =
  "web_read opens only a whole https address on the public internet, with no sign-in in it";

/**
 * The address as it will be read: absolute, https, with no sign-in in it,
 * and without its fragment, which a server never sees. Throws the refusal.
 */
export function pageAddress(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    // i18n-exempt: served to the crewmate as a tool answer
    throw new PageRefusal(
      `Refused: ${input} is not a whole web address. ${ONLY_PUBLIC_HTTPS}.`,
      true,
    );
  }
  // i18n-exempt: served to the crewmate as a tool answer
  if (url.protocol !== "https:")
    throw new PageRefusal(
      `Refused: ${url.protocol === "http:" ? "plain http" : `a ${url.protocol} address`} is not read. ${ONLY_PUBLIC_HTTPS}.`,
      true,
    );
  // i18n-exempt: served to the crewmate as a tool answer
  if (url.username || url.password)
    throw new PageRefusal(`Refused: the address carries a sign-in. ${ONLY_PUBLIC_HTTPS}.`, true);
  url.hash = "";
  const literal = literalAddress(url.hostname);
  if (literal) refuseUnlessPublic(url.hostname, [literal]);
  return url;
}

// i18n-exempt: served to the crewmate as a tool answer
const KIND_WORDS = {
  "this-computer": "this computer",
  private: "a private network",
  reserved: "an address that is not on the internet",
} as const;

/** Throws the refusal unless every answer for the name is on the public internet. */
function refuseUnlessPublic(hostname: string, addresses: readonly string[]): void {
  // i18n-exempt: served to the crewmate as a tool answer
  if (addresses.length === 0)
    throw new PageRefusal(`Refused: ${hostname} has no address. Nothing was sent.`, true);
  for (const address of addresses) {
    const kind = addressKind(address);
    // i18n-exempt: served to the crewmate as a tool answer
    if (kind !== "public")
      throw new PageRefusal(
        `Refused: ${hostname} leads to ${KIND_WORDS[kind]} (${address}). ${ONLY_PUBLIC_HTTPS}. Nothing was sent to it.`,
        true,
      );
  }
}

const lookupAll = async (hostname: string): Promise<readonly string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

const normalRoots = [...rootCertificates];

/**
 * The request a page read sends: GET, no cookie, no sign-in, nothing of
 * the app's or the person's, and a plain client name.
 */
// i18n-exempt: request headers a web server reads, not a person
const REQUEST_HEADERS = {
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
  "accept-encoding": "gzip, deflate, br",
  "user-agent": "Mozilla/5.0 (compatible; Infinitary web_read)",
};

/** An https GET that connects only to the addresses checked, never asking the resolver again. */
function pinnedSend(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<PageReply> {
  const address = addresses[0] as string;
  return new Promise((accept, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        agent: false,
        ca: normalRoots,
        rejectUnauthorized: true,
        ...(addresses.length > 1 ? { autoSelectFamily: true } : { family: isIP(address) }),
        lookup: (_hostname, options, callback) => {
          if (options.all)
            callback(
              null,
              addresses.map((checked) => ({ address: checked, family: isIP(checked) })),
            );
          else callback(null, address, isIP(address));
        },
        headers: REQUEST_HEADERS,
        signal,
      },
      (reply) => accept({ status: reply.statusCode ?? 0, headers: reply.headers, body: reply }),
    );
    request.on("error", reject);
    request.end();
  });
}

/** A stand-in page over plain http on this computer, for a test's listed name. */
function standInSend(origin: string, url: URL, signal: AbortSignal): Promise<PageReply> {
  const target = new URL(`${url.pathname}${url.search}`, origin);
  return new Promise((accept, reject) => {
    const request = httpRequest(
      target,
      { method: "GET", agent: false, headers: { ...REQUEST_HEADERS, host: url.host }, signal },
      (reply) => accept({ status: reply.statusCode ?? 0, headers: reply.headers, body: reply }),
    );
    request.on("error", reject);
    request.end();
  });
}

/**
 * The network a page read uses. An unpackaged run may name stand-in pages
 * with `INFINITARY_WEB_READ_HOSTS`, a JSON map of names to the http origin
 * on this computer that serves each, such as `{"pages.example":
 * "http://127.0.0.1:4123"}`; a listed name is never resolved, any other
 * name is not found and nothing else is sent, an address written as
 * numbers included, so a test's reader reaches no real network. A
 * packaged app never reads it.
 */
export function webReadNetwork(packaged: boolean, env = process.env): WebReadNetwork {
  const named = packaged ? undefined : settingFrom(env, "WEB_READ_HOSTS")?.trim();
  if (!named) return { resolve: lookupAll, send: pinnedSend };
  const hosts = new Map<string, string>();
  try {
    const parsed = JSON.parse(named) as unknown;
    if (parsed && typeof parsed === "object")
      for (const [name, origin] of Object.entries(parsed))
        if (typeof origin === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
          hosts.set(name.toLowerCase(), origin);
  } catch {
    // A map that does not read lists no name, and finds none.
  }
  return {
    resolve: async (hostname) => {
      throw Object.assign(new Error(`${hostname} not found`), { code: "ENOTFOUND" });
    },
    send: async (url) => {
      throw new Error(`${url.hostname} is not a stand-in page in this run`);
    },
    standIn: (hostname) => hosts.get(hostname.toLowerCase()),
  };
}

/** The body's bytes, unpacked, up to `PAGE_MAX_BYTES`; past it the page is cut. */
async function bodyBytes(reply: PageReply): Promise<{ bytes: Buffer; cut: boolean }> {
  const encoding = String(reply.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const unpack =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (encoding && encoding !== "identity" && !unpack) {
    reply.body.destroy();
    // i18n-exempt: served to the crewmate as a tool answer
    throw new PageRefusal(
      `Refused: the page came packed as ${encoding}, which is not read.`,
      false,
    );
  }
  // pipeline, not pipe: pipe never passes the body's error on, so a packed
  // page cut off by the time limit or a dropped connection would never end.
  // pipeline destroys the unpacker with that error, which the loop below throws.
  const stream = unpack ? pipeline(reply.body, unpack, () => {}) : reply.body;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      size += buffer.length;
      if (size >= PAGE_MAX_BYTES) {
        reply.body.destroy();
        return { bytes: Buffer.concat(chunks).subarray(0, PAGE_MAX_BYTES), cut: true };
      }
    }
  } catch (caught) {
    // i18n-exempt: served to the crewmate as a tool answer
    throw new PageRefusal(
      `The page stopped part way: ${caught instanceof Error ? caught.message : String(caught)}`,
      false,
    );
  }
  return { bytes: Buffer.concat(chunks), cut: false };
}

/** The media type and character set a reply names. */
function contentType(headers: IncomingHttpHeaders): { type: string; charset?: string } {
  const [type = "", ...params] = String(headers["content-type"] ?? "").split(";");
  const charset = params
    .map((param) => param.trim().split("="))
    .find(([name]) => name?.toLowerCase() === "charset")?.[1]
    ?.replace(/^"|"$/g, "");
  return { type: type.trim().toLowerCase(), ...(charset ? { charset } : {}) };
}

function isHtml(type: string): boolean {
  return type === "text/html" || type === "application/xhtml+xml";
}

function isText(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    /^application\/[\w.+-]+\+(json|xml)$/.test(type)
  );
}

function decode(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Read one public page: GET the address, follow at most five redirects to
 * checked https addresses, and turn the page into text. Throws a
 * `PageRefusal` saying why, and whether anything was sent.
 */
export async function readPublicPage(
  input: string,
  network: WebReadNetwork,
  outer?: AbortSignal,
): Promise<ReadPage> {
  const signal = outer
    ? AbortSignal.any([outer, AbortSignal.timeout(READ_MS)])
    : AbortSignal.timeout(READ_MS);
  let url = pageAddress(input);
  let sent = false;
  for (let hop = 0; ; hop++) {
    let reply: PageReply;
    try {
      const origin = network.standIn?.(url.hostname);
      if (origin) {
        sent = true;
        reply = await standInSend(origin, url, signal);
      } else {
        const literal = literalAddress(url.hostname);
        let addresses: readonly string[];
        try {
          addresses = literal ? [literal] : await network.resolve(url.hostname);
        } catch {
          // i18n-exempt: served to the crewmate as a tool answer
          throw new PageRefusal(`${url.hostname} could not be found. Nothing was sent.`, !sent);
        }
        refuseUnlessPublic(url.hostname, addresses);
        sent = true;
        reply = await network.send(url, addresses, signal);
      }
    } catch (caught) {
      if (caught instanceof PageRefusal) throw new PageRefusal(caught.message, !sent);
      // i18n-exempt: served to the crewmate as a tool answer
      const why = signal.aborted
        ? `it took longer than ${READ_MS / 1000} seconds`
        : caught instanceof Error
          ? caught.message
          : String(caught);
      // i18n-exempt: served to the crewmate as a tool answer
      throw new PageRefusal(`${url.href} could not be read: ${why}.`, false);
    }
    const location = reply.headers.location;
    if (reply.status >= 300 && reply.status < 400 && location) {
      reply.body.destroy();
      // i18n-exempt: served to the crewmate as a tool answer
      if (hop >= MAX_REDIRECTS)
        throw new PageRefusal(
          `${input} redirected more than ${MAX_REDIRECTS} times, so it was not read.`,
          false,
        );
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        // i18n-exempt: served to the crewmate as a tool answer
        throw new PageRefusal(`${url.href} redirected to an address that does not read.`, false);
      }
      try {
        url = pageAddress(next.href);
      } catch (caught) {
        // i18n-exempt: served to the crewmate as a tool answer
        throw new PageRefusal(
          `${url.href} redirected to ${next.href}, which is not read: ${caught instanceof Error ? caught.message : String(caught)}`,
          false,
        );
      }
      continue;
    }
    const { type, charset } = contentType(reply.headers);
    if (type !== "" && !isHtml(type) && !isText(type)) {
      reply.body.destroy();
      // i18n-exempt: served to the crewmate as a tool answer
      throw new PageRefusal(
        `${url.href} is ${type}, not a page of text, so it was not read.`,
        false,
      );
    }
    const { bytes, cut } = await bodyBytes(reply);
    const words = decode(bytes, charset);
    const page =
      isHtml(type) || (type === "" && /^\s*</.test(words))
        ? pageText(words, url)
        : { title: "", text: words };
    // i18n-exempt: served to the crewmate as a tool answer
    return {
      address: url.href,
      title: page.title,
      text: cut
        ? `${page.text}\n\n(The page was cut at ${PAGE_MAX_BYTES / 1024 / 1024} MB.)`
        : page.text,
      status: reply.status,
    };
  }
}
