import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
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

async function guarded(hosts: Record<string, string[]>, sitePort?: number): Promise<Started> {
  const refused: GuardRefusal[] = [];
  const lookups: string[] = [];
  const connects: string[] = [];
  const lookup = hostsLookup(hosts);
  const guard = await startConnectionGuard({
    onRefused: (refusal) => refused.push(refusal),
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

/** Send raw bytes to the guard and read what it answers, until it closes or `until` matches. */
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

  it("refuses a public name that leads to this Mac or a private network, before any connection", async () => {
    const { guard, connects, refused } = await guarded({
      "rebind.example": ["127.0.0.1"],
      "router.example": ["192.168.1.1"],
      "mixed.example": ["93.184.215.14", "10.0.0.7"],
      "mapped.example": ["::ffff:10.0.0.7"],
    });
    for (const host of ["rebind.example", "router.example", "mixed.example", "mapped.example"]) {
      const text = await exchange(guard, connectTo(`${host}:443`, guard));
      expect(text, host).toMatch(/^HTTP\/1\.1 403 /);
    }
    expect(connects).toEqual([]);
    expect(refused).toEqual([
      { host: "rebind.example", kind: "private" },
      { host: "router.example", kind: "private" },
      { host: "mixed.example", kind: "private" },
      { host: "mapped.example", kind: "private" },
    ]);
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

  it("says when a name was not found or its server did not answer", async () => {
    const { guard, refused } = await guarded({ "down.example": ["93.184.215.14"] });
    expect(await exchange(guard, connectTo("nowhere.example:443", guard))).toMatch(
      /^HTTP\/1\.1 502 /,
    );
    expect(await exchange(guard, connectTo("down.example:443", guard))).toMatch(/^HTTP\/1\.1 502 /);
    expect(refused).toEqual([
      { host: "nowhere.example", kind: "unresolved" },
      { host: "down.example", kind: "unreachable" },
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
