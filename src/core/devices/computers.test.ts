import { X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { computerPresenceOf, type DeviceView, parsePairingLink } from "@shared/devices";
import { afterEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  DeviceOutOfReachError,
  type ViewDeviceContact,
  type WorkDeviceContact,
} from "../connection/connection";
import { type WorkDeviceLink, WorkDevices } from "../placed/workDevices";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { Computers } from "./computers";
import { createKeyIdentity, type KeyIdentity } from "./identity";
import { DevicePairing, type DevicePairingOptions } from "./pairing";

/**
 * Settings -> Devices' list while this Mac's network moves (docs/devices.md,
 * "Where devices find this Mac" and "Finding the home again"): the real
 * pairing following a stand-in network on a clock the test moves, the real
 * `WorkDevices` and `Computers`, and a stand-in for where the connection
 * listens, since a test never listens on this Mac's own network
 * (docs/e2e-contracts.md). That the connection listens anew when pairing's
 * address moves is src/core/connection/connection.test.ts.
 */

const PORT = 47_623;

function manualClock() {
  let now = 5_000_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule: ((ms, run) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    }) satisfies DevicePairingOptions["schedule"],
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

/** This Mac on one network, at `address`, as `os.networkInterfaces()` lists it. */
const network = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: [
    {
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    },
  ],
});

/** A request on a TLS socket where `device` showed its key, dialed to this Mac at `to`. */
const shown = (device: KeyIdentity, to?: string) =>
  ({
    headers: {},
    socket: {
      remoteAddress: "192.168.65.30",
      ...(to ? { localAddress: to, localPort: PORT } : {}),
      getPeerX509Certificate: () => new X509Certificate(device.cert),
    },
  }) as unknown as IncomingMessage;

/**
 * The connection as `WorkDevices` reads it, listening where the test moves
 * it, and telling each computer's work come and go as the test says.
 */
