import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DeviceSsh, deviceLabel } from "@shared/devices";
import { type RemoteLoginAddOptions, remoteLoginWords } from "@shared/remoteLogin";
import { sshConnectionWords } from "@shared/sshConnection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectClient, freePort } from "../../../tests/helpers/connectionClient";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { forwardSocket } from "../../../tests/helpers/socketForward";
import {
  SSH_SERVER_AVAILABLE,
  type SshServer,
  startSshServer,
} from "../../../tests/helpers/sshServer";
import { standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { WorkDevices } from "../placed/workDevices";
import { claimLink, findHomeAgain } from "./dial";
import { JoinedHome } from "./joinedHome";
import { DevicePairing } from "./pairing";
import { RemoteLogin } from "./remoteLogin";
import type { SshProgram } from "./ssh";
import { CLEANUP_HORIZON_MS, type DeviceConnectionEvent, SshConnections } from "./sshConnections";

/**
 * This Mac's own SSH connection to a computer it added by its address
 * (docs/devices.md, "Through the home's SSH"), as the home keeps it: the
 * Mac's own `/usr/bin/ssh` in batch mode against a throwaway SSH server on
 * loopback (`tests/helpers/sshServer.ts`), the real pairing, connection and
 * Remote Login, and a stand-in Firstmate there whose `work connect` speaks
 * the controller's side (`tests/helpers/standInFirstmate.ts`). The real
 * controller is src/core/helper/connect.test.ts's, and the real app on both
 * sides is tests/e2e/run-work.spec.ts's.
 */

// Real processes: sshd, ssh, tar, curl and openssl (slowest measured 2.1 s).
vi.setConfig({ testTimeout: 15_000 });

/** Add it after saying this is the Mac, so the check is not what these tests are about. */
async function addChecked(
  remote: RemoteLogin,
  address: string,
  options: Partial<RemoteLoginAddOptions> = {},
) {
  const asked = await remote.addOrAsk(address, options);
  if (!("asks" in asked) || asked.asks !== "confirm") {
    if ("asks" in asked) throw new Error(remoteLoginWords.leaveQuestion(asked)[0]);
    return asked;
  }
  const again = await remote.addOrAsk(address, { ...options, confirm: asked.line });
  if ("asks" in again) throw new Error(remoteLoginWords.leaveQuestion(again)[0]);
  return again;
}

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const servers: SshServer[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

/** The macOS user number the stand-in joins as; the home runs as another. */
const THEIR_UID = 4242;

/** A computer that runs work, as it pairs. */
const MINI = { kind: "work", name: "Mac mini", user: { name: "sam", uid: THEIR_UID } } as const;

async function server(options?: { forwarding?: boolean }): Promise<SshServer> {
  const started = await startSshServer(options);
  servers.push(started);
  return started;
}

/**
 * A home, as the app composes it: pairing, the connection attached to the
 * core's way to its computers, Remote Login, and the SSH connections, with
 * the tries and beats cut short. The stand-in there writes down every
 * start, each forward and beat, and when its connection ended.
 */
async function home(
  ssh: SshProgram,
  options: { now?: () => number; agent?: string; quietRetryMs?: number } = {},
) {
  const port = await freePort();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-ssh-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: THEIR_UID + 1,
    ...(options.now ? { now: options.now } : {}),
  });
  pairings.push(pairing);
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
  });
  connections.push(connection);
  const work = new WorkDevices();
  work.attach(connection);
  const record = join(scratchDir("infinitary-ssh-record-"), "started");
  const said: DeviceConnectionEvent[] = [];
  const lines: string[] = [];
  const controlBase = socketScratchDir("fm-c-");
  let changes = 0;
  /** Every state Devices could read of each computer, at each change. */
  const seen: (DeviceSsh | undefined)[] = [];
  const ssh2 = new SshConnections({
    pairing,
    ssh,
    flavor: "dev",
    listening: () => work.listening(),
    settled: () => work.settled(),
    welcomed: (deviceId) => work.inReach(deviceId) || work.version(deviceId) !== undefined,
    onWorkDevice: (listener) => work.onWorkDevice(listener),
    cleanUpThere: (cleanup) => remote.cleanUpThere(cleanup),
    emit: (event) => said.push(event),
    changed: () => {
      changes += 1;
      for (const device of pairing.list()) seen.push(ssh2.state(device.id));
    },
    controlBase,
    retryMs: [50, 100],
    quietRetryMs: options.quietRetryMs ?? 200,
    cleanupRetryMs: [100],
    beatMs: 100,
    revocationWaitMs: 2_000,
    ...(options.now ? { now: options.now } : {}),
  });
  const remote: RemoteLogin = new RemoteLogin({
    pairing,
    ssh,
    flavor: "dev",
    appBundle: () =>
      standInFirstmate(record, THEIR_UID, {
        joined: "running",
        updated: "running",
        ...(options.agent ? { agent: options.agent } : {}),
      }),
    listening: () => work.settled(),
    inReach: (deviceId) => work.inReach(deviceId),
    connections: ssh2,
    controlBase,
    emit: (event) => lines.push(event.text),
  });
  return {
    pairing,
    port,
    work,
    remote,
    connections: ssh2,
    said,
    lines,
    controlBase,
    changes: () => changes,
    seen,
    /** What the stand-in there wrote down. */
    record: () => (existsSync(record) ? readFileSync(record, "utf8") : ""),
    /** How many forwards this Mac put in place there, one a connection. */
    forwards: () =>
      [...(existsSync(record) ? readFileSync(record, "utf8") : "").matchAll(/^forwarded /gm)]
        .length,
    start: () => {
      const stop = ssh2.start();
      stops.push(stop);
      return stop;
    },
  };
}

