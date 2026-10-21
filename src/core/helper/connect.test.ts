import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ControllerSays,
  controllerSaysSchema,
  readSshMessage,
  SSH_MESSAGE_VERSION,
  sshMessageLine,
} from "@shared/sshConnection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { forwardSocket, type SocketForward } from "../../../tests/helpers/socketForward";
import { type HomeConnection, startConnection } from "../connection/connection";
import { claimLink } from "../devices/dial";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { DevicePairing } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { writeRetiredMarker } from "../folderMove/record";
import { type ConnectEnded, type ConnectOptions, connectFromHome } from "./connect";
import { HomeRoute, ROUTE_LEASE_MS } from "./route";

/**
 * The controller the home's SSH connection runs on the Mac that runs work
 * (`work connect --from-home`, docs/helper.md "Through the home's SSH"),
 * against the real pairing and connection: what it says to the home, the
 * route it keeps, and how it ends. The forward the home's SSH puts in place
 * is stood in by a socket that carries each connection to the home's
 * loopback port, as OpenSSH's reverse forward does; the real OpenSSH forward
 * is src/core/devices/sshConnections.test.ts's.
 */

// Real TLS on loopback and a socket of its own; the silence it waits for is cut short (slowest measured 0.3 s).
vi.setConfig({ testTimeout: 5_000 });

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const forwards: SocketForward[] = [];
afterEach(async () => {
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

/**
 * A home, and a folder joined to it as a computer it reaches through its
 * own SSH connection, as the join over that connection keeps it.
 */
async function joined() {
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir: `${scratchDir("infinitary-connect-home-")}/devices`,
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: (process.getuid?.() ?? 0) + 1,
  });
  pairings.push(pairing);
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
  });
  connections.push(connection);
  const { link } = pairing.invite(
    { kind: "work" },
    { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
  );
  await connection.settled();
  // The join dials through a forward of its own, as the setup's SSH session makes one.
  const joining = await forwardAt(`${socketScratchDir("fm-j-")}/s`, port);
  const grant = await claimLink(
    link,
    { kind: "work", name: "Mac mini", user: { name: "sam", uid: 501 } },
    { target: { socket: joining } },
  );
  const dataDir = scratchDir("infinitary-connect-work-");
  new JoinedHome(dataDir).join(grant, 0);
  return {
    pairing,
    port,
    grant,
    dataDir,
    expected: { homeKey: grant.homeKey, deviceId: grant.deviceId },
  };
}

/** A socket at `path` that carries each connection to `port` on loopback, as the home's forward does. */
async function forwardAt(path: string, port: number): Promise<string> {
  forwards.push(await forwardSocket(port, path));
  return path;
}

/** The controller, started with the home's side of its SSH session in the test's hands. */
function controller(options: Omit<ConnectOptions, "input" | "output">) {
  const input = new PassThrough();
  const output = new PassThrough();
  const said: ControllerSays[] = [];
  let held = "";
  output.on("data", (chunk: Buffer) => {
    held += chunk.toString();
    for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
      const message = readSshMessage(controllerSaysSchema, held.slice(0, at));
      held = held.slice(at + 1);
      if (message) said.push(message);
    }
  });
  const ended: Promise<ConnectEnded> = connectFromHome({
    socketBase: socketScratchDir("fm-b-"),
    ...options,
    input,
    output,
  });
  return {
    said,
    ended,
    /** What the home says next. */
    home: (firstmate: "forwarded" | "beat") =>
      input.write(sshMessageLine({ firstmate, v: SSH_MESSAGE_VERSION })),
    /** The home's SSH session ends. */
    hangUp: () => input.end(),
    /** The socket it said, once it said one. */
    socket: async () => {
      await vi.waitFor(() => expect(said[0]?.firstmate).toBe("socket"));
      const first = said[0];
      return first?.firstmate === "socket" ? first.socket : "";
    },
  };
}

