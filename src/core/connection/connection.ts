import { constants as cryptoConstants } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { Duplex } from "node:stream";
import {
  channelIn,
  FIRST_SPELLING,
  OWN_SPELLING,
  ownChannel,
  readSpellings,
  SPELLINGS,
  type Spelling,
  spellingFor,
} from "@shared/codeNames";
import {
  type ClientFrame,
  CONNECTION_CLOSE,
  CONNECTION_MAX_FRAME_BYTES,
  CONNECTION_PATH,
  CONNECTION_PORT,
  clientFrameSchema,
  FETCH_APP_PATH,
  FETCH_APP_REFUSAL_STATUS,
  FETCH_APP_SHA256_HEADER,
  FETCH_APP_TYPES,
  type FetchAppRefusal,
  fetchAppRequestSchema,
  PAIR_BODY_MAX_BYTES,
  PAIR_PATH,
  PAIR_REFUSAL_STATUS,
  type PairGrant,
  type PairRefusal,
} from "@shared/connection";
import { COMPUTER, HOME } from "@shared/deviceNames";
import {
  type DeviceChip,
  type DeviceKind,
  type DeviceRole,
  type DeviceSystem,
  deviceMayBe,
  deviceNameSchema,
} from "@shared/devices";
import {
  CORE_INVOKE_CHANNELS,
  type ContractAccess,
  type CoreInvokeChannel,
  contractAccess,
  invokeContract,
  isRunViewInvokeChannel,
  isViewInvokeChannel,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  takesWork,
} from "@shared/ipc";
import { WebSocket, WebSocketServer } from "ws";
import { copyStream, type FarBuild } from "../devices/farBuilds";
import type { CoreActor, CoreDispatch } from "../dispatcher";
import type { CoreEventBus } from "../events";
import { listenAddresses, listenOn } from "./addresses";
import { CONTRACT_CHANGES } from "./contractChanges";
import {
  DEFAULT_JOURNAL_LIMITS,
  EventJournal,
  type JournalEntry,
  type JournalLimits,
} from "./journal";

/**
 * A device the pairing seam vouches for (docs/devices.md): a `mac` both
 * controls this Firstmate and runs work, a `view` only controls, a `work`
 * device only runs work. Each connection says which it is (`DeviceRole`).
 */
export type PairedDevice = {
  readonly id: string;
  readonly kind: DeviceKind;
  /**
   * Whether it joined from this Mac itself, as pairing found it; absent
   * when its entry does not say. A computer that runs work hears it in its
   * welcome (`onHomeMac`).
   */
  readonly onThisMac?: boolean;
};

/** How pairing answered a device using its link at `PAIR_PATH`. */
export type PairOutcome =
  | { ok: true; grant: PairGrant }
  | { ok: false; refused: PairRefusal; reason: string };

/**
 * What the connection asks of pairing (docs/connection.md). Pairing decides
 * who is paired and how a device proves it; the connection only asks, so it
 * never listens with nothing paired and never lets an unproven device send a
 * frame. The real pairing is `DevicePairing` (src/core/devices/pairing.ts).
 */
export type PairedDevices = {
  /** Whether anything is paired or a link is open; the connection listens only while this holds. */
  any(): boolean;
  /** Current alternatives, supplied only after the device authenticates. */
  offerTargets?(phone?: boolean): string[];
  /**
   * Called after every change to what is paired, before the change returns;
   * answers its own unsubscribe.
   */
  subscribe(listener: () => void): () => void;
  /** The home's TLS key and certificate, PEM. Read each time listening starts. */
  identity(): { readonly key: string; readonly cert: string };
  /** The paired device a connection request proves to be, or null to refuse it. */
  admit(request: IncomingMessage): PairedDevice | null | Promise<PairedDevice | null>;
  /** Whether a device admitted earlier is still paired. */
  holds(deviceId: string): boolean;
  /** A device uses its link: the parsed JSON body of `POST /pair`, and the request it came on. */
  claim(body: unknown, request: IncomingMessage): PairOutcome | Promise<PairOutcome>;
  /**
   * Whether a command may get Firstmate with this body's code at
   * `FETCH_APP_PATH`: null for an open link made for a computer that runs
   * work, else why not. Reading it never spends it. A body with no code is a
   * computer that runs work already paired, getting its home's Firstmate to
   * update itself: null when the key the request's TLS socket showed is one.
   */
  opened?(body: unknown, request: IncomingMessage): FetchAppRefusal | null;
  /**
   * A connected device's person chose Leave on it: take it off the list.
   * Listeners hear of it before this returns, so the connection cuts the
   * device as for a Remove.
   */
  leave(deviceId: string): void;
  /**
   * What a device said it is in its hello (docs/devices.md, "What a device
   * is"): kept beside its kind. Said only when its hello named either.
   */
  noteSystem?(
    deviceId: string,
    said: {
      system?: DeviceSystem;
      chip?: DeviceChip;
      automaticStartup?: import("@shared/devices").AutomaticStartup;
    },
  ): void;
};

