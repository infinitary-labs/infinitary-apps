import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, isIP, connect as netConnect, type Socket } from "node:net";
import { type Duplex, pipeline } from "node:stream";
import { settingFrom } from "@shared/envSettings";
import { type AddressKind, addressKind, neverReachable } from "./addresses";
import { isLoopbackHost } from "./destinations";

/**
 * A task browser's connection guard (docs/task-browser.md, "Where a page
 * may go"; docs/architecture.md section 1): the one way its page reaches
 * the internet, and where a private address is refused at the connection
 * itself.
 *
 * The page's session sends every connection that is not to this Mac's own
 * loopback here as an HTTP `CONNECT`. The guard resolves the name itself,
 * dials only the answers it checked are public - skipping any private one
 * among them, and refusing a name with none - and never resolves it again,
 * so a public name that leads to a private address, or changes to one
 * between a check and a connection, never reaches this Mac's network. A tunnel then carries the
 * page's own TLS, end to end, which the guard neither reads nor ends.
 *
 * A name on the captain's private sites list (`listed`, docs/task-browser.md,
 * "Private sites") may also reach its answers on a private network, never
 * one no allowance reaches (`neverReachable`), and only such a name may ask
 * for a plain http page, which the guard carries to the address it checked.
 *
 * An engine that cannot keep this Mac's loopback off its proxy for every
 * connection (Google Chrome's websockets, docs/task-browser.md, "Installed browser engines") sends loopback here too: the guard carries it
 * to this Mac only for a host and port its browser registered (`local`),
 * never through a name server, and refuses every other as this Mac's.
 *
 * It listens on loopback alone, only while its browser is open, and answers
 * only that browser: the session signs in with a secret made for this one
 * guard, and any other caller is refused before anything is resolved. It
 * carries `CONNECT`, and a plain http request only for a listed name. The session signs in once before its page
 * loads, by asking for `GUARD_SIGN_IN_HOST`, because a browser never
 * answers a sign-in challenge for a page's cross-origin picture, which may
 * be its first connection off this Mac.
 */

/** Why the guard did not carry a connection, as the crewmate is told. */
export type GuardRefusalKind = "private" | "unresolved" | "unreachable";
export type GuardAnswer = { address: string; kind: AddressKind };
/**
 * A refused or failed connection, with every address the name answered
 * (none when it was not found): a private refusal's are all non-public, and
 * an unreachable name's are the public ones it tried and any it skipped.
 */
export type GuardRefusal = {
  host: string;
  kind: GuardRefusalKind;
  answers: readonly GuardAnswer[];
  /** The name is on the captain's private sites list, so its private answers were admitted too. */
  listed?: true;
  /**
   * An unreachable name whose every dialed address this computer's
   * network has no route to, as when a name has only IPv6 addresses and
   * the network has no IPv6: no server was ever asked.
   */
  noRoute?: true;
};

/** What a dial answers when the computer's network has no way to the address. */
const NO_ROUTE = new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT"]);

export type GuardLookup = (host: string) => Promise<string[]>;

export type ConnectionGuardOptions = {
  onRefused: (refusal: GuardRefusal) => void;
  /** The system's resolver when absent. */
  lookup?: GuardLookup;
  /** Whether a name is on the captain's private sites list, read at each connection; none is when absent. */
  listed?: (host: string) => boolean;
  /**
   * Whether its browser may reach a host and port on this Mac's loopback,
   * as `URL` writes the host, read at each connection; none may when
   * absent.
   */
  local?: (host: string, port: number) => boolean;
  /** Opens the socket to a checked address; a test stands in its own. */
  connect?: (address: string, port: number) => Duplex;
  /** How long one address may take to answer before the next is tried. */
  connectMs?: number;
};

/** Where a task browser's session sends its connections, and the sign-in it answers with. */
export type GuardEndpoint = {
  host: "127.0.0.1";
  port: number;
  username: string;
  password: string;
};

export type ConnectionGuardHandle = GuardEndpoint & {
  close: () => void;
  /**
   * The private sites list changed: every connection a name's listing let
   * through ends once that name is no longer listed. A stand-in may omit it.
   */
  recheck?: () => void;
};

/**
 * The name a browser's session asks its guard for once, signed in, before
 * its page loads: answered at once, never resolved and never reported. A
 * reserved name, so no site can have it.
 */
export const GUARD_SIGN_IN_HOST = "sign-in.task-browser.invalid";

const CONNECT_MS = 10_000;
/** Headers that speak of one hop alone, which a carried http request leaves behind. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REALM = "task browser";

const systemLookup: GuardLookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const defaultConnect = (address: string, port: number): Socket =>
  netConnect({ host: address, port });

/**
 * A lookup that answers only from a fixed map of names to addresses, and
 * finds no other name: an unpackaged run's stand-in for the resolver, so an
 * end-to-end run reaches no real network. Every answer is still checked.
 */
export function hostsLookup(hosts: Record<string, string[]>): GuardLookup {
  return async (host) => {
    const addresses = hosts[host.toLowerCase()];
    if (!addresses || addresses.length === 0) {
      throw Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" });
    }
    return addresses;
  };
}