function connectionAt(first: string[]) {
  let at = first;
  const listeners = new Set<(listening: string[]) => void>();
  const workListeners = new Set<(contact: WorkDeviceContact) => void>();
  const viewListeners = new Set<(contact: ViewDeviceContact) => void>();
  const link: WorkDeviceLink = {
    ask: async () => {
      throw new DeviceOutOfReachError();
    },
    onWorkDevice: (listener) => {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
    },
    onViewDevice: (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    listening: () => [...at],
    onListening: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    link,
    listensAt(next: string[]) {
      at = next;
      for (const listener of [...listeners]) listener([...at]);
    },
    tell(contact: WorkDeviceContact) {
      for (const listener of [...workListeners]) listener(contact);
    },
    tellView(contact: ViewDeviceContact) {
      for (const listener of [...viewListeners]) listener(contact);
    },
  };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

/**
 * The real pairing, `WorkDevices` and `Computers` on this Mac at `address`,
 * with the connection listening there, and another Mac that joined with a
 * command after dialing this Mac at that address, as its command said.
 */
function homeAt(address: string) {
  const userData = scratchDir("infinitary-computers-");
  const clock = manualClock();
  let interfaces = network(address);
  const pairing = new DevicePairing({
    dir: join(userData, "devices"),
    ...clock,
    onProblem: () => {},
    interfaces: () => interfaces,
    port: PORT,
    ownUid: 501,
  });
  stops.push(() => pairing.dispose());
  const db = freshDatabase();
  stops.push(() => db.close());
  const work = new WorkDevices();
  const connection = connectionAt([`127.0.0.1:${PORT}`, `${address}:${PORT}`]);
  stops.push(work.attach(connection.link));
  const pushed: DeviceView[][] = [];
  const computers = new Computers({
    pairing,
    work,
    tasks: new TaskService({ db, now: clock.now }),
    repos: new RepoRegistry(db, join(userData, "fleet")),
    stopTasks: async () => {},
    bringHome: async () => {},
    emit: (list) => pushed.push(list),
    onProblem: () => {},
    now: clock.now,
    bootedAt: () => 0,
  });
  const key = createKeyIdentity("Mac mini");
  const { link } = pairing.invite({ kind: "work", command: "another-mac" });
  expect(parsePairingLink(link).at).toBe(`${address}:${PORT}`);
  const joined = pairing.claim(
    {
      code: parsePairingLink(link).code,
      kind: "work",
      name: "Mac mini",
      user: { name: "sam", uid: 501 },
    },
    shown(key, `::ffff:${address}`),
  );
  if (!joined.ok) throw new Error(joined.reason);
  return {
    clock,
    pairing,
    connection,
    computers,
    pushed,
    key,
    deviceId: joined.grant.deviceId,
    /** This Mac moves to another network. */
    moveTo: (next: string) => {
      interfaces = network(next);
    },
  };
}

describe("a Mac that both controls this Firstmate and runs work", () => {
  it("reads its work, and whether Firstmate is open on it, on one row", () => {
    const { pairing, connection, computers, deviceId: miniId } = homeAt("192.168.65.2");
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "iMac",
        user: { name: "sam", uid: 501 },
        window: true,
      },
      shown(createKeyIdentity("iMac"), "::ffff:192.168.65.9"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    const deviceId = joined.grant.deviceId;
    const imac = () => computers.list().find((device) => device.id === deviceId);
    expect(imac()).toMatchObject({ kind: "mac", inReach: false, controlling: false, tasks: 0 });
    // INF-1066: a native view receives only public identity/reach from these real pairing readings.
    expect(computerPresenceOf(computers.list())).toEqual([
      { id: miniId, name: "Mac mini", inReach: false },
      { id: deviceId, name: "iMac", inReach: false },
    ]);
    // Its work in reach, then Firstmate opened there.
    connection.tell({ deviceId, contact: "in-reach" });
    expect(imac()).toMatchObject({ inReach: true, controlling: false });
    expect(computerPresenceOf(computers.list())).toEqual([
      { id: miniId, name: "Mac mini", inReach: false },
      { id: deviceId, name: "iMac", inReach: true },
    ]);
    connection.tellView({ deviceId, contact: "in-reach" });
    expect(imac()).toMatchObject({ inReach: true, controlling: true, runs: [] });
    // Closing its window leaves its work in reach.
    connection.tellView({ deviceId, contact: "gone" });
    expect(imac()).toMatchObject({ inReach: true, controlling: false });
  });
});

describe("your devices while this Mac's network moves", () => {
  it("says a computer out of reach still looks at the old address once the connection listens where this Mac is now", () => {
    // Another Mac joined with a command, and last reached this Mac at 192.168.65.2.
    const { clock, pairing, connection, computers, pushed, key, deviceId, moveTo } =
      homeAt("192.168.65.2");
    pairing.admit(shown(key, "::ffff:192.168.65.2"));
    const mini = () => pushed.at(-1)?.find((device) => device.id === deviceId)?.addressChanged;
    const unfollow = pairing.followNetwork();
    stops.push(unfollow);
    expect(computers.list()[0]).not.toHaveProperty("addressChanged");

    // This Mac moves to another network, and pairing hears it once the move holds.
    moveTo("192.168.65.77");
    clock.advance(5_000);
    clock.advance(5_000);
    expect(pairing.address()).toBe("192.168.65.77");
    // Until the connection listens there, nothing says the address changed.
    expect(mini()).toBeUndefined();

    // It listens where this Mac is now: the list says so, with no link made.
    connection.listensAt([`127.0.0.1:${PORT}`, `192.168.65.77:${PORT}`]);
    expect(mini()).toBe(true);
  });

  it("says macOS holds a computer a command added on the local network until its work is in reach, and a new address strands it first", () => {
    const { clock, pairing, connection, computers, deviceId, moveTo } = homeAt("192.168.65.2");
    const mini = () => computers.list().find((device) => device.id === deviceId);
    // Joined from another Mac at this Mac's local-network address, and never in reach since.
    expect(mini()).toMatchObject({ inReach: false, heldOnLocalNetwork: true });
    expect(mini()).not.toHaveProperty("addressChanged");

    // This Mac moves: it is stranded at the old address, which is the way back to say.
    const unfollow = pairing.followNetwork();
    stops.push(unfollow);
    moveTo("192.168.65.77");
    clock.advance(5_000);
    clock.advance(5_000);
    connection.listensAt([`127.0.0.1:${PORT}`, `192.168.65.77:${PORT}`]);
    expect(mini()).toMatchObject({ addressChanged: true });
    expect(mini()).not.toHaveProperty("heldOnLocalNetwork");
    moveTo("192.168.65.2");
    clock.advance(5_000);
    clock.advance(5_000);
    connection.listensAt([`127.0.0.1:${PORT}`, `192.168.65.2:${PORT}`]);
    expect(mini()).toMatchObject({ heldOnLocalNetwork: true });

    // Its work reaches this Mac once, and nothing holds it from then on, in reach or not.
    connection.tell({ deviceId, contact: "in-reach" });
    expect(mini()).toMatchObject({ inReach: true });
    expect(mini()).not.toHaveProperty("heldOnLocalNetwork");
    connection.tell({ deviceId, contact: "gone" });
    expect(mini()).toMatchObject({ inReach: false });
    expect(mini()).not.toHaveProperty("heldOnLocalNetwork");
  });
});