/** The other user's world: a home folder of its own, and where its work keeps its data. */
function otherUser() {
  const home = scratchDir("infinitary-ssh-user-");
  const work = join(home, "work");
  return {
    work,
    env: { HOME: home, INFINITARY_HELPER_DATA_DIR: work, INFINITARY_DEVICE_NAME: "Mac mini" },
  };
}

/** The ssh processes this home started, by its control sockets' folder. */
function sshProcesses(controlBase: string): string[] {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", controlBase], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The socket this Mac forwarded there for the connection now, from what the stand-in wrote down. */
function forwarded(record: string): string {
  return [...record.matchAll(/^forwarded (.+)$/gm)].at(-1)?.[1] ?? "";
}

const state = (connections: SshConnections, deviceId: string): DeviceSsh | undefined =>
  connections.state(deviceId);

describe.runIf(SSH_SERVER_AVAILABLE)(
  "this Mac's own SSH connection to a computer it added by its address",
  () => {
    it("keeps one connection: forwards the socket there to this Mac's own listener, carries the computer's pinned connection, beats, and ends whole", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      const stop = at.start();

      // Added: the computer is set up over its own SSH session, then the connection starts.
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });
      // Its route is out there; its work has not said hello yet.
      expect(state(at.connections, device.id)).toEqual({ state: "connecting" });
      expect(at.record()).toMatch(
        new RegExp(
          `^started: work connect --from-home --home ${at.pairing.identity().pin} --device ${device.id}$`,
          "m",
        ),
      );

      // The work there dials the socket the connection forwards: welcomed, it is connected.
      const socket = forwarded(at.record());
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      expect(grant.via).toBe("ssh");
      const client = await connectClient(grant, { dial: { target: { socket } } });
      expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
      await vi.waitFor(() =>
        expect(state(at.connections, device.id)).toEqual({ state: "connected" }),
      );
      // Each beat reaches the controller there.
      await vi.waitFor(() => expect(at.record().match(/^beat$/gm)?.length ?? 0).toBeGreaterThan(1));
      await client.close();

      // Stopped, as the app quits: the controller there let go, and nothing is left on either side.
      await stop();
      expect(at.record()).toMatch(/^connect ended$/m);
      expect(sshProcesses(at.controlBase)).toEqual([]);
      expect(readdirSync(at.controlBase)).toEqual([]);
      expect(existsSync(socket)).toBe(false);
      expect(state(at.connections, device.id)).toBeUndefined();
    });

    it("tries again on its own after a drop, and stops on what only a person mends until Try again", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // The connection drops: it is made again by itself.
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });

      // The other Mac answers unlike the key that was remembered: this Mac stops, and signs in to nothing.
      const remembered = at.pairing.rememberedHost(sshd.address);
      if (!remembered) throw new Error("Nothing was remembered for that address.");
      at.pairing.rememberHost(sshd.address, {
        ...remembered,
        publicKey: "AQID",
        line: "ED25519 SHA256:not-this-mac",
      });
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(() =>
        expect(state(at.connections, device.id)).toEqual({
          state: "stopped",
          reason: "host-changed",
        }),
      );
      const lines = sshConnectionWords.stopped("host-changed", { address: sshd.address, device });
      expect(at.said.map((event) => event.text)).toEqual(lines);
      expect(at.said.every((event) => event.tone === "warn" && event.state === "stopped")).toBe(
        true,
      );
      const tried = at.forwards();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(at.forwards()).toBe(tried);

      // Mended, Try again makes it once more.
      at.pairing.rememberHost(sshd.address, remembered);
      expect(at.connections.tryAgain()).toBe(1);
      await vi.waitFor(() => expect(at.forwards()).toBe(tried + 1), { timeout: 10_000 });
      expect(state(at.connections, device.id)).toEqual({ state: "connecting" });
      // Its work said hello again: said once that it is back.
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      const client = await connectClient(grant, {
        dial: { target: { socket: forwarded(at.record()) } },
      });
      await vi.waitFor(() => expect(at.said.at(-1)?.text).toBe(sshConnectionWords.back(device)));
      await client.close();
    });

    it("a key its app did not approve: its own reason, said once, tried again quietly, and back by itself once approved", async () => {
      const sshd = await server();
      const them = otherUser();
      // The person's SSH, whose key an app holds and asks about before each use.
      sshd.agentAnswers("approve");
      const at = await home(sshd.ssh({ key: "agent", remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // The app does not approve it this time, and the connection drops.
      sshd.agentAnswers("decline");
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(
        () =>
          expect(state(at.connections, device.id)).toEqual({
            state: "stopped",
            reason: "agent-declined",
          }),
        { timeout: 10_000 },
      );
      const lines = sshConnectionWords.stopped("agent-declined", { address: sshd.address, device });
      expect(at.said.map((event) => event.text)).toEqual(lines);

      // Tried again by itself, quietly: Devices says why it stopped all along, and the feed nothing new.
      at.seen.splice(0);
      const before = at.changes();
      await vi.waitFor(() => expect(at.changes()).toBeGreaterThan(before + 4), { timeout: 10_000 });
      expect(at.seen).not.toHaveLength(0);
      expect(
        at.seen.every((seen) => seen?.state === "stopped" && seen.reason === "agent-declined"),
      ).toBe(true);
      expect(at.said.map((event) => event.text)).toEqual(lines);
      expect(at.forwards()).toBe(1);

      // Approved: the next quiet try makes it, and the feed says once that it is back.
      sshd.agentAnswers("approve");
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      const client = await connectClient(grant, {
        dial: { target: { socket: forwarded(at.record()) } },
      });
      await vi.waitFor(() =>
        expect(state(at.connections, device.id)).toEqual({ state: "connected" }),
      );
      await vi.waitFor(() =>
        expect(at.said.map((event) => event.text)).toEqual([
          ...lines,
          sshConnectionWords.back(device),
        ]),
      );
      await client.close();
    });

    it("a key whose app is not open: its own reason, said once, tried again quietly, and back by itself once opened", async () => {
      const sshd = await server();
      const them = otherUser();
      // The person's SSH, whose key an app holds, approving while it runs.
      sshd.agentAnswers("approve");
      const at = await home(sshd.ssh({ key: "agent", remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // The app quits, leaving its socket behind, and the connection drops.
      await sshd.agentRuns("quit-left");
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(
        () =>
          expect(state(at.connections, device.id)).toEqual({
            state: "stopped",
            reason: "agent-not-running",
          }),
        { timeout: 10_000 },
      );
      const lines = sshConnectionWords.stopped("agent-not-running", {
        address: sshd.address,
        device,
      });
      expect(at.said.map((event) => event.text)).toEqual(lines);

      // Tried again by itself, quietly: Devices says why it stopped all along, and the feed nothing new.
      at.seen.splice(0);
      const before = at.changes();
      await vi.waitFor(() => expect(at.changes()).toBeGreaterThan(before + 4), { timeout: 10_000 });
      expect(at.seen).not.toHaveLength(0);
      expect(
        at.seen.every((seen) => seen?.state === "stopped" && seen.reason === "agent-not-running"),
      ).toBe(true);
      expect(at.said.map((event) => event.text)).toEqual(lines);
      expect(at.forwards()).toBe(1);

      // Opened again: the next quiet try makes it, and the feed says once that it is back.
      await sshd.agentRuns("open");
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      const client = await connectClient(grant, {
        dial: { target: { socket: forwarded(at.record()) } },
      });
      await vi.waitFor(() =>
        expect(state(at.connections, device.id)).toEqual({ state: "connected" }),
      );
      await vi.waitFor(() =>
        expect(at.said.map((event) => event.text)).toEqual([
          ...lines,
          sshConnectionWords.back(device),
        ]),
      );
      await client.close();
    });

    it("stops when the other Mac's Remote Login will not carry the connection, or Firstmate is gone there", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });
      await at.connections.hold(device.id, async () => {
        // Firstmate there is deleted while the connection is held.
        execFileSync("/bin/rm", ["-rf", join(them.work, "app")]);
      });
      // Made again, it reads the check line and signs in before the controller
      // there refuses: SSH's own work, which outlasts a second on a busy Linux runner.
      await vi.waitFor(
        () =>
          expect(state(at.connections, device.id)).toEqual({
            state: "stopped",
            reason: "not-set-up",
          }),
        { timeout: 10_000 },
      );

      // A Remote Login that refuses every forward refuses to set a Mac up, and nothing joins.
      const closed = await server({ forwarding: false });
      const elsewhere = await home(closed.ssh({ remote: otherUser().env }));
      elsewhere.start();
      await expect(addChecked(elsewhere.remote, closed.address)).rejects.toMatchObject({
        refusal: "forwarding-refused",
      });
      expect(elsewhere.pairing.list()).toEqual([]);
      expect(elsewhere.pairing.any()).toBe(false);
    });

    it("holds the connection while an operation runs on that Mac, and makes it again after", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // Updated: the connection lets go first, the copy is replaced, and it is made again to it.
      await at.remote.update(device.id);
      const record = at.record();
      const update = record.lastIndexOf("started: work update");
      expect(record.lastIndexOf("connect ended")).toBeLessThan(update);
      expect(record.lastIndexOf("connect ended")).toBeGreaterThan(record.indexOf("forwarded "));
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
      expect(at.record().lastIndexOf("forwarded ")).toBeGreaterThan(update);
    });

    it("a computer found again by its address waits for the find to end before its connection is made", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      // A computer a command joined, which dials this Mac's address itself.
      const direct = at.pairing.invite({ kind: "work", at: `127.0.0.1:${at.port}` }).link;
      await at.work.settled();
      const grant = await claimLink(direct, MINI);
      expect(at.pairing.sshConnections()).toEqual([]);

      // Add it finds it again over this Mac's SSH: the connection pairing now
      // asks for stays held until the find is done, then is made.
      const forward = await forwardSocket(at.port);
      stops.push(() => forward.close());
      await at.connections.hold(grant.deviceId, async () => {
        const { link } = at.pairing.invite(
          { kind: "work" },
          { remoteLogin: sshd.address, via: "ssh", locality: "elsewhere" },
        );
        await at.work.settled();
        await findHomeAgain(link, grant, MINI, { target: { socket: forward.socket } });
        expect(at.pairing.sshConnections()).toEqual([
          { deviceId: grant.deviceId, address: sshd.address },
        ]);
        expect(state(at.connections, grant.deviceId)).toBeUndefined();
        expect(sshProcesses(at.controlBase)).toEqual([]);
      });
      // Nothing was set up there in this test, so the connection made after
      // finds no Firstmate and says so.
      await vi.waitFor(
        () =>
          expect(state(at.connections, grant.deviceId)).toEqual({
            state: "stopped",
            reason: "not-set-up",
          }),
        { timeout: 10_000 },
      );
    });

    it("asleep it tries nothing, and waking tries a computer out of reach at once", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      at.connections.suspend();
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(() => expect(state(at.connections, device.id)?.state).toBe("reconnecting"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(at.forwards()).toBe(1);

      at.connections.resume();
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
    });

    it("a key that is locked, or whose app did not answer: said once, tried again quietly every few minutes, and back by itself once unlocked", async () => {
      const sshd = await server();
      const them = otherUser();
      // The person's SSH, whose key the test locks and unlocks as its app would.
      const ssh: SshProgram = { ...sshd.ssh({ remote: them.env }) };
      const at = await home(ssh);
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // The key's app stops answering, and the connection drops.
      Object.assign(ssh, sshd.ssh({ key: "locked", remote: them.env }));
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(
        () =>
          expect(state(at.connections, device.id)).toEqual({
            state: "stopped",
            reason: "key-locked",
          }),
        { timeout: 10_000 },
      );
      const lines = sshConnectionWords.stopped("key-locked", { address: sshd.address, device });
      expect(at.said.map((event) => event.text)).toEqual(lines);

      // Tried again by itself, quietly: Devices says it stopped all along, and the feed nothing new.
      at.seen.splice(0);
      const before = at.changes();
      await vi.waitFor(() => expect(at.changes()).toBeGreaterThan(before + 4), { timeout: 10_000 });
      expect(at.seen).not.toHaveLength(0);
      expect(
        at.seen.every((seen) => seen?.state === "stopped" && seen.reason === "key-locked"),
      ).toBe(true);
      expect(at.said.map((event) => event.text)).toEqual(lines);
      expect(at.forwards()).toBe(1);

      // Unlocked: the next quiet try makes it, and the feed says once that it is back.
      Object.assign(ssh, sshd.ssh({ remote: them.env }));
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      const client = await connectClient(grant, {
        dial: { target: { socket: forwarded(at.record()) } },
      });
      await vi.waitFor(() =>
        expect(state(at.connections, device.id)).toEqual({ state: "connected" }),
      );
      await vi.waitFor(() =>
        expect(at.said.map((event) => event.text)).toEqual([
          ...lines,
          sshConnectionWords.back(device),
        ]),
      );
      await client.close();
    });

    it("a key that is locked, or whose app did not answer: asleep it tries nothing, and waking tries it at once", async () => {
      const sshd = await server();
      const them = otherUser();
      const ssh: SshProgram = { ...sshd.ssh({ remote: them.env }) };
      // Quiet tries far apart, so only waking tries it within the test.
      const at = await home(ssh, { quietRetryMs: 10 * 60_000 });
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });
      Object.assign(ssh, sshd.ssh({ key: "locked", remote: them.env }));
      for (const pid of sshProcesses(at.controlBase)) process.kill(Number(pid), "SIGKILL");
      await vi.waitFor(() => expect(state(at.connections, device.id)?.reason).toBe("key-locked"), {
        timeout: 10_000,
      });

      // Unlocked while this Mac sleeps: nothing is tried until it wakes.
      at.connections.suspend();
      Object.assign(ssh, sshd.ssh({ remote: them.env }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(at.forwards()).toBe(1);

      at.connections.resume();
      await vi.waitFor(() => expect(at.forwards()).toBe(2), { timeout: 10_000 });
      // Said once, never again for the quiet try.
      const lines = sshConnectionWords.stopped("key-locked", { address: sshd.address, device });
      expect(at.said.map((event) => event.text)).toEqual(lines);
    });

    it("removing a computer in reach: its connection ends once it heard, then what Firstmate set up there is removed over SSH, checked to be this home's", async () => {
      const sshd = await server();
      const them = otherUser();
      const at = await home(sshd.ssh({ remote: them.env }));
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });
      const grant = new JoinedHome(them.work).read()?.grant;
      if (!grant) throw new Error("Nothing joined there.");
      const client = await connectClient(grant, {
        dial: { target: { socket: forwarded(at.record()) } },
      });
      await vi.waitFor(() => expect(at.work.inReach(device.id)).toBe(true));

      // Removed: it is cut off through the connection, which ends once it went.
      at.pairing.remove(device.id, { cleanUpThere: true });
      await client.closed;
      // The removal reads the check line and signs in again over SSH, like the stop above.
      await vi.waitFor(
        () =>
          expect(at.record()).toContain(
            `started: work remove --from-home --home ${at.pairing.identity().pin} --device ${device.id}\n`,
          ),
        { timeout: 10_000 },
      );
      const record = at.record();
      expect(record.lastIndexOf("connect ended")).toBeLessThan(
        record.lastIndexOf("started: work remove"),
      );
      await vi.waitFor(() => expect(at.pairing.sshCleanups()).toEqual([]), { timeout: 10_000 });
      expect(sshProcesses(at.controlBase)).toEqual([]);
    });

    it("removing a computer out of reach: what Firstmate set up there is tried again quietly while it cannot be reached, and given up after thirty days", async () => {
      const sshd = await server();
      const them = otherUser();
      let now = Date.now();
      const at = await home(sshd.ssh({ remote: them.env }), { now: () => now });
      at.start();
      const device = await addChecked(at.remote, sshd.address);
      await vi.waitFor(() => expect(at.forwards()).toBe(1), { timeout: 10_000 });

      // That Mac stops answering, and the captain removes it now.
      await sshd.stop();
      at.pairing.remove(device.id, { cleanUpThere: true });
      expect(at.pairing.sshCleanups()).toEqual([
        { deviceId: device.id, address: sshd.address, name: deviceLabel(device), at: now },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(at.pairing.sshCleanups()).toHaveLength(1);
      expect(at.said).toEqual([]);

      now += CLEANUP_HORIZON_MS;
      await vi.waitFor(() => expect(at.pairing.sshCleanups()).toEqual([]), { timeout: 10_000 });
      expect(at.said.map((event) => event.text)).toEqual(
        sshConnectionWords.gaveUp({ name: deviceLabel(device), address: sshd.address }),
      );
    });
  },
);
