import { X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { APP_UPDATE_LIVE } from "@shared/appFollow";
import {
  computerPresenceOf,
  type DeviceKind,
  type DeviceView,
  deviceLabel,
  parsePairingLink,
} from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { englishOf, type Said, said } from "@shared/i18n/said";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { WORK_PROGRESS_ORDER, WORK_SOURCE_ORDER } from "@shared/work";
import { WORK_REACH_GRACE_MS, WORK_SETUP_LIVE } from "@shared/workSetup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  DeviceOutOfReachError,
  type RunningDeviceVersion,
  type ViewDeviceContact,
  type WorkDeviceContact,
  type WorkDeviceVersion,
} from "../connection/connection";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { foldProof } from "../helper/fromWindow";
import { type WorkDeviceLink, WorkDevices } from "../placed/workDevices";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { Computers, type ComputersOptions, type DeviceUpdateEvent } from "./computers";
import { createKeyIdentity, type KeyIdentity } from "./identity";
import { DevicePairing, type DevicePairingOptions } from "./pairing";
import { RemoteLoginRefusedError } from "./remoteLogin";

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
  /** What each live frame to a Mac's window said, and the Macs whose window is connected. */
  const live: { deviceId: string; channel: string; payload: unknown }[] = [];
  const viewsIn = new Set<string>();
  /** What each connection's hello said of its version, as the connection lists them. */
  const running: RunningDeviceVersion[] = [];
  const versionListeners = new Set<(deviceId: string, version: WorkDeviceVersion | null) => void>();
  const link: WorkDeviceLink = {
    runningVersions: () => [...running],
    onWorkVersion: (listener) => {
      versionListeners.add(listener);
      return () => versionListeners.delete(listener);
    },
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
    liveToView: (deviceId, channel, payload) => {
      live.push({ deviceId, channel, payload });
      return viewsIn.has(deviceId);
    },
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
    live,
    running,
    /** A computer's work says its version at its welcome. */
    tellVersion(deviceId: string, version: WorkDeviceVersion) {
      for (const listener of [...versionListeners]) listener(deviceId, version);
    },
    tellView(contact: ViewDeviceContact) {
      if (contact.contact === "in-reach") viewsIn.add(contact.deviceId);
      else viewsIn.delete(contact.deviceId);
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
function homeAt(
  address: string,
  home?: ComputersOptions["home"],
  more: Partial<ComputersOptions> = {},
) {
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
  const lines: DeviceUpdateEvent[] = [];
  const moved: string[] = [];
  const tasks = new TaskService({ db, now: clock.now });
  const computers = new Computers({
    pairing,
    work,
    tasks,
    repos: new RepoRegistry(db, join(userData, "fleet")),
    stopTasks: async () => {},
    runsOnMoved: (taskId) => moved.push(taskId),
    bringHome: async () => {},
    emit: (list) => pushed.push(list),
    emitUpdate: (line) => lines.push(line),
    onProblem: () => {},
    now: clock.now,
    schedule: clock.schedule,
    bootedAt: () => 0,
    ...(home ? { home } : {}),
    ...more,
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
    lines,
    moved,
    db,
    tasks,
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

/**
 * Each copy's version (docs/devices.md, "Each copy's version"; INF-5372's plan,
 * piece 1): the version each app open on a device said in its hello, measured
 * against this computer's, beside its work's. The user's three copies: a Mac
 * that runs work, a Mac user that only controls, still on 0.8.3, and a phone.
 */
describe("each copy's version", () => {
  const HOME = { app: "0.8.4", contract: PROTOCOL_VERSION };
  /** A device that joined with `kind`, as pairing keeps one, said to be `system` by its hello. */
  const joinAs = (
    pairing: DevicePairing,
    kind: DeviceKind,
    name: string,
    system: "macos" | "ios",
  ) => {
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind }).link).code,
        kind,
        name,
        ...(kind === "mac" ? { user: { name: "sam", uid: 501 }, window: true } : {}),
      },
      shown(createKeyIdentity(name), "::ffff:192.168.65.9"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    pairing.noteSystem(joined.grant.deviceId, { system });
    return joined.grant.deviceId;
  };

  it("lists the version of each app open now, marks one behind this computer's, and leaves a phone's unmeasured", () => {
    const { pairing, connection, computers } = homeAt("192.168.65.2", HOME);
    const second = joinAs(pairing, "view", "MacBook Pro", "macos");
    const imac = joinAs(pairing, "mac", "iMac", "macos");
    const phone = joinAs(pairing, "view", "Kun's iPhone", "ios");
    const row = (id: string) => computers.list().find((device) => device.id === id);
    const open = (deviceId: string, version: string | null) => {
      connection.running.push({ deviceId, role: "view", version });
      connection.tellView({ deviceId, contact: "in-reach" });
    };
    // Nothing open: nothing is said of any app's version.
    expect(row(second)?.appVersion).toBeUndefined();

    open(second, "0.8.3");
    expect(row(second)?.appVersion).toEqual({ app: "0.8.3", than: "older" });
    open(phone, "0.1.0 (212)");
    expect(row(phone)?.appVersion).toEqual({ app: "0.1.0 (212)" });

    // A Mac's work and its window, both on this computer's version.
    connection.tell({ deviceId: imac, contact: "in-reach" });
    connection.tellVersion(imac, { contract: PROTOCOL_VERSION, app: "0.8.4", takesWork: true });
    open(imac, "0.8.4");
    expect(row(imac)).toMatchObject({
      workVersion: "0.8.4",
      appVersion: { app: "0.8.4", same: true },
    });
    expect(row(imac)?.otherVersion).toBeUndefined();

    // A second app of the same device, from before apps said their version, reads as the older.
    open(imac, null);
    expect(row(imac)?.appVersion).toEqual({});
  });

  // INF-5372's plan, piece 2: the home's row follows an app catching up by itself, and the
  // captain's "i think we should still provide a manual update flow in the devices view".
  it("says an app's step of catching up while it is behind, sends Update app to it, and forgets the step when it goes", async () => {
    const { pairing, connection, computers } = homeAt("192.168.65.2", HOME);
    const second = joinAs(pairing, "view", "MacBook Pro", "macos");
    const row = () => computers.list().find((device) => device.id === second);
    connection.running.push({ deviceId: second, role: "view", version: "0.8.3" });
    connection.tellView({ deviceId: second, contact: "in-reach" });
    const view = { kind: "captain" as const, view: second };

    await computers.appFollowAsked([{ version: "0.8.4", step: "getting", percent: 40 }], view);
    expect(row()?.appVersion).toEqual({
      app: "0.8.3",
      than: "older",
      follow: { version: "0.8.4", step: "getting", percent: 40 },
    });
    // A step of another version than this computer's is not this computer's to show.
    await computers.appFollowAsked([{ version: "0.8.5", step: "waiting" }], view);
    expect(row()?.appVersion?.follow).toBeUndefined();
    // Only that app's own connection tells it.
    await expect(
      computers.appFollowAsked([{ version: "0.8.4", step: "waiting" }], { kind: "captain" }),
    ).rejects.toThrow();

    expect(computers.updateApp(second)).toBe(true);
    expect(connection.live.at(-1)).toEqual({
      deviceId: second,
      channel: APP_UPDATE_LIVE,
      payload: { deviceId: second },
    });

    await computers.appFollowAsked([{ version: "0.8.4", step: "waiting" }], view);
    connection.tellView({ deviceId: second, contact: "gone" });
    connection.running.splice(0);
    connection.running.push({ deviceId: second, role: "view", version: "0.8.3" });
    connection.tellView({ deviceId: second, contact: "in-reach" });
    expect(row()?.appVersion).toEqual({ app: "0.8.3", than: "older" });
    connection.tellView({ deviceId: second, contact: "gone" });
    expect(computers.updateApp(second)).toBe(false);
  });
});

/**
 * A home run from source on the person's own data (`HostAppInfo.sourceOnOwnData`,
 * INF-5635's plan, piece 1): its package.json version names no release, so it
 * names none to compare (src/core/devices/homeDevices.ts), and an installed
 * computer on its contract reads as current, never as newer with an
 * Install older version to offer.
 */
describe("a home run from source", () => {
  it("reads a computer on an installed release as current when both speak one contract", () => {
    const { pairing, connection, computers } = homeAt("192.168.65.2", {
      contract: PROTOCOL_VERSION,
    });
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "Mac mini",
        user: { name: "sam", uid: 501 },
      },
      shown(createKeyIdentity("Mac mini"), "::ffff:192.168.65.9"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    const mini = joined.grant.deviceId;
    connection.tell({ deviceId: mini, contact: "in-reach" });
    connection.tellVersion(mini, {
      contract: PROTOCOL_VERSION,
      app: "0.8.6-alpha.16",
      takesWork: true,
    });
    const row = computers.list().find((device) => device.id === mini);
    expect(row?.otherVersion).toBeUndefined();
    expect(row?.workVersion).toBe("0.8.6-alpha.16");
  });
});

/**
 * A computer on this Mac's major whose hello lacks a change a crewmate turn
 * there needs (INF-5442 behavior 3): a task started there would only wait
 * for its update, so it takes no new work, and its row says so.
 */
describe("a computer behind a change a turn needs", () => {
  it("takes no new work while its hello lacks the project-address change, and takes work once it lists it", () => {
    const { pairing, connection, computers } = homeAt("192.168.65.2", {
      app: "0.8.4",
      contract: PROTOCOL_VERSION,
    });
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "Mac mini",
        user: { name: "sam", uid: 501 },
      },
      shown(createKeyIdentity("Mac mini"), "::ffff:192.168.65.9"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    const mini = joined.grant.deviceId;
    const row = () => computers.list().find((device) => device.id === mini);
    const older = CONTRACT_CHANGES.names.filter((name) => name !== "placed-project-address");
    connection.tell({ deviceId: mini, contact: "in-reach" });
    connection.tellVersion(mini, {
      contract: PROTOCOL_VERSION,
      app: "0.8.2",
      takesWork: true,
      changes: older,
    });
    expect(computers.takesNoWorkUntilUpdated(mini)).toBe(true);
    expect(row()?.otherVersion).toMatchObject({ than: "older", takesWork: false });

    // Updated: it lists the change and takes work again.
    connection.tellVersion(mini, {
      contract: PROTOCOL_VERSION,
      app: "0.8.3",
      takesWork: true,
      changes: CONTRACT_CHANGES.names,
    });
    expect(computers.takesNoWorkUntilUpdated(mini)).toBe(false);
    expect(row()?.otherVersion).toMatchObject({ than: "older", takesWork: true });

    // A newer major lists none of this major's changes, yet this Mac is the one behind.
    const newerMajor = `${Number(PROTOCOL_VERSION.split(".")[0]) + 1}.0.0`;
    connection.tellVersion(mini, {
      contract: newerMajor,
      app: "9.0.0",
      takesWork: false,
      changes: [],
    });
    expect(computers.takesNoWorkUntilUpdated(mini)).toBe(false);
  });
});

/**
 * One computer, one row (docs/devices.md, "One computer, one entry"; INF-4835's
 * piece 3, captain: "Fold them into one row by itself, keeping the one that
 * runs work"): a Mac on the list twice, once for its window and once for
 * its work, asks with its window to fold the window's entry into the work's,
 * signed with the work's key, as `foldProof` writes it on that Mac.
 */
describe("a Mac on your list twice", () => {
  const ADDRESS = "192.168.65.2";

  /** Another Mac claims a `mac` link as `user`, keeping the grant its window or work would keep. */
  function claimMac(home: ReturnType<typeof homeAt>, user: string, kind: DeviceKind = "mac") {
    const identity = createKeyIdentity("iMac");
    const joined = home.pairing.claim(
      {
        code: parsePairingLink(home.pairing.invite({ kind }).link).code,
        kind,
        name: "iMac",
        user: { name: user, uid: 501 },
        window: true,
      },
      shown(identity, "::ffff:192.168.65.9"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    return {
      version: 1 as const,
      name: "iMac",
      joinedAt: 0,
      grant: {
        at: `${ADDRESS}:${PORT}`,
        homeKey: home.pairing.identity().pin,
        deviceId: joined.grant.deviceId,
        kind: joined.grant.kind,
        key: identity.key,
        cert: identity.cert,
      },
    };
  }

  it("folds the window's row into the one its work keeps, moving each live task's Runs on, with one feed line", async () => {
    const home = homeAt(ADDRESS);
    const window = claimMac(home, "sam");
    const work = claimMac(home, "sam");
    seedTask(home.tasks, {
      id: "waits",
      title: "Fix the footer",
      status: "queued",
      shape: { kind: "fix", runs_on_ask: window.grant.deviceId },
    });
    seedTask(home.tasks, {
      id: "here",
      title: "Fix the header",
      status: "queued",
      shape: { kind: "fix", runs_on_ask: "this-mac" },
    });
    home.connection.tell({ deviceId: work.grant.deviceId, contact: "in-reach" });
    home.connection.tellView({ deviceId: window.grant.deviceId, contact: "in-reach" });
    const fold = foldProof(window, work);
    if (!fold) throw new Error("no fold");

    const kept = await home.computers.foldAsked([fold], {
      kind: "captain",
      view: window.grant.deviceId,
    });

    expect(kept).toMatchObject({ id: work.grant.deviceId, name: "iMac", kind: "mac" });
    expect(home.computers.list().map((device) => device.id)).toEqual([
      home.deviceId,
      work.grant.deviceId,
    ]);
    expect(home.tasks.get("waits")?.shape?.runs_on_ask).toBe(work.grant.deviceId);
    expect(home.tasks.get("here")?.shape?.runs_on_ask).toBe("this-mac");
    // The task that moved goes where it would start now, as after any change to its Runs on.
    expect(home.moved).toEqual(["waits"]);
    expect(home.lines).toEqual([
      expect.objectContaining({ deviceId: work.grant.deviceId, stage: "done", tone: "info" }),
    ]);
  });

  it("refuses a fold not signed by the row it keeps, another user's row, a phone's ask, and a row with a working copy", async () => {
    const home = homeAt(ADDRESS);
    const window = claimMac(home, "sam");
    const work = claimMac(home, "sam");
    const other = claimMac(home, "alex");
    const asWindow = { kind: "captain" as const, view: window.grant.deviceId };
    const listed = () => home.computers.list().map((device) => device.id);
    const before = listed();

    // Signed by the window's own key, not the work's.
    const forged = foldProof(window, { ...work, grant: { ...work.grant, key: window.grant.key } });
    await expect(home.computers.foldAsked([forged], asWindow)).rejects.toThrow(/not signed/);
    // Another user on the same Mac stays its own row.
    await expect(home.computers.foldAsked([foldProof(window, other)], asWindow)).rejects.toThrow(
      /same user|one user/,
    );
    // Asked by no window at all.
    await expect(
      home.computers.foldAsked([foldProof(window, work)], { kind: "captain" }),
    ).rejects.toThrow(/own window/);
    // The row that would go keeps a working copy there.
    seedTask(home.tasks, {
      id: "there",
      title: "Fix the footer",
      status: "idle",
      worktreeDir: "/work/footer",
      deviceId: window.grant.deviceId,
    });
    await expect(home.computers.foldAsked([foldProof(window, work)], asWindow)).rejects.toThrow(
      /working copy/,
    );
    expect(listed()).toEqual(before);
    expect(home.lines).toEqual([]);
  });

  it("removes a row only its window holds, waiting to be removed when it is back, once that window connects", async () => {
    const home = homeAt(ADDRESS);
    const window = claimMac(home, "sam");
    const id = window.grant.deviceId;
    await home.computers.remove(id, "when-back");
    expect(home.computers.list().find((device) => device.id === id)).toMatchObject({
      removal: "when-back",
    });

    home.connection.tellView({ deviceId: id, contact: "in-reach" });
    // Its work connecting while that removal runs starts no second one.
    home.connection.tell({ deviceId: id, contact: "in-reach" });

    await vi.waitFor(() =>
      expect(home.computers.list().map((device) => device.id)).toEqual([home.deviceId]),
    );
    const stages = home.pushed.flatMap((list) =>
      list.filter((device) => device.id === id).map((device) => device.removal),
    );
    expect(stages).toContain("cleaning-up");
    expect(stages).not.toContain("bringing-work");
  });
});

// The captain's ask (INF-4835): "Set it up again by itself, and say why when it still cannot".
describe("a Mac whose window is connected and whose work is not in reach", () => {
  function joinedMac() {
    const home = homeAt("192.168.65.2");
    // Joined with its window from another Mac, dialing this Mac on the local network.
    const joined = home.pairing.claim(
      {
        code: parsePairingLink(home.pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "iMac",
        user: { name: "sam", uid: 501 },
        window: true,
      },
      shown(createKeyIdentity("iMac"), "::ffff:192.168.65.2"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    const deviceId = joined.grant.deviceId;
    const imac = () => home.pushed.at(-1)?.find((device) => device.id === deviceId);
    const listed = () => home.computers.list().find((device) => device.id === deviceId);
    return { ...home, deviceId, imac, listed };
  }

  it("says why its window could not set up its work, until its work is in reach or its window goes", () => {
    const { connection, computers, deviceId, listed } = joinedMac();
    connection.tellView({ deviceId, contact: "in-reach" });
    // Nothing is said before its window says what it found.
    expect(listed()).toMatchObject({ inReach: false, controlling: true });
    expect(listed()).not.toHaveProperty("workSetup");

    computers.heardWorkSetup(deviceId, { state: "blocked", reason: "background-off" });
    expect(listed()?.workSetup).toEqual({ state: "blocked", reason: "background-off" });

    // Its work reaches this Mac: nothing more to say.
    connection.tell({ deviceId, contact: "in-reach" });
    expect(listed()).not.toHaveProperty("workSetup");
    connection.tell({ deviceId, contact: "gone" });
    expect(listed()?.workSetup).toEqual({ state: "blocked", reason: "background-off" });
    // Its window goes: what it found is said again at its next connection.
    connection.tellView({ deviceId, contact: "gone" });
    expect(listed()).not.toHaveProperty("workSetup");
    connection.tellView({ deviceId, contact: "in-reach" });
    expect(listed()).not.toHaveProperty("workSetup");
  });

  it("reads a run its window found or asked for as starting, then from the work's own contact as held on the local network", () => {
    const { clock, connection, computers, deviceId, imac, listed } = joinedMac();
    connection.tellView({ deviceId, contact: "in-reach" });
    // Its window's own connection never says its work's dial reached this Mac.
    expect(listed()).toMatchObject({ heldOnLocalNetwork: true });

    computers.heardWorkSetup(deviceId, { state: "running" });
    expect(imac()?.workSetup).toEqual({ state: "starting" });
    clock.advance(WORK_REACH_GRACE_MS);
    // The list is pushed again once the run had its moment.
    expect(imac()?.workSetup).toEqual({ state: "blocked", reason: "local-network" });

    // Once its work reached this Mac, a later run that does not is not named.
    connection.tell({ deviceId, contact: "in-reach" });
    connection.tell({ deviceId, contact: "gone" });
    computers.heardWorkSetup(deviceId, { state: "running" });
    clock.advance(WORK_REACH_GRACE_MS);
    expect(imac()?.workSetup).toEqual({ state: "blocked", reason: "not-reached" });

    // A run asked for that never took the folder is not left setting up.
    computers.heardWorkSetup(deviceId, { state: "starting" });
    expect(imac()?.workSetup).toEqual({ state: "starting" });
    clock.advance(WORK_REACH_GRACE_MS);
    expect(imac()?.workSetup).toEqual({ state: "blocked", reason: "not-reached" });
  });

  // INF-5468's plan, piece 2: a background whose recorded copy was deleted
  // starts the app there instead, and the home says so once.
  it("says once in the feed that its work starts from the app there now, its recorded copy gone", () => {
    const { connection, computers, deviceId, lines, listed } = joinedMac();
    connection.tellView({ deviceId, contact: "in-reach" });
    const said = () => lines.filter((line) => line.deviceId === deviceId).map((line) => line.text);
    computers.heardWorkSetup(deviceId, { state: "starting", copyGone: true });
    const name = deviceLabel(listed() as DeviceView);
    expect(said()).toEqual([m.devicesWorkCopyGone({ device: name })]);
    // A later report without it says nothing more.
    computers.heardWorkSetup(deviceId, { state: "running" });
    expect(said()).toEqual([m.devicesWorkCopyGone({ device: name })]);
  });

  it("asks its window, connected now, to set its work up again on Fix it", () => {
    const { connection, computers, deviceId } = joinedMac();
    expect(computers.fixWork(deviceId)).toBe(false);
    connection.tellView({ deviceId, contact: "in-reach" });
    expect(computers.fixWork(deviceId)).toBe(true);
    expect(connection.live.at(-1)).toEqual({
      deviceId,
      channel: WORK_SETUP_LIVE,
      payload: { deviceId },
    });
  });

  it("refuses a report for a computer that is not a Mac with a window", () => {
    const { computers } = joinedMac();
    // The Mac mini a command added runs work and has no window here.
    const mini = computers.list().find((device) => device.kind === "work");
    expect(() => computers.heardWorkSetup(mini?.id ?? "", { state: "running" })).toThrow();
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

describe("your devices after a task changes", () => {
  // INF-2240: every task write refreshes this list. Each computer's count
  // comes from where its running tasks run, never from composing their records.
  it("counts each computer's running tasks from where they run, without composing a task record", () => {
    const { computers, pushed, db, tasks, deviceId } = homeAt("192.168.65.2");
    const tasksOn = (list: DeviceView[] | undefined) =>
      list?.find((device) => device.id === deviceId)?.tasks;
    const measured = () => {
      const parse = vi.spyOn(JSON, "parse");
      try {
        let list: DeviceView[] = [];
        const rows = rowsRead(db, () => {
          list = computers.list();
        });
        return { rows, parses: parse.mock.calls.length, tasks: tasksOn(list) };
      } finally {
        parse.mockRestore();
      }
    };
    // Each record keeps what it was asked, as a real one does.
    const seed = (id: string, status: "idle" | "running" | "queued" | "cancelled", on?: string) =>
      seedTask(tasks, {
        id,
        title: "Fix the footer",
        status,
        intent: { goal: "Fix the footer", userWords: "the footer is broken" },
        ...(on ? { deviceId: on } : {}),
      });
    seed("there-0", "idle", deviceId);
    seed("there-1", "running", deviceId);
    const before = measured();
    expect(before.tasks).toBe(2);

    // Twenty more run there and twenty here; ten wait there and ten closed there.
    for (let index = 0; index < 20; index += 1) {
      seed(`more-${index}`, "idle", deviceId);
      seed(`here-${index}`, "idle");
    }
    for (let index = 0; index < 10; index += 1) {
      seed(`waits-${index}`, "queued", deviceId);
      seed(`closed-${index}`, "cancelled", deviceId);
    }
    const after = measured();
    console.info(JSON.stringify({ intent: "INF-2240 device task counts", before, after }));
    expect(after.tasks).toBe(22);
    // One row for each task running there, and no record composed for any of them.
    expect(after.rows - before.rows).toBe(20);
    expect(after.parses).toBe(before.parses);

    // A task change pushes the list with the count it moved to.
    seed("started", "idle", deviceId);
    expect(tasksOn(pushed.at(-1))).toBe(23);
    tasks.placement.setDevice("more-0", null);
    expect(tasksOn(pushed.at(-1))).toBe(22);
    tasks.close("there-0", { status: "dropped", reason: "cancelled", actor: "host" });
    expect(tasksOn(pushed.at(-1))).toBe(21);
    expect(computers.list().find((device) => device.id === deviceId)?.tasks).toBe(21);
  });
});

/**
 * A computer that joined again under a new key (docs/devices.md, "Joined
 * again"; INF-5468's piece 1): its data folder gone, Mac mini joins as a
 * new entry while its earlier one is out of reach with a task started
 * there. The real pairing, task record and `Computers`; the move of each
 * task stands in for `TaskMoves.requestComputerMove`, whose own tests own
 * the move itself.
 */
describe("a computer that joins again under a new key", () => {
  const ADDRESS = "192.168.65.2";

  /** Mac mini joins again as `user` with a fresh key, a minute after its first join. */
  function joinAgain(home: ReturnType<typeof homeAt>, user = "sam") {
    home.clock.advance(60_000);
    const joined = home.pairing.claim(
      {
        code: parsePairingLink(home.pairing.invite({ kind: "work", command: "another-mac" }).link)
          .code,
        kind: "work",
        name: "Mac mini",
        user: { name: user, uid: 501 },
      },
      shown(createKeyIdentity("Mac mini"), `::ffff:${ADDRESS}`),
    );
    if (!joined.ok) throw new Error(joined.reason);
    home.connection.tell({ deviceId: joined.grant.deviceId, contact: "in-reach" });
    return joined.grant.deviceId;
  }

  function started(home: ReturnType<typeof homeAt>, id: string) {
    seedTask(home.tasks, {
      id,
      title: "Fix the footer",
      status: "running",
      intent: { goal: "Fix the footer", userWords: "the footer is broken" },
      deviceId: home.deviceId,
    });
  }

  it("names the earlier entry on the new one only for the same name and user", () => {
    const home = homeAt(ADDRESS);
    started(home, "footer");
    const again = joinAgain(home);
    const other = joinAgain(home, "builder");
    const row = (id: string) => home.computers.list().find((device) => device.id === id);
    expect(row(again)?.earlier).toEqual([home.deviceId]);
    expect(row(other)?.earlier).toBeUndefined();
    expect(row(home.deviceId)).toMatchObject({ inReach: false, tasks: 1, carriesOn: 1 });
    expect(row(again)?.carriesOn).toBeUndefined();
  });

  it("carries every task on to the new entry, then removes the earlier one", async () => {
    const asked: [string, string][] = [];
    let tasks: TaskService | undefined;
    const home = homeAt(ADDRESS, undefined, {
      // The move finishes at once: the task runs on the new entry.
      carryTask: async (taskId, to) => {
        asked.push([taskId, to]);
        tasks?.placement.setDevice(taskId, to);
        return { ok: true, text: "moving" };
      },
    });
    tasks = home.tasks;
    started(home, "footer");
    started(home, "header");
    // One not started yet names the earlier entry as where it runs.
    seedTask(home.tasks, {
      id: "waits",
      title: "Fix the menu",
      status: "queued",
      shape: { kind: "fix", runs_on_ask: home.deviceId },
    });
    const again = joinAgain(home);

    const label = (id: string) => {
      const row = home.computers.list().find((device) => device.id === id);
      if (!row) throw new Error("not on the list");
      return deviceLabel(row);
    };
    const fact = said("devicesCarryRunsOn", { to: label(again), from: label(home.deviceId) });
    const answer = await home.computers.carryOn(home.deviceId, again);
    await vi.waitFor(() => expect(home.lines).toHaveLength(1));

    expect(answer).toEqual({ moving: 2, stayed: [] });
    expect(asked).toEqual([
      ["footer", again],
      ["header", again],
    ]);
    expect(home.tasks.get("footer")?.deviceId).toBe(again);
    expect(home.computers.list().map((device) => device.id)).toEqual([again]);
    // Its Runs on follows, and its record says why: the carry, not a fold.
    expect(home.tasks.get("waits")?.shape?.runs_on_ask).toBe(again);
    expect(home.moved).toContain("waits");
    const line = home.tasks.timeline("waits").find((event) => event.data?.said);
    expect(line).toMatchObject({ text: englishOf(fact), data: { said: fact } });
    expect(home.lines.at(-1)).toMatchObject({ deviceId: again, stage: "done", tone: "info" });
  });

  it("leaves a review behind uncounted, and Remove now stops it with the earlier entry", async () => {
    const asked: string[] = [];
    const stopped: string[] = [];
    let tasks: TaskService | undefined;
    const home = homeAt(ADDRESS, undefined, {
      carryTask: async (taskId, to) => {
        asked.push(taskId);
        tasks?.placement.setDevice(taskId, to);
        return { ok: true, text: "moving" };
      },
      stopTasks: async (deviceId) => {
        stopped.push(deviceId);
      },
    });
    tasks = home.tasks;
    started(home, "footer");
    // Its builder's independent review runs there too, and follows its builder.
    seedTask(home.tasks, {
      id: "review",
      title: "Review the footer",
      status: "running",
      intent: { goal: "Review the footer", userWords: "the footer is broken" },
      shape: { kind: "review" },
      deviceId: home.deviceId,
    });
    const again = joinAgain(home);
    const row = (id: string) => home.computers.list().find((device) => device.id === id);
    expect(row(home.deviceId)).toMatchObject({ tasks: 2, carriesOn: 1 });

    const answer = await home.computers.carryOn(home.deviceId, again);
    await vi.waitFor(() => expect(home.lines).toHaveLength(1));

    expect(answer).toEqual({ moving: 1, stayed: [] });
    expect(asked).toEqual(["footer"]);
    expect(stopped).toEqual([home.deviceId]);
    expect(home.computers.list().map((device) => device.id)).toEqual([again]);
  });

  it("keeps the earlier entry and says why when a task cannot move", async () => {
    const problems: (string | Said)[] = [];
    const home = homeAt(ADDRESS, undefined, {
      carryTask: async () => ({ ok: false, text: "The footer task holds no commit here." }),
      onProblem: (text) => problems.push(text),
    });
    started(home, "footer");
    const again = joinAgain(home);

    const answer = await home.computers.carryOn(home.deviceId, again);

    expect(answer).toEqual({ moving: 0, stayed: ["The footer task holds no commit here."] });
    const earlier = home.computers.list().find((device) => device.id === home.deviceId);
    expect(earlier).toMatchObject({ carriesOn: 1, tasks: 1 });
    expect(earlier?.carrying).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("keeps the earlier entry when a move it started ends with the task still there", async () => {
    const problems: (string | Said)[] = [];
    const home = homeAt(ADDRESS, undefined, {
      carryTask: async () => ({ ok: true, text: "moving" }),
      onProblem: (text) => problems.push(text),
    });
    started(home, "footer");
    const again = joinAgain(home);

    const earlier = home.computers.list().find((device) => device.id === home.deviceId);
    if (!earlier) throw new Error("not on the list");
    await home.computers.carryOn(home.deviceId, again);

    expect(home.computers.list().map((device) => device.id)).toContain(home.deviceId);
    // Saved as a fact, worded wherever it is shown.
    expect(problems).toEqual([
      said("devicesCarryStayed", { count: 1, from: deviceLabel(earlier) }),
    ]);
  });

  it("refuses a computer in reach, and a destination out of reach", async () => {
    const home = homeAt(ADDRESS, undefined, { carryTask: async () => ({ ok: true, text: "" }) });
    started(home, "footer");
    const again = joinAgain(home);
    await expect(home.computers.carryOn(again, home.deviceId)).rejects.toThrow(/in reach/);
    home.connection.tell({ deviceId: again, contact: "gone" });
    await expect(home.computers.carryOn(home.deviceId, again)).rejects.toThrow(/out of reach/);
  });
});

// INF-5635's plan, piece 3: "Match brings a Mac to the home's commit; a failing build leaves it
// on its old copy and says why".
describe("matching a computer to this Mac's source", () => {
  const HOME = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const sourceHome = () => {
    const home = homeAt("192.168.65.2", {
      contract: PROTOCOL_VERSION,
      build: { commit: HOME, source: { edited: true } },
    });
    home.connection.tell({ deviceId: home.deviceId, contact: "in-reach" });
    return home;
  };
  /** The Mac mini's hello: its build, and whether it lists the source builds change. */
  const hello = (build: WorkDeviceVersion["build"], builds = true): WorkDeviceVersion => ({
    contract: PROTOCOL_VERSION,
    app: "0.8.6-alpha.16",
    takesWork: true,
    changes: builds ? [...CONTRACT_CHANGES.names] : [],
    ...(build ? { build } : {}),
  });

  it("names this Mac's commit on a row running another build, and none once it runs that commit", () => {
    const { connection, computers, deviceId } = sourceHome();
    connection.tellVersion(deviceId, hello({ commit: OTHER, source: { edited: false } }));
    const row = () => computers.list().find((device) => device.id === deviceId);
    expect(row()?.otherVersion?.source).toEqual({ commit: HOME });
    connection.tellVersion(deviceId, hello({ commit: HOME, source: { edited: false } }));
    expect(row()?.otherVersion).toBeUndefined();
  });

  it("asks the computer to build this Mac's commit, says each step, and answers once it runs it", async () => {
    const { connection, computers, deviceId, lines } = sourceHome();
    connection.tellVersion(deviceId, hello({ commit: OTHER }));
    const asked: { channel: string; args: unknown }[] = [];
    let state = "fetching";
    connection.link.ask = async (_deviceId, channel, args) => {
      asked.push({ channel, args });
      if (channel === WORK_PROGRESS_ORDER) return { received: 0, state };
      state = "building";
      await new Promise((resolve) => setTimeout(resolve, 30));
      // It restarts on the build, and its hello names this Mac's commit.
      setImmediate(() =>
        connection.tellVersion(deviceId, hello({ commit: HOME, source: { edited: false } })),
      );
      return { restarts: true };
    };
    const view = await computers.update(deviceId);
    expect(asked.find((ask) => ask.channel === WORK_SOURCE_ORDER)?.args).toEqual([
      { commit: HOME },
    ]);
    expect("otherVersion" in view && view.otherVersion).toBeFalsy();
    const said = lines.map((line) => line.text);
    expect(said).toContain(m.devicesSourceFetching({ device: "Mac mini" }));
    expect(said.at(-1)).toContain("Mac mini");
    expect(lines.at(-1)?.stage).toBe("done");
  });

  it("says the step a build failed at, and that the computer keeps its version", async () => {
    const { connection, computers, deviceId, lines } = sourceHome();
    connection.tellVersion(deviceId, hello({ commit: OTHER }));
    connection.link.ask = async (_deviceId, channel) =>
      channel === WORK_SOURCE_ORDER
        ? { failed: "install", detail: "ERR_PNPM_FETCH_404" }
        : { received: 0, state: "installing" };
    const refused = await computers.update(deviceId).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
    expect((refused as RemoteLoginRefusedError).lines).toEqual([
      m.devicesSourceFailedInstall({ device: "Mac mini" }),
      m.devicesSourceKeepsVersion(),
    ]);
    expect(lines.filter((line) => line.stage === "refused").map((line) => line.text)).toEqual([
      m.devicesSourceFailedInstall({ device: "Mac mini" }),
      m.devicesSourceKeepsVersion(),
    ]);
  });

  it("refuses a computer too old to build source, sending it nothing", async () => {
    const { connection, computers, deviceId } = sourceHome();
    connection.tellVersion(deviceId, hello(undefined, false));
    const asked: string[] = [];
    connection.link.ask = async (_deviceId, channel) => {
      asked.push(channel);
      return {};
    };
    const refused = await computers.update(deviceId).catch((error: unknown) => error);
    expect((refused as RemoteLoginRefusedError).lines).toEqual([
      m.devicesSourceTooOld({ device: "Mac mini" }),
      m.devicesSourceTooOldNext(),
    ]);
    expect(asked).toEqual([]);
  });

  it("builds this Mac's commit on a Mac added by its address, without going over Remote Login", async () => {
    const overRemoteLogin: string[] = [];
    const home = homeAt(
      "192.168.65.2",
      { contract: PROTOCOL_VERSION, build: { commit: HOME, source: { edited: true } } },
      {
        updateOverRemoteLogin: async (deviceId) => {
          overRemoteLogin.push(deviceId);
          throw new Error("went over Remote Login");
        },
      },
    );
    const { connection, computers, deviceId, pairing } = home;
    // As the list keeps a Mac added by its address.
    const list = pairing.list.bind(pairing);
    pairing.list = () =>
      list().map((device) =>
        device.id === deviceId ? { ...device, remoteLogin: "sam@mini.local" } : device,
      );
    connection.tell({ deviceId, contact: "in-reach" });
    connection.tellVersion(deviceId, hello({ commit: OTHER }));
    const asked: string[] = [];
    connection.link.ask = async (_deviceId, channel) => {
      asked.push(channel);
      return channel === WORK_SOURCE_ORDER
        ? { failed: "build" }
        : { received: 0, state: "building" };
    };
    await computers.update(deviceId).catch(() => undefined);
    expect(asked).toContain(WORK_SOURCE_ORDER);
    expect(overRemoteLogin).toEqual([]);
  });

  it("refuses a computer that is not a Mac, sending it nothing and keeping no yes", async () => {
    const { connection, computers, deviceId, pairing } = sourceHome();
    pairing.noteSystem(deviceId, { system: "linux" });
    connection.tellVersion(deviceId, hello({ commit: OTHER }));
    const asked: string[] = [];
    connection.link.ask = async (_deviceId, channel) => {
      asked.push(channel);
      return {};
    };
    const refused = await computers.update(deviceId).catch((error: unknown) => error);
    expect((refused as RemoteLoginRefusedError).lines).toEqual([
      m.devicesSourceNotMac({ device: "Mac mini" }),
      m.devicesSourceKeepsVersion(),
    ]);
    expect(asked).toEqual([]);
    computers.allowSource(deviceId);
    expect(computers.sourceAllowed(deviceId)).toBe(false);
  });

  it("keeps the captain's Match as that computer's yes to running source, and only then", () => {
    const { connection, computers, deviceId } = sourceHome();
    connection.tellVersion(deviceId, hello({ commit: HOME, source: { edited: false } }));
    computers.allowSource(deviceId);
    expect(computers.sourceAllowed(deviceId)).toBe(false);
    connection.tellVersion(deviceId, hello({ commit: OTHER }));
    computers.allowSource(deviceId);
    expect(computers.sourceAllowed(deviceId)).toBe(true);
  });
});
