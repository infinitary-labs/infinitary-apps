import { constants as cryptoConstants } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:https";
import { join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { PAIRING_LINK_ALSO_MAX } from "@shared/devices";
import {
  COPY_FILES_ORDER,
  COPY_FILES_PAGE,
  COPY_GATHER_CHANGE,
  COPY_LINK_FRAME_BYTES,
  COPY_LINK_PATH,
  COPY_PIECE_BYTES,
  COPY_PIECE_ORDER,
  COPY_WHERE_ORDER,
  type CopyLinkFrame,
  type CopyOrderChannel,
  type CopyPeer,
  type CopyPeerState,
  copyLinkFrameSchema,
  copyOrders,
  copyPeerStateSchema,
  isCopyOrderChannel,
  STANDBY_PEERS_CHANGE,
  type StandbyPeersOrderChannel,
  standbyPeersOrders,
} from "@shared/standbyPeers";
import {
  isStandbyPhoneOrderChannel,
  type PhoneLinkFrame,
  phoneLinkFrameSchema,
  STANDBY_PHONE_FRAME_BYTES,
  STANDBY_PHONE_PATH,
  type StandbyPhoneOrderChannel,
} from "@shared/standbyPhone";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { type DeviceKey, type DialOptions, homeSocketUrl, pinnedAny } from "../devices/dial";
import { peerPin, writePrivate } from "../devices/identity";
import { hashFile } from "../homeMove/record";
import { CopyAccess } from "./copyAccess";
import { readStandbyState, STANDBY_COPY, STANDBY_DIR } from "./keeper";
import { STANDBYS_FILE, standbysSchema } from "./named";

/** Where this computer last saw each other copy, beside its copy, for its own status. */
const PEERS_FILE = "peers.json";

const peersFileSchema = z.object({
  version: z.literal(1),
  peers: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(64),
        name: z.string().min(1).max(160),
        state: copyPeerStateSchema,
      }),
    )
    .max(64),
});
export type CopyPeerLine = z.infer<typeof peersFileSchema>["peers"][number];

/** What a copy reads of the home's list of devices: each one's id, name and key's pin. */
const listedSchema = z.object({
  devices: z.array(
    z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(160),
      keyPin: z.string(),
    }),
  ),
});

/** What a copy reads of each device's system, kept beside the list (`devices/systems.json`). */
const systemsSchema = z.object({
  devices: z.record(z.string(), z.object({ system: z.string().optional() })),
});

/** The other copies this computer last saw, as `work status` says them; none while it keeps no copy. */
export function readCopyPeers(workDir: string): CopyPeerLine[] {
  try {
    return peersFileSchema.parse(
      JSON.parse(readFileSync(join(workDir, STANDBY_DIR, PEERS_FILE), "utf8")),
    ).peers;
  } catch {
    return [];
  }
}

/** The other copy is not reached over a link now, so nothing was asked. */
export class CopyOutOfReachError extends Error {
  constructor() {
    super("That copy is out of reach, so nothing was asked.");
    this.name = "CopyOutOfReachError";
  }
}

/** Waits before dialing a copy again after a dial failed: each next one, staying at the last. */
const REDIAL_MS = [1_000, 5_000, 15_000, 60_000] as const;
/** How often each link is pinged, and the computer's own addresses looked at again. */
const LOOK_MS = 15_000;
/** How long an order over a link waits for its answer. */
const ASK_MS = 10_000;

/** One other copy, as this computer's copy of the record names it. */
type Peer = { deviceId: string; name: string; pin: string; listens: string[] };

type Link = {
  ws: WebSocket;
  peer: string;
  /** Which side dialed it: when two links to one copy are up, both sides keep the same one. */
  dialedBy: string;
  /** It heard the other side's hello: the other copy is in reach over it. */
  heard: boolean;
  /** The contract changes the other side's hello listed. */
  changes: readonly string[];
  /** It answered a ping since the last look. */
  answered: boolean;
};

/**
 * The orders a copy may send again over another link to the same copy:
 * every order between copies, since each only reads (`copyOrders`), so one
 * asked twice is answered as once. An order that changes something would
 * fail to type here, and would need its own way across a dropped link.
 */
