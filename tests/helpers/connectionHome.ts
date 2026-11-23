import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { connect } from "node:tls";
import { PAIR_PATH } from "@shared/connection";
import type { DeviceGrant, DeviceKind } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach } from "vitest";
import {
  type ConnectionOptions,
  type HomeConnection,
  startConnection,
} from "../../src/core/connection/connection";
import { claimLink, type DeviceKey, pinnedSocket } from "../../src/core/devices/dial";
import { createKeyIdentity } from "../../src/core/devices/identity";
import { DevicePairing, type DevicePairingOptions } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import { claimedPort } from "./claimedPort";
import { scratchDir } from "./scratchDirs";

/**
 * The home's connection with the real event bus, the real pairing over a
 * scratch folder, and a stand-in core behind `dispatch`, for the connection's
 * own tests (src/core/connection/connection.test.ts and localDoor.test.ts):
 * each closes when its test ends.
 */

export function standInCore() {
  const asked: { channel: string; args: unknown; actor: unknown }[] = [];
  const dispatch = (async (channel, args, actor) => {
    asked.push({ channel, args, actor });
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
  return { dispatch, asked, events: new CoreEventBus() };
}

export function answersAt(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Every connection a test opened, closed when it ends; a test that starts its own adds it here. */
export const open: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

export async function home(
  options: Partial<Omit<ConnectionOptions, "devices">> & {
    pairing?: Omit<DevicePairingOptions, "dir">;
  } = {},
) {
  const { pairing: pairingOptions, ...connectionOptions } = options;
  const core = standInCore();
  const devicesDir = join(scratchDir("infinitary-connection-"), "devices");
  const pairing = new DevicePairing({
    dir: devicesDir,
    onProblem: () => {},
    ...pairingOptions,
  });
  pairings.push(pairing);
  const port = options.port ?? (await claimedPort());
  const connection = startConnection({ ...core, ...connectionOptions, devices: pairing, port });
  open.push(connection);
  const at = `127.0.0.1:${port}`;
  return {
    ...core,
    pairing,
    devicesDir,
    connection,
    port,
    at,
    link: (kind: DeviceKind = "view") => pairing.invite({ kind, at }).link,
    join: async (kind: DeviceKind = "view", name = "Test Mac"): Promise<DeviceGrant> => {
      const { link } = pairing.invite({ kind, at });
      await connection.settled();
      return claimLink(link, { kind, name, ...(kind === "work" ? { user: ANOTHER_USER } : {}) });
    },
  };
}

/**
 * A computer that runs work dials these homes from loopback, so it runs as a
 * user other than the one this process runs as, as another user on the
 * home's own Mac would (docs/helper.md).
 */
export const ANOTHER_USER = { name: "builder", uid: (process.getuid?.() ?? 0) + 1 };

export const changed = (events: CoreEventBus) => events.emit("inf:models:changed", { ok: true });

/**
 * Posts to `/pair` over a pinned socket, the way a device would but with any
 * body or header, showing a fresh key of its own unless told which or none.
 */
export async function postPair(
  at: string,
  key: string,
  request: {
    method?: string;
    contentType?: string;
    origin?: string;
    body?: string;
    device?: DeviceKey | null;
    chunked?: boolean;
  },
): Promise<{ status: number; body: string }> {
  const device = request.device === undefined ? createKeyIdentity("Device") : request.device;
  const socket = await pinnedSocket({ address: at }, key, device);
  const [host, port] = at.split(":");
  return new Promise((resolve, reject) => {
    const asked = httpsRequest(
      {
        host,
        port: Number(port),
        method: request.method ?? "POST",
        path: PAIR_PATH,
        headers: {
          ...(request.contentType === undefined
            ? { "content-type": "application/json" }
            : request.contentType
              ? { "content-type": request.contentType }
              : {}),
          ...(request.origin ? { origin: request.origin } : {}),
        },
        createConnection: () => socket,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    asked.on("error", reject);
    if (request.chunked && request.body) {
      asked.write(request.body);
      asked.end();
    } else asked.end(request.body);
  });
}
