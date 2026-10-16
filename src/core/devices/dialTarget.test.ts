import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { connectClient, freePort } from "../../../tests/helpers/connectionClient";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { forwardSocket, type SocketForward } from "../../../tests/helpers/socketForward";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import {
  claimLink,
  dialHome,
  fetchFirstmate,
  findHomeAgain,
  HomeKeyMismatchError,
  HomeRouteMissingError,
  PairRefusedError,
  pinnedSocket,
  probeHome,
} from "./dial";
import { createKeyIdentity } from "./identity";
import { DevicePairing } from "./pairing";

/**
 * Where a dial physically goes, apart from who must answer it
 * (docs/connection.md, "Where a device dials"): a device dials an address,
 * or a private socket on its own Mac that the home's SSH connection forwards
 * to the home, with the same pinned TLS and the same keys either way. The
 * real pairing and connection over scratch folders, and a socket that does
 * what OpenSSH's reverse forward does at the far end (`forwardSocket`): every
 * connection to it is carried to the home's loopback. A real OpenSSH forward
 * is remoteLogin.test.ts's. Built on PR #838's checks of a dial carried by a
 * relay: joined, connected and answered through it; refused when nothing
 * answers there or another computer does.
 */

/** The home's own macOS user number: a forwarded connection reaches it from loopback all the same. */
const HOME_UID = 501;

const open: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const servers: TlsServer[] = [];
const forwards: SocketForward[] = [];
afterEach(async () => {
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A home on loopback: the real connection and pairing, with a core that answers a work request. */
async function home() {
  const dispatch = (async (channel) => {
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (channel === "inf:work:progress") return { text: "Noted." };
    throw new Error(`Rejected ${channel}: malformed request`);
  }) as CoreDispatch;
  const port = await freePort();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-target-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: HOME_UID,
  });
  pairings.push(pairing);
  const connection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
  });
  open.push(connection);
  return { pairing, connection, port, at: `127.0.0.1:${port}` };
}

/** The far end of the home's SSH connection, carrying every connection to `port`. */
async function forward(port: number): Promise<SocketForward> {
  const made = await forwardSocket(port);
  forwards.push(made);
  return made;
}

/** A computer that runs work, as it says itself: here, the home's own user number. */
const MINI = { kind: "work", name: "Mac mini", user: { name: "sam", uid: HOME_UID } } as const;

