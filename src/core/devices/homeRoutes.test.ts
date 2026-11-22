import { readFileSync } from "node:fs";
import { createServer, connect as dialTcp, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { type DeviceGrant, deviceGrantSchema } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { claimLink, dialHome, HomeKeyMismatchError } from "./dial";
import { HomeLink, type HomeLinkState } from "./homeLink";
import { createKeyIdentity } from "./identity";
import { HOME_ADDRESSES_FILE, JoinedHome } from "./joinedHome";
import { DevicePairing } from "./pairing";

/**
 * INF-4207 piece 1, "Find the home on any route": a Mac's window and a
 * computer that runs work keep every address the home offers, refreshed on
 * each connection, fall back to the home's announcement on the local network,
 * and check every route against the home's key (docs/devices.md, "Finding the
 * home again"). The real pairing and connection over scratch folders, on
 * loopback: a second port that carries each connection to the home stands in
 * for an address the home had and then lost, as when its Wi-Fi changed, and a
 * TLS listener with a key of its own for another computer at an address.
 */

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/**
 * A home on loopback that offers its own loopback address in every welcome;
 * one started on another's devices folder shows the same key, as a home that
 * took over from a copy of the record does.
 */
async function home(dir = join(scratchDir("infinitary-routes-home-"), "devices")) {
  const dispatch = (async (channel) => {
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    throw new Error(`Rejected ${channel}: malformed request`);
  }) as CoreDispatch;
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir,
    onProblem: () => {},
    interfaces: () => ({}),
    port,
  });
  const connection: HomeConnection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    heartbeatMs: 60_000,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await connection.close();
    pairing.dispose();
  };
  stops.push(stop);
  await connection.settled();
  return {
    pairing,
    connection,
    at: `127.0.0.1:${port}`,
    dir,
    stop,
  };
}

/**
 * An address the home answers at for now: a loopback port that carries each
 * connection to the home's own. `lose` cuts what it carries and stops
 * listening, as an address the home no longer has.
 */
