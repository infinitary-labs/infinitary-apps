import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import {
  assertCustomApiAddresses,
  type CustomApiDestination,
  type CustomNetworkMode,
  classifyCustomApiAddresses,
  customApiHostname,
  normalizeCustomApiBase,
} from "../../../pi/customApiPolicy";

/**
 * An MCP server's address, reached the way a custom API is
 * (docs/integrations.md, "MCP servers"; `src/core/pi/customApiTransport.ts`):
 * the address's network class - this computer, a private network or the
 * public internet - is read once when the server is added and held on
 * every request. Each request resolves the name again, refuses an answer
 * outside that class, and connects only to the checked addresses, on a
 * fresh connection with the normal certificate roots. A redirect is
 * refused, and so is a request to any other origin. Plain http is only
 * for a server on this computer.
 */

export type McpResolver = (hostname: string) => Promise<readonly string[]>;

/** The fetch the SDK's Streamable HTTP transport calls (`FetchLike`). */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** An address that cannot be reached safely; the message says why in the person's words. */
export class McpAddressError extends Error {}

const lookupAll: McpResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

const normalRoots = [...rootCertificates];

/** Read an address's network class now, from every DNS answer of its name. */
export async function readMcpDestination(
  address: string,
  resolve: McpResolver = lookupAll,
): Promise<CustomApiDestination> {
  let hostname: string;
  try {
    hostname = customApiHostname(address);
  } catch {
    throw new McpAddressError(
      "That address cannot be used: write it whole, with no sign-in, query or # in it.",
    );
  }
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new McpAddressError(`${hostname} could not be found.`);
  }
  let mode: CustomNetworkMode;
  try {
    mode = classifyCustomApiAddresses(addresses);
  } catch {
    throw new McpAddressError(`${hostname} points somewhere Infinitary does not connect to.`);
  }
  return holdMcpDestination(address, mode);
}

/** An address with the network class it was added under. */
export function holdMcpDestination(address: string, mode: CustomNetworkMode): CustomApiDestination {
  let destination: CustomApiDestination;
  try {
    destination = normalizeCustomApiBase(address, mode);
  } catch {
    throw new McpAddressError(
      "That address cannot be used: write it whole, with no sign-in, query or # in it.",
    );
  }
  if (destination.baseUrl.startsWith("http:") && destination.mode !== "local")
    throw new McpAddressError(
      "Plain http is only for a server on this computer: use the server's https address.",
    );
  return destination;
}

/**
 * The fetch every request to one server goes through. `roots` are the
 * certificate authorities an https address is checked against, the normal
 * roots unless its caller trusts more, as the usage report's connection
 * trusts the computer's list.
 */
export function guardedMcpFetch(
  destination: CustomApiDestination,
  resolve: McpResolver = lookupAll,
  roots: () => readonly string[] = () => normalRoots,
): McpFetch {
  const origin = new URL(destination.baseUrl).origin;
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    if (url.origin !== origin)
      throw new McpAddressError("The server sent the request to another address; it was not sent.");
    const addresses = isIP(destination.hostname)
      ? [destination.hostname]
      : await resolve(destination.hostname);
    try {
      assertCustomApiAddresses(addresses, destination.mode);
    } catch {
      throw new McpAddressError(
        `${destination.hostname} now points somewhere other than when it was added; remove it and add it again.`,
      );
    }
    return sendPinned(
      url,
      init,
      addresses,
      () =>
        new McpAddressError(
          "The server redirected the request elsewhere; add the address it ends at instead.",
        ),
      roots(),
    );
  };
}

/**
 * The fetch a server's sign-in goes through (docs/integrations.md, "MCP
 * servers that sign in"): its documents, its registration, its token and
 * its revocation, at whatever address the server's documents name, since a
 * sign-in often lives at another address than the server (Todoist's at
 * todoist.com). Each request is https, resolves its name again, connects
 * only to the checked addresses and follows no redirect. An address in a
 * private network or on this computer is reached only when the server itself
 * is there, and plain http only for a server on this computer.
 */
export function guardedSignInFetch(
  server: CustomNetworkMode,
  resolve: McpResolver = lookupAll,
): McpFetch {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    const addresses = await checkSignInAddress(url, server, resolve);
    return sendPinned(
      url,
      init,
      addresses,
      () =>
        new McpAddressError(
          `The sign-in at ${url.hostname} answered with a redirect, which Infinitary does not follow.`,
        ),
    );
  };
}

/**
 * Whether a sign-in address may be reached from a server added under
 * `server`'s network class: the checked addresses, or words saying why not.
 */
export async function checkSignInAddress(
  url: URL,
  server: CustomNetworkMode,
  resolve: McpResolver = lookupAll,
): Promise<readonly string[]> {
  if (url.username || url.password)
    throw new McpAddressError("The server's sign-in names an address with a sign-in in it.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && server === "local"))
    throw new McpAddressError(
      `The server's sign-in is at ${url.hostname} over plain http, which Infinitary does not use. It needs https.`,
    );
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  } catch {
    throw new McpAddressError(`The server's sign-in at ${url.hostname} could not be found.`);
  }
  let mode: CustomNetworkMode;
  try {
    mode = classifyCustomApiAddresses(addresses);
  } catch {
    throw new McpAddressError(
      `The server's sign-in at ${url.hostname} points somewhere Infinitary does not connect to.`,
    );
  }
  if (mode !== "public" && mode !== server)
    throw new McpAddressError(
      `The server's sign-in at ${url.hostname} is in a private network, but the server is not, so Infinitary does not reach it.`,
    );
  if (url.protocol === "http:" && mode !== "local")
    throw new McpAddressError(
      `The server's sign-in is at ${url.hostname} over plain http, which Infinitary does not use. It needs https.`,
    );
  return addresses;
}

/**
 * Send one request to `url` on a fresh connection to the checked
 * `addresses` alone, checked against `roots`; a redirect is refused with
 * the `redirected` error.
 */
function sendPinned(
  url: URL,
  init: RequestInit,
  addresses: readonly string[],
  redirected: () => McpAddressError,
  roots: readonly string[] = normalRoots,
): Promise<Response> {
  return (async () => {
    const address = addresses[0] as string;
    const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers));
    const body =
      init.body === undefined || init.body === null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : Buffer.from(await new Response(init.body).arrayBuffer());
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((accept, reject) => {
      const request = send(
        url,
        {
          method: init.method ?? "GET",
          agent: false,
          ...(addresses.length > 1 ? { autoSelectFamily: true } : { family: isIP(address) }),
          ...(url.protocol === "https:" ? { ca: [...roots], rejectUnauthorized: true } : {}),
          // No second DNS answer between the check and the connection.
          lookup: (_hostname, options, callback) => {
            if (options.all)
              callback(
                null,
                addresses.map((checked) => ({ address: checked, family: isIP(checked) })),
              );
            else callback(null, address, isIP(address));
          },
          headers,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (reply) => {
          const status = reply.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            reply.destroy();
            reject(redirected());
            return;
          }
          const replyHeaders = new Headers();
          for (const [name, value] of Object.entries(reply.headers)) {
            if (Array.isArray(value)) for (const one of value) replyHeaders.append(name, one);
            else if (value !== undefined) replyHeaders.set(name, value);
          }
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) reply.resume();
          accept(
            new Response(empty ? null : (Readable.toWeb(reply) as ReadableStream<Uint8Array>), {
              status,
              headers: replyHeaders,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  })();
}