describe("the controller of the home's SSH connection", () => {
  it("makes a private socket, publishes its route once the home answers through it, renews it on each beat, and withdraws it when the home lets go", async () => {
    const { port, grant, dataDir, expected } = await joined();
    let now = 5_000_000;
    let agent: "at-login" | "running" = "at-login";
    const run = controller({
      dataDir,
      expected,
      now: () => now,
      agent: async () => agent,
    });
    const socket = await run.socket();
    // Its folder is this user's alone, and the route is not out before the forward.
    expect(socket.startsWith("/")).toBe(true);
    expect(new HomeRoute(dataDir, () => now).current(grant)).toBeNull();

    await forwardAt(socket, port);
    run.home("forwarded");
    await vi.waitFor(() =>
      expect(run.said[1]).toEqual({ firstmate: "route", v: 1, agent: "at-login" }),
    );
    expect(new HomeRoute(dataDir, () => now).current(grant)).toBe(socket);

    // A beat renews the lease; nobody logged in until now, it says so once the work runs.
    now += ROUTE_LEASE_MS - 1_000;
    agent = "running";
    run.home("beat");
    await vi.waitFor(() =>
      expect(run.said[2]).toEqual({ firstmate: "agent", v: 1, agent: "running" }),
    );
    now += ROUTE_LEASE_MS - 1_000;
    expect(new HomeRoute(dataDir, () => now).current(grant)).toBe(socket);

    // The home's SSH session ends: the route goes, and so does its own folder.
    run.hangUp();
    expect(await run.ended).toBe("ended");
    expect(new HomeRoute(dataDir, () => now).current(grant)).toBeNull();
    expect(existsSync(dirname(socket))).toBe(false);
  });

  it("ends by itself when the home goes quiet, and when a later connection took the route", async () => {
    const { port, grant, dataDir, expected } = await joined();
    const quiet = controller({ dataDir, expected, silenceMs: 200 });
    await forwardAt(await quiet.socket(), port);
    quiet.home("forwarded");
    await vi.waitFor(() => expect(quiet.said[1]?.firstmate).toBe("route"));
    // No beat: it takes the home to be gone, as after a crash or a sleep.
    expect(await quiet.ended).toBe("silent");
    expect(new HomeRoute(dataDir).current(grant)).toBeNull();

    const first = controller({ dataDir, expected });
    await forwardAt(await first.socket(), port);
    first.home("forwarded");
    await vi.waitFor(() => expect(first.said[1]?.firstmate).toBe("route"));
    // The next connection's controller takes a new generation: the first one cannot write over it.
    const next = controller({ dataDir, expected });
    const nextSocket = await next.socket();
    first.home("beat");
    expect(await first.ended).toBe("superseded");
    expect(first.said.at(-1)).toEqual({ firstmate: "refused", reason: "superseded" });
    await forwardAt(nextSocket, port);
    next.home("forwarded");
    await vi.waitFor(() => expect(new HomeRoute(dataDir).current(grant)).toBe(nextSocket));
    next.hangUp();
    expect(await next.ended).toBe("ended");
  });

  it("ends at the next beat once its folder moved into a newer app's, so the home connects to where the work is", async () => {
    const { port, grant, expected } = await joined();
    const dataDir = join(scratchDir("infinitary-connect-moving-"), "work");
    new JoinedHome(dataDir).join(grant, 0);
    const moving = controller({ dataDir, expected });
    await forwardAt(await moving.socket(), port);
    moving.home("forwarded");
    await vi.waitFor(() => expect(moving.said[1]?.firstmate).toBe("route"));
    writeRetiredMarker(dirname(dataDir), "/Users/sam/Library/Application Support/infinitary", "x");
    moving.home("beat");
    expect(await moving.ended).toBe("moved");
    expect(moving.said.at(-1)).toEqual({ firstmate: "refused", reason: "moved" });
    expect(new HomeRoute(dataDir).current(grant)).toBeNull();
  });

  it("refuses a folder that runs work for another home or as another computer, or none, and touches nothing", async () => {
    const { dataDir, expected } = await joined();
    const other = createKeyIdentity("Another home").pin;
    for (const [wrong, reason] of [
      [{ ...expected, homeKey: other }, "other-home"],
      [{ ...expected, deviceId: "another" }, "other-home"],
    ] as const) {
      const run = controller({ dataDir, expected: wrong });
      expect(await run.ended).toEqual({ refused: reason });
      expect(run.said).toEqual([{ firstmate: "refused", reason }]);
    }
    expect(existsSync(`${dataDir}/route.json`)).toBe(false);

    const empty = controller({ dataDir: scratchDir("infinitary-connect-none-"), expected });
    expect(await empty.ended).toEqual({ refused: "not-joined" });
  });

  it("publishes nothing when what answers through the socket is not the home its grant names", async () => {
    const { grant, dataDir, expected } = await joined();
    // Another home answers at the far end of the forward.
    const elsewhere = await joined();
    const run = controller({ dataDir, expected });
    await forwardAt(await run.socket(), elsewhere.port);
    run.home("forwarded");
    expect(await run.ended).toEqual({ refused: "not-that-home" });
    expect(new HomeRoute(dataDir).current(grant)).toBeNull();
    const file = JSON.parse(readFileSync(`${dataDir}/route.json`, "utf8")) as { route: unknown };
    expect(file.route).toBeNull();
  });
});