/**
 * What a connection in each role may ask (docs/devices.md): a view the
 * channels whose reach is `views`, as the captain at another Mac, and of a
 * first mate started by a command every `home` channel but those that stay
 * there (docs/run.md, "Control from another computer"); a computer's work
 * the channels whose reach is `work`, as itself, about a conversation it
 * holds for this home (src/shared/work.ts).
 */
function askerOf(
  device: PairedDevice,
  role: DeviceRole,
  channel: CoreInvokeChannel,
  startedByCommand: boolean,
): CoreActor | null {
  if (role === "view")
    return (startedByCommand ? isRunViewInvokeChannel(channel) : isViewInvokeChannel(channel))
      ? { kind: "captain" }
      : null;
  return isWorkInvokeChannel(channel) ? { kind: "device", deviceId: device.id } : null;
}

/**
 * A request the home could not put to a computer that runs work: it is not
 * connected, takes no work, or its connection went before it answered.
 * Nothing says whether it did the work, so the home asks again under the
 * same order id once it is back (src/shared/work.ts).
 */
export class DeviceOutOfReachError extends Error {
  constructor(message = "That computer is out of reach, so nothing was sent.") {
    super(message);
    this.name = "DeviceOutOfReachError";
  }
}

/** A computer that runs work came into reach of this home, or went. */
export type WorkDeviceContact = { deviceId: string; contact: "in-reach" | "gone" };

/** A Mac that controls this Firstmate connected to this home, or its last connection went. */
export type ViewDeviceContact = { deviceId: string; contact: "in-reach" | "gone" };

/**
 * What a connected computer that runs work said of itself in its hello: the
 * contract version it speaks, the version of Firstmate it runs when it said
 * one, and whether its welcome let it take work (docs/devices.md, "Another
 * version").
 */
export type WorkDeviceVersion = {
  contract: string;
  app?: string;
  takesWork: boolean;
  /**
   * The contract changes its hello listed by name (`changes`,
   * src/core/connection/contractChanges.ts); absent when it listed none.
   */
  changes?: readonly string[];
};

export type ConnectionOptions = {
  dispatch: CoreDispatch;
  events: CoreEventBus;
  devices: PairedDevices;
  /**
   * The private addresses of this Mac to listen on beside loopback, or
   * where to read them each time listening is reconciled. One address is
   * still accepted. A list is every address a link may carry
   * (docs/devices.md, "Where devices find this Mac").
   */
  address?: string | readonly string[] | (() => string | readonly string[] | undefined);
  /** Defaults to CONNECTION_PORT; 0 lets the system choose (tests). */
  port?: number;
  /**
   * The contract version this home speaks, which its welcome reports and the
   * version rule measures each device against. Defaults to PROTOCOL_VERSION;
   * a test stands in a later home with it.
   */
  protocolVersion?: string;
  /**
   * The contract changes this home's welcome lists by name. Defaults to this
   * build's own (`CONTRACT_CHANGES`); a test stands in another home's with
   * it, and an empty list says none, as a home from before names.
   */
  changes?: readonly string[];
  /**
   * The spelling of channel names this home writes to a device that reads
   * it (docs/connection.md, "Two spellings"). Defaults to this build's own;
   * a test stands in Infinitary's with it.
   */
  speaks?: Spelling;
  journal?: JournalLimits;
  /** A connected device that misses one ping in this long is cut. */
  heartbeatMs?: number;
  /** A device with more than this waiting to be sent is cut, and catches up when it returns. */
  maxBufferedBytes?: number;
  /** Where the connection says it could not listen. */
  onProblem?: (text: string) => void;
  /**
   * The first mate was started by a command, with no window (docs/run.md):
   * a view's welcome says so, and a view asks every `home` channel but
   * those that stay on this computer (`RUN_HOME_ONLY_CHANNELS`).
   */
  startedByCommand?: boolean;
  /**
   * This Mac's own name, which the welcome tells a device (a view says the
   * Mac it controls by it). Read at each welcome; absent, the welcome names
   * none.
   */
  name?: () => string | undefined;
  /**
   * The app this home sends a command on another Mac at `FETCH_APP_PATH`:
   * its one `.app` bundle, or null when it cannot send itself.
   */
  app?: () => string | null;
  /**
   * The Firstmate for a computer that names its system and chip at
   * `FETCH_APP_PATH` (docs/devices.md, "Infinitary for another system"): this
   * home's own when it suits, else the one published for them, got and
   * checked; null when there is none to send.
   */
  build?: (
    system: DeviceSystem,
    chip: DeviceChip | undefined,
    kind?: "deb",
  ) => Promise<FarBuild | null>;
};

export type RunningDeviceVersion = { deviceId: string; role: DeviceRole; version: string | null };

