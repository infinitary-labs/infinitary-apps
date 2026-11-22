import { createServer as createHttpServer } from "node:http";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { listsPrivateSite } from "@shared/privateSites";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConnectionGuardHandle,
  GUARD_SIGN_IN_HOST,
  type GuardRefusal,
  hostsLookup,
  startConnectionGuard,
} from "./connectionGuard";

/**
 * A task browser's connection guard: the page's every connection to the
 * internet goes through it, and it connects only to a public address it
 * resolved and checked itself. A stand-in "site" on loopback plays the
 * public server, reached only through the guard's own connect, so nothing
 * here touches a real network.
 */

const open: { close: () => void }[] = [];

afterEach(() => {
  for (const item of open.splice(0)) item.close();
});

/** An echo server standing in for a public site: it answers "pong" to "ping". */
async function site(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    socket.on("data", (data) => {
      if (data.toString() === "ping") socket.write("pong");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => server.close() });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, server };
}

type Started = {
  guard: ConnectionGuardHandle;
  refused: GuardRefusal[];
  lookups: string[];
  connects: string[];
};

/** A plain http server standing in for a private site: it answers with what it was asked. */
async function webSite(): Promise<{ port: number }> {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(
      `${request.method} ${request.url} host=${request.headers.host} proxy=${request.headers["proxy-authorization"] ?? "none"}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => server.close() });
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0 };
}

async function guarded(
  hosts: Record<string, string[]>,
  sitePort?: number,
  /** The captain's private sites list (INF-3116, answer A). */
  sites: readonly string[] = [],
): Promise<Started> {
  const refused: GuardRefusal[] = [];
  const lookups: string[] = [];
  const connects: string[] = [];
  const lookup = hostsLookup(hosts);
  const guard = await startConnectionGuard({
    onRefused: (refusal) => refused.push(refusal),
    listed: (host) => listsPrivateSite(sites, host),
    lookup: (host) => {
      lookups.push(host);
      return lookup(host);
    },
    // The checked address is where the guard connects; the stand-in site
    // answers for it, so the test sees exactly which address that was.
    connect: (address, port) => {
      connects.push(`${address}:${port}`);
      if (sitePort === undefined) {
        const socket = netConnect({ host: "127.0.0.1", port: 1 });
        return socket;
      }
      return netConnect({ host: "127.0.0.1", port: sitePort });
    },
  });
  open.push(guard);
  return { guard, refused, lookups, connects };
}

function exchange(
  guard: ConnectionGuardHandle,
  request: string,
  options: { until?: RegExp; afterHead?: (socket: Socket) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: guard.host, port: guard.port });
    open.push({ close: () => socket.destroy() });
    let text = "";
    let followed = false;
    socket.on("connect", () => socket.write(request));
    socket.on("data", (data) => {
      text += data.toString();
      if (!followed && options.afterHead && text.includes("\r\n\r\n")) {
        followed = true;
        options.afterHead(socket);
      }
      if (options.until?.test(text)) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

const signIn = (guard: ConnectionGuardHandle): string =>
  `Proxy-Authorization: Basic ${Buffer.from(`${guard.username}:${guard.password}`).toString("base64")}\r\n`;

const connectTo = (target: string, guard?: ConnectionGuardHandle): string =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${guard ? signIn(guard) : ""}\r\n`;

describe("the task browser's connection guard", () => {
  it("listens on loopback alone and answers only its own browser's sign-in", async () => {
    const { guard, lookups } = await guarded({ "skyfare.example": ["93.184.215.14"] });
    expect(guard.host).toBe("127.0.0.1");
    const anyone = await exchange(guard, connectTo("skyfare.example:443"));
    expect(anyone).toMatch(/^HTTP\/1\.1 407 /);
    expect(anyone).toContain('Proxy-Authenticate: Basic realm="task browser"');
    const wrong = await exchange(
      guard,
      `CONNECT skyfare.example:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from("task:guess").toString("base64")}\r\n\r\n`,
    );
    expect(wrong).toMatch(/^HTTP\/1\.1 407 /);
    // Nothing is resolved for a caller that is not the browser.
    expect(lookups).toEqual([]);
  });

  it("answers its browser's sign-in at once, resolving and reporting nothing", async () => {
    const { guard, lookups, connects, refused } = await guarded({});
    expect(await exchange(guard, connectTo(`${GUARD_SIGN_IN_HOST}:443`))).toMatch(
      /^HTTP\/1\.1 407 /,
    );
    expect(await exchange(guard, connectTo(`${GUARD_SIGN_IN_HOST}:443`, guard))).toMatch(
      /^HTTP\/1\.1 204 /,
    );
    expect([lookups, connects, refused]).toEqual([[], [], []]);
  });

  it("tunnels a public name to the one address it checked, resolving it once", async () => {
    const { port } = await site();
    const { guard, lookups, connects, refused } = await guarded(
      { "skyfare.example": ["93.184.215.14"] },
      port,
    );
    const text = await exchange(guard, connectTo("skyfare.example:443", guard), {
      until: /pong/,
      afterHead: (socket) => socket.write("ping"),
    });
    expect(text).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(text.endsWith("pong")).toBe(true);
    expect(lookups).toEqual(["skyfare.example"]);
    expect(connects).toEqual(["93.184.215.14:443"]);
    expect(refused).toEqual([]);
  });

  it("refuses a public name that leads only to this Mac or a private network, before any connection", async () => {
    const { guard, connects, refused } = await guarded({
      "rebind.example": ["127.0.0.1"],
      "router.example": ["192.168.1.1"],
      "mapped.example": ["::ffff:10.0.0.7"],
      "wiki.corp.example": ["10.20.30.40", "fd00::5"],
    });
    for (const host of [
      "rebind.example",
      "router.example",
      "mapped.example",
      "wiki.corp.example",
    ]) {
      const text = await exchange(guard, connectTo(`${host}:443`, guard));
      expect(text, host).toMatch(/^HTTP\/1\.1 403 /);
    }
    expect(connects).toEqual([]);
    expect(refused).toEqual([
      {
        host: "rebind.example",
        kind: "private",
        answers: [{ address: "127.0.0.1", kind: "this-computer" }],
      },
      {
        host: "router.example",
        kind: "private",
        answers: [{ address: "192.168.1.1", kind: "private" }],
      },
      {
        host: "mapped.example",
        kind: "private",
        answers: [{ address: "::ffff:10.0.0.7", kind: "private" }],
      },
      {
        host: "wiki.corp.example",
        kind: "private",
        answers: [
          { address: "10.20.30.40", kind: "private" },
          { address: "fd00::5", kind: "private" },
        ],
      },
    ]);
  });

  // INF-3116, answer 1: a name with public and private answers connects
  // through its public answers only; the private ones are never dialed.
  it("tunnels a name with public and private answers to its public ones alone", async () => {
    const { port } = await site();
    const { guard, connects, refused } = await guarded(
      { "mixed.example": ["10.0.0.7", "93.184.215.14", "127.0.0.1"] },
      port,
    );
    const text = await exchange(guard, connectTo("mixed.example:443", guard), {
      until: /pong/,
      afterHead: (socket) => socket.write("ping"),
    });
    expect(text).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(connects).toEqual(["93.184.215.14:443"]);
    expect(refused).toEqual([]);
  });

  it("says which answers it skipped when a mixed name's public ones do not answer", async () => {
    const { guard, connects, refused } = await guarded({
      "portal.corp.example": ["2606:4700:10::6814:2011", "10.0.0.5"],
    });
    expect(await exchange(guard, connectTo("portal.corp.example:443", guard))).toMatch(
      /^HTTP\/1\.1 502 /,
    );
    expect(connects).toEqual(["2606:4700:10::6814:2011:443"]);
    expect(refused).toEqual([
      {
        host: "portal.corp.example",
        kind: "unreachable",
        answers: [
          { address: "2606:4700:10::6814:2011", kind: "public" },
          { address: "10.0.0.5", kind: "private" },
        ],
      },
    ]);
  });

  // INF-3116, answer A: a listed name reaches its answers on a private network.
  it("tunnels a listed name and a name under a listed suffix to their private answers", async () => {
    const { port } = await site();
    const { guard, connects, refused } = await guarded(
      {
        "wiki.corp.example": ["10.20.30.40"],
        "build.eng.corp.example.com": ["fd00::7", "100.101.102.103"],
        "corp.example.com": ["10.0.0.9"],
      },
      port,
      ["wiki.corp.example", ".corp.example.com"],
    );
    for (const host of ["wiki.corp.example", "build.eng.corp.example.com"]) {
      const text = await exchange(guard, connectTo(`${host}:443`, guard), {
        until: /pong/,
        afterHead: (socket) => socket.write("ping"),
      });
      expect(text, host).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    }
    // A suffix covers the names under it, never the bare name itself (answer 3).
    expect(await exchange(guard, connectTo("corp.example.com:443", guard))).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(connects).toEqual(["10.20.30.40:443", "fd00::7:443"]);
    expect(refused).toEqual([
      {
        host: "corp.example.com",
        kind: "private",
        answers: [{ address: "10.0.0.9", kind: "private" }],
      },
    ]);
  });

  // INF-3129 review, the captain's ruling: a Remove stops every open task browser at once.
  it("ends a listed name's open tunnel once the name is removed, and keeps a public one", async () => {
    const { port } = await site();
    const sites = ["wiki.corp.example"];
    const { guard } = await guarded(
      { "wiki.corp.example": ["10.20.30.40"], "skyfare.example": ["93.184.215.14"] },
      port,
      sites,
    );
    const tunnel = (host: string) =>
      new Promise<{ closed: Promise<void> }>((resolve, reject) => {
        const socket = netConnect({ host: guard.host, port: guard.port });
        open.push({ close: () => socket.destroy() });
        const closed = new Promise<void>((done) => socket.once("close", () => done()));
        let text = "";
        socket.on("connect", () => socket.write(connectTo(`${host}:443`, guard)));
        socket.on("data", (data) => {
          text += data.toString();
          if (text.endsWith("\r\n\r\n")) socket.write("ping");
          if (text.endsWith("pong")) resolve({ closed });
        });
        socket.on("error", reject);
      });
    const listed = await tunnel("wiki.corp.example");
    const publicSite = await tunnel("skyfare.example");
    let publicClosed = false;
    void publicSite.closed.then(() => {
      publicClosed = true;
    });
    // The list the guard reads changes, as the captain's Remove changes it.
    sites.length = 0;
    guard.recheck?.();
    await listed.closed;
    expect(await exchange(guard, connectTo("wiki.corp.example:443", guard))).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    // A whole exchange later, the public tunnel is still open.
    expect(publicClosed).toBe(false);
  });

  it("refuses a listed name whose Remove lands while it is being dialed", async () => {
    const { port } = await site();
    const sites = ["wiki.corp.example"];
    const refused: GuardRefusal[] = [];
    const guard = await startConnectionGuard({
      onRefused: (refusal) => refused.push(refusal),
      listed: (host) => listsPrivateSite(sites, host),
      lookup: hostsLookup({ "wiki.corp.example": ["10.20.30.40"] }),
      // The captain's Remove lands as the guard dials the checked address.
      connect: () => {
        sites.length = 0;
        return netConnect({ host: "127.0.0.1", port });
      },
    });
    open.push(guard);
    expect(await exchange(guard, connectTo("wiki.corp.example:443", guard))).toMatch(
      /^HTTP\/1\.1 403 /,
    );
    expect(refused).toMatchObject([{ host: "wiki.corp.example", kind: "private", listed: true }]);
  });

  it("never dials this computer, link-local or metadata answers of a listed name", async () => {
    const { port } = await site();
    const { guard, connects, refused } = await guarded(
      {
        "rebind.corp.example": ["127.0.0.1", "::ffff:169.254.169.254"],
        "meta.corp.example": ["100.100.100.200", "fd00:ec2::254", "64:ff9b::a9fe:a9fe"],
        "portal.corp.example": ["169.254.169.254", "10.0.0.5"],
      },
      port,
      [".corp.example"],
    );
    for (const host of ["rebind.corp.example", "meta.corp.example"]) {
      expect(await exchange(guard, connectTo(`${host}:443`, guard)), host).toMatch(
        /^HTTP\/1\.1 403 /,
      );
    }
    // Among them a private answer it may reach is still dialed, alone.
    const text = await exchange(guard, connectTo("portal.corp.example:443", guard), {
      until: /pong/,
      afterHead: (socket) => socket.write("ping"),
    });
    expect(text).toMatch(/^HTTP\/1\.1 200 /);
    expect(connects).toEqual(["10.0.0.5:443"]);
    expect(refused.map(({ host, kind, listed }) => ({ host, kind, listed }))).toEqual([
      { host: "rebind.corp.example", kind: "private", listed: true },
      { host: "meta.corp.example", kind: "private", listed: true },
    ]);
  });

  // INF-3116, answer 4: a listed site opens over plain http too.
  it("carries a plain http request for a listed name to the address it checked", async () => {
    const { port } = await webSite();
    const { guard, connects, lookups } = await guarded(
      { "wiki.corp.example": ["10.20.30.40"] },
      port,
      ["wiki.corp.example"],
    );
    const text = await exchange(
      guard,
      `GET http://wiki.corp.example/pages?id=7 HTTP/1.1\r\nHost: wiki.corp.example\r\n${signIn(guard)}Proxy-Connection: keep-alive\r\n\r\n`,
      { until: /proxy=none/ },
    );
    expect(text).toMatch(/^HTTP\/1\.1 200 /);
    // The site reads the request as a browser sent it, with no word of the guard's sign-in.
    expect(text).toContain("GET /pages?id=7 host=wiki.corp.example proxy=none");
    expect(lookups).toEqual(["wiki.corp.example"]);
    expect(connects).toEqual(["10.20.30.40:80"]);
  });

  it("asks a plain http request without its sign-in to sign in, resolving nothing", async () => {
    const { guard, lookups } = await guarded({ "wiki.corp.example": ["10.20.30.40"] }, undefined, [
      "wiki.corp.example",
    ]);
    const text = await exchange(
      guard,
      "GET http://wiki.corp.example/ HTTP/1.1\r\nHost: wiki.corp.example\r\n\r\n",
    );
    expect(text).toMatch(/^HTTP\/1\.1 407 /);
    expect(lookups).toEqual([]);
  });

  it("refuses a private address written out, without resolving anything", async () => {
    const { guard, lookups, connects, refused } = await guarded({});
    for (const target of ["10.0.0.7:443", "[fe80::1]:443", "127.0.0.1:5173"]) {
      expect(await exchange(guard, connectTo(target, guard)), target).toMatch(/^HTTP\/1\.1 403 /);
    }
    expect(lookups).toEqual([]);
    expect(connects).toEqual([]);
    expect(refused.map((refusal) => refusal.host)).toEqual(["10.0.0.7", "fe80::1", "127.0.0.1"]);
  });

  // An engine that sends loopback to its guard (Google Chrome, whose
  // websockets skip the request pausing) reaches only the origins its
  // browser registered: the captain chose to close that gap at the guard.
  it("carries this Mac's loopback only to a host and port its browser registered, resolving nothing", async () => {
    const echo = await site();
    const web = await webSite();
    const refused: GuardRefusal[] = [];
    const lookups: string[] = [];
    const connects: string[] = [];
    const registered = new Set([`localhost:${echo.port}`, `127.0.0.1:${web.port}`]);
    const guard = await startConnectionGuard({
      onRefused: (refusal) => refused.push(refusal),
      lookup: async (host) => {
        lookups.push(host);
        return [];
      },
      local: (host, port) => registered.has(`${host}:${port}`),
      connect: (address, port) => {
        connects.push(`${address}:${port}`);
        return netConnect({ host: address, port });
      },
    });
    open.push(guard);
    const tunnel = await exchange(guard, connectTo(`localhost:${echo.port}`, guard), {
      until: /pong/,
      afterHead: (socket) => socket.write("ping"),
    });
    expect(tunnel).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(tunnel.endsWith("pong")).toBe(true);
    const page = await exchange(
      guard,
      `GET http://127.0.0.1:${web.port}/live HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\n${signIn(guard)}\r\n`,
      { until: /proxy=none/ },
    );
    expect(page).toMatch(/^HTTP\/1\.1 200 /);
    expect(page).toContain(`GET /live host=127.0.0.1:${web.port} proxy=none`);
    expect(connects).toEqual([`127.0.0.1:${echo.port}`, `127.0.0.1:${web.port}`]);
    // Another port on this Mac, or the same one by another name, is refused undialed.
    for (const target of [
      `127.0.0.1:${echo.port}`,
      `localhost:${web.port}`,
      `[::1]:${echo.port}`,
    ]) {
      expect(await exchange(guard, connectTo(target, guard)), target).toMatch(/^HTTP\/1\.1 403 /);
    }
    expect(
      await exchange(
        guard,
        `GET http://localhost:${echo.port + 1}/ HTTP/1.1\r\nHost: localhost\r\n${signIn(guard)}\r\n`,
      ),
    ).toMatch(/^HTTP\/1\.1 403 /);
    expect(connects).toHaveLength(2);
    expect(lookups).toEqual([]);
    expect(refused.map(({ host, kind }) => `${kind} ${host}`)).toEqual([
      "private 127.0.0.1",
      "private localhost",
      "private ::1",
      "private localhost",
    ]);
  });

  it("drops the browser's request when the server it reached drops the connection or nothing listens, never answering for it", async () => {
    const dropping = createHttpServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
    open.push({ close: () => dropping.close() });
    const port = (dropping.address() as { port: number }).port;
    const guard = await startConnectionGuard({
      onRefused: () => undefined,
      local: (host, asked) => host === "127.0.0.1" && asked === port,
    });
    open.push(guard);
    const answer = await exchange(
      guard,
      `GET http://127.0.0.1:${port}/failed HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${signIn(guard)}\r\n`,
    );
    expect(answer).toBe("");
    // A registered port with nothing listening reads the same way.
    dropping.close();
    await new Promise((resolve) => dropping.once("close", resolve));
    const down = await exchange(
      guard,
      `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${signIn(guard)}\r\n`,
    );
    expect(down).toBe("");
  });

  it("says when a name was not found or its server did not answer", async () => {
    const { guard, refused } = await guarded({ "down.example": ["93.184.215.14"] });
    expect(await exchange(guard, connectTo("nowhere.example:443", guard))).toMatch(
      /^HTTP\/1\.1 502 /,
    );
    expect(await exchange(guard, connectTo("down.example:443", guard))).toMatch(/^HTTP\/1\.1 502 /);
    expect(refused).toEqual([
      { host: "nowhere.example", kind: "unresolved", answers: [] },
      {
        host: "down.example",
        kind: "unreachable",
        answers: [{ address: "93.184.215.14", kind: "public" }],
      },
    ]);
  });

  it("says when the network has no route to any of a name's addresses, as with IPv6 alone", async () => {
    const refused: GuardRefusal[] = [];
    const guard = await startConnectionGuard({
      onRefused: (refusal) => refused.push(refusal),
      lookup: hostsLookup({
        "v6only.example": ["2606:4700:10::6814:2011"],
        "down.example": ["93.184.215.14"],
      }),
      // A network with no IPv6 answers at once that it has no route there;
      // a public IPv4 server here refuses the connection.
      connect: (address) => {
        const socket = new PassThrough();
        const code = address.includes(":") ? "ENETUNREACH" : "ECONNREFUSED";
        setImmediate(() => socket.emit("error", Object.assign(new Error(code), { code })));
        return socket;
      },
    });
    open.push(guard);
    for (const name of ["v6only.example", "down.example"]) {
      expect(await exchange(guard, connectTo(`${name}:443`, guard))).toMatch(/^HTTP\/1\.1 502 /);
    }
    expect(refused).toEqual([
      {
        host: "v6only.example",
        kind: "unreachable",
        answers: [{ address: "2606:4700:10::6814:2011", kind: "public" }],
        noRoute: true,
      },
      {
        host: "down.example",
        kind: "unreachable",
        answers: [{ address: "93.184.215.14", kind: "public" }],
      },
    ]);
  });

  it("carries no plain request, even signed in", async () => {
    const { guard, lookups } = await guarded({ "skyfare.example": ["93.184.215.14"] });
    const text = await exchange(
      guard,
      `GET http://skyfare.example/ HTTP/1.1\r\nHost: skyfare.example\r\n${signIn(guard)}\r\n`,
    );
    expect(text).toMatch(/^HTTP\/1\.1 403 /);
    expect(lookups).toEqual([]);
  });

  it("ends its open tunnels and stops listening when its browser closes", async () => {
    const { port } = await site();
    const { guard } = await guarded({ "skyfare.example": ["93.184.215.14"] }, port);
    const tunnel = exchange(guard, connectTo("skyfare.example:443", guard), {
      afterHead: () => guard.close(),
    });
    expect(await tunnel).toMatch(/^HTTP\/1\.1 200 /);
    const refused = await new Promise<string>((resolve) => {
      const socket = netConnect({ host: guard.host, port: guard.port });
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
    });
    expect(refused).toBe("ECONNREFUSED");
  });
});
