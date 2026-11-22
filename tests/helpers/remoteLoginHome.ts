import { statSync } from "node:fs";
import { join } from "node:path";
import type { RemoteLoginAddOptions } from "@shared/remoteLogin";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { packApp } from "../../src/core/devices/appArchive";
import type { FarBuilds } from "../../src/core/devices/farBuilds";
import type { LocalityChallenge } from "../../src/core/devices/locality";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { PhoneDoor } from "../../src/core/devices/phoneDoor";
import { type DeviceSetupEvent, RemoteLogin } from "../../src/core/devices/remoteLogin";
import type { SshProgram } from "../../src/core/devices/ssh";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { claimedPort } from "./claimedPort";
import { scratchDir } from "./scratchDirs";
import { type SshServer, startSshServer } from "./sshServer";
import { standInFirstmate } from "./standInFirstmate";

/**
 * A home that adds computers over Remote Login, for the Remote Login tests
 * (`src/core/devices/remoteLogin*.test.ts`, docs/devices.md, "Adding a
 * computer by its address"): the real pairing and connection, the Mac's own
 * ssh against a real SSH server (`sshServer.ts`), and a stand-in Firstmate
 * bundle the home sends (`standInFirstmate.ts`). Each test file closes what
 * its tests started with `afterEach(closeEach)`.
 */

export const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

export const connections: HomeConnection[] = [];
export const pairings: DevicePairing[] = [];
export const servers: SshServer[] = [];
export const doors: PhoneDoor[] = [];

export async function closeEach() {
  for (const door of doors.splice(0)) door.close();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
}

/** The macOS user number the stand-in joins as; the home runs as another. */
export const THEIR_UID = 4242;

/**
 * Add it the way the captain does after saying this is the Mac: the first
 * reach asks, and the yes is the line just shown. A later refusal is the
 * add's own.
 */
export async function addChecked(
  remote: RemoteLogin,
  address: string,
  options: Partial<RemoteLoginAddOptions> = {},
) {
  const asked = await remote.addOrAsk(address, options);
  if (!("asks" in asked) || asked.asks !== "confirm") {
    if ("asks" in asked) throw new Error(`Asked ${asked.asks}.`);
    return asked;
  }
  const again = await remote.addOrAsk(address, { ...options, confirm: asked.line });
  if ("asks" in again) throw new Error(`Asked ${again.asks}.`);
  return again;
}

export const standInBundle = (record: string, uid = THEIR_UID) => standInFirstmate(record, uid);

export function otherUser(extra: Record<string, string> = {}) {
  const home = scratchDir("infinitary-remote-user-");
  const work = join(home, "work");
  return {
    home,
    work,
    env: {
      HOME: home,
      INFINITARY_HELPER_DATA_DIR: work,
      INFINITARY_DEVICE_NAME: "Mac mini",
      ...extra,
    },
  };
}

/**
 * A home: pairing, the connection (unless it is to be out of reach), and
 * adding over SSH. A home started again on the same `dir` is the same home,
 * answering at another port, as after its address changed.
 */
export async function home(options: {
  ssh: SshProgram;
  bundle: string | null;
  listen?: boolean;
  ownUid?: number;
  dir?: string;
  inReach?: (deviceId: string) => boolean;
  here?: () => LocalityChallenge;
  copyEveryMs?: number;
  builds?: FarBuilds;
  idleTimeoutMs?: number;
  sendTimeoutMs?: number;
}) {
  const port = await claimedPort();
  const pairing = new DevicePairing({
    // Where the app keeps it has a space in it, as Application Support does.
    dir:
      options.dir ?? join(scratchDir("infinitary-remote-home-"), "Application Support", "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: options.ownUid ?? THEIR_UID + 1,
  });
  pairings.push(pairing);
  const listening =
    options.listen === false
      ? null
      : startConnection({ dispatch: standIn, events: new CoreEventBus(), devices: pairing, port });
  if (listening) connections.push(listening);
  const said: DeviceSetupEvent[] = [];
  const remote = new RemoteLogin({
    pairing,
    ssh: options.ssh,
    flavor: "dev",
    appBundle: () => options.bundle,
    builds: options.builds,
    idleTimeoutMs: options.idleTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    listening: async () => {
      await listening?.settled();
    },
    ...(options.inReach ? { inReach: options.inReach } : {}),
    ...(options.here ? { here: options.here } : {}),
    ...(options.copyEveryMs !== undefined ? { copyEveryMs: options.copyEveryMs } : {}),
    emit: (event) => said.push(event),
  });
  return {
    pairing,
    port,
    remote,
    said,
    /** Each line said, but the copy's moving count, which `sending` reads. */
    lines: () => said.filter((event) => event.copy?.state !== "sending").map((event) => event.text),
    /** The copy's count of the bytes it sent so far, each time it was said. */
    sending: () => said.filter((event) => event.copy?.state === "sending"),
    /** Resolves once the connection listens for what pairing holds now. */
    settled: async () => {
      await listening?.settled();
    },
    close: async () => {
      await listening?.close();
    },
  };
}

/** How many bytes this Mac's copy of `bundle` is, packed as it is sent; a Linux AppImage goes as itself. */
export function packedSize(bundle: string): Promise<number> {
  if (bundle.endsWith(".AppImage")) return Promise.resolve(statSync(bundle).size);
  return new Promise((resolve, reject) => {
    const tar = packApp(bundle);
    let size = 0;
    tar.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    tar.once("error", reject);
    tar.once("close", () => resolve(size));
  });
}

export async function server(): Promise<SshServer> {
  const started = await startSshServer();
  servers.push(started);
  return started;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