export type HomeConnection = {
  /** Live hello facts, including views and incompatible work computers; never a cached installation. */
  runningVersions(): RunningDeviceVersion[];
  /** Where it listens now, as address:port; empty while nothing is paired. */
  listening(): string[];
  /**
   * Asks a connected computer that runs work one order (src/shared/work.ts)
   * and resolves with its answer, or rejects with its refusal. With
   * `anyVersion` - the update and download orders alone, whose shapes never
   * change - it reaches one that takes no work too. Refused at
   * once with `DeviceOutOfReachError` when the device is not connected or
   * its welcome said it takes no work, and with it too when the connection
   * goes before the answer; never asked again here.
   */
  ask(
    deviceId: string,
    channel: string,
    args: unknown,
    options?: { anyVersion?: boolean },
  ): Promise<unknown>;
  /**
   * Hears each computer that runs work come into reach, welcomed and taking
   * work, and go; answers its own unsubscribe.
   */
  onWorkDevice(listener: (contact: WorkDeviceContact) => void): () => void;
  /**
   * Hears each Mac that controls this Firstmate connect, welcomed, and its
   * last connection go; answers its own unsubscribe.
   */
  onViewDevice(listener: (contact: ViewDeviceContact) => void): () => void;
  /**
   * Hears what each connected computer that runs work says of its version,
   * whether or not it takes work, at each welcome, and null once its last
   * connection went; answers its own unsubscribe.
   */
  onWorkVersion(
    listener: (deviceId: string, version: WorkDeviceVersion | null) => void,
  ): () => void;
  /**
   * Hears where it listens each time that changes - a new listening run at
   * another address, the first thing paired, the last one gone - with
   * `listening()`'s answer; answers its own unsubscribe.
   */
  onListening(listener: (listening: string[]) => void): () => void;
  /**
   * Hears each piece of Firstmate this home sends a computer on its list at
   * `FETCH_APP_PATH`, as it goes, by that computer's id and the piece's
   * bytes (docs/devices.md, "Downloading over the connection"); a command's
   * get, which carries a code, names no computer and is not heard. Answers
   * its own unsubscribe.
   */
  onAppSent(listener: (deviceId: string, bytes: number) => void): () => void;
  /** Resolves once listening reflects the latest change to what is paired. */
  settled(): Promise<void>;
  /** Stops listening and following pairing, then drains device closes with a two-second grace. */
  close(): Promise<void>;
};

type Client = {
  readonly ws: WebSocket;
  readonly device: PairedDevice;
  welcomed: boolean;
  /** What this connection does, from its hello: null until it is welcomed. */
  role: DeviceRole | null;
  /** The contract version its hello spoke, and what the version rule lets it ask. */
  speaks: string;
  /** The spelling of channel names it is written in: its own, when its hello said it reads that one. */
  spelling: Spelling;
  /** The version of Firstmate its hello said it runs, when it said one. */
  appVersion: string | undefined;
  access: ContractAccess;
  closing: boolean;
  answeredPing: boolean;
  waitedForHello: boolean;
  /** For a computer that runs work: its welcome said it takes work, so the home may ask it. */
  takesWork: boolean;
  /**
   * A computer's join, dialing once only to hear the home's name: welcomed,
   * and nothing of it is that computer in reach, its version, or work.
   */
  nameOnly: boolean;
  /** What the home asked it and waits for, by request id. */
  readonly asked: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
};

type Run = {
  readonly servers: Server[];
  /** The address it was asked to listen on beside loopback, as asked. */
  readonly chosen: string | undefined;
  readonly addresses: string[];
  readonly clients: Set<Client>;
  readonly detach: () => void;
  readonly heartbeat: NodeJS.Timeout;
};

const CORE_CHANNELS = new Set<string>(CORE_INVOKE_CHANNELS);

/**
 * A numbered push's frame with its channel in `spelling`; the rest is the
 * same bytes, so every device is still sent the same push under the same
 * number. A frame not written as the journal writes one goes as it is.
 */
export function pushFrameIn(entry: JournalEntry, spelling: Spelling): string {
  const channel = channelIn(entry.channel, spelling);
  if (channel === entry.channel) return entry.frame;
  const head = (name: string) => `{"t":"push","seq":${entry.seq},"channel":${JSON.stringify(name)}`;
  const was = head(entry.channel);
  return entry.frame.startsWith(was) ? head(channel) + entry.frame.slice(was.length) : entry.frame;
}

/** What each refusal at `FETCH_APP_PATH` says; none echoes the code. */
const FETCH_APP_REASONS: Record<FetchAppRefusal, string> = {
  malformed: "The request for Infinitary is not one this home reads.",
  unknown: "This home has no open link with that code.",
  kind: `This link is for the app on another ${COMPUTER.one}.`,
  used: "This link was used already.",
  expired: "This link has expired.",
  none: `This copy of Infinitary cannot send itself to another ${COMPUTER.one}.`,
};

/**
 * A request's body as text, read without iterating, so a body that grows
 * past the cap without a length (chunked) is answered 413 (null) rather
 * than reset; undefined when the request failed.
 */
function readBody(request: IncomingMessage): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      if (size > PAIR_BODY_MAX_BYTES) return;
      size += chunk.length;
      if (size > PAIR_BODY_MAX_BYTES) resolve(null);
      else chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", () => resolve(undefined));
  });
}

/**
 * The home's side of the connection (docs/connection.md): the core's
 * requests and pushes served to paired devices over WebSocket. Like the
 * desktop adapter it names no channel - it forwards whatever the contract
 * lets a view ask to `dispatch`, as the captain, and numbers every push from
 * `events` once, so every device sees the same push under the same number.
 */
