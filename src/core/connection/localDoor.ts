import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  CONNECTION_MAX_FRAME_BYTES,
  CONNECTION_PATH,
  LOCAL_DOOR_FILES,
  LOCAL_DOOR_KEY_HEADER,
} from "@shared/connection";
import { WebSocket } from "ws";
import { homeSocketUrl, pinnedSocket } from "../devices/dial";
import { keyPin } from "../devices/identity";

/**
 * The local door (docs/connection.md, "The local door"): how a client on
 * the first mate's own computer, as its own account, reaches the connection
 * with no pairing and no row on its list of devices - the window there, and
 * any second local client.
 *
 * It is the phone door's pattern (docs/devices.md, "A phone that joins by
 * its address"): the connection listens on a loopback port of its own and
 * writes that address, the pin of its own TLS key and a 256-bit key to three
 * files only their owner can read (0600) in a folder only its owner can
 * open (0700). Reading the key is the permission: only this account can,
 * and it could already read the first mate's record. The folder is emptied
 * each time the door opens and when it closes, so a run that was killed
 * leaves no key behind that answers. A run started by a command also names
 * itself there, by its process and start, before the key: the door that
 * admits a key is that run's, so a client knows which run it reached.
 */

/** The run a door belongs to, as its run record names it: its process and when it started. */
export type LocalDoorRun = { readonly pid: number; readonly startedAt: string };

/** Where a local client finds the door, read from its folder. */
export type LocalDoorAddress = {
  /** `127.0.0.1:port`. */
  readonly address: string;
  /** The pin the door's TLS key must hash to. */
  readonly pin: string;
  /** The key the upgrade carries. */
  readonly key: string;
  /** The run that opened the door, where it named itself; null for one that did not. */
  readonly run: LocalDoorRun | null;
};

/** The run each socket dialed through a local door reached, where that door named it. */
const runsReached = new WeakMap<object, LocalDoorRun>();

/** The run a socket `dialLocalDoor` returned reached, or null where its door named none. */
export function localDoorRunOf(socket: object | null): LocalDoorRun | null {
  return (socket && runsReached.get(socket)) ?? null;
}

function readRun(dir: string): LocalDoorRun | null {
  try {
    const run = JSON.parse(readFileSync(join(dir, LOCAL_DOOR_FILES.run), "utf8")) as unknown;
    if (typeof run !== "object" || run === null) return null;
    const { pid, startedAt } = run as Record<string, unknown>;
    if (!Number.isInteger(pid) || (pid as number) <= 0 || typeof startedAt !== "string")
      return null;
    return { pid: pid as number, startedAt };
  } catch {
    return null;
  }
}

function digestOf(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** The pin of a PEM certificate's key. */
export function pinOfCertificate(cert: string): string {
  return keyPin(new X509Certificate(cert).publicKey);
}

/** The door as the connection holds it: whether a request carries its key, and how to close it. */
export type OpenLocalDoor = {
  readonly address: string;
  /** Whether the upgrade request carries this door's key. */
  admits(request: IncomingMessage): boolean;
  /** Removes the folder, so nothing answers with its key any more. */
  close(): void;
};

/**
 * Empties the folder and writes the door's files for a listener at
 * `address` serving the certificate `cert`, and the run that opens it where
 * one is given. A new key each time.
 */
export function openLocalDoor(
  dir: string,
  address: string,
  cert: string,
  run?: LocalDoorRun,
): OpenLocalDoor {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const key = randomBytes(32).toString("hex");
  const digest = digestOf(key);
  try {
    // The key lands last: a folder holding a key always holds where it opens.
    writeFileSync(join(dir, LOCAL_DOOR_FILES.address), `${address}\n`, { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, LOCAL_DOOR_FILES.pin), `${pinOfCertificate(cert)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    if (run)
      writeFileSync(
        join(dir, LOCAL_DOOR_FILES.run),
        `${JSON.stringify({ pid: run.pid, startedAt: run.startedAt })}\n`,
        { mode: 0o600, flag: "wx" },
      );
    writeFileSync(join(dir, LOCAL_DOOR_FILES.key), `${key}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    address,
    admits: (request) => {
      const supplied = request.headers[LOCAL_DOOR_KEY_HEADER];
      return (
        !closed &&
        typeof supplied === "string" &&
        timingSafeEqual(digestOf(supplied.trim()), digest)
      );
    },
    close: () => {
      if (closed) return;
      closed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The door's address, pin and key from its folder, or null while it is not
 * open, with the run it names. That run is read before and after the key,
 * and kept only where both readings agree, so a door opened again between
 * them names no run rather than another one.
 */
export function readLocalDoor(dir: string): LocalDoorAddress | null {
  try {
    const read = (name: string) => readFileSync(join(dir, name), "utf8").trim();
    const before = readRun(dir);
    const key = read(LOCAL_DOOR_FILES.key);
    const address = read(LOCAL_DOOR_FILES.address);
    const pin = read(LOCAL_DOOR_FILES.pin);
    if (!key || !pin || !address.startsWith("127.0.0.1:")) return null;
    const after = readRun(dir);
    const run =
      before && after && before.pid === after.pid && before.startedAt === after.startedAt
        ? before
        : null;
    return { address, pin, key, run };
  } catch {
    return null;
  }
}

/**
 * Dials the door read from `dir`: TLS 1.3 to its loopback address with the
 * door's pin checked before a byte is written, as every dial is, then
 * the upgrade on `CONNECTION_PATH` carrying the key. The client shows no key
 * of its own: the door's key is what admits it.
 */
export async function dialLocalDoor(dir: string, timeoutMs?: number): Promise<WebSocket> {
  const door = readLocalDoor(dir);
  if (!door) throw new Error("The first mate on this computer is not open.");
  const socket = await pinnedSocket({ address: door.address }, door.pin, null, {
    relay: null,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const reached = new WebSocket(homeSocketUrl(door.address, CONNECTION_PATH), {
    createConnection: () => socket,
    perMessageDeflate: false,
    maxPayload: CONNECTION_MAX_FRAME_BYTES,
    headers: { [LOCAL_DOOR_KEY_HEADER]: door.key },
  });
  // Only the door that wrote this key admits it, so the run it named is the one reached.
  if (door.run) runsReached.set(reached, door.run);
  return reached;
}
