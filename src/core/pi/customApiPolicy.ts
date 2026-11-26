import { BlockList, isIP } from "node:net";
import { CUSTOM_API_MAX_HEADERS, type CustomApiFailureCategory } from "@shared/customApi";
import { neverReachable } from "../browser/addresses";

export type CustomNetworkMode = "public" | "private" | "local";
export type CustomApiFailure = CustomApiFailureCategory;

const messages: Record<CustomApiFailure, string> = {
  address:
    "Enter an absolute API base address without credentials, queries or an operation suffix.",
  destination: "The server address is not allowed in this connection's network mode.",
  credential: "Enter a literal key that can be sent safely as a bearer credential.",
  header:
    "Enter each extra header once, as a plain name and a one-line value. Names Infinitary sets itself cannot be used.",
  redirect: "The server redirected the request. Enter and approve its base address separately.",
  "key-rejected": "The server rejected the key. Review or replace it.",
  "access-refused": "The server refused access. Check the account's permission.",
  "not-found": "The server could not find the requested API or model.",
  "rate-limit": "The server is limiting requests. Try again later.",
  server: "The server could not complete the request.",
  certificate: "The server's certificate could not be verified.",
  network: "The server could not be reached.",
  timeout: "The server took too long to answer.",
  stalled: "The server stopped sending its reply.",
  cancelled: "The request was cancelled.",
  closed: "This connection has been closed.",
  oversized: "The server reply or request exceeded the connection's size limit.",
  malformed: "The server returned an unsupported reply.",
  "certificate-policy":
    "Supply valid public CA certificates and approve them for this private connection.",
  incompatible:
    "The server did not complete the selected text and tool protocol. Review the connection or choose another model.",
  limits:
    "Enter documented positive whole-number context and output limits, with output below context.",
  // Worded as an overflow Pi recognizes (`isContextOverflow`), so a rolling
  // session compacts and retries the refused turn instead of failing it.
  "context-limit": "This request exceeds the context window. Shorten it before trying again.",
};

/**
 * Never retain a raw error, body, header, URL or credential as message/cause.
 * A refused destination keeps the DNS answers it was refused for, so the form
 * can say what DNS answered; they are addresses, never part of the message.
 * A refused request keeps a short excerpt of the server's reason, cut, cleaned
 * and checked for echoed secrets by the transport; it too stays off the message.
 */
export class CustomApiError extends Error {
  constructor(
    readonly category: CustomApiFailure,
    readonly status?: number,
    readonly baseSuggestion?: string,
    readonly addresses?: readonly string[],
    readonly reason?: string,
  ) {
    super(messages[category]);
    this.name = "CustomApiError";
  }
}

export type CustomApiDestination = Readonly<{
  baseUrl: string;
  hostname: string;
  mode: CustomNetworkMode;
}>;

type ParsedBase = { url: URL; hostname: string; rawHost: string };