export function startConnection(options: ConnectionOptions): HomeConnection {
  const { dispatch, events, devices } = options;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024;
  const onProblem = options.onProblem ?? ((text) => console.warn(`[connection] ${text}`));
  const homeVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const homeChanges = options.changes ?? CONTRACT_CHANGES.names;
  const startedByCommand = options.startedByCommand === true;
  const speaks = options.speaks ?? OWN_SPELLING;
  let run: Run | null = null;
  let closed = false;
  let tail = Promise.resolve();
  let nextAsk = 1;
  const workListeners = new Set<(contact: WorkDeviceContact) => void>();
  const sentListeners = new Set<(deviceId: string, bytes: number) => void>();
  const tellSent = (deviceId: string, bytes: number) => {
    for (const listener of [...sentListeners]) {
      try {
        listener(deviceId, bytes);
      } catch (error) {
        onProblem(`a send listener failed: ${(error as Error).message}`);
      }
    }
  };
  const versionListeners = new Set<(deviceId: string, version: WorkDeviceVersion | null) => void>();
  const tellVersion = (deviceId: string, version: WorkDeviceVersion | null) => {
    for (const listener of [...versionListeners]) {
      try {
        listener(deviceId, version);
      } catch (error) {
        onProblem(`a version listener failed: ${(error as Error).message}`);
      }
    }
  };
  const tellWork = (contact: WorkDeviceContact) => {
    for (const listener of [...workListeners]) {
      try {
        listener(contact);
      } catch (error) {
        onProblem(`a work listener failed: ${(error as Error).message}`);
      }
    }
  };
  const listeningListeners = new Set<(listening: string[]) => void>();
  const listeningNow = () => [...(run?.addresses ?? [])];
  const tellListening = () => {
    for (const listener of [...listeningListeners]) {
      try {
        listener(listeningNow());
      } catch (error) {
        onProblem(`a listening listener failed: ${(error as Error).message}`);
      }
    }
  };
  const viewListeners = new Set<(contact: ViewDeviceContact) => void>();
  const tellView = (contact: ViewDeviceContact) => {
    for (const listener of [...viewListeners]) {
      try {
        listener(contact);
      } catch (error) {
        onProblem(`a view listener failed: ${(error as Error).message}`);
      }
    }
  };
  /**
   * The newest welcomed connection of a computer that takes work, if any;
   * with `anyVersion`, of one that takes no work too.
   */
  const workClient = (deviceId: string, anyVersion = false): Client | undefined =>
    [...(run?.clients ?? [])]
      .reverse()
      .find(
        (client) =>
          client.device.id === deviceId &&
          client.role === "work" &&
          client.welcomed &&
          !client.nameOnly &&
          (client.takesWork || anyVersion) &&
          !client.closing,
      );
  const listenList = (): { key: string; addresses: string[] } => {
    const read = typeof options.address === "function" ? options.address() : options.address;
    const addresses = Array.isArray(read)
      ? listenOn(read)
      : listenAddresses(typeof read === "string" ? read : undefined);
    return { key: addresses.join(" "), addresses };
  };
  // A name the welcome could not carry is no name: every device parses it.
  const homeName = (): string | undefined => {
    try {
      const parsed = deviceNameSchema.safeParse(options.name?.());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  const follow = async () => {
    if (closed || !devices.any()) {
      await stop(closed ? CONNECTION_CLOSE.closing : CONNECTION_CLOSE.unpaired);
      return;
    }
    // A new set of addresses is a new listening run: devices come back and reload.
    let listed: { key: string; addresses: string[] };
    try {
      listed = listenList();
    } catch (refusal) {
      onProblem(`not listening: ${(refusal as Error).message}`);
      if (run) await stop(CONNECTION_CLOSE.closing);
      return;
    }
    if (run && run.chosen !== listed.key) await stop(CONNECTION_CLOSE.closing);
    if (!run) run = await start(listed);
    for (const client of run?.clients ?? [])
      if (!devices.holds(client.device.id)) cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
  };
  const reconcile = () => {
    tail = tail
      .then(async () => {
        const was = listeningNow().join(" ");
        try {
          await follow();
        } finally {
          if (listeningNow().join(" ") !== was) tellListening();
        }
      })
      .catch((error) => onProblem(`stopped following pairing: ${(error as Error).message}`));
    return tail;
  };
  // A device whose pairing went is cut in the same call that removed it
  // (docs/devices.md, "Remove"); listening follows on the chain.
  const unsubscribe = devices.subscribe(() => {
    for (const client of run?.clients ?? [])
      if (!devices.holds(client.device.id)) cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    void reconcile();
  });
  void reconcile();

  async function start(ready?: { key: string; addresses: string[] }): Promise<Run | null> {
    let addresses: string[];
    let identity: { key: string; cert: string };
    let listed = ready;
    try {
      listed ??= listenList();
      addresses = listed.addresses;
      identity = devices.identity();
    } catch (refusal) {
      onProblem(`not listening: ${(refusal as Error).message}`);
      return null;
    }
    const chosen = listed.key;
    let journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
    const clients = new Set<Client>();
    const sockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: CONNECTION_MAX_FRAME_BYTES,
    });
    const send = (client: Client, frame: string) => {
      if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
      if (client.ws.bufferedAmount > maxBufferedBytes) {
        cut(client, CONNECTION_CLOSE.behind, "behind");
        return;
      }
      client.ws.send(frame);
    };
    // Never throws into the core's emit. A push that cannot be written would
    // leave every device with a hole it cannot see, so they all start over.
    const detach = events.subscribe((channel, payload) => {
      try {
        const entry = journal.record(
          (seq) => JSON.stringify({ t: "push", seq, channel, payload }),
          channel,
        );
        for (const client of clients)
          if (client.welcomed && client.role === "view")
            send(client, pushFrameIn(entry, client.spelling));
      } catch (error) {
        onProblem(`could not send ${channel}: ${(error as Error).message}`);
        journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
        for (const client of clients) cut(client, CONNECTION_CLOSE.behind, "behind");
      }
    });

    const welcome = (client: Client, hello: Extract<ClientFrame, { t: "hello" }>) => {
      // What this connection does: what it says, or what its kind does. A
      // Mac that does both runs its work unless it says it controls.
      const role: DeviceRole = hello.as ?? (client.device.kind === "view" ? "view" : "work");
      if (!deviceMayBe(client.device.kind, role)) {
        cut(client, CONNECTION_CLOSE.protocol, `a ${client.device.kind} device is never a ${role}`);
        return;
      }
      client.role = role;
      // Only a view is sent pushes, so only a view catches up on them.
      const missed = hello.cursor && role === "view" ? journal.since(hello.cursor) : null;
      client.speaks = hello.protocolVersion;
      client.spelling = spellingFor(readSpellings(hello.spellings), speaks);
      client.appVersion = hello.appVersion;
      client.access = contractAccess(hello.protocolVersion, homeVersion);
      const takes = role === "work" && takesWork(hello.protocolVersion, homeVersion);
      // A join hearing the name is welcomed as any connection is, and is
      // nothing more: never that computer in reach, so Devices can tell one
      // whose work never reached this Mac since it joined (docs/devices.md).
      client.nameOnly = role === "work" && hello.nameOnly === true;
      client.takesWork = takes && !client.nameOnly;
      const name = homeName();
      send(
        client,
        JSON.stringify({
          t: "welcome",
          protocolVersion: homeVersion,
          epoch: journal.epoch,
          seq: journal.seq,
          catchUp: missed ? "replay" : "reload",
          access: client.access,
          ...(name ? { name } : {}),
          ...(devices.offerTargets ? { addresses: devices.offerTargets(true) } : {}),
          // A computer that runs work takes new work only on this home's own
          // major (docs/helper.md); a view is never sent work.
          ...(role === "work" ? { takesWork: takes } : {}),
          // Where its work runs decides that work's priority there: the home
          // says what its list found, and the computer keeps it on its grant.
          ...(role === "work" && client.device.onThisMac !== undefined
            ? { onHomeMac: client.device.onThisMac }
            : {}),
          ...(role === "view" && startedByCommand ? { startedByCommand: true } : {}),
          spellings: SPELLINGS,
          ...(homeChanges.length ? { changes: homeChanges } : {}),
        }),
      );
      for (const entry of missed ?? []) send(client, pushFrameIn(entry, client.spelling));
      client.welcomed = true;
      if (hello.system || hello.chip || hello.automaticStartup)
        devices.noteSystem?.(client.device.id, {
          ...(hello.system ? { system: hello.system } : {}),
          ...(hello.chip ? { chip: hello.chip } : {}),
          ...(hello.automaticStartup ? { automaticStartup: hello.automaticStartup } : {}),
        });
      if (role === "work" && !client.nameOnly)
        tellVersion(client.device.id, {
          contract: hello.protocolVersion,
          ...(hello.appVersion ? { app: hello.appVersion } : {}),
          takesWork: client.takesWork,
          ...(hello.changes?.length ? { changes: hello.changes } : {}),
        });
      if (client.takesWork) tellWork({ deviceId: client.device.id, contact: "in-reach" });
      if (role === "view") tellView({ deviceId: client.device.id, contact: "in-reach" });
    };

    const answer = async (client: Client, asked: Extract<ClientFrame, { t: "invoke" }>) => {
      // Read in this home's own spelling, whichever the device wrote.
      const frame = { ...asked, channel: ownChannel(asked.channel) };
      const reply = (outcome: { ok: true; value: unknown } | { ok: false; error: string }) => {
        let text: string;
        try {
          text = JSON.stringify({ t: "result", id: frame.id, ...outcome });
        } catch {
          text = JSON.stringify({
            t: "result",
            id: frame.id,
            ok: false,
            error: `The answer to ${frame.channel} could not be sent.`,
          });
        }
        send(client, text);
      };
      if (!CORE_CHANNELS.has(frame.channel)) {
        reply({ ok: false, error: `${frame.channel} is not a request this home answers.` });
        return;
      }
      const channel = frame.channel as CoreInvokeChannel;
      const actor = client.role
        ? askerOf(client.device, client.role, channel, startedByCommand)
        : null;
      if (!actor) {
        reply({
          ok: false,
          error: isWorkInvokeChannel(channel)
            ? `${channel} is asked only by a computer that runs work.`
            : `${channel} is answered only on ${HOME.the}.`,
        });
        return;
      }
      if (actor.kind === "device" && !client.takesWork) {
        reply({
          ok: false,
          error: `${channel} is work, and a computer on contract ${client.speaks} takes no work from a home on ${homeVersion} until it is updated.`,
        });
        return;
      }
      // The version rule (docs/contract.md): outside the window a device
      // reads, and changes nothing until it is updated.
      if (client.access === "read" && invokeContract[channel].effect === "change") {
        reply({
          ok: false,
          error: `${channel} changes something, and a device on contract ${client.speaks} only reads from a home on ${homeVersion} until it is updated.`,
        });
        return;
      }
      try {
        // A paired view is the captain at another Mac: the same actor the
        // desktop adapter stamps, with the contract's reach as the limit, so
        // the words it types are his own words (the captain's pick, FI3-709).
        // A computer that runs work asks as itself, by the pairing it proved.
        reply({ ok: true, value: await dispatch(channel, frame.args, actor) });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    // Leave (docs/devices.md): the device asks to come off the list, and
    // pairing's change cuts it as `unpaired` before this returns.
    const leave = (client: Client) => {
      try {
        devices.leave(client.device.id);
      } catch (error) {
        onProblem(`a device could not leave: ${(error as Error).message}`);
      }
      cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    };

    const attach = (ws: WebSocket, device: PairedDevice) => {
      const client: Client = {
        ws,
        device,
        welcomed: false,
        role: null,
        speaks: "",
        spelling: FIRST_SPELLING,
        appVersion: undefined,
        access: "read",
        closing: false,
        answeredPing: true,
        waitedForHello: false,
        takesWork: false,
        nameOnly: false,
        asked: new Map(),
      };
      clients.add(client);
      if (!devices.holds(device.id)) cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
      ws.on("pong", () => {
        client.answeredPing = true;
      });
      ws.on("close", () => {
        clients.delete(client);
        const waiting = [...client.asked.values()];
        client.asked.clear();
        for (const entry of waiting)
          entry.reject(
            new DeviceOutOfReachError("The connection to that computer went mid-request."),
          );
        const stillHere = [...clients].some(
          (other) => other.device.id === client.device.id && other.welcomed && other.takesWork,
        );
        if (client.welcomed && client.takesWork && !stillHere)
          tellWork({ deviceId: client.device.id, contact: "gone" });
        const stillViewing = [...clients].some(
          (other) =>
            other.device.id === client.device.id && other.welcomed && other.role === "view",
        );
        if (client.welcomed && client.role === "view" && !stillViewing)
          tellView({ deviceId: client.device.id, contact: "gone" });
        // What it said of its version holds while any connection of it does.
        if (client.welcomed && client.role === "work" && !client.nameOnly) {
          const newest = [...clients]
            .reverse()
            .find(
              (other) =>
                other.device.id === client.device.id &&
                other.welcomed &&
                other.role === "work" &&
                !other.nameOnly,
            );
          if (!newest) tellVersion(client.device.id, null);
        }
      });
      // The close that follows an error is what removes the client.
      ws.on("error", () => {});
      ws.on("message", (raw, isBinary) => {
        if (client.closing) return;
        if (!devices.holds(client.device.id)) {
          cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
          return;
        }
        let frame: ClientFrame;
        try {
          if (isBinary) throw new Error("binary");
          frame = clientFrameSchema.parse(JSON.parse(String(raw)));
        } catch {
          cut(client, CONNECTION_CLOSE.protocol, "malformed frame");
          return;
        }
        if (frame.t === "hello") {
          if (client.welcomed) cut(client, CONNECTION_CLOSE.protocol, "one hello per connection");
          else welcome(client, frame);
        } else if (!client.welcomed) cut(client, CONNECTION_CLOSE.protocol, "hello first");
        else if (frame.t === "leave") leave(client);
        else if (frame.t === "result") {
          // The answer to something the home asked; one it did not ask is ignored.
          const waiting = client.asked.get(Number(frame.id));
          if (!waiting) return;
          client.asked.delete(Number(frame.id));
          if (frame.ok) waiting.resolve(frame.value);
          else waiting.reject(new Error(frame.error));
        } else void answer(client, frame);
      });
    };

    const refuse = (socket: Duplex, status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const answerJson = (response: ServerResponse, status: number, body: unknown) => {
      response
        .writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        })
        .end(JSON.stringify(body));
    };
    // A device uses its link (docs/devices.md, "Joining"). Pairing reads the
    // body; the connection only bounds it and keeps browsers out.
    const pair = async (request: IncomingMessage, response: ServerResponse) => {
      const refuseWith = (status: number) => {
        request.resume();
        response.writeHead(status, { Connection: "close" }).end();
      };
      if (request.headers.origin !== undefined) return refuseWith(403);
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return refuseWith(405);
      }
      if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? ""))
        return refuseWith(415);
      if (Number(request.headers["content-length"] ?? 0) > PAIR_BODY_MAX_BYTES)
        return refuseWith(413);
      const text = await readBody(request);
      if (text === undefined) return void response.destroy();
      if (text === null) return refuseWith(413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      let outcome: PairOutcome;
      try {
        outcome = await devices.claim(body, request);
      } catch (error) {
        onProblem(`a device could not join: ${(error as Error).message}`);
        return answerJson(response, 500, { reason: "The home could not save the device." });
      }
      if (outcome.ok) answerJson(response, 201, outcome.grant);
      else
        answerJson(response, PAIR_REFUSAL_STATUS[outcome.refused], {
          refused: outcome.refused,
          reason: outcome.reason,
        });
    };
    // A command on another Mac gets Firstmate with its link's code
    // (docs/devices.md, "Getting Infinitary from this Mac"), and a computer
    // its home updates gets it with its own key: pairing says whether the
    // code is open, without spending it, or the key is on its list, and the
    // app goes as one gzipped tar of its bundle, made as it is sent.
    const fetchApp = async (request: IncomingMessage, response: ServerResponse) => {
      const refuseWith = (status: number) => {
        request.resume();
        response.writeHead(status, { Connection: "close" }).end();
      };
      const refused = (why: FetchAppRefusal, reason: string) =>
        answerJson(response, FETCH_APP_REFUSAL_STATUS[why], { refused: why, reason });
      if (request.headers.origin !== undefined) return refuseWith(403);
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return refuseWith(405);
      }
      if (!/^application\/json(;|$)/i.test(request.headers["content-type"] ?? ""))
        return refuseWith(415);
      if (Number(request.headers["content-length"] ?? 0) > PAIR_BODY_MAX_BYTES)
        return refuseWith(413);
      const text = await readBody(request);
      if (text === undefined) return void response.destroy();
      if (text === null) return refuseWith(413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const why = devices.opened ? devices.opened(body, request) : "unknown";
      if (why) return refused(why, FETCH_APP_REASONS[why]);
      const want = fetchAppRequestSchema.safeParse(body).data;
      // A command asks first whether its code is open, before it downloads
      // Firstmate elsewhere: nothing is sent, and the code is not spent.
      if (want?.check) return void response.writeHead(204, { Connection: "close" }).end();
      // A computer on the list, proven by its key, is heard as it is sent
      // Firstmate; a command's get names no computer yet.
      let sentTo: string | null = null;
      if (want && want.code === undefined) {
        try {
          sentTo = (await devices.admit(request))?.id ?? null;
        } catch {
          sentTo = null;
        }
      }
      // A computer that names its system gets the Firstmate for it; one that
      // names none is a Mac that asks as Macs always have, and gets this
      // home's own bundle, or nothing from a home that is not a Mac. A home
      // wired with no builds answers its own bundle to every computer.
      const bundle = options.app?.() ?? null;
      const ownBundle: FarBuild | null = bundle?.endsWith(".app")
        ? { form: "bundle", path: bundle }
        : null;
      let build: FarBuild | null = null;
      if (want?.system && options.build) {
        try {
          build = await options.build(want.system, want.chip, want.package);
        } catch (error) {
          onProblem(`could not get Infinitary for another system: ${String(error)}`);
          build = null;
        }
      } else build = ownBundle;
      if (!build) return refused("none", FETCH_APP_REASONS.none);
      if (response.destroyed) return;
      const { stream, ended, stop } = copyStream(build);
      ended.catch((error: unknown) => {
        onProblem(
          `could not send Infinitary: ${error instanceof Error ? error.message : String(error)}`,
        );
        // A copy that fails part way cuts the answer short, so the computer
        // never unpacks half an app.
        response.destroy();
      });
      response.writeHead(200, {
        "Content-Type":
          build.form === "bundle"
            ? FETCH_APP_TYPES.bundle
            : build.form === "zip"
              ? FETCH_APP_TYPES.zip
              : FETCH_APP_TYPES.appImage,
        "Cache-Control": "no-store",
        Connection: "close",
        ...(build.form === "bundle" ? {} : { [FETCH_APP_SHA256_HEADER]: build.sha256 }),
      });
      if (sentTo !== null) {
        const deviceId = sentTo;
        stream.on("data", (piece: Buffer) => tellSent(deviceId, piece.length));
      }
      stream.pipe(response);
      response.once("close", stop);
    };
    const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => {});
      // A browser always sends an Origin; no web page reaches the home.
      if (request.headers.origin !== undefined) return refuse(socket, "403 Forbidden");
      if (new URL(request.url ?? "/", "http://home").pathname !== CONNECTION_PATH)
        return refuse(socket, "404 Not Found");
      let device: PairedDevice | null;
      try {
        device = await devices.admit(request);
      } catch {
        device = null;
      }
      if (!device || run?.clients !== clients || !devices.holds(device.id))
        return refuse(socket, "401 Unauthorized");
      const admitted = device;
      sockets.handleUpgrade(request, socket, head, (ws) => attach(ws, admitted));
    };

    const servers: Server[] = [];
    const bound: string[] = [];
    let port = options.port ?? CONNECTION_PORT;
    try {
      for (const address of addresses) {
        // TLS 1.3 only, with the home's own key, on every address including
        // loopback: a device checks the key before it sends anything, and
        // shows its own, which pairing reads. No session is resumed, so
        // every connection shows both keys again.
        const server = createServer(
          {
            key: identity.key,
            cert: identity.cert,
            requestCert: true,
            rejectUnauthorized: false,
            secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
            minVersion: "TLSv1.3",
            handshakeTimeout: 10_000,
            headersTimeout: 10_000,
            requestTimeout: 10_000,
          },
          (request, response) => {
            const path = new URL(request.url ?? "/", "https://home").pathname;
            if (path === PAIR_PATH) void pair(request, response);
            else if (path === FETCH_APP_PATH) void fetchApp(request, response);
            else
              response
                .writeHead(path === CONNECTION_PATH ? 426 : 404, { Connection: "close" })
                .end();
          },
        );
        server.on("upgrade", (request, socket, head) => void upgrade(request, socket, head));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host: address, port }, () => {
            server.off("error", reject);
            resolve();
          });
        });
        servers.push(server);
        const where = server.address();
        if (where && typeof where === "object") port = where.port;
        bound.push(`${address.includes(":") ? `[${address}]` : address}:${port}`);
      }
    } catch (error) {
      for (const server of servers) server.close();
      detach();
      sockets.close();
      onProblem(`could not listen: ${(error as Error).message}`);
      return null;
    }

    const heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.answeredPing) {
          client.closing = true;
          client.ws.terminate();
        } else if (!client.welcomed && client.waitedForHello) {
          cut(client, CONNECTION_CLOSE.protocol, "hello first");
        } else {
          client.waitedForHello = true;
          client.answeredPing = false;
          client.ws.ping();
        }
      }
    }, heartbeatMs);
    heartbeat.unref();

    return { servers, chosen, addresses: bound, clients, detach, heartbeat };
  }

  function cut(client: Client, code: number, reason: string) {
    if (client.closing) return;
    client.closing = true;
    client.ws.close(code, reason);
  }

  async function stop(code: number) {
    const ending = run;
    run = null;
    if (!ending) return;
    ending.detach();
    clearInterval(ending.heartbeat);
    // Stop accepting at once. HTTP requests do not hold quit open; upgraded
    // device sockets get their own bounded close handshake below.
    for (const server of ending.servers) server.close();
    const drained = [...ending.clients].map(
      ({ ws }) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) resolve();
          else ws.once("close", () => resolve());
        }),
    );
    // Writing 1001 is not delivery: exiting now can turn an intentional
    // quit into 1006 (lost) at a busy view. All devices close concurrently;
    // a device that never replies cannot hold quit open indefinitely.
    const deadline = setTimeout(() => {
      for (const client of ending.clients) client.ws.terminate();
    }, 2_000);
    try {
      for (const client of ending.clients) cut(client, code, "closing");
      await Promise.all(drained);
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    listening: listeningNow,
    runningVersions: () => {
      const versions = new Map<string, RunningDeviceVersion>();
      for (const client of run?.clients ?? []) {
        if (!client.welcomed || client.closing || client.nameOnly || !client.role) continue;
        versions.set(JSON.stringify([client.device.id, client.role, client.appVersion ?? null]), {
          deviceId: client.device.id,
          role: client.role,
          version: client.appVersion ?? null,
        });
      }
      return [...versions.values()];
    },
    ask: (deviceId, channel, args, askOptions) => {
      const client = workClient(deviceId, askOptions?.anyVersion === true);
      if (!client) return Promise.reject(new DeviceOutOfReachError());
      const id = nextAsk++;
      let text: string;
      try {
        text = JSON.stringify({
          t: "invoke",
          id,
          channel: channelIn(channel, client.spelling),
          args,
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return new Promise((resolve, reject) => {
        client.asked.set(id, { resolve, reject });
        if (client.ws.bufferedAmount > maxBufferedBytes) {
          client.asked.delete(id);
          reject(new DeviceOutOfReachError());
          cut(client, CONNECTION_CLOSE.behind, "behind");
          return;
        }
        client.ws.send(text, (error) => {
          if (!error || !client.asked.has(id)) return;
          client.asked.delete(id);
          reject(new DeviceOutOfReachError());
        });
      });
    },
    onWorkDevice: (listener) => {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
    },
    onViewDevice: (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    onWorkVersion: (listener) => {
      versionListeners.add(listener);
      return () => versionListeners.delete(listener);
    },
    onAppSent: (listener) => {
      sentListeners.add(listener);
      return () => sentListeners.delete(listener);
    },
    onListening: (listener) => {
      listeningListeners.add(listener);
      return () => listeningListeners.delete(listener);
    },
    settled: () => tail,
    close: async () => {
      closed = true;
      unsubscribe();
      await reconcile();
    },
  };
}
