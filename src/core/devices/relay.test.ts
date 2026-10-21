import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createTlsServer, type Server } from "node:tls";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { isLoopback } from "../connection/addresses";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { claimLink, HomeKeyMismatchError, PairRefusedError, pinnedSocket } from "./dial";
import { createKeyIdentity } from "./identity";
import { DevicePairing } from "./pairing";
import { relayFor, SYSTEM_RELAY } from "./relay";

/**
 * A device's dial carried by a relay program (docs/devices.md, "Through
 * macOS's own nc"), against the real connection and the real pairing over
 * a scratch folder: a computer that runs work joins, connects and is
 * answered through the relay, and a home that does not answer or another
 * computer answering is refused through it as it is directly. Each case
 * runs through a stand-in relay that does what nc does, on any system, and
 * on a Mac through macOS's own nc too.
 */

const ANOTHER_USER = { name: "builder", uid: (process.getuid?.() ?? 0) + 1 };

const open: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A home on loopback: the real connection and pairing, with a core that answers the work request. */
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
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-relay-home-"), "devices"),
    onProblem: () => {},
  });
  pairings.push(pairing);
  const port = await claimedPort();
  const connection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
  });
  open.push(connection);
  const at = `127.0.0.1:${port}`;
  return { pairing, connection, at };
}

/**
 * A relay that does what nc does: `<relay> host port` connects there, sends
 * its input and prints what comes back, and on a failed connection says why
 * on stderr and exits 1. It notes its pid in `pids`.
 */
function standInRelay(): { program: string; pids: () => number[] } {
  const dir = scratchDir("infinitary-relay-");
  const pids = join(dir, "pids");
  const script = join(dir, "relay.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      'import { connect } from "node:net";',
      `appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");`,
      "const [host, port] = process.argv.slice(2);",
      "const socket = connect(Number(port), host);",
      'socket.once("error", (error) => { process.stderr.write("relay: " + error.message + "\\n"); process.exit(1); });',
      "process.stdin.pipe(socket);",
      "socket.pipe(process.stdout);",
      'socket.once("end", () => process.exit(0));',
    ].join("\n"),
  );
  const program = join(dir, "relay");
  writeFileSync(
    program,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  chmodSync(program, 0o755);
  return {
    program,
    pids: () =>
      existsSync(pids)
        ? readFileSync(pids, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((pid) => Number(pid))
        : [],
  };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const relays: { name: string; program: () => string }[] = [
  { name: "a stand-in relay", program: () => standInRelay().program },
  ...(process.platform === "darwin" && existsSync(SYSTEM_RELAY)
    ? [{ name: "macOS's own nc", program: () => SYSTEM_RELAY }]
    : []),
];

describe("a device's dial carried by a relay", () => {
  it("goes through macOS's own nc to every host but loopback, and only on macOS", () => {
    for (const host of ["192.168.4.48", "100.102.217.78", "mini.local", "fd00::1"])
      expect(relayFor(host, "darwin")).toBe(SYSTEM_RELAY);
    for (const host of ["127.0.0.1", "127.8.0.1", "localhost", "::1", "[::1]"])
      expect(relayFor(host, "darwin")).toBeNull();
    expect(relayFor("192.168.4.48", "linux")).toBeNull();
  });

  it("preserves socket and literal relay policies at unusual address boundaries", () => {
    for (const [host, socketLoopback, relayed] of [
      ["LOCALHOST", true, false],
      ["[::1]", true, false],
      ["::ffff:127.0.0.1", true, true],
      ["[::ffff:127.0.0.1]", true, true],
      ["127.0.0.999", false, true],
      ["127.example.test", false, true],
      ["", false, true],
      ["192.168.1.2", false, true],
    ] as const) {
      expect(isLoopback(host), host).toBe(socketLoopback);
      expect(relayFor(host, "darwin"), host).toBe(relayed ? SYSTEM_RELAY : null);
      expect(relayFor(host, "linux"), host).toBeNull();
    }
  });

  for (const relay of relays) {
    it(`joins, connects and is answered through ${relay.name}`, async () => {
      const program = relay.program();
      const { pairing, connection, at } = await home();
      const { link } = pairing.invite({ kind: "work", at });
      await connection.settled();

      const grant = await claimLink(
        link,
        { kind: "work", name: "Mac mini", user: ANOTHER_USER },
        { relay: program },
      );
      expect(pairing.list()).toEqual([
        expect.objectContaining({ id: grant.deviceId, kind: "work", name: "Mac mini" }),
      ]);

      const client = await connectClient(grant, { dial: { relay: program } });
      expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
      await expect(
        client.invoke("inf:work:progress", [{ task: "t1", callId: "c1", text: "Started." }]),
      ).resolves.toEqual({ text: "Noted." });
      await client.close();
    });

    it(`refuses through ${relay.name} when nothing answers, or another computer does`, async () => {
      const program = relay.program();
      const { pairing } = await home();
      const silent = `127.0.0.1:${await claimedPort()}`;
      const { link } = pairing.invite({ kind: "work", at: silent });
      const nothing = await claimLink(
        link,
        { kind: "work", name: "Mac mini", user: ANOTHER_USER },
        { relay: program, timeoutMs: 30_000 },
      ).catch((error: unknown) => error);
      expect(nothing).toBeInstanceOf(Error);
      expect(nothing).not.toBeInstanceOf(HomeKeyMismatchError);
      expect(nothing).not.toBeInstanceOf(PairRefusedError);

      const other = createKeyIdentity("Another computer");
      const server = createTlsServer({ key: other.key, cert: other.cert, minVersion: "TLSv1.3" });
      servers.push(server);
      const port = await claimedPort();
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      const theHome = createKeyIdentity("The home");
      expect(other.pin).not.toBe(theHome.pin);
      await expect(
        pinnedSocket({ address: `127.0.0.1:${port}` }, theHome.pin, null, { relay: program }),
      ).rejects.toBeInstanceOf(HomeKeyMismatchError);
    });
  }

  it("stops the relay once its connection closes", async () => {
    const relay = standInRelay();
    const { pairing, connection, at } = await home();
    const { link } = pairing.invite({ kind: "work", at });
    await connection.settled();
    const grant = await claimLink(
      link,
      { kind: "work", name: "Mac mini", user: ANOTHER_USER },
      { relay: relay.program },
    );
    const client = await connectClient(grant, { dial: { relay: relay.program } });
    await client.close();
    // One relay for the link, one for the connection; neither outlives its socket.
    expect(relay.pids()).toHaveLength(2);
    await vi.waitFor(() => expect(relay.pids().filter(running)).toEqual([]));
  });
});