/** The host and port a `CONNECT` names, or nothing for one that names none. */
function targetOf(request: IncomingMessage): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(request.url ?? "");
  if (!match) return undefined;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: (match[1] ?? match[2] ?? "").toLowerCase(), port };
}

function answer(socket: Duplex, status: string, headers: string[] = []): void {
  socket.end(
    [`HTTP/1.1 ${status}`, ...headers, "Content-Length: 0", "Connection: close", "", ""].join(
      "\r\n",
    ),
  );
}

/** Start a guard for one task browser; it listens until `close`. */
export async function startConnectionGuard(
  options: ConnectionGuardOptions,
): Promise<ConnectionGuardHandle> {
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? defaultConnect;
  const connectMs = options.connectMs ?? CONNECT_MS;
  const username = "task";
  const password = randomBytes(32).toString("base64url");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const sockets = new Set<Duplex>();
  /** Each connection to a listed name, by that name, so a Remove ends it. */
  const byListing = new Map<Duplex, string>();
  let closed = false;
  const track = (socket: Duplex): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const signedIn = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /**
   * The first of the checked addresses that answers, or nothing, and
   * whether the network had no route to any of them.
   */
  const reach = async (
    addresses: string[],
    port: number,
  ): Promise<{ upstream?: Duplex; noRoute: boolean }> => {
    let routed = false;
    for (const address of addresses) {
      if (closed) return { noRoute: false };
      const upstream = connect(address, port);
      track(upstream);
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          routed = true;
          done(false);
        }, connectMs);
        timer.unref?.();
        function done(result: boolean): void {
          clearTimeout(timer);
          upstream.off("connect", onConnect);
          upstream.off("error", onError);
          resolve(result);
        }
        const onConnect = (): void => done(true);
        const onError = (error: unknown): void => {
          const code = (error as { code?: unknown } | undefined)?.code;
          if (typeof code !== "string" || !NO_ROUTE.has(code)) routed = true;
          done(false);
        };
        upstream.once("connect", onConnect);
        upstream.once("error", onError);
      });
      if (ok && !closed) return { upstream, noRoute: false };
      upstream.destroy();
    }
    return { noRoute: addresses.length > 0 && !routed };
  };

  /**
   * A host on this Mac's loopback: dialed on loopback alone, never resolved,
   * and only when its browser registered it.
   */
  const loopback = async (
    host: string,
    port: number,
  ): Promise<{ ok: true; upstream: Duplex } | { ok: false; refusal?: GuardRefusal }> => {
    const written = isIP(host) === 6 ? `[${host}]` : host;
    const addresses = isIP(host) ? [host] : ["127.0.0.1", "::1"];
    const answers = addresses.map((address) => ({ address, kind: addressKind(address) }));
    if (options.local?.(written, port) !== true) {
      return { ok: false, refusal: { host, kind: "private", answers } };
    }
    const { upstream } = await reach(addresses, port);
    if (upstream) return { ok: true, upstream };
    return closed ? { ok: false } : { ok: false, refusal: { host, kind: "unreachable", answers } };
  };

  /**
   * Resolve a name once and dial only the answers it may reach: public
   * ones, and for a listed name a private network's too, never one no
   * allowance reaches. Nothing when the guard closed meanwhile.
   */
  const admit = async (
    host: string,
    port: number,
  ): Promise<{ ok: true; upstream: Duplex } | { ok: false; refusal?: GuardRefusal }> => {
    if (isLoopbackHost(isIP(host) === 6 ? `[${host}]` : host)) return loopback(host, port);
    const listed = !isIP(host) && options.listed?.(host) === true;
    const refused = (
      kind: GuardRefusalKind,
      answers: readonly GuardAnswer[] = [],
    ): { ok: false; refusal: GuardRefusal } => ({
      ok: false,
      refusal: { host, kind, answers, ...(listed ? { listed: true as const } : {}) },
    });
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = await lookup(host);
      } catch {
        return closed ? { ok: false } : refused("unresolved");
      }
    }
    if (closed) return { ok: false };
    if (addresses.length === 0) return refused("unresolved");
    // Only a checked answer is ever dialed: one it may not reach is
    // skipped, and a name with none it may reach is refused whole.
    const answers = addresses.map((address) => ({ address, kind: addressKind(address) }));
    const reachable = answers.filter(
      (answer) =>
        answer.kind === "public" ||
        (listed && answer.kind === "private" && !neverReachable(answer.address)),
    );
    if (reachable.length === 0) return refused("private", answers);
    const { upstream, noRoute } = await reach(
      reachable.map((answer) => answer.address),
      port,
    );
    if (!upstream) {
      if (closed) return { ok: false };
      const refusal = refused("unreachable", answers);
      return noRoute ? { ok: false, refusal: { ...refusal.refusal, noRoute: true } } : refusal;
    }
    if (listed) {
      // A Remove that landed while this name was being dialed ends it here.
      if (options.listed?.(host) !== true) {
        upstream.destroy();
        return refused("private", answers);
      }
      byListing.set(upstream, host);
      upstream.once("close", () => byListing.delete(upstream));
    }
    return { ok: true, upstream };
  };

  /**
   * A plain http request, which a page's session sends its proxy whole: only
   * for a name on the private sites list, carried to the address the guard
   * checked, or for a host and port on this Mac's loopback its browser
   * registered. Every other one is refused, since a public website is reached
   * over https alone.
   */
  const forward = (request: IncomingMessage, response: ServerResponse): void => {
    if (!signedIn(request)) {
      response.writeHead(407, {
        "proxy-authenticate": `Basic realm="${REALM}"`,
        connection: "close",
      });
      response.end();
      return;
    }
    let url: URL | undefined;
    try {
      url = new URL(request.url ?? "");
    } catch {
      url = undefined;
    }
    const written = url?.hostname.toLowerCase() ?? "";
    // `URL` keeps an IPv6 address in brackets; a dial takes it without.
    const host = written.replace(/^\[(.*)\]$/, "$1");
    const reachable = isLoopbackHost(written) || (!isIP(host) && options.listed?.(host) === true);
    if (url?.protocol !== "http:" || !reachable) {
      response.writeHead(403, { connection: "close" });
      response.end();
      return;
    }
    const port = Number(url.port || 80);
    const path = `${url.pathname}${url.search}`;
    void (async () => {
      const reached = await admit(host, port);
      if (!reached.ok) {
        if (reached.refusal) {
          options.onRefused(reached.refusal);
          // Nothing listening on a registered port of this Mac reads as a
          // failed request, as it does where the browser dials it itself.
          if (reached.refusal.kind === "unreachable" && isLoopbackHost(written)) {
            response.destroy();
            return;
          }
          response.writeHead(reached.refusal.kind === "private" ? 403 : 502, {
            connection: "close",
          });
          response.end();
        } else response.destroy();
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_HEADERS.has(name)) continue;
        headers[name] = value;
      }
      headers.connection = "close";
      const upstream = reached.upstream;
      const outgoing = httpRequest({
        method: request.method ?? "GET",
        path,
        headers,
        setHost: false,
        createConnection: () => upstream as Socket,
      });
      outgoing.on("response", (incoming) => {
        const back: string[] = [];
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index] ?? "";
          if (HOP_HEADERS.has(name.toLowerCase())) continue;
          back.push(name, incoming.rawHeaders[index + 1] ?? "");
        }
        response.writeHead(incoming.statusCode ?? 502, back);
        // Either side ending ends the other, so neither waits on a gone peer.
        pipeline(incoming, response, () => upstream.destroy());
      });
      // A server that drops the connection reaches the browser as a dropped
      // connection, so the page reads a failed request, as it does where the
      // browser dials the server itself, never an answer the server did not give.
      outgoing.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      pipeline(request, outgoing, (error) => {
        if (error) upstream.destroy();
      });
    })();
  };

  const server = createServer(forward);
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      if (!signedIn(request)) {
        answer(socket, "407 Proxy Authentication Required", [
          `Proxy-Authenticate: Basic realm="${REALM}"`,
        ]);
        return;
      }
      const target = targetOf(request);
      if (!target) {
        answer(socket, "400 Bad Request");
        return;
      }
      if (target.host === GUARD_SIGN_IN_HOST) {
        answer(socket, "204 No Content");
        return;
      }
      const reached = await admit(target.host, target.port);
      if (!reached.ok) {
        if (reached.refusal) {
          options.onRefused(reached.refusal);
          answer(socket, reached.refusal.kind === "private" ? "403 Forbidden" : "502 Bad Gateway");
        } else socket.destroy();
        return;
      }
      const upstream = reached.upstream;
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    host: "127.0.0.1",
    port,
    username,
    password,
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    recheck: () => {
      for (const [upstream, host] of byListing)
        if (options.listed?.(host) !== true) upstream.destroy();
    },
  };
}

/**
 * The names an unpackaged run's task browsers resolve, when it names them
 * (`INFINITARY_TASK_BROWSER_HOSTS`, a JSON map of names to addresses): an
 * end-to-end run's stand-in for the resolver, so no page reaches a real
 * network and a name can lead wherever the run needs. The guard still
 * checks every answer, so it can only narrow what a page reaches. A
 * packaged app never reads it. The home's browsers and those of a computer
 * that runs work for it read it alike.
 */
export function browserLookup(packaged: boolean): { lookup?: GuardLookup } {
  const named = packaged ? undefined : settingFrom(process.env, "TASK_BROWSER_HOSTS")?.trim();
  if (!named) return {};
  const hosts: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(named) as unknown;
    if (parsed && typeof parsed === "object") {
      for (const [name, addresses] of Object.entries(parsed)) {
        if (Array.isArray(addresses)) hosts[name.toLowerCase()] = addresses.map(String);
      }
    }
  } catch {
    // A map that does not read finds no name at all.
  }
  return { lookup: hostsLookup(hosts) };
}
