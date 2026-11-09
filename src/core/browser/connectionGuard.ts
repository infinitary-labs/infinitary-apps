import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, type IncomingMessage } from "node:http";
import { type AddressInfo, isIP, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { settingFrom } from "@shared/envSettings";
import { type AddressKind, addressKind } from "./addresses";

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
 * It listens on loopback alone, only while its browser is open, and answers
 * only that browser: the session signs in with a secret made for this one
 * guard, and any other caller is refused before anything is resolved. It
 * carries nothing but `CONNECT`. The session signs in once before its page
 * loads, by asking for `GUARD_SIGN_IN_HOST`, because a browser never
 * answers a sign-in challenge for a page's cross-origin picture, which may
 * be its first connection off this Mac.
 */

/** Why the guard did not carry a connection, as the crewmate is told. */
export type GuardRefusalKind = "private" | "unresolved" | "unreachable";
/** One address a name answered, and its kind. */
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
};

/** Every address a name resolves to. */
export type GuardLookup = (host: string) => Promise<string[]>;

export type ConnectionGuardOptions = {
  /** A connection the guard refused or could not make, by the host it named. */
  onRefused: (refusal: GuardRefusal) => void;
  /** The system's resolver when absent. */
  lookup?: GuardLookup;
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

export type ConnectionGuardHandle = GuardEndpoint & { close: () => void };

/**
 * The name a browser's session asks its guard for once, signed in, before
 * its page loads: answered at once, never resolved and never reported. A
 * reserved name, so no site can have it.
 */
export const GUARD_SIGN_IN_HOST = "sign-in.task-browser.invalid";

const CONNECT_MS = 10_000;
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
  let closed = false;
  const track = (socket: Duplex): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const signedIn = (request: IncomingMessage): boolean => {
    const given = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /** The first of the checked addresses that answers, or nothing. */
  const reach = async (addresses: string[], port: number): Promise<Duplex | undefined> => {
    for (const address of addresses) {
      if (closed) return undefined;
      const upstream = connect(address, port);
      track(upstream);
      const ok = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => done(false), connectMs);
        timer.unref?.();
        function done(result: boolean): void {
          clearTimeout(timer);
          upstream.off("connect", onConnect);
          upstream.off("error", onError);
          resolve(result);
        }
        const onConnect = (): void => done(true);
        const onError = (): void => done(false);
        upstream.once("connect", onConnect);
        upstream.once("error", onError);
      });
      if (ok && !closed) return upstream;
      upstream.destroy();
    }
    return undefined;
  };

  const server = createServer((_request, response) => {
    // Only tunnels: the page's own TLS rides them. A plain request is refused.
    response.writeHead(403, { connection: "close" });
    response.end();
  });
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
      const refuse = (kind: GuardRefusalKind, answers: readonly GuardAnswer[] = []): void => {
        options.onRefused({ host: target.host, kind, answers });
        answer(socket, kind === "private" ? "403 Forbidden" : "502 Bad Gateway");
      };
      let addresses: string[];
      if (isIP(target.host)) addresses = [target.host];
      else {
        try {
          addresses = await lookup(target.host);
        } catch {
          refuse("unresolved");
          return;
        }
      }
      if (closed) {
        socket.destroy();
        return;
      }
      if (addresses.length === 0) {
        refuse("unresolved");
        return;
      }
      // Only a checked public answer is ever dialed: a private one among
      // them is skipped, and a name with none is refused whole.
      const answers = addresses.map((address) => ({ address, kind: addressKind(address) }));
      const reachable = answers.filter((answer) => answer.kind === "public");
      if (reachable.length === 0) {
        refuse("private", answers);
        return;
      }
      const upstream = await reach(
        reachable.map((answer) => answer.address),
        target.port,
      );
      if (!upstream) {
        if (!closed) refuse("unreachable", answers);
        else socket.destroy();
        return;
      }
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
