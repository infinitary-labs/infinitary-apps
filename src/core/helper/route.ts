import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type DeviceGrant, KEY_TEXT_PATTERN } from "@shared/devices";
import { z } from "zod";
import type { DialOptions } from "../devices/dial";
import { writePrivate } from "../devices/identity";

/**
 * The route to a home that reaches this computer through its own SSH
 * connection (docs/helper.md, "Through the home's SSH"): the private socket
 * on this Mac that the home's SSH connection forwards to the home now. The
 * connection that forwards it keeps it - the controller the home's SSH
 * session runs here - and it lasts only as long as that connection does, so
 * it is transient: `route.json` in the data folder holds the socket, the
 * home's pin, this computer's id on that home's list, a generation and a
 * lease, and never a key or a link.
 *
 * Each connection takes a new generation, which no earlier one can write
 * over or withdraw: a writer whose generation is no longer the file's has
 * lost the route for good. A route whose lease ran out - its connection
 * stopped renewing it, crashed, or this Mac restarted - is no route. The run
 * reads it on every dial, and anything it cannot use - missing, run out,
 * another home's or device's, unreadable, or a socket that is not private to
 * this user - is out of reach: never a reason to dial the grant's address,
 * to forget the grant, or to remove anything.
 */

export const ROUTE_FILE = "route.json";
const ROUTE_LOCK = "route.lock";

/** How long a published route lasts without its connection renewing it. */
export const ROUTE_LEASE_MS = 75_000;
/** How often the connection that keeps a route renews it. */
export const ROUTE_RENEW_MS = 15_000;
/**
 * The longest socket path a dial can reach: macOS keeps a Unix socket's
 * path in 104 bytes with its closing zero.
 */
export const SOCKET_PATH_MAX_BYTES = 103;
/** A write lock older than this was left by a writer that died holding it. */
const STALE_LOCK_MS = 10_000;
/** How long a writer waits for another one to finish. */
const LOCK_WAIT_MS = 2_000;

const deviceIdSchema = z.string().min(1).max(64);
const routeFileSchema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().positive(),
  route: z
    .strictObject({
      socket: z.string().min(1).max(4096),
      homeKey: z.string().regex(KEY_TEXT_PATTERN),
      deviceId: deviceIdSchema,
      leaseUntil: z.number().int().nonnegative(),
    })
    .nullable(),
});
type RouteFile = z.infer<typeof routeFileSchema>;

export type RouteEntry = { socket: string; homeKey: string; deviceId: string };

export function socketPathFits(path: string): boolean {
  return isAbsolute(path) && Buffer.byteLength(path) <= SOCKET_PATH_MAX_BYTES;
}

/**
 * Whether `path` is a socket this user owns in a folder only this user can
 * reach - a real folder, never a link to one, that no group or other user
 * may read, write or enter.
 */
export function privateSocket(path: string, uid = process.getuid?.()): boolean {
  if (!socketPathFits(path) || uid === undefined) return false;
  try {
    const folder = lstatSync(dirname(path));
    if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0) return false;
    const socket = lstatSync(path);
    return socket.isSocket() && socket.uid === uid;
  } catch {
    return false;
  }
}

export class HomeRoute {
  private readonly file: string;
  private readonly lock: string;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dataDir, ROUTE_FILE);
    this.lock = join(dataDir, ROUTE_LOCK);
  }

  /**
   * The socket `grant` dials its home through now, or null when there is
   * none it may use. Reads only: nothing is written or removed.
   */
  current(grant: Pick<DeviceGrant, "homeKey" | "deviceId">): string | null {
    const route = this.read()?.route;
    if (!route) return null;
    if (route.homeKey !== grant.homeKey || route.deviceId !== grant.deviceId) return null;
    if (route.leaseUntil <= this.now()) return null;
    return privateSocket(route.socket) ? route.socket : null;
  }

  /**
   * Takes the route for a new connection: answers its generation, after
   * which no earlier connection can publish or withdraw one. The route is
   * withdrawn until this generation publishes its own.
   */
  begin(): number {
    return this.locked(() => {
      const generation = (this.read()?.generation ?? 0) + 1;
      this.write({ version: 1, generation, route: null });
      return generation;
    });
  }

  /**
   * Publishes this generation's route for one lease, or renews it: false,
   * and nothing written, once a later connection took the route.
   */
  publish(generation: number, entry: RouteEntry): boolean {
    if (!socketPathFits(entry.socket))
      throw new Error("A route's socket must be an absolute path short enough to dial.");
    if (!KEY_TEXT_PATTERN.test(entry.homeKey) || !deviceIdSchema.safeParse(entry.deviceId).success)
      throw new Error("A route names a home's pin and this computer's id on its list.");
    return this.locked(() => {
      if (this.read()?.generation !== generation) return false;
      this.write({
        version: 1,
        generation,
        route: { ...entry, leaseUntil: this.now() + ROUTE_LEASE_MS },
      });
      return true;
    });
  }

  withdraw(generation: number): void {
    this.locked(() => {
      const read = this.read();
      if (read?.generation !== generation || read.route === null) return;
      this.write({ version: 1, generation, route: null });
    });
  }

  /**
   * Removes the route for good, as a finished removal does (`cleanUp`): under
   * the write lock, so a connection's renewal or withdrawal under way writes
   * first, and every one after finds no route of its generation to write.
   * Throws, removing nothing, while another writer holds the lock too long.
   */
  remove(): void {
    this.locked(() => rmSync(this.file, { force: true }));
  }

  private read(): RouteFile | null {
    try {
      return routeFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return null;
    }
  }

  private write(value: RouteFile): void {
    writePrivate(this.file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Runs `run` holding the write lock, so a check and the write it decides
   * are one step for every writer. A lock older than `STALE_LOCK_MS` was
   * left by a writer that died holding it - no write takes that long - and is
   * taken over; nothing reads a process number that may be another's now.
   */
  private locked<T>(run: () => T): T {
    if (!existsSync(this.dataDir)) throw new Error("This computer has joined no home.");
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lock).mtimeMs > STALE_LOCK_MS)
            rmSync(this.lock, { force: true });
        } catch {
          // Released between the two looks: try again.
        }
        if (Date.now() >= until) throw new Error("Another process is writing the route.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      return run();
    } finally {
      rmSync(this.lock, { force: true });
    }
  }
}

/**
 * How `grant` dials its home now (docs/helper.md, "Through the home's SSH"):
 * a grant that reaches its home only through the home's SSH connection
 * dials the route's socket, and with no route nothing at all, since `dial.ts`
 * never sends such a grant to its address; any other dials its address.
 * Read again on every dial, so a new route is taken as soon as it is there.
 */
export function homeDialOptions(
  dataDir: string,
  grant: DeviceGrant,
  now?: () => number,
): DialOptions {
  if (grant.via !== "ssh") return {};
  const socket = new HomeRoute(dataDir, now).current(grant);
  return socket ? { target: { socket } } : {};
}