type ReadCopyOrder = {
  [K in CopyOrderChannel]: (typeof copyOrders)[K]["effect"] extends "read" ? K : never;
}[CopyOrderChannel];

/** One ask to another copy, waiting for its answer. */
type Asked = {
  channel: ReadCopyOrder;
  args: unknown[];
  /** The link it went over; null while it waits for another link to that copy to be heard. */
  over: Link | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type StandbyPeersOptions = {
  /** The work folder, which holds the copy in `standby/`. */
  workDir: string;
  /** This computer's id on the home's list, and the key it joined with, shown and checked on every link. */
  own: DeviceKey & { deviceId: string };
  /** This computer's own addresses on the network, where it listens. */
  hosts: () => readonly string[];
  /** The port it asks for first; the system picks one when it is taken. */
  port: number;
  /** The home number this computer heard last (docs/devices.md, "Moving the first mate"). */
  homeNumber: () => number;
  log: (line: string) => void;
  /** Waits before dialing a copy again, each next one, staying at the last. */
  redialMs?: readonly number[];
  /** How often each link is pinged and the addresses looked at again. */
  lookMs?: number;
  /** How a dial to another copy goes; tests dial loopback directly. */
  dial?: Pick<DialOptions, "relay" | "timeoutMs">;
  /**
   * What a phone the copy's record lists may ask (docs/devices.md, "Taking
   * over from a phone"): absent, no phone is admitted.
   */
  phone?: (channel: StandbyPhoneOrderChannel, args: unknown[]) => Promise<unknown>;
  /**
   * Who writes the copy on this computer (`./copyAccess.ts`, the keeper): each
   * read of the copy's files closes them before a write renames or removes
   * any, as Windows needs. Its own when absent.
   */
  access?: CopyAccess;
};

/**
 * Copies that reach each other (docs/devices.md, "Copies that reach each
 * other"). While this computer keeps a copy, it listens at its own
 * addresses with the key it joined with, and admits only a copy whose key
 * its copy of the record names as another computer that keeps a copy. It
 * dials each such copy at the addresses that copy told the home, pinned to
 * that copy's key, so one side that can dial is enough: a link answers
 * orders both ways, and two links to one copy settle on the one the side
 * with the lower id dialed, an ask still unanswered on the other going again
 * over that one. Nothing here needs the home in reach.
 */
export class StandbyPeers {
  private readonly peers = new Map<string, Peer>();
  private readonly links = new Map<string, Set<Link>>();
  private readonly states = new Map<string, CopyPeerState>();
  private readonly servers = new Map<string, { server: Server; port: number }>();
  private readonly sockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: COPY_LINK_FRAME_BYTES,
  });
  private readonly phoneSockets = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: STANDBY_PHONE_FRAME_BYTES,
  });
  /**
   * Each other copy's asks waiting for an answer, by id: an ask is to the
   * copy, not to one link, so it can go again over another link to it.
   */
  private readonly asks = new Map<string, Map<number, Asked>>();
  /** The next ask's id, never used twice by this computer, so no two links' asks share one. */
  private nextAsk = 0;
  private readonly dialing = new Set<string>();
  private readonly redials = new Map<string, { tries: number; timer: NodeJS.Timeout | null }>();
  /** The record files' sizes and times last read, so an unchanged copy is not read again. */
  private seen = "";
  private binding: Promise<void> = Promise.resolve();
  /** It keeps a copy, or the home asked for one: it listens and dials. */
  private active = false;
  private stopped = false;
  private look: NodeJS.Timeout | null = null;
  private readonly access: CopyAccess;

  constructor(private readonly options: StandbyPeersOptions) {
    this.access = options.access ?? new CopyAccess();
  }

  /** Starts listening when a copy is already kept here, and looks again every so often. */
  start(): void {
    if (this.stopped || this.look) return;
    this.look = setInterval(() => this.lookAgain(), this.options.lookMs ?? LOOK_MS);
    this.look.unref();
    if (readStandbyState(this.options.workDir).stream !== null || this.holdsList()) this.want();
  }

  /** Where it listens, once it does: the home asked for a copy, so it listens from now on. */
  async listens(): Promise<string[]> {
    if (this.stopped) return [];
    this.want();
    await this.binding;
    return [...this.servers].map(([host, held]) => `${host}:${held.port}`);
  }

  /** The keeper's word: the copy changed, so the others may have; or it went, so this stops. */
  copyChanged(what: "changed" | "dropped"): void {
    if (this.stopped) return;
    if (what === "dropped") this.quiet();
    else if (!this.active) this.want();
    else this.refresh();
  }

  /** The home's order: every other copy the record names, and whether this one reaches it. */
  answer(channel: StandbyPeersOrderChannel, args: unknown): { peers: CopyPeer[] } {
    standbyPeersOrders[channel].request.parse(args);
    if (this.active) this.refresh();
    return {
      peers: [...this.peers.values()].map((peer) => ({
        deviceId: peer.deviceId,
        state: this.stateOf(peer.deviceId),
      })),
    };
  }

  /**
   * Asks another copy an order over the link to it; should that link close
   * while another to the same copy is left, the ask goes again over that one.
   */
  ask(deviceId: string, channel: CopyOrderChannel, args: unknown[]): Promise<unknown> {
    const link = this.heardLink(deviceId);
    if (!link) return Promise.reject(new CopyOutOfReachError());
    const id = this.nextAsk++;
    const asks = this.asks.get(deviceId) ?? new Map<number, Asked>();
    this.asks.set(deviceId, asks);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.takeAsk(deviceId, id);
        reject(new Error("That copy did not answer."));
      }, ASK_MS);
      asks.set(id, {
        channel,
        args,
        over: link,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(link, { t: "ask", id, channel, args });
    }).then((value) => copyOrders[channel].response.parse(value));
  }

  /** The other copies reached over a link now, and whether each offers what bringing in its copy asks. */
  inReach(): { deviceId: string; name: string; gathers: boolean }[] {
    return [...this.peers.values()].flatMap((peer) => {
      const link = this.heardLink(peer.deviceId);
      return link
        ? [
            {
              deviceId: peer.deviceId,
              name: peer.name,
              gathers: link.changes.includes(COPY_GATHER_CHANGE),
            },
          ]
        : [];
    });
  }

  /** Every link and listener goes, and nothing starts again. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.look) clearInterval(this.look);
    this.look = null;
    this.quiet();
    this.sockets.close();
    this.phoneSockets.close();
  }

  // -- listening ------------------------------------------------------------

  private want(): void {
    if (this.stopped) return;
    this.active = true;
    this.rebind();
    this.refresh();
    this.dialAll();
  }

  /** No copy here: no listener, no link and nothing said of the others. */
  private quiet(): void {
    this.active = false;
    for (const held of this.servers.values()) held.server.close();
    this.servers.clear();
    for (const deviceId of [...this.links.keys()]) this.cut(deviceId);
    for (const redial of this.redials.values()) if (redial.timer) clearTimeout(redial.timer);
    this.redials.clear();
    this.peers.clear();
    this.states.clear();
    this.seen = "";
    rmSync(join(this.options.workDir, STANDBY_DIR, PEERS_FILE), { force: true });
  }

  /**
   * Listens again after what came before, whatever it did: a bind that
   * failed is said in the log, and the next look tries again.
   */
  private rebind(): void {
    this.binding = this.binding
      .then(() => this.bind())
      .catch((error: unknown) =>
        this.options.log(`could not listen for the other copies: ${String(error)}`),
      );
  }

  /** Listens at each of this computer's addresses, and on none it no longer has. */
  private async bind(): Promise<void> {
    const hosts = [...new Set(this.options.hosts())].slice(0, PAIRING_LINK_ALSO_MAX + 1);
    for (const [host, held] of this.servers)
      if (!hosts.includes(host) || !this.active) {
        held.server.close();
        this.servers.delete(host);
      }
    for (const host of hosts) {
      if (!this.active || this.servers.has(host)) continue;
      const port = [...this.servers.values()][0]?.port ?? this.options.port;
      let held: { server: Server; port: number } | null = null;
      try {
        held = await this.listenOn(host, port);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && port !== 0)
          held = await this.listenOn(host, 0).catch((again: unknown) => {
            this.options.log(`could not listen for the other copies at ${host}: ${String(again)}`);
            return null;
          });
        else this.options.log(`could not listen for the other copies at ${host}: ${String(error)}`);
      }
      if (!held) continue;
      // Stopped or dropped while it bound: it listens nowhere.
      if (!this.active) held.server.close();
      else this.servers.set(host, held);
    }
  }

  private listenOn(host: string, port: number): Promise<{ server: Server; port: number }> {
    const { key, cert } = this.options.own;
    // TLS 1.3 only with the key this computer joined with, as the home's
    // own listener: the other copy checks it before it sends anything, and
    // shows its own, which admission reads. No session is resumed.
    const server = createServer(
      {
        key,
        cert,
        requestCert: true,
        rejectUnauthorized: false,
        secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
        minVersion: "TLSv1.3",
        handshakeTimeout: 10_000,
        headersTimeout: 10_000,
        requestTimeout: 10_000,
      },
      (request, response) => {
        request.resume();
        response.writeHead(404, { Connection: "close" }).end();
      },
    );
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    server.on("tlsClientError", () => {});
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        server.off("error", reject);
        server.on("error", (error) => this.options.log(`a listener stopped: ${String(error)}`));
        const where = server.address();
        resolve({ server, port: where && typeof where === "object" ? where.port : port });
      });
    });
  }

  /** Admits only another copy its record names, by the key it showed, or a phone it lists. */
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => {});
    if (new URL(request.url ?? "/", "https://copy").pathname === STANDBY_PHONE_PATH) {
      this.upgradePhone(request, socket, head);
      return;
    }
    const admitted = this.admit(request);
    if ("refused" in admitted) {
      socket.end(`HTTP/1.1 ${admitted.refused}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const { peer } = admitted;
    this.sockets.handleUpgrade(request, socket, head, (ws) =>
      this.attach(ws, peer.deviceId, peer.deviceId),
    );
  }

  private admit(request: IncomingMessage): { peer: Peer } | { refused: string } {
    // A browser always sends an Origin; no web page reaches a copy.
    if (request.headers.origin !== undefined) return { refused: "403 Forbidden" };
    if (new URL(request.url ?? "/", "https://copy").pathname !== COPY_LINK_PATH)
      return { refused: "404 Not Found" };
    if (this.active) this.refresh();
    const pin = peerPin(request.socket);
    const peer = [...this.peers.values()].find((each) => each.pin === pin);
    return this.active && peer ? { peer } : { refused: "401 Unauthorized" };
  }

  // -- a phone ---------------------------------------------------------------

  /**
   * A phone that cannot reach the home (docs/devices.md, "Taking over from a
   * phone"): admitted only when the copy's record lists it as a phone, by
   * the key it showed, and only while this computer keeps a copy.
   */
  private upgradePhone(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const answer = this.options.phone;
    if (request.headers.origin !== undefined) {
      refuse("403 Forbidden");
      return;
    }
    if (!answer || !this.active) {
      refuse("404 Not Found");
      return;
    }
    if (!this.listsPhone(peerPin(request.socket))) {
      refuse("401 Unauthorized");
      return;
    }
    this.phoneSockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.on("message", (data, isBinary) => {
        let frame: PhoneLinkFrame;
        try {
          if (isBinary) throw new Error("binary");
          frame = phoneLinkFrameSchema.parse(JSON.parse(rawText(data)));
        } catch {
          ws.close(1008, "frames are JSON text");
          return;
        }
        if (frame.t !== "ask") return;
        const reply = (out: PhoneLinkFrame) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out));
        };
        const asked = isStandbyPhoneOrderChannel(frame.channel)
          ? answer(frame.channel, frame.args)
          : Promise.reject(new Error(`No order ${frame.channel} from a phone.`));
        void asked.then(
          (value) => reply({ t: "answer", id: frame.id, value }),
          (error: unknown) =>
            reply({
              t: "refused",
              id: frame.id,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 600),
            }),
        );
      });
    });
  }

  /**
   * Whether the copy's record lists a phone with this key's pin: a device
   * on the list whose hello said `ios` (`devices/systems.json`).
   */
  private listsPhone(pin: string | null): boolean {
    if (!pin) return false;
    try {
      const listed = listedSchema.parse(
        JSON.parse(readFileSync(this.recordFile("devices/devices.json"), "utf8")),
      );
      const systems = systemsSchema.parse(
        JSON.parse(readFileSync(this.recordFile("devices/systems.json"), "utf8")),
      );
      return listed.devices.some(
        (device) => device.keyPin === pin && systems.devices[device.id]?.system === "ios",
      );
    } catch {
      return false;
    }
  }

  // -- the other copies -----------------------------------------------------

  private recordFile(path: string): string {
    return join(this.options.workDir, STANDBY_DIR, STANDBY_COPY, ...path.split("/"));
  }

  /** Whether the copy here holds a list of the computers keeping copies. */
  private holdsList(): boolean {
    return existsSync(this.recordFile(STANDBYS_FILE));
  }

  /** Reads which other copies the record names, when its files changed since the last read. */
  private refresh(): void {
    const files = [this.recordFile("devices/devices.json"), this.recordFile(STANDBYS_FILE)];
    const seen = files
      .map((file) => {
        try {
          const facts = statSync(file);
          return `${facts.size}:${facts.mtimeMs}`;
        } catch {
          return "-";
        }
      })
      .join("|");
    if (seen === this.seen) return;
    this.seen = seen;
    const found = new Map<string, Peer>();
    try {
      const [devicesFile, standbysFile] = files as [string, string];
      const listed = listedSchema.parse(JSON.parse(readFileSync(devicesFile, "utf8")));
      const standbys = standbysSchema.parse(JSON.parse(readFileSync(standbysFile, "utf8")));
      const own = this.options.own.deviceId;
      // A computer its own copy no longer names keeps reaching nobody.
      if (standbys.standbys.some((each) => each.deviceId === own))
        for (const each of standbys.standbys) {
          if (each.deviceId === own) continue;
          const device = listed.devices.find((one) => one.id === each.deviceId);
          if (!device) continue;
          found.set(each.deviceId, {
            deviceId: each.deviceId,
            name: device.name,
            pin: device.keyPin,
            listens: [...(each.listens ?? [])],
          });
        }
    } catch {
      // A copy still arriving holds no list yet: it reaches nobody until it does.
    }
    for (const [deviceId, before] of this.peers) {
      const now = found.get(deviceId);
      if (!now || now.pin !== before.pin) {
        this.cut(deviceId);
        this.states.delete(deviceId);
      }
      if (!now || JSON.stringify(now.listens) !== JSON.stringify(before.listens)) {
        const redial = this.redials.get(deviceId);
        if (redial?.timer) clearTimeout(redial.timer);
        this.redials.delete(deviceId);
      }
    }
    this.peers.clear();
    for (const [deviceId, peer] of found) this.peers.set(deviceId, peer);
    for (const deviceId of this.peers.keys()) this.mark(deviceId);
    this.keepLines();
    this.dialAll();
  }

  private lookAgain(): void {
    if (this.stopped || !this.active) return;
    for (const set of this.links.values())
      for (const link of set) {
        if (!link.answered) {
          link.ws.terminate();
          continue;
        }
        link.answered = false;
        try {
          link.ws.ping();
        } catch {
          link.ws.terminate();
        }
      }
    this.rebind();
    this.refresh();
    this.dialAll();
  }

  private dialAll(): void {
    for (const deviceId of this.peers.keys()) {
      const redial = this.redials.get(deviceId);
      if (!redial?.timer) void this.dial(deviceId);
    }
  }

  /** Dials one other copy at every address it said, pinned to its key, unless a link is up or on its way. */
  private async dial(deviceId: string): Promise<void> {
    const peer = this.peers.get(deviceId);
    if (!this.active || !peer || peer.listens.length === 0) return;
    if (this.dialing.has(deviceId) || (this.links.get(deviceId)?.size ?? 0) > 0) return;
    this.dialing.add(deviceId);
    try {
      const { at, socket } = await pinnedAny(peer.listens, peer.pin, this.options.own, {
        ...this.options.dial,
      });
      if (!this.active || this.peers.get(deviceId)?.pin !== peer.pin) {
        socket.destroy();
        return;
      }
      const ws = new WebSocket(homeSocketUrl(at, COPY_LINK_PATH), {
        createConnection: () => socket,
        perMessageDeflate: false,
        maxPayload: COPY_LINK_FRAME_BYTES,
      });
      await opened(ws);
      if (!this.active || this.peers.get(deviceId)?.pin !== peer.pin) {
        ws.terminate();
        return;
      }
      this.redials.delete(deviceId);
      this.attach(ws, deviceId, this.options.own.deviceId);
    } catch (error) {
      // Said once each time it goes out of reach, not at every try after.
      if (!this.redials.has(deviceId))
        this.options.log(`could not reach the copy on ${peer.name} yet: ${String(error)}`);
      this.redialLater(deviceId);
    } finally {
      this.dialing.delete(deviceId);
    }
  }

  private redialLater(deviceId: string): void {
    if (!this.active || !this.peers.has(deviceId)) return;
    const waits = this.options.redialMs ?? REDIAL_MS;
    const redial = this.redials.get(deviceId) ?? { tries: 0, timer: null };
    if (redial.timer) clearTimeout(redial.timer);
    const wait = waits[Math.min(redial.tries, waits.length - 1)] ?? LOOK_MS;
    redial.tries += 1;
    redial.timer = setTimeout(() => {
      redial.timer = null;
      void this.dial(deviceId);
    }, wait);
    redial.timer.unref();
    this.redials.set(deviceId, redial);
  }

  // -- a link ---------------------------------------------------------------

  private attach(ws: WebSocket, peer: string, dialedBy: string): void {
    const link: Link = {
      ws,
      peer,
      dialedBy,
      heard: false,
      changes: [],
      answered: true,
    };
    const set = this.links.get(peer) ?? new Set<Link>();
    set.add(link);
    this.links.set(peer, set);
    ws.on("error", () => {});
    ws.on("pong", () => {
      link.answered = true;
    });
    ws.on("message", (data, isBinary) => this.frame(link, data, isBinary));
    ws.once("close", () => this.closed(link));
    this.send(link, { t: "hello", changes: [STANDBY_PEERS_CHANGE, COPY_GATHER_CHANGE] });
  }

  private send(link: Link, frame: CopyLinkFrame): void {
    if (link.ws.readyState !== WebSocket.OPEN) return;
    link.ws.send(JSON.stringify(frame));
  }

  private frame(link: Link, data: RawData, isBinary: boolean): void {
    let frame: CopyLinkFrame;
    try {
      if (isBinary) throw new Error("binary");
      frame = copyLinkFrameSchema.parse(JSON.parse(rawText(data)));
    } catch {
      link.ws.close(1008, "frames are JSON text");
      return;
    }
    switch (frame.t) {
      case "hello":
        link.heard = true;
        link.changes = frame.changes;
        this.settle(link.peer);
        this.mark(link.peer);
        this.keepLines();
        this.askAgain(link.peer);
        return;
      case "ask":
        if (!link.heard) return;
        void this.answerCopy(frame.channel, frame.args).then(
          (value) => this.send(link, { t: "answer", id: frame.id, value }),
          (error: unknown) =>
            this.send(link, {
              t: "refused",
              id: frame.id,
              error: (error instanceof Error ? error.message : String(error)).slice(0, 600),
            }),
        );
        return;
      case "answer":
        this.answerTo(link, frame.id)?.resolve(frame.value);
        return;
      case "refused":
        this.answerTo(link, frame.id)?.reject(new Error(frame.error));
        return;
    }
  }

  /**
   * What another copy may ask this one: where its copy stands and the home
   * number it heard, and, for a computer taking over, its copy's files.
   */
  async answerCopy(channel: string, args: unknown[]): Promise<unknown> {
    if (!isCopyOrderChannel(channel)) throw new Error(`No order ${channel} between copies.`);
    switch (channel) {
      case COPY_WHERE_ORDER:
        copyOrders[channel].request.parse(args);
        return copyOrders[COPY_WHERE_ORDER].response.parse({
          ...readStandbyState(this.options.workDir),
          homeNumber: this.options.homeNumber(),
        });
      case COPY_FILES_ORDER: {
        const [{ from }] = copyOrders[channel].request.parse(args);
        const state = readStandbyState(this.options.workDir);
        const { files, next } = await this.copyFiles(state.stream, state.seq, from);
        return { stream: state.stream, seq: state.seq, files, next };
      }
      case COPY_PIECE_ORDER: {
        const [{ path, offset }] = copyOrders[channel].request.parse(args);
        const file = this.copyPath(path);
        return this.access.read(async () => {
          const handle = await open(file, "r");
          try {
            const buffer = Buffer.alloc(COPY_PIECE_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, COPY_PIECE_BYTES, offset);
            return { data: buffer.subarray(0, bytesRead).toString("base64") };
          } finally {
            await handle.close();
          }
        });
      }
    }
  }

  /** The copy's files, hashed once for each place in the stream, in path order as each is hashed. */
  private listing: {
    at: string;
    files: CopyFile[];
    done: boolean;
    failed: unknown;
    hashed: (() => void)[];
  } | null = null;

  /**
   * One page of the copy's files from `from`: the files hashed so far, up to
   * a page, waiting only for the first of them, so a large copy answers each
   * ask while the rest are still hashed.
   */
  private async copyFiles(
    stream: string | null,
    seq: number,
    from: number,
  ): Promise<{ files: CopyFile[]; next: number | null }> {
    const at = `${stream}:${seq}`;
    if (this.listing?.at !== at) {
      const listing: NonNullable<typeof this.listing> = {
        at,
        files: [],
        done: false,
        failed: null,
        hashed: [],
      };
      const tell = () => {
        for (const wake of listing.hashed.splice(0)) wake();
      };
      listCopy(this.copyRoot(), this.access, (file) => {
        listing.files.push(file);
        tell();
      }).then(
        () => {
          listing.done = true;
          tell();
        },
        (error: unknown) => {
          listing.failed = error;
          listing.done = true;
          tell();
        },
      );
      this.listing = listing;
    }
    const listing = this.listing;
    while (!listing.done && listing.files.length <= from)
      await new Promise<void>((resolve) => listing.hashed.push(resolve));
    if (listing.failed) throw listing.failed;
    const files = listing.files.slice(from, from + COPY_FILES_PAGE);
    const end = from + files.length;
    return { files, next: end < listing.files.length || !listing.done ? end : null };
  }

  private copyRoot(): string {
    return join(this.options.workDir, STANDBY_DIR, STANDBY_COPY);
  }

  /** A path of the copy, never outside it. */
  private copyPath(path: string): string {
    const root = this.copyRoot();
    const file = resolve(root, ...path.split("/"));
    if (!file.startsWith(root + sep)) throw new Error("That path is not in the copy.");
    return file;
  }

  /** Two links to one copy: both sides keep the one the lower id dialed, the newest of those. */
  private settle(peer: string): void {
    const heard = [...(this.links.get(peer) ?? [])].filter(
      (link) => link.heard && link.ws.readyState === WebSocket.OPEN,
    );
    if (heard.length < 2) return;
    const lowest = heard.reduce((low, link) => (link.dialedBy < low ? link.dialedBy : low), "￿");
    const kept = heard.filter((link) => link.dialedBy === lowest).at(-1);
    for (const link of heard) if (link !== kept) link.ws.close(4000, "one link to each copy");
  }

  /**
   * A link went. While another open link to that copy is left, as when both
   * sides dialed and one closed the link it settled against, each ask the
   * link carried goes again over the one that stays, once that one is heard,
   * since its answer may never come over this one; once no open link is
   * left, every ask to that copy is refused, as it is out of reach.
   */
  private closed(link: Link): void {
    const set = this.links.get(link.peer);
    set?.delete(link);
    if (set?.size === 0) this.links.delete(link.peer);
    if (![...(set ?? [])].some((each) => each.ws.readyState === WebSocket.OPEN))
      this.refuseAsks(link.peer);
    else {
      for (const asked of this.asks.get(link.peer)?.values() ?? [])
        if (asked.over === link) asked.over = null;
      this.askAgain(link.peer);
    }
    if (!this.active || !this.peers.has(link.peer)) return;
    this.mark(link.peer);
    this.keepLines();
    if (!this.links.has(link.peer)) this.redialLater(link.peer);
  }

  /** Sends each ask to that copy whose link went over a link to it now heard, if one is. */
  private askAgain(deviceId: string): void {
    const link = this.heardLink(deviceId);
    if (!link) return;
    for (const [id, asked] of this.asks.get(deviceId) ?? []) {
      if (asked.over !== null) continue;
      asked.over = link;
      this.send(link, { t: "ask", id, channel: asked.channel, args: asked.args });
    }
  }

  /** No link to that copy is left: every ask to it is refused. */
  private refuseAsks(deviceId: string): void {
    const asks = this.asks.get(deviceId);
    this.asks.delete(deviceId);
    for (const asked of asks?.values() ?? []) asked.reject(new CopyOutOfReachError());
  }

  /**
   * The ask an answer over this link is for, taken off the waiting ones:
   * only one that last went over this link, since the other copy answers
   * each ask over the link it came by.
   */
  private answerTo(link: Link, id: number): Asked | undefined {
    if (this.asks.get(link.peer)?.get(id)?.over !== link) return undefined;
    return this.takeAsk(link.peer, id);
  }

  /** The ask with this id to that copy, taken off the waiting ones; none once answered or given up. */
  private takeAsk(deviceId: string, id: number): Asked | undefined {
    const asks = this.asks.get(deviceId);
    const asked = asks?.get(id);
    asks?.delete(id);
    if (asks?.size === 0) this.asks.delete(deviceId);
    return asked;
  }

  private cut(deviceId: string): void {
    for (const link of this.links.get(deviceId) ?? []) link.ws.terminate();
    this.links.delete(deviceId);
    this.refuseAsks(deviceId);
  }

  private heardLink(deviceId: string): Link | undefined {
    return [...(this.links.get(deviceId) ?? [])].find(
      (link) => link.heard && link.ws.readyState === WebSocket.OPEN,
    );
  }

  // -- what it says ---------------------------------------------------------

  private stateOf(deviceId: string): CopyPeerState {
    return this.states.get(deviceId) ?? "no-address";
  }

  /** Where one other copy stands now. */
  private mark(deviceId: string): void {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    this.states.set(
      deviceId,
      this.heardLink(deviceId)
        ? "in-reach"
        : peer.listens.length === 0
          ? "no-address"
          : "out-of-reach",
    );
  }

  /** Keeps what it last saw of the others beside the copy, for `work status`. */
  private keepLines(): void {
    if (!this.active) return;
    const dir = join(this.options.workDir, STANDBY_DIR);
    if (!existsSync(dir)) return;
    const peers = [...this.peers.values()].map((peer) => ({
      deviceId: peer.deviceId,
      name: peer.name,
      state: this.stateOf(peer.deviceId),
    }));
    try {
      writePrivate(join(dir, PEERS_FILE), `${JSON.stringify({ version: 1, peers })}\n`);
    } catch (error) {
      this.options.log(`could not keep which copies are in reach: ${String(error)}`);
    }
  }
}

/** Resolves once a dialed link opens; rejects on a refusal or a drop before. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("unexpected-response", onRefused);
      ws.off("close", onClose);
      if (error) {
        ws.on("error", () => {});
        ws.terminate();
        reject(error);
      } else resolve();
    };
    const onOpen = () => done();
    const onError = (error: Error) => done(error);
    const onRefused = (request: { destroy: () => void }, response: { statusCode?: number }) => {
      request.destroy();
      done(new Error(`The other copy refused this one (${response.statusCode ?? 0}).`));
    };
    const onClose = () => done(new Error("The other copy closed the link."));
    ws.on("open", onOpen);
    ws.on("error", onError);
    ws.on("unexpected-response", onRefused);
    ws.on("close", onClose);
  });
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

type CopyFile = { path: string; size: number; sha256: string };

/**
 * Gives every file under `root`, by its record path, with its size and
 * SHA-256, in path order, as each is hashed: each file read under `access`,
 * so no write of the copy renames it while it is open.
 */
async function listCopy(
  root: string,
  access: CopyAccess,
  each: (file: CopyFile) => void,
): Promise<void> {
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, path);
      else if (entry.isFile())
        each(
          await access.read(async () => ({
            path,
            size: statSync(abs).size,
            sha256: await hashFile(abs),
          })),
        );
    }
  };
  await walk(root, "");
}