/** A link for a computer that reaches this home only through its SSH connection, found to be another Mac. */
function sshLink(pairing: DevicePairing): string {
  return pairing.invite(
    { kind: "work" },
    { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
  ).link;
}

describe("a device's dial goes to an address or a private socket, with the same keys", () => {
  it("joins, connects and is answered through the private socket the home's SSH forwards", async () => {
    const { pairing, connection, port } = await home();
    const route = await forward(port);
    const link = sshLink(pairing);
    await connection.settled();

    const grant = await claimLink(link, MINI, { target: { socket: route.socket } });
    expect(grant).toMatchObject({ kind: "work", via: "ssh" });
    // Found to be another Mac before the link existed, it joins with the
    // home's own user number, though it reached the home from loopback.
    expect(pairing.list()).toEqual([
      expect.objectContaining({
        id: grant.deviceId,
        onThisMac: false,
        remoteLogin: "sam@mini.local",
      }),
    ]);
    expect(pairing.sshConnections()).toEqual([
      { deviceId: grant.deviceId, address: "sam@mini.local" },
    ]);

    const client = await connectClient(grant, { dial: { target: { socket: route.socket } } });
    expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
    await expect(
      client.invoke("inf:work:progress", [{ task: "t1", callId: "c1", text: "Started." }]),
    ).resolves.toEqual({ text: "Noted." });
    await client.close();
    // One connection to use the link, one to stay connected: both through the socket.
    expect(route.carried()).toBe(2);
  });

  it("never dials the address of a link or grant that reaches its home only through the home's SSH", async () => {
    const { pairing, connection, port, at } = await home();
    const route = await forward(port);
    const link = sshLink(pairing);
    await connection.settled();

    // The link names the home's loopback, where the home does answer: with
    // no socket it is refused before anything is dialed, and stays good.
    for (const options of [{}, { target: { address: at } }])
      await expect(claimLink(link, MINI, options)).rejects.toBeInstanceOf(HomeRouteMissingError);
    await expect(probeHome({ at, via: "ssh" }, pairing.identity().pin)).rejects.toBeInstanceOf(
      HomeRouteMissingError,
    );
    expect(pairing.list()).toEqual([]);

    const grant = await claimLink(link, MINI, { target: { socket: route.socket } });
    expect(route.carried()).toBe(1);
    await expect(dialHome(grant)).rejects.toBeInstanceOf(HomeRouteMissingError);
    await expect(dialHome(grant, { target: { address: at } })).rejects.toBeInstanceOf(
      HomeRouteMissingError,
    );
    await expect(fetchFirstmate(grant, new PassThrough())).rejects.toBeInstanceOf(
      HomeRouteMissingError,
    );
    expect(route.carried()).toBe(1);
  });

  it("refuses through a socket when nothing answers there, or another computer does", async () => {
    const { pairing } = await home();
    const nothing = join(socketScratchDir("fm-t-"), "none");
    const silent = await pinnedSocket({ socket: nothing }, pairing.identity().pin, null).catch(
      (error: unknown) => error,
    );
    expect(silent).toBeInstanceOf(Error);
    expect(silent).not.toBeInstanceOf(HomeKeyMismatchError);
    expect(silent).not.toBeInstanceOf(PairRefusedError);

    // Something else answers at the far end: its key is not the home's.
    const other = createKeyIdentity("Another computer");
    const impostor = createTlsServer({ key: other.key, cert: other.cert, minVersion: "TLSv1.3" });
    servers.push(impostor);
    const impostorPort = await freePort();
    await new Promise<void>((resolve) => impostor.listen(impostorPort, "127.0.0.1", resolve));
    const route = await forward(impostorPort);
    await expect(
      pinnedSocket({ socket: route.socket }, pairing.identity().pin, null),
    ).rejects.toBeInstanceOf(HomeKeyMismatchError);
    await expect(
      claimLink(sshLink(pairing), MINI, { target: { socket: route.socket } }),
    ).rejects.toBeInstanceOf(HomeKeyMismatchError);
    expect(pairing.list()).toEqual([]);
  });

  it("dials a direct grant at its address, or through a socket it is given, proving the same key", async () => {
    const { pairing, connection, port, at } = await home();
    const { link } = pairing.invite({ kind: "work", at });
    await connection.settled();
    const grant = await claimLink(link, { ...MINI, user: { name: "sam", uid: HOME_UID + 1 } });
    expect(grant).not.toHaveProperty("via");
    const route = await forward(port);
    const client = await connectClient(grant, { dial: { target: { socket: route.socket } } });
    expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
    await client.close();
    // A socket on this Mac is no dial to the network: no relay carries it,
    // whatever relay a dial names.
    const direct = await connectClient(grant, {
      dial: { target: { socket: route.socket }, relay: "/nonexistent/relay" },
    });
    expect(direct.welcome).toMatchObject({ t: "welcome" });
    await direct.close();
    // A key the home does not list is refused through the socket as at the address.
    const { key, cert } = createKeyIdentity("Stranger");
    await expect(
      connectClient({ ...grant, key, cert }, { dial: { target: { socket: route.socket } } }),
    ).rejects.toThrow("refused: 401");
  });

  it("finds its home again over its SSH for good, never back at an address", async () => {
    const { pairing, connection, port } = await home();
    const route = await forward(port);
    await connection.settled();
    const grant = await claimLink(sshLink(pairing), MINI, { target: { socket: route.socket } });

    const direct = pairing.invite({ kind: "work" }).link;
    await expect(
      findHomeAgain(direct, grant, { name: "Mac mini", user: MINI.user }),
    ).rejects.toMatchObject({ refused: "via" });
    const again = await findHomeAgain(
      sshLink(pairing),
      grant,
      { name: "Mac mini", user: MINI.user },
      { target: { socket: route.socket } },
    );
    expect(again).toEqual(grant);
    expect(pairing.list()).toHaveLength(1);

    // A grant that dials an address moves onto the home's SSH with a link over it.
    const { link: byAddress } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
    const dialing = await claimLink(byAddress, {
      ...MINI,
      user: { name: "sam", uid: HOME_UID + 1 },
    });
    const moved = await findHomeAgain(
      sshLink(pairing),
      dialing,
      { name: "Mac mini", user: MINI.user },
      { target: { socket: route.socket } },
    );
    expect(moved).toEqual({ ...dialing, at: grant.at, via: "ssh" });
    expect(pairing.list()).toHaveLength(2);
  });
});