/** The address's syntax alone, before any network class is known. */
function parseCustomApiBase(input: string): ParsedBase {
  if (typeof input !== "string" || input.length > 4096) throw new CustomApiError("address");
  const raw = input.trim();
  if (
    !/^https?:\/\/[^/]+/i.test(raw) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject URL parser control-character normalization before destination consent.
    /[\\?#\s\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new CustomApiError("address");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CustomApiError("address");
  }
  const rawAuthority = raw.split("/")[2];
  if (!rawAuthority) throw new CustomApiError("address");
  const rawPath = raw.slice(raw.indexOf("://") + 3 + rawAuthority.length);
  if (
    url.username ||
    url.password ||
    rawAuthority.includes("@") ||
    rawPath.includes("%") ||
    /[^\x21-\x7e]/.test(rawPath) ||
    rawPath.split("/").some((part) => part === "." || part === "..") ||
    rawPath.replace(/\/+$/, "").includes("//")
  ) {
    throw new CustomApiError("address");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const rawHost = rawAuthority.startsWith("[")
    ? rawAuthority.slice(1, rawAuthority.indexOf("]"))
    : rawAuthority.split(":")[0];
  // WHATWG accepts integer, octal, hexadecimal and shortened IPv4 spellings.
  if (isIP(hostname) === 4 && rawHost !== hostname) throw new CustomApiError("address");
  return { url, hostname, rawHost: rawHost ?? "" };
}

/** The host an address names, for reading its network before a class is chosen. */
export function customApiHostname(input: string): string {
  return parseCustomApiBase(input).hostname;
}

/** No guessed /v1; conservative paths avoid normalization changing consent. */
export function normalizeCustomApiBase(
  input: string,
  mode: CustomNetworkMode,
): CustomApiDestination {
  if (!["public", "private", "local"].includes(mode)) throw new CustomApiError("address");
  const { url, hostname, rawHost } = parseCustomApiBase(input);
  if (mode === "local") {
    // Names are checked against every DNS answer at request time; keep the
    // original name for Host routing and TLS identity on local proxies.
    if (isIP(hostname) && !["127.0.0.1", "::1"].includes(hostname)) {
      throw new CustomApiError("destination");
    }
    if (hostname === "::1" && rawHost !== "::1") throw new CustomApiError("address");
  } else if (isIP(hostname)) {
    assertCustomApiAddresses([hostname], mode);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = url.toString().replace(/\/$/, "");
  const suffix = /\/(?:chat\/completions|responses|models)$/i;
  if (suffix.test(baseUrl)) {
    throw new CustomApiError("address", undefined, baseUrl.replace(suffix, ""));
  }
  return Object.freeze({ baseUrl, hostname, mode });
}

function ranges(entries: [string, number][]): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of entries) {
    list.addSubnet(address, prefix, isIP(address) === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

const privateRanges = ranges([
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["fc00::", 7],
]);
const loopback = ranges([
  ["127.0.0.0", 8],
  ["::1", 128],
]);
const forbidden = ranges([
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
  // Known metadata/virtual-service destinations outside link-local ranges.
  ["100.100.100.200", 32],
  ["168.63.129.16", 32],
  ["fd00:ec2::254", 128],
  ["fd20:ce::254", 128],
  ["::", 128],
  ["::1", 128],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]);
const globalV6 = ranges([["2000::", 3]]);
const mappedV4 = ranges([["::ffff:0:0", 96]]);

function has(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** All DNS answers must stay in the approved class, not just the first one. */
export function assertCustomApiAddresses(
  addresses: readonly string[],
  mode: CustomNetworkMode,
): void {
  if (!addresses.length) throw new CustomApiError("destination");
  for (const address of addresses) {
    const family = isIP(address);
    const allowed =
      family &&
      (mode === "local"
        ? has(loopback, address)
        : !has(forbidden, address) &&
          (mode === "private"
            ? has(privateRanges, address)
            : !has(privateRanges, address) &&
              (family === 4 || has(globalV6, address) || has(mappedV4, address))));
    if (!allowed) throw new CustomApiError("destination");
  }
}

/** The kind of network one DNS answer points to, as the form tells it. */
export function customApiAnswerKind(address: string): "local" | "private" | "public" | "reserved" {
  if (!isIP(address)) return "reserved";
  if (has(loopback, address)) return "local";
  if (has(forbidden, address)) return "reserved";
  if (has(privateRanges, address)) return "private";
  if (isIP(address) === 4 || has(globalV6, address) || has(mappedV4, address)) return "public";
  return "reserved";
}

/**
 * Whether the person may make an exception for these answers: every one is an
 * address, and none is one no allowance reaches (`neverReachable`, shared
 * with the task browsers' private sites), directly or through NAT64.
 */
export function customApiExceptionAllows(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every((address) => !neverReachable(address));
}

/** An excepted address's answers, checked on every request as a class is. */
export function assertCustomApiException(addresses: readonly string[]): void {
  if (!customApiExceptionAllows(addresses))
    throw new CustomApiError("destination", undefined, undefined, addresses);
}

/**
 * The one network class every DNS answer belongs to: this Mac, an
 * organization's private network or the public internet. Answers in two
 * classes, or in a forbidden range, have none.
 */
export function classifyCustomApiAddresses(addresses: readonly string[]): CustomNetworkMode {
  for (const mode of ["local", "private", "public"] as const) {
    try {
      assertCustomApiAddresses(addresses, mode);
      return mode;
    } catch {}
  }
  throw new CustomApiError("destination", undefined, undefined, addresses);
}

/** Command/environment-looking keys remain data; no substitution or trimming. */
export function assertLiteralBearerKey(key: string): void {
  if (
    typeof key !== "string" ||
    !key ||
    key.length > 8192 ||
    /[^\x20-\x7e]/.test(key) ||
    key.trim() !== key
  ) {
    throw new CustomApiError("credential");
  }
}

// Headers the transport owns or that change how a request travels or is read.
const reservedHeaders = new Set([
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

/**
 * Extra headers are literal data: a token name, one printable line of value,
 * never a name the transport sets or one that changes the request's framing,
 * route or proxying. `Authorization` is the key's own, so a header may set it
 * only on a connection that sends no key.
 */
export function assertCustomHeaders(
  headers: readonly { name: string; value: string }[],
  keyed: boolean,
): void {
  if (!Array.isArray(headers) || headers.length > CUSTOM_API_MAX_HEADERS)
    throw new CustomApiError("header");
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    const lower = typeof name === "string" ? name.toLowerCase() : "";
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      reservedHeaders.has(lower) ||
      lower.startsWith("proxy-") ||
      (keyed && lower === "authorization") ||
      seen.has(lower) ||
      typeof value !== "string" ||
      !value ||
      value.length > 8192 ||
      /[^\x20-\x7e]/.test(value) ||
      value.trim() !== value
    ) {
      throw new CustomApiError("header");
    }
    seen.add(lower);
  }
}