async function oldAddress(homeAt: string): Promise<{ at: string; lose: () => Promise<void> }> {
  const homePort = Number(homeAt.split(":")[1]);
  const carrying = new Set<Socket>();
  const server: Server = createServer((device) => {
    const to = dialTcp(homePort, "127.0.0.1");
    for (const end of [device, to]) {
      carrying.add(end);
      end.once("close", () => carrying.delete(end));
    }
    device.on("error", () => to.destroy());
    to.on("error", () => device.destroy());
    device.pipe(to).pipe(device);
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  let lost = false;
  const lose = async () => {
    if (lost) return;
    lost = true;
    for (const end of carrying) end.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  stops.push(lose);
  return { at: `127.0.0.1:${port}`, lose };
}

async function anotherComputer(): Promise<{ at: string; dialed: () => number }> {
  const other = createKeyIdentity("Another computer");
  let dialed = 0;
  const server: TlsServer = createTlsServer(
    { key: other.key, cert: other.cert, minVersion: "TLSv1.3" },
    (socket) => socket.on("error", () => {}),
  );
  server.on("connection", () => {
    dialed += 1;
  });
  server.on("tlsClientError", () => {});
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { at: `127.0.0.1:${port}`, dialed: () => dialed };
}

function follow(grant: DeviceGrant, find?: () => Promise<readonly string[]>) {
  const dir = scratchDir("infinitary-routes-joined-");
  const joined = new JoinedHome(dir, () => {});
  joined.join(grant, 1);
  const states: HomeLinkState[] = [];
  const link = new HomeLink({
    grant,
    dial: (dialing, reached) => dialHome(dialing, { reached, ...(find ? { find } : {}) }),
    onRoutes: (routes) => joined.routes(routes.at, routes.also),
    onPush: () => {},
    onState: (state) => states.push(state),
    retryMs: [20],
    pingMs: 60_000,
  });
  stops.push(() => link.close());
  link.start();
  const kept = () => {
    const read = joined.read()?.grant;
    return { at: read?.at, also: read?.also ?? [] };
  };
  const inReach = () => link.state().contact === "in-reach";
  /** The grant's own file as a version that knows no `also` reads it, and the addresses kept beside it. */
  const saved = () => ({
    grant: deviceGrantSchema
      .omit({ also: true })
      .strict()
      .parse(JSON.parse(readFileSync(join(dir, "home.json"), "utf8")).grant),
    beside: JSON.parse(readFileSync(join(dir, HOME_ADDRESSES_FILE), "utf8")),
  });
  return { link, states, kept, inReach, saved };
}

const until = (check: () => boolean) =>
  expect.poll(check, { timeout: 8_000, interval: 10 }).toBe(true);

describe("a device finds its home on any route it keeps or hears, and only with the home's key", () => {
  it("keeps every address the home offers in its welcome, and comes back at one of them once its own is gone", async () => {
    const { pairing, connection, at: homeAt } = await home();
    const old = await oldAddress(homeAt);
    const { link } = pairing.invite({ kind: "view", at: old.at });
    await connection.settled();
    const grant = await claimLink(link, { kind: "view", name: "MacBook Air" });
    expect(grant.at).toBe(old.at);
    expect(grant.also).toBeUndefined();

    const device = follow(grant);
    await until(device.inReach);
    // The welcome offered the home's own address: kept after the one that answered.
    await until(() => device.kept().also.includes(homeAt));
    expect(device.kept()).toEqual({ at: old.at, also: [homeAt] });
    // The captain's pick on the review: the other addresses sit beside the grant, so a
    // version that knows no `also` still reads the grant's own file as it was.
    expect(device.saved()).toEqual({
      grant: grant,
      beside: { version: 1, deviceId: grant.deviceId, also: [homeAt] },
    });

    // The home's old address is gone, as when its network changed.
    await old.lose();
    await until(() => device.kept().at === homeAt);
    await until(device.inReach);
    // Refreshed again: the home no longer offers the old address, so it is not kept.
    expect(device.kept()).toEqual({ at: homeAt, also: [] });
  });

  it("hears where a copy kept after it connected would answer, so it can follow a takeover there", async () => {
    const { pairing, connection, at: homeAt } = await home();
    let copies: string[][] = [];
    pairing.offerCopies(() => copies);
    const { link } = pairing.invite({ kind: "work", at: homeAt });
    await connection.settled();
    const grant = await claimLink(link, {
      kind: "work",
      name: "Mac mini",
      user: { name: "builder", uid: (process.getuid?.() ?? 0) + 1 },
    });
    const device = follow(grant);
    await until(device.inReach);
    expect(device.kept()).toEqual({ at: homeAt, also: [] });

    // The captain keeps a copy on Mac Studio after this device connected: its
    // hello says where a first mate there would answer, and the home tells
    // every device now rather than at their next welcome.
    const studio = await anotherComputer();
    copies = [[studio.at]];
    await connection.routes();
    await until(() => device.kept().also.includes(studio.at));
    expect(device.kept()).toEqual({ at: homeAt, also: [studio.at] });
    expect(device.inReach()).toBe(true);
  });

  it("dials the home this computer took over as at once, without waiting for a welcome or a restart", async () => {
    const first = await home();
    const { link } = first.pairing.invite({ kind: "view", at: first.at });
    await first.connection.settled();
    const grant = await claimLink(link, { kind: "view", name: "Mac Studio" });
    const device = follow(grant);
    await until(device.inReach);

    // The home is gone, and this computer's first mate took over on the same
    // record at another address, as home 2.
    await first.stop();
    await until(() => !device.inReach());
    const second = await home(first.dir);
    second.pairing.raiseHomeNumber(2);
    device.link.tookOver(second.at, 2);
    await until(device.inReach);
    expect(device.link.state().contact).toBe("in-reach");
  });

  it("finds its home by the announcement on the local network once no address it keeps answers", async () => {
    const { pairing, connection, at: homeAt } = await home();
    const old = await oldAddress(homeAt);
    const { link } = pairing.invite({ kind: "work", at: old.at });
    await connection.settled();
    const grant = await claimLink(link, {
      kind: "work",
      name: "Mac mini",
      user: { name: "builder", uid: (process.getuid?.() ?? 0) + 1 },
    });
    // A grant kept before it kept the home's other addresses, whose address went.
    await old.lose();
    const stranger = await anotherComputer();
    let looked = 0;
    const device = follow(grant, async () => {
      looked += 1;
      return [stranger.at, homeAt];
    });
    await until(device.inReach);
    expect(looked).toBeGreaterThan(0);
    expect(device.kept()).toEqual({ at: homeAt, also: [] });
  });

  it("refuses a route that answers with another key, whether kept or heard, and keeps nothing of it", async () => {
    const { pairing, connection, at: homeAt } = await home();
    const { link } = pairing.invite({ kind: "view", at: homeAt });
    await connection.settled();
    const grant = await claimLink(link, { kind: "view", name: "MacBook Air" });
    const stranger = await anotherComputer();
    const gone = await oldAddress(homeAt);
    await gone.lose();

    // Its kept address went, and another computer answers at the other it keeps.
    const kept: DeviceGrant = { ...grant, at: gone.at, also: [stranger.at] };
    await expect(dialHome(kept)).rejects.toBeInstanceOf(HomeKeyMismatchError);
    // The same when the announcement names only that computer.
    await expect(
      dialHome({ ...grant, at: gone.at }, { find: async () => [stranger.at] }),
    ).rejects.toBeInstanceOf(HomeKeyMismatchError);
    await until(() => stranger.dialed() === 2);

    const device = follow(kept, async () => [stranger.at]);
    await until(() => device.states.some((state) => state.contact === "lost"));
    expect(device.inReach()).toBe(false);
    expect(device.kept()).toEqual({ at: gone.at, also: [stranger.at] });
  });
});
