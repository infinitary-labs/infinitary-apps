import type { ClientRequest } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import type { Writable } from "node:stream";
import { connect, type TLSSocket } from "node:tls";
import {
  CONNECTION_MAX_FRAME_BYTES,
  CONNECTION_PATH,
  type DeviceUser,
  FETCH_APP_PATH,
  type FoundTools,
  fetchAppRefusalSchema,
  PAIR_PATH,
  type PairGrant,
  pairGrantSchema,
  pairRefusalSchema,
} from "@shared/connection";
import { COMPUTER, HERE, HOME } from "@shared/deviceNames";
import {
  type DeviceChip,
  type DeviceGrant,
  type DeviceKind,
  type DeviceSystem,
  deviceGrantSchema,
  deviceRunsWork,
  type HomeVia,
  isPhone,
  linkAddresses,
  PAIRING_LINK_ALSO_MAX,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import { WebSocket } from "ws";
import { createKeyIdentity, peerPin } from "./identity";
import { relayedStream, relayFor } from "./relay";

/**
 * A device's side of pairing (docs/devices.md): it checks the home's key
 * before it sends a byte, shows its own key in the same handshake, uses a
 * link once, and dials with the grant it got. Written against the wire
 * alone, so the app as a view and the helper share it, and so do the tests.
 *
 * Where a dial physically goes is apart from who must answer it
 * (docs/connection.md, "Where a device dials"): the target is an address or
 * a private socket on this Mac, and the authority is the home's pin and the
 * device's own key, checked the same way whichever the target is.
 */

/** The device's own key and certificate, PEM, shown in every handshake. */
export type DeviceKey = { key: string; cert: string };

/** The home that answered is not the one the link or grant names. */
export class HomeKeyMismatchError extends Error {
  constructor() {
    super(`The ${COMPUTER.one} at this address is not the one the link names.`);
    this.name = "HomeKeyMismatchError";
  }
}

/** The home refused a link (docs/devices.md, "Joining"). */
export class PairRefusedError extends Error {
  constructor(
    readonly refused: string,
    reason: string,
  ) {
    super(reason);
    this.name = "PairRefusedError";
  }
}

/**
 * Where a dial physically goes: a TCP address, `host:port`, or a Unix-domain
 * socket on this Mac, such as the private socket a home's SSH connection
 * forwards to it. It never says who answers.
 */
export type DialTarget = { address: string } | { socket: string };

/**
 * How one dial goes: `timeoutMs` bounds it; `target` names where it
 * physically goes - by default the address its link or grant names; and
 * `relay` names the program that carries a dial to an address (`./relay.ts`),
 * null to dial it directly, or by default the one `relayFor` picks for it. A
 * socket on this Mac is dialed directly: it is no dial to the network.
 */
export type DialOptions = {
  timeoutMs?: number;
  target?: DialTarget;
  relay?: string | null;
  /** Ends a Firstmate fetch at once, as when the run that asked for it stops (`fetchFirstmate`). */
  signal?: AbortSignal;
  /**
   * A connection's last way to its home (`dialHome`): the addresses heard
   * announcing Infinitary on the local network right now (`./findHome.ts`),
   * looked for only once every address the grant keeps did not answer with
   * the home's key. Each is checked against that key like any other.
   */
  find?: () => Promise<readonly string[]>;
  /** Told the address a connection's dial reached its home at (`dialHome`). */
  reached?: (at: string) => void;
};

/**
 * A link or grant that reaches its home only through the home's SSH
 * connection was dialed with no socket to go through: it is out of reach,
 * and never dials its address instead.
 */
export class HomeRouteMissingError extends Error {
  constructor() {
    super(`The connection from ${HOME.the} to ${HERE.this} is not open, so nothing was dialed.`);
    this.name = "HomeRouteMissingError";
  }
}

/**
 * Default limit for one pinned TLS dial, before the WebSocket welcome wait
 * starts, and for each quiet stretch of a request on it (`quietFor`).
 */
export const HOME_DIAL_TIMEOUT_MS = 10_000;
const ANSWER_MAX_BYTES = 16 * 1024;

/**
 * Ends `asked` with `quiet` once its socket has gone quiet for the dial's
 * limit, so a home that took the request and then says nothing does not
 * leave this computer waiting. The request goes on an already-pinned
 * socket, and Node arms a request's `timeout` option only on a socket it
 * makes itself: the request arms it on the pinned socket here instead.
 */
function quietFor(asked: ClientRequest, options: DialOptions, quiet: () => void): void {
  asked.setTimeout(options.timeoutMs ?? HOME_DIAL_TIMEOUT_MS, quiet);
}

/**
 * Where a link's or grant's dial goes: `target` when given, else its own
 * address. One that reaches its home only through the home's SSH connection
 * (`via: "ssh"`) goes only to a socket, never to its address.
 */
function targetOf(reach: { at: string; via?: HomeVia }, target: DialTarget | undefined) {
  if (reach.via === "ssh") {
    if (!target || !("socket" in target)) throw new HomeRouteMissingError();
    return target;
  }
  return target ?? { address: reach.at };
}

function addressOf(at: string): { host: string; port: number } {
  const address = splitDialAddress(at);
  if (!address) throw new Error("The address to dial is not host:port.");
  return address;
}

/**
 * Opens TLS 1.3 to `target`, showing `device`'s key when given, and resolves
 * only once the home's public key hashes to `homeKey`. No request is written
 * on the socket before that, so a computer that answers in the home's place
 * learns no code; and the device's key proves itself by signing this
 * handshake alone, so nothing it learns works anywhere else. No session is resumed:
 * every connection shows both keys again. On macOS the bytes to another Mac
 * at an address travel through its own nc (`./relay.ts`), so local network
 * privacy asks nobody; the TLS is the device's own either way. A private
 * socket gets no shortcut: the same TLS, the same pin and the same keys.
 */
export function pinnedSocket(
  target: DialTarget,
  homeKey: string,
  device: DeviceKey | null,
  options: DialOptions = {},
): Promise<TLSSocket> {
  // A socket on this Mac is dialed directly; an address maybe through a relay.
  const address = "address" in target ? addressOf(target.address) : null;
  const relay = address && (options.relay === undefined ? relayFor(address.host) : options.relay);
  return new Promise((resolve, reject) => {
    const carried = address && relay ? relayedStream(relay, address.host, address.port) : null;
    const where =
      "socket" in target
        ? { path: target.socket, servername: "" }
        : {
            ...(carried ? { socket: carried } : { host: address?.host, port: address?.port }),
            servername: address && !isIP(address.host) ? address.host : "",
          };
    const socket = connect({
      ...where,
      // The home's certificate is self-signed: the pin below is the trust.
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      ...(device ? { key: device.key, cert: device.cert } : {}),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${HOME.The} did not answer.`));
    }, options.timeoutMs ?? HOME_DIAL_TIMEOUT_MS);
    const failed = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", failed);
    if (carried) {
      // Nothing answering there is the relay's error; later ones close the socket.
      carried.once("error", failed);
      carried.on("error", () => {});
      socket.once("close", () => carried.destroy());
    }
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      carried?.off("error", failed);
      if (peerPin(socket) !== homeKey) {
        socket.destroy();
        reject(new HomeKeyMismatchError());
        return;
      }
      // Whoever takes the socket listens for its errors; until then one
      // must not throw.
      socket.off("error", failed);
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}

/**
 * Whether the home a link or grant names answers where it dials with its own
 * key: TLS pinned as for a request, closed at once, with nothing written and
 * no key of the device's shown. A computer that runs work asks this before
 * its person is asked to agree (docs/helper.md). Rejects as `pinnedSocket`
 * does: the home did not answer, or another computer did; and, for one that
 * reaches its home only through the home's SSH connection, with no socket to
 * dial (`HomeRouteMissingError`).
 */
export async function probeHome(
  reach: { at: string; via?: HomeVia; also?: readonly string[] },
  homeKey: string,
  options: DialOptions = {},
): Promise<void> {
  const socket = await pinnedFirst(reach, homeKey, null, options);
  socket.destroy();
}

/** The first address that answers with the home's key. A named target is tried alone. */
async function pinnedFirst(
  reach: { at: string; via?: HomeVia; also?: readonly string[] },
  homeKey: string,
  device: DeviceKey | null,
  options: DialOptions,
): Promise<TLSSocket> {
  if (options.target || reach.via === "ssh") {
    return pinnedSocket(targetOf(reach, options.target), homeKey, device, options);
  }
  let last: unknown;
  let mismatch: HomeKeyMismatchError | null = null;
  for (const at of linkAddresses(reach)) {
    try {
      return await pinnedSocket({ address: at }, homeKey, device, options);
    } catch (error) {
      if (error instanceof HomeKeyMismatchError) mismatch = error;
      else last = error;
    }
  }
  throw mismatch ?? last ?? new Error(`Could not reach the ${COMPUTER.one}.`);
}

/** The address of the dial that answered, so the grant pins that one. */
async function answeredAt(
  reach: { at: string; via?: HomeVia; also?: readonly string[] },
  homeKey: string,
  device: DeviceKey | null,
  options: DialOptions,
): Promise<{ at: string; socket: TLSSocket }> {
  if (options.target || reach.via === "ssh") {
    return {
      at: reach.at,
      socket: await pinnedSocket(targetOf(reach, options.target), homeKey, device, options),
    };
  }
  let last: unknown;
  let mismatch: HomeKeyMismatchError | null = null;
  for (const at of linkAddresses(reach)) {
    try {
      return { at, socket: await pinnedSocket({ address: at }, homeKey, device, options) };
    } catch (error) {
      if (error instanceof HomeKeyMismatchError) mismatch = error;
      else last = error;
    }
  }
  throw mismatch ?? last ?? new Error(`Could not reach the ${COMPUTER.one}.`);
}

/**
 * Dials every address at once and answers the first that answers with the
 * home's key; each other that answers is closed. Rejects once all failed:
 * with `HomeKeyMismatchError` when one answered with another key, so a
 * computer that took the home's old address is never taken for it. A copy
 * dials another copy the same way, pinned to that copy's key
 * (`../standby/peers.ts`).
 */
export function pinnedAny(
  addresses: readonly string[],
  homeKey: string,
  device: DeviceKey | null,
  options: DialOptions,
): Promise<{ at: string; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    if (addresses.length === 0) {
      reject(new Error(`Could not reach the ${COMPUTER.one}.`));
      return;
    }
    let left = addresses.length;
    let won = false;
    let last: unknown;
    let mismatch: HomeKeyMismatchError | null = null;
    for (const at of addresses) {
      pinnedSocket({ address: at }, homeKey, device, options).then(
        (socket) => {
          if (won) {
            socket.destroy();
            return;
          }
          won = true;
          resolve({ at, socket });
        },
        (error: unknown) => {
          if (error instanceof HomeKeyMismatchError) mismatch = error;
          else last = error;
          left -= 1;
          if (left === 0 && !won) reject(mismatch ?? last);
        },
      );
    }
  });
}

/**
 * Where a connection reaches its home (docs/devices.md, "Finding the home
 * again"): the address that answered last, then every address the grant
 * keeps at once, then, when none answered with the home's key, every address
 * announcing Infinitary on the local network at once (`find`), each time
 * beside the address that answered last. A
 * grant that reaches its home only through the home's SSH, or a dial that
 * names its target, goes only there, as before.
 */
async function pinnedRoute(
  grant: DeviceGrant,
  options: DialOptions,
): Promise<{ at: string; socket: TLSSocket }> {
  if (options.target || grant.via === "ssh") {
    return {
      at: grant.at,
      socket: await pinnedSocket(targetOf(grant, options.target), grant.homeKey, grant, options),
    };
  }
  const tried = new Set<string>([grant.at]);
  let failure: unknown;
  let mismatch: HomeKeyMismatchError | null = null;
  const failed = (error: unknown) => {
    if (error instanceof HomeKeyMismatchError) mismatch = error;
    else failure = error;
  };
  try {
    return {
      at: grant.at,
      socket: await pinnedSocket({ address: grant.at }, grant.homeKey, grant, options),
    };
  } catch (error) {
    failed(error);
  }
  // The address that answered last is dialed again beside the others, so a
  // home that comes back there while they are still being tried is found at once.
  const kept = linkAddresses(grant);
  for (const at of kept) tried.add(at);
  if (kept.length > 1) {
    try {
      return await pinnedAny(kept, grant.homeKey, grant, options);
    } catch (error) {
      failed(error);
    }
  }
  if (options.find) {
    let found: readonly string[] = [];
    try {
      found = await options.find();
    } catch {
      // Nothing heard on the local network is no way to the home.
    }
    const fresh = found.filter((at) => !tried.has(at) && splitDialAddress(at) !== null);
    if (fresh.length > 0) {
      try {
        return await pinnedAny([grant.at, ...fresh], grant.homeKey, grant, options);
      } catch (error) {
        failed(error);
      }
    }
  }
  throw mismatch ?? failure ?? new Error(`Could not reach the ${COMPUTER.one}.`);
}

/** What a device says about itself when it uses a link. */
type PairingDevice = {
  kind: DeviceKind;
  name: string;
  user?: DeviceUser;
  found?: FoundTools;
  /** Firstmate at its own first launch, with its window, rather than its work mode. */
  window?: true;
  /** The system it runs; a phone (`ios`) joins as a view whichever link it used (docs/devices.md, "Joining"). */
  system?: DeviceSystem;
};

/**
 * Uses a pasted link once, as a device of `kind` labelled `name`: makes the
 * device's own key, shows it while using the link, and answers the grant to
 * keep, with the kind the home made it - which for a link made for a Mac
 * used from the home's own Mac is a second app or another user there. A
 * device that may run work also says the macOS user it runs as.
 * Refuses a link made for the other kind before dialing, so it stays good
 * for the device it was meant for. A link for a device that reaches its home
 * only through the home's SSH connection is used only through the socket
 * `options.target` names, and its grant keeps that mode.
 */
export async function claimLink(
  text: string,
  device: PairingDevice,
  options: DialOptions = {},
): Promise<DeviceGrant> {
  const link = parsePairingLink(text);
  if (link.kind !== device.kind)
    throw new PairRefusedError(
      "kind",
      link.kind === "work"
        ? `This link is for another user on that ${COMPUTER.one}.`
        : `This link is for another ${COMPUTER.one}.`,
    );
  const own = createKeyIdentity("Firstmate device");
  const { grant, at } = await pair(link, own, device, false, options);
  return deviceGrantSchema.parse({
    at,
    ...otherAddresses(link, at),
    homeKey: link.key,
    deviceId: grant.deviceId,
    kind: grant.kind,
    key: own.key,
    cert: own.cert,
    ...(link.via ? { via: link.via } : {}),
  });
}

/**
 * Uses a link to find the home this device is already paired with, where
 * the link says it is now (docs/devices.md, "Finding the home again"): the
 * same pinned TLS, showing the key in `grant` rather than a new one, and
 * asking `again`, so the home spends the link and keeps the device as it is
 * on its list. Answers the grant dialing the link's address, with the same
 * key and the same place on the list. A link from another home is refused
 * before dialing; the home answering `removed` means its list no longer
 * holds this device. A link over the home's SSH connection moves a grant
 * that dialed an address onto that connection for good, as when the home
 * finds a computer a command joined by its address (docs/devices.md,
 * "Finding the home again"); a grant on that connection never leaves it, so
 * a link that dials an address is refused for it.
 */
export async function findHomeAgain(
  text: string,
  grant: DeviceGrant,
  device: Omit<PairingDevice, "kind">,
  options: DialOptions = {},
): Promise<DeviceGrant> {
  const link = parsePairingLink(text);
  if (link.key !== grant.homeKey) throw new HomeKeyMismatchError();
  // A computer that runs work keeps its kind: any link that adds one finds its home again.
  // A phone is a view and finds it again with a link for a Mac.
  const phone = isPhone(device) && grant.kind === "view" && link.kind !== "work";
  if (
    link.kind !== grant.kind &&
    !phone &&
    !(deviceRunsWork(link.kind) && deviceRunsWork(grant.kind))
  )
    throw new PairRefusedError("kind", "This link is for another kind of device.");
  if (grant.via === "ssh" && link.via !== "ssh")
    throw new PairRefusedError("via", "This link reaches the home another way than this device.");
  const answer = await pair(link, grant, { ...device, kind: link.kind }, true, options);
  if (answer.grant.deviceId !== grant.deviceId)
    throw new PairRefusedError("other", `${HOME.The} answered for another device.`);
  const { also: _also, ...kept } = grant;
  return deviceGrantSchema.parse({
    ...kept,
    at: answer.at,
    ...otherAddresses(link, answer.at),
    ...(link.via ? { via: link.via } : {}),
  });
}

/**
 * The link's other addresses a grant keeps beside the one that answered, so
 * a connection tries them when that one does not (docs/devices.md, "Finding
 * the home again"); none for a link over the home's SSH, which never dials
 * an address.
 */
function otherAddresses(
  link: { at: string; also?: readonly string[]; via?: HomeVia },
  at: string,
): { also?: string[] } {
  if (link.via) return {};
  const also = linkAddresses(link)
    .filter((each) => each !== at)
    .slice(0, PAIRING_LINK_ALSO_MAX);
  return also.length > 0 ? { also } : {};
}

/**
 * `POST /pair` on a socket pinned to the link's home, showing `own`: the
 * home's answer to the link, or its refusal thrown as `PairRefusedError`.
 */
async function pair(
  link: ReturnType<typeof parsePairingLink>,
  own: DeviceKey,
  device: PairingDevice,
  again: boolean,
  options: DialOptions,
): Promise<{ grant: PairGrant; at: string }> {
  const dialed = await answeredAt(link, link.key, own, options);
  const socket = dialed.socket;
  const { host, port } = addressOf(dialed.at);
  const body = JSON.stringify({
    code: link.code,
    kind: device.kind,
    name: device.name,
    ...(device.user ? { user: device.user } : {}),
    ...(device.found ? { found: device.found } : {}),
    ...(again ? { again: true } : {}),
    ...(device.window ? { window: true } : {}),
    ...(device.system ? { system: device.system } : {}),
  });
  const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const asked = request(
      {
        host,
        port,
        method: "POST",
        path: PAIR_PATH,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        createConnection: () => socket,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > ANSWER_MAX_BYTES)
            response.destroy(new Error("The home's answer is too long."));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    quietFor(asked, options, () => asked.destroy(new Error(`${HOME.The} did not answer.`)));
    asked.once("error", reject);
    asked.end(body);
  });
  socket.destroy();
  const json = (() => {
    try {
      return JSON.parse(answer.text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (answer.status !== 201) {
    const refusal = pairRefusalSchema.safeParse(json);
    if (refusal.success) throw new PairRefusedError(refusal.data.refused, refusal.data.reason);
    throw new PairRefusedError("other", `${HOME.The} refused to pair (${answer.status}).`);
  }
  const grant = pairGrantSchema.parse(json);
  if (!pairedAs(device, grant.kind, again))
    throw new PairRefusedError("kind", "The home paired this device as another kind.");
  return { grant, at: dialed.at };
}

/**
 * Whether the home may pair a device as `kind` (docs/devices.md,
 * "Joining"): as it asked; a link for a Mac used from the home's own Mac as
 * a second app (`window`) or as another user there; and one that finds its
 * home again as the kind it keeps; and a phone as a view.
 */
function pairedAs(device: PairingDevice, kind: DeviceKind, again: boolean): boolean {
  if (kind === device.kind) return true;
  // A phone is paired as a view whichever link it used.
  if (isPhone(device)) return kind === "view";
  if (again) return deviceRunsWork(kind) && deviceRunsWork(device.kind);
  return device.kind === "mac" && kind === (device.window ? "view" : "work");
}

/**
 * Gets its home's Firstmate as a computer that runs work already on its
 * list, to update itself (docs/devices.md, "Updating over the connection"):
 * `POST FETCH_APP_PATH` with no code, on TLS pinned to the home's key and
 * showing the device's own, which is what proves it. With `want`, its own
 * system and chip, the home answers the Firstmate for them (docs/devices.md,
 * "Infinitary for another system"). The answer goes into `sink`, or the one
 * `sink` opens for the answer's `Content-Type` (`FETCH_APP_TYPES`), which it
 * ends; resolves once all of it came, and rejects with the home's refusal
 * (`PairRefusedError`) or an answer cut short, leaving `sink` open. A sink
 * that stops taking the answer before its end, as the Mac's tar does once it
 * has the whole app, still has the answer read to its end.
 * `timeoutMs` bounds each quiet stretch, never the whole copy.
 */
export async function fetchFirstmate(
  grant: DeviceGrant,
  sink: Writable | ((contentType: string) => Writable),
  options: DialOptions = {},
  want?: { system: DeviceSystem; chip: DeviceChip },
): Promise<void> {
  const socket = await pinnedSocket(targetOf(grant, options.target), grant.homeKey, grant, options);
  const { host, port } = addressOf(grant.at);
  const body = JSON.stringify(want ? { system: want.system, chip: want.chip } : {});
  // What lets the copy go when the run stops, removed once the request settles.
  const stopping: { stop?: () => void } = {};
  try {
    await new Promise<void>((resolve, reject) => {
      const asked = request(
        {
          host,
          port,
          method: "POST",
          path: FETCH_APP_PATH,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          createConnection: () => socket,
        },
        (response) => {
          response.once("error", reject);
          if (response.statusCode !== 200) {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= ANSWER_MAX_BYTES) chunks.push(chunk);
            });
            response.once("end", () => {
              const refusal = fetchAppRefusalSchema.safeParse(
                (() => {
                  try {
                    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
                  } catch {
                    return undefined;
                  }
                })(),
              );
              reject(
                refusal.success
                  ? new PairRefusedError(refusal.data.refused, refusal.data.reason)
                  : new PairRefusedError(
                      "other",
                      `${HOME.The} would not send Infinitary (${response.statusCode ?? 0}).`,
                    ),
              );
            });
            return;
          }
          // An answer the home cut short ends without completing: the
          // sink is left open, so nothing reads half an app as whole.
          response.once("close", () => {
            if (response.complete) resolve();
            else
              reject(
                new Error(`Infinitary did not arrive whole from the ${COMPUTER.one} that sent it.`),
              );
          });
          const into =
            typeof sink === "function"
              ? sink(String(response.headers["content-type"] ?? ""))
              : sink;
          response.pipe(into);
          // A sink can close before the answer ends: the Mac's tar exits at
          // the archive's end marker, before the zero padding that fills its
          // last block, and its input closes with it, which stops the pipe.
          // The rest is read and dropped, so the answer still ends and says
          // whether all of it came; whether the sink kept it whole is its
          // caller's to judge, by tar's exit or a file's finish.
          into.once("close", () => response.resume());
        },
      );
      quietFor(asked, options, () =>
        asked.destroy(new Error(`${HOME.The} stopped sending Infinitary.`)),
      );
      asked.once("error", reject);
      // A run that stops lets the copy go at once, leaving the sink open.
      const stop = () => asked.destroy(new Error("Infinitary stopped here before all of it came."));
      stopping.stop = stop;
      if (options.signal?.aborted) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });
      asked.end(body);
    });
  } finally {
    if (stopping.stop) options.signal?.removeEventListener("abort", stopping.stop);
    socket.destroy();
  }
}

/**
 * Dials the home with a grant: TLS pinned again with the device's own key
 * shown, then the WebSocket upgrade on `CONNECTION_PATH`. Nothing secret
 * rides the request at all. Answers the socket as soon as it is created; the
 * caller waits for `open`. It tries every address the grant keeps, then
 * those `find` hears announcing (`pinnedRoute`), and tells `reached` the one
 * that answered with the home's key. A grant that reaches its home only
 * through the home's SSH connection dials only the socket `options.target`
 * names.
 */
export async function dialHome(grant: DeviceGrant, options: DialOptions = {}): Promise<WebSocket> {
  const { at, socket } = await pinnedRoute(grant, options);
  options.reached?.(at);
  return new WebSocket(homeSocketUrl(at, CONNECTION_PATH), {
    createConnection: () => socket,
    perMessageDeflate: false,
    maxPayload: CONNECTION_MAX_FRAME_BYTES,
  });
}

/** The address a request on an already-pinned socket names. */
export function homeSocketUrl(at: string, path: string): string {
  const { host, port } = addressOf(at);
  return `wss://${host.includes(":") ? `[${host}]` : host}:${port}${path}`;
}
