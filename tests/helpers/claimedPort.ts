import { randomInt } from "node:crypto";
import { connect, createServer, type Server } from "node:net";

/**
 * The ports a home in an e2e run may be given, from `first`, and above them
 * the ports that claim them. Both bands sit below every ephemeral range the
 * suite runs on (Linux's 32768-60999, macOS's 49152-65535), so the system
 * never hands either to a listener that asks for port 0 or to an outgoing
 * connection.
 */
export const CLAIMED_PORTS = { first: 20_000, count: 6_000 } as const;

export type PortClaims = {
  /** A loopback port nothing listens on, held for this claimer until it releases. */
  claim(): Promise<number>;
  release(): Promise<void>;
};

/**
 * Hands out ports no other process in the run can be listening on (INF-267:
 * a home given a port that `freePort` had freed can find a port-0 listener
 * there, and the guardrail then reads that listener as the home).
 * Each port it hands out stays claimed by a listener on the port `count`
 * above it, so no other claimer on this computer - another worker, or
 * another run - hands it out while this one holds it.
 */
export function portClaims(start = randomInt(CLAIMED_PORTS.count)): PortClaims {
  const claims: Server[] = [];
  let next = start;
  return {
    async claim() {
      for (let tried = 0; tried < CLAIMED_PORTS.count; tried++) {
        const port = CLAIMED_PORTS.first + ((next + tried) % CLAIMED_PORTS.count);
        const claim = await listening(port + CLAIMED_PORTS.count);
        if (!claim) continue;
        if (await free(port)) {
          // The worker exits with its claims held; the system drops them then.
          claim.unref();
          claims.push(claim);
          next += tried + 1;
          return port;
        }
        await closed(claim);
      }
      throw new Error(
        `No loopback port from ${CLAIMED_PORTS.first} to ${CLAIMED_PORTS.first + CLAIMED_PORTS.count - 1} could be claimed.`,
      );
    },
    async release() {
      await Promise.all(claims.splice(0).map(closed));
    },
  };
}

const workerClaims = portClaims();

/** A port only this worker's home listens on, claimed until the worker exits. */
export function claimedPort(): Promise<number> {
  return workerClaims.claim();
}

function listening(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closed(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Whether a home could listen on loopback at `port` and nothing answers
 * there: a listener on every address can answer a dial to loopback while a
 * bind to loopback alone still succeeds on macOS.
 */
async function free(port: number): Promise<boolean> {
  const server = await listening(port);
  if (!server) return false;
  await closed(server);
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}
