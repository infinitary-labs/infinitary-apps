import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity } from "../devices/identity";
import { HomeRoute, homeDialOptions, ROUTE_LEASE_MS, SOCKET_PATH_MAX_BYTES } from "./route";

/**
 * The route to a home that reaches this computer through its own SSH
 * connection (docs/helper.md, "Through the home's SSH"), on its own: what a
 * dial reads, on a clock the test moves, and what each connection's
 * generation lets it write. The run dialing through it is helper.test.ts.
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A socket listening in a folder private to this user, as the home's SSH forward makes one. */
async function privateSocket(): Promise<string> {
  const socket = join(socketScratchDir("fm-r-"), "h");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

const home = createKeyIdentity("The home").pin;
const grant = { homeKey: home, deviceId: "mini" };

function clock() {
  let now = 9_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the route to a home over its SSH connection", () => {
  it("answers the published socket for its home and device until its lease runs out", async () => {
    const dataDir = scratchDir("infinitary-route-");
    const time = clock();
    const route = new HomeRoute(dataDir, time.now);
    const socket = await privateSocket();
    expect(route.current(grant)).toBeNull();

    const generation = route.begin();
    expect(route.current(grant)).toBeNull();
    expect(route.publish(generation, { socket, ...grant })).toBe(true);
    expect(route.current(grant)).toBe(socket);
    expect(statSync(join(dataDir, "route.json")).mode & 0o777).toBe(0o600);
    // It names no key and no link: the socket, the home's pin, this computer's id.
    expect(JSON.parse(readFileSync(join(dataDir, "route.json"), "utf8"))).toEqual({
      version: 1,
      generation,
      route: { socket, homeKey: home, deviceId: "mini", leaseUntil: 9_000_000 + ROUTE_LEASE_MS },
    });

    // Another home's grant, or another device's, has no route here.
    expect(route.current({ ...grant, deviceId: "studio" })).toBeNull();
    expect(route.current({ ...grant, homeKey: createKeyIdentity("Another home").pin })).toBeNull();

    // Renewed, it lasts another lease; not renewed, it is no route.
    time.advance(ROUTE_LEASE_MS - 1);
    expect(route.current(grant)).toBe(socket);
    expect(route.publish(generation, { socket, ...grant })).toBe(true);
    time.advance(ROUTE_LEASE_MS - 1);
    expect(route.current(grant)).toBe(socket);
    time.advance(1);
    expect(route.current(grant)).toBeNull();

    // A dial reads it each time: the grant's own address never.
    const sshGrant = {
      at: "127.0.0.1:47623",
      ...grant,
      kind: "work" as const,
      key: "k",
      cert: "c",
      via: "ssh" as const,
    };
    expect(homeDialOptions(dataDir, sshGrant, time.now)).toEqual({});
    expect(route.publish(generation, { socket, ...grant })).toBe(true);
    expect(homeDialOptions(dataDir, sshGrant, time.now)).toEqual({ target: { socket } });
    const { via: _via, ...direct } = sshGrant;
    expect(homeDialOptions(dataDir, direct, time.now)).toEqual({});
  });

  it("lets no earlier connection write over or withdraw a later one's route", async () => {
    const dataDir = scratchDir("infinitary-route-");
    const route = new HomeRoute(dataDir);
    const [first, second] = [await privateSocket(), await privateSocket()];
    const old = route.begin();
    expect(route.publish(old, { socket: first, ...grant })).toBe(true);

    // A new connection takes the route; the old one's is withdrawn at once.
    const next = route.begin();
    expect(next).toBeGreaterThan(old);
    expect(route.current(grant)).toBeNull();
    expect(route.publish(old, { socket: first, ...grant })).toBe(false);
    expect(route.publish(next, { socket: second, ...grant })).toBe(true);
    route.withdraw(old);
    expect(route.current(grant)).toBe(second);

    // Its own connection withdraws it, and nothing after can bring it back
    // but a connection of its own.
    route.withdraw(next);
    expect(route.current(grant)).toBeNull();
    expect(route.publish(old, { socket: first, ...grant })).toBe(false);
    expect(route.begin()).toBe(next + 1);
  });

  it("is removed for good, so no earlier connection's renewal or withdrawal brings it back", async () => {
    const dataDir = scratchDir("infinitary-route-");
    const route = new HomeRoute(dataDir);
    const socket = await privateSocket();
    const generation = route.begin();
    expect(route.publish(generation, { socket, ...grant })).toBe(true);

    route.remove();
    expect(route.current(grant)).toBeNull();
    expect(route.publish(generation, { socket, ...grant })).toBe(false);
    route.withdraw(generation);
    // Nothing is left: no route, and no lock.
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("is out of reach, never anything else, when it is unreadable or its socket is not private", async () => {
    const dataDir = scratchDir("infinitary-route-");
    const route = new HomeRoute(dataDir);
    const socket = await privateSocket();
    const generation = route.begin();
    route.publish(generation, { socket, ...grant });
    expect(route.current(grant)).toBe(socket);

    // A folder another user may enter.
    const folder = join(socket, "..");
    chmodSync(folder, 0o755);
    expect(route.current(grant)).toBeNull();
    chmodSync(folder, 0o700);
    expect(route.current(grant)).toBe(socket);

    // A socket behind a link to its folder, or something that is not a socket.
    const linked = join(socketScratchDir("fm-r-"), "l");
    symlinkSync(folder, linked);
    expect(route.publish(generation, { socket: join(linked, "h"), ...grant })).toBe(true);
    expect(route.current(grant)).toBeNull();
    const plain = join(socketScratchDir("fm-r-"), "f");
    writeFileSync(plain, "");
    expect(route.publish(generation, { socket: plain, ...grant })).toBe(true);
    expect(route.current(grant)).toBeNull();

    // A path no dial could reach is refused before it is written.
    expect(() =>
      route.publish(generation, { socket: `/${"s".repeat(SOCKET_PATH_MAX_BYTES)}`, ...grant }),
    ).toThrow("short enough to dial");
    expect(() => route.publish(generation, { socket: "relative/h", ...grant })).toThrow();

    // What cannot be read is no route, and the next connection starts over.
    writeFileSync(join(dataDir, "route.json"), "{ not json");
    expect(route.current(grant)).toBeNull();
    const fresh = route.begin();
    expect(route.publish(fresh, { socket, ...grant })).toBe(true);
    expect(route.current(grant)).toBe(socket);
  });

  it("takes over a write lock left by a writer that died holding it", () => {
    const dataDir = scratchDir("infinitary-route-");
    mkdirSync(dataDir, { recursive: true });
    const lock = join(dataDir, "route.lock");
    writeFileSync(lock, "");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    const route = new HomeRoute(dataDir);
    expect(route.begin()).toBe(1);
    expect(() => statSync(lock)).toThrow();
  });
});
