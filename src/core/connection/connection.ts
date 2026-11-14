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
  COMMAND_PATH,
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
  invokeArgs,
  PAIR_BODY_MAX_BYTES,
  PAIR_PATH,
  PAIR_REFUSAL_STATUS,
  type PairGrant,
  type PairRefusal,
  REPLACED_PUSH_CHANNEL,
} from "@shared/connection";
import {
  asksWhileReading,
  type ContractAccess,
  contractAccess,
  type FoldedInto16,
  hasSince16,
  readsEndedCards,
  readsSeenUpdate,
  readsSharedCards,
  takesWork,
} from "@shared/contractFeatures";
import { COMPUTER, HOME } from "@shared/deviceNames";
import {
  type DeviceChip,
  type DeviceKind,
  type DeviceRole,
  type DeviceSystem,
  deviceMayBe,
  deviceNameSchema,
} from "@shared/devices";
import { type FmEvent, isStreamedEvent } from "@shared/events";
import {
  CORE_INVOKE_CHANNELS,
  type CoreInvokeChannel,
  invokeContract,
  isViewInvokeChannel,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  VIEW_FLOOR,
} from "@shared/ipc";
import type { TaskBrowserFrame } from "@shared/taskBrowser";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserViewer } from "../browser/browserViews";
import { copyStream, type FarBuild } from "../devices/farBuilds";
import { createKeyIdentity } from "../devices/identity";
import type { CoreActor, CoreDispatch } from "../dispatcher";
import type { CoreEventBus } from "../events";
import { listenAddresses, listenOn } from "./addresses";
import { lookFor, threadLinesFor } from "./cardCompatibility";
import { CONTRACT_CHANGES } from "./contractChanges";
import { readsFrameParts } from "./frameParts";
import {
  DEFAULT_JOURNAL_LIMITS,
  EventJournal,
  type JournalEntry,
  type JournalLimits,
  type ReplayEntry,
  replacedFrame,
  replayBytes,
  replayOf,
} from "./journal";
import { type OpenLocalDoor, openLocalDoor } from "./localDoor";

/** The name on the local door's own certificate. */
const LOCAL_DOOR_NAME = "Infinitary local door";

import { Outbox } from "./outbox";
import {
  type ActionReads,
  frameWithoutUnreadActions,
  readsKeepGoing,
  readsTaskAllow,
  withoutUnreadActions,
} from "./taskAllow";

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
 * The additions major 16 folded in that a home and a view still check of
 * each other by their historical names (`hasSince16`,
 * src/shared/contractFeatures.ts): a view within its floor may be on major
 * 15, and so may the home a view on this major meets.
 */

/** One rule for every view: a home answers it every request whose reach is `views`. */
export const EVERY_VIEW_ASKS = "every-view-asks" satisfies FoldedInto16;

/** A view asks the home's computers, phones and Knowledge. */
export const DEVICES_FROM_A_VIEW = "devices-from-a-view" satisfies FoldedInto16;

/**
 * Any view asks every request of a task's browser, and the home sends its
 * pictures as `live` frames.
 */
export const BROWSER_FROM_ANY_VIEW = "browser-from-any-view" satisfies FoldedInto16;

/** A view draws the captain's panels from the home's own files. */
export const PANELS_IN_EVERY_WINDOW = "panels-in-every-window" satisfies FoldedInto16;

/**
 * Streamed reply pieces and tool starts and ends go to a view as `live`
 * frames, outside the numbering, and to a phone not at all.
 */
export const STREAMED_EVENTS_LIVE = "streamed-events-live" satisfies FoldedInto16;

/**
 * The computers' live processor and memory readings go to a view as `live`
 * frames, outside the numbering, and to a phone not at all.
 */
export const COMPUTER_READINGS_LIVE = "computer-readings-live" satisfies FoldedInto16;

/** What a view's hello says of what it reads: its contract, its system and the changes it lists. */
type ViewHello = { protocolVersion: string; system?: string; changes?: readonly string[] };

/**
 * Whether a view has an addition major 16 folded in. A computer that speaks
 * that major has every one, and an older one within the floor has what its
 * hello lists by name. A phone has only what its hello lists, whatever it
 * speaks, because it lists what it draws.
 */
function viewHas(hello: ViewHello, name: FoldedInto16): boolean {
  return hello.system === "ios"
    ? (hello.changes?.includes(name) ?? false)
    : hasSince16(hello.protocolVersion, hello.changes, name);
}

/** The push the computers' readings ride (`COMPUTER_READINGS_LIVE`). */
const READINGS_CHANNEL = "inf:computers:resources";

/**
 * How a view is sent a push that stays outside the numbering: as a `live`
 * frame, under the newest number for a view from before its change, or not at
 * all, as a phone, which never reads it.
 */
type Unnumbered = "live" | "numbered" | "none";

function unnumberedFor(hello: ViewHello, name: FoldedInto16): Unnumbered {
  if (hello.system === "ios") return "none";
  return viewHas(hello, name) ? "live" : "numbered";
}

/**
 * Who a client the local door admitted is (docs/connection.md, "The local
 * door"): no device on the list, never told to pairing, always a view.
 */
export const LOCAL_CLIENT = "local";
const LOCAL_DEVICE: PairedDevice = { id: LOCAL_CLIENT, kind: "view" };

/**
 * What a connection in each role may ask (docs/devices.md): a view the
 * channels whose reach is `views`, as the captain at another Mac, naming the
 * device so a phone's own usage events go under its own ID; a computer's work
 * the channels whose reach is `work`, as itself, about a conversation it
 * holds for this home (src/shared/work.ts).
 */
function askerOf(
  device: PairedDevice,
  role: DeviceRole,
  channel: CoreInvokeChannel,
  changes: readonly string[] | undefined,
  version: string,
): CoreActor | null {
  // A client of the local door asks as the window on this computer always
  // has: everything but the work requests, as the captain himself.
  if (role === "view" && device === LOCAL_DEVICE)
    return isWorkInvokeChannel(channel) ? null : { kind: "captain" };
  if (role === "view")
    return isViewInvokeChannel(channel)
      ? {
          kind: "captain",
          view: device.id,
          viewVersion: version,
          ...(changes ? { viewChanges: changes } : {}),
        }
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
   * The oldest major a view may change things from on this home. Defaults to
   * VIEW_FLOOR; a test stands in a later home's with it.
   */
  viewFloor?: number;
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
  /**
   * A connected device that answers no ping in this long is cut. Every piece
   * the home writes is followed by a ping, so a device still receiving a
   * long catch-up answers within it however slow its link (docs/connection.md,
   * "Pacing and liveness").
   */
  heartbeatMs?: number;
  /**
   * The smallest piece the home writes a frame in, and the least it sends
   * ahead of a device's answer. Defaults to 4 KiB: at 1 KB/s a ping or pong
   * then waits behind about 8 s of data, inside the 10 s a Mac's link and
   * the phone's ping give an answer.
   */
  pieceBytes?: number;
  /**
   * On a faster link, how much of the rate a device's answers measure the
   * home sends ahead of its answer. Defaults to two seconds' worth.
   */
  aheadMs?: number;
  /** A device with more than this waiting to be sent is cut, and catches up when it returns. */
  maxBufferedBytes?: number;
  /** Where the connection says it could not listen. */
  onProblem?: (text: string) => void;
  /**
   * The local door's folder (docs/connection.md, "The local door"): with
   * one, the connection listens on a loopback port of its own for as long
   * as it runs, paired or not, and admits a client on this computer that
   * shows the key it writes there. Absent, it listens only while something
   * is paired.
   */
  localDoor?: string;
  /**
   * The captain's own command at the local door (docs/axi-commands.md,
   * "Infinitary from your terminal"): a POST on `COMMAND_PATH` carrying the
   * door's key goes to it, answered as the command prints it. Absent, that
   * path is 404 as any other.
   */
  command?: (request: IncomingMessage, response: ServerResponse) => void;
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
  /** Where it listens now, as address:port; empty while nothing is paired. The local door is not among them. */
  listening(): string[];
  /** Where the local door listens now, as `127.0.0.1:port`, or null while it is not open. */
  localDoor(): string | null;
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
  /** Admitted by the local door's key, not by pairing: it outlives no pairing and is never one. */
  readonly local: boolean;
  welcomed: boolean;
  /** What this connection does, from its hello: null until it is welcomed. */
  role: DeviceRole | null;
  /** The contract version its hello spoke, and what the version rule lets it ask. */
  speaks: string;
  /** The spelling of channel names it is written in: its own, when its hello said it reads that one. */
  spelling: Spelling;
  /** The version of Firstmate its hello said it runs, when it said one. */
  appVersion: string | undefined;
  /** The contract changes its hello listed, when it listed any. */
  changes: readonly string[] | undefined;
  /** The look's later choices it does not read (`unreadLook`): every one, until its hello. */
  unreadLook: readonly string[];
  /** Older desktop card decoders are strict; only capable desktops receive the added fields. */
  cardReads: CardReads;
  /** Whether it reads a thread line's contributor fields (`SHARED_CARDS_SINCE`). */
  sharedCards: boolean;
  /** Which card buttons it reads: Allow for the rest of this task, Keep going on credits. */
  actionReads: ActionReads;
  /**
   * How it is sent streamed reply pieces and tool starts and ends
   * (`STREAMED_EVENTS_LIVE`): as `live` frames, under the newest number
   * for a view from before the change, or not at all, as a phone.
   */
  streamed: Unnumbered;
  /** How it is sent the computers' readings (`COMPUTER_READINGS_LIVE`), as `streamed` is. */
  readings: Unnumbered;
  access: ContractAccess;
  closing: boolean;
  /** What the home writes to it, paced by its answers. */
  readonly out: Outbox;
  /** It answered a ping since the last heartbeat: a piece's or the heartbeat's own. */
  answeredPing: boolean;
  waitedForHello: boolean;
  /** For a computer that runs work: its welcome said it takes work, so the home may ask it. */
  takesWork: boolean;
  /**
   * A computer's join, dialing once only to hear the home's name: welcomed,
   * and nothing of it is that computer in reach, its version, or work.
   */
  nameOnly: boolean;
  /**
   * As a view, the one that watches a task's browser through it, made at its
   * first request: its pictures go out as `live` frames to it alone.
   */
  viewer?: BrowserViewer;
  /** Who hears it go: each watch it holds, ended when it closes. */
  gone: (() => void)[];
  /**
   * Per task it watches, whether a picture is still being written to it, and
   * the newest one that came meanwhile: only the newest goes next.
   */
  readonly pictures: Map<string, { next?: TaskBrowserFrame }>;
  /** What the home asked it and waits for, by request id. */
  readonly asked: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
};

type Run = {
  /** The listeners devices dial, while anything is paired. */
  servers: Server[];
  /** The addresses it was asked to listen on, as asked; empty while nothing is paired. */
  chosen: string;
  addresses: string[];
  /** The local door's own listener and its key, for as long as the run lasts. */
  readonly local: { readonly server: Server; readonly door: OpenLocalDoor } | null;
  /** Listens on these addresses for devices, in place of those it listened on. */
  readonly listen: (listed: { key: string; addresses: string[] }) => Promise<void>;
  readonly clients: Set<Client>;
  readonly detach: () => void;
  readonly heartbeat: NodeJS.Timeout;
};

const CORE_CHANNELS = new Set<string>(CORE_INVOKE_CHANNELS);

/**
 * What a view reads first on a reload (docs/connection.md, "Catching up"):
 * the card list, Activity, the whole board, the last reply, the conversation's
 * state and the computers in reach. A computer's window reads more besides.
 */
const RELOAD_READS = [
  "inf:cards:list",
  "inf:feed:recent",
  "inf:tasks:board",
  "inf:conversation:last-turn",
  "inf:conversation:state",
  "inf:computers:presence",
] as const satisfies CoreInvokeChannel[];
const RELOAD_READ_SET: ReadonlySet<string> = new Set(RELOAD_READS);

/** The read of a reload whose answer a whole list's push is, as it would be read now. */
const WHOLE_LIST_READS: Partial<Record<string, (typeof RELOAD_READS)[number]>> = {
  "inf:cards": "inf:cards:list",
  "inf:tasks": "inf:tasks:board",
};

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

/** The look's later choices a view does not have, which it cannot read (`lookFor`). */
function unreadLook(hello: ViewHello): string[] {
  return [
    ...(viewHas(hello, "language-choice") ? [] : ["language"]),
    ...(viewHas(hello, "font-choice") ? [] : ["fonts"]),
  ];
}

/** Which added card fields a view's card decoder reads. */
type CardReads = {
  updates: boolean;
  ended: boolean;
  annotations: boolean;
  files: boolean;
  through: boolean;
};

/**
 * Keep old desktop strict card decoders working: a snapshot leaves out each
 * added field the view does not read. Phones already ignore optional JSON fields.
 */
function legacyCardSnapshot(value: unknown, reads: CardReads): unknown {
  if (!Array.isArray(value) || (reads.updates && reads.ended && reads.files)) return value;
  return value.map(({ currentUpdateId, currentUpdateSeen, ended, files, ...card }) => ({
    ...card,
    ...(reads.updates ? { currentUpdateId, currentUpdateSeen } : {}),
    ...(reads.ended ? { ended } : {}),
    ...(reads.files && files ? { files } : {}),
  }));
}

/**
 * Every channel a view may ask, or hears, whose answer carries card lines:
 * an older desktop reads each line strictly, so it gets them without who
 * wrote them.
 */
const THREAD_CHANNELS = new Set([
  "inf:cards:show",
  "inf:cards:thread",
  "inf:cards:past",
  "inf:cards:show-past",
  "inf:cards:reply",
]);

function cardPushFor(
  entry: JournalEntry,
  spelling: Spelling,
  reads: CardReads,
  sharedCards = true,
  actionReads: ActionReads = { taskAllow: true, keepGoing: true },
  unread: readonly string[] = [],
): string {
  const spelled = lookPushFor(entry, spelling, unread);
  const text = entry.channel.startsWith("inf:cards")
    ? frameWithoutUnreadActions(spelled, actionReads)
    : spelled;
  if (
    (!sharedCards || !reads.annotations || !reads.through) &&
    THREAD_CHANNELS.has(entry.channel)
  ) {
    const frame = JSON.parse(text);
    return JSON.stringify({
      ...frame,
      payload: threadLinesFor(frame.payload, {
        sharing: sharedCards,
        annotations: reads.annotations,
        through: reads.through,
      }),
    });
  }
  if ((reads.updates && reads.ended && reads.files) || entry.channel !== "inf:cards") return text;
  const frame = JSON.parse(text);
  return JSON.stringify({ ...frame, payload: legacyCardSnapshot(frame.payload, reads) });
}

/** A look pushed to a view, without the choices it cannot read (`lookFor`). */
function lookPushFor(entry: JournalEntry, spelling: Spelling, unread: readonly string[]): string {
  const spelled = pushFrameIn(entry, spelling);
  if (unread.length === 0 || entry.channel !== "inf:shell:preferences") return spelled;
  const frame = JSON.parse(spelled);
  return JSON.stringify({ ...frame, payload: lookFor(entry.channel, frame.payload, unread) });
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
  const pacing = { pieceBytes: options.pieceBytes ?? 4 * 1024, aheadMs: options.aheadMs ?? 2_000 };
  const onProblem = options.onProblem ?? ((text) => console.warn(`[connection] ${text}`));
  const homeVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const viewFloor = options.viewFloor ?? VIEW_FLOOR;
  const homeChanges = options.changes ?? CONTRACT_CHANGES.names;
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

  const local = options.localDoor;
  const follow = async () => {
    const paired = !closed && devices.any();
    // The local door keeps a run going while nothing is paired.
    if (closed || (!paired && !local)) {
      await stop(closed ? CONNECTION_CLOSE.closing : CONNECTION_CLOSE.unpaired);
      return;
    }
    let listed: { key: string; addresses: string[] } = { key: "", addresses: [] };
    if (paired) {
      try {
        listed = listenList();
      } catch (refusal) {
        onProblem(`not listening: ${(refusal as Error).message}`);
        if (!local) {
          if (run) await stop(CONNECTION_CLOSE.closing);
          return;
        }
      }
    }
    if (run && run.chosen !== listed.key) {
      // A new set of addresses is a new listening run: devices come back and
      // reload. With the local door, only the devices' listeners change.
      if (local) await run.listen(listed);
      else await stop(CONNECTION_CLOSE.closing);
    }
    if (!run) run = await start(listed);
    for (const client of run?.clients ?? [])
      if (!client.local && !devices.holds(client.device.id))
        cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
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
      if (!client.local && !devices.holds(client.device.id))
        cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    void reconcile();
  });
  void reconcile();

  async function start(listed: { key: string; addresses: string[] }): Promise<Run | null> {
    // The home's own key, read only once devices are listened for: pairing
    // writes nothing, not even that key, until the first link
    // (docs/devices.md). Without the local door it is read at once, as before.
    let homeIdentity: { key: string; cert: string } | null = null;
    const ownIdentity = () => {
      homeIdentity ??= devices.identity();
      return homeIdentity;
    };
    if (!local)
      try {
        ownIdentity();
      } catch (refusal) {
        onProblem(`not listening: ${(refusal as Error).message}`);
        return null;
      }
    let journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
    // The bytes of the newest answer to each read a view's reload makes first.
    const reloadWeights = new Map<string, number>();
    const clients = new Set<Client>();
    const sockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: CONNECTION_MAX_FRAME_BYTES,
    });
    const send = (client: Client, frame: string) => {
      if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
      if (behind(client)) {
        cut(client, CONNECTION_CLOSE.behind, "behind");
        return;
      }
      client.out.send(frame);
    };
    // What is happening in a turn now (`isStreamedEvent`), and the
    // computers' readings: outside the numbering, so a stream of them never
    // pushes a dropped view's place out of the journal, and only to the views
    // that read them.
    const sendUnnumbered = (
      channel: string,
      payload: unknown,
      how: (client: Client) => Unnumbered,
    ) => {
      for (const client of clients) {
        if (!client.welcomed || client.role !== "view") continue;
        const mode = how(client);
        if (mode === "none") continue;
        const spelled = channelIn(channel, client.spelling);
        if (mode === "live") {
          send(client, JSON.stringify({ t: "live", channel: spelled, payload }));
          continue;
        }
        // A view from before the change reads only numbered pushes: the newest
        // number again moves its cursor nowhere, so a replay still has no hole.
        if (journal.seq > 0)
          send(client, JSON.stringify({ t: "push", seq: journal.seq, channel: spelled, payload }));
      }
    };
    // Never throws into the core's emit. A push that cannot be written would
    // leave every device with a hole it cannot see, so they all start over.
    const detach = events.subscribe((channel, payload) => {
      const unnumbered =
        channel === "inf:event" && isStreamedEvent(payload as FmEvent)
          ? (client: Client) => client.streamed
          : channel === READINGS_CHANNEL
            ? (client: Client) => client.readings
            : null;
      if (unnumbered) {
        try {
          sendUnnumbered(channel, payload, unnumbered);
        } catch (error) {
          onProblem(`could not send ${channel}: ${(error as Error).message}`);
        }
        return;
      }
      try {
        // Kept for catch-up only while something is paired: with nothing
        // paired only the local door's clients, on this computer, dial, and
        // one that dropped reads everything again (docs/connection.md).
        const entry = journal.record(
          (seq) => JSON.stringify({ t: "push", seq, channel, payload }),
          channel,
          devices.any(),
        );
        // A whole list pushed is what a reload would read of it now.
        const read = WHOLE_LIST_READS[channel];
        if (read) reloadWeights.set(read, Buffer.byteLength(entry.frame));
        for (const client of clients)
          if (client.welcomed && client.role === "view")
            send(
              client,
              cardPushFor(
                entry,
                client.spelling,
                client.cardReads,
                client.sharedCards,
                client.actionReads,
                client.unreadLook,
              ),
            );
      } catch (error) {
        onProblem(`could not send ${channel}: ${(error as Error).message}`);
        journal = new EventJournal(options.journal ?? DEFAULT_JOURNAL_LIMITS);
        for (const client of clients) cut(client, CONNECTION_CLOSE.behind, "behind");
      }
    });

    // A picture of a page a view watches (docs/connection.md, "Live
    // pushes"): to that connection alone, unnumbered and never kept. While
    // one is still being written, only the newest that comes meanwhile
    // follows, so a slow link shows the page as it is now, never a queue.
    const showLive = (client: Client, frame: TaskBrowserFrame) => {
      const writing = client.pictures.get(frame.taskId);
      if (writing) {
        writing.next = frame;
        return;
      }
      if (client.closing || client.ws.readyState !== WebSocket.OPEN) return;
      if (behind(client)) {
        cut(client, CONNECTION_CLOSE.behind, "behind");
        return;
      }
      const slot: { next?: TaskBrowserFrame } = {};
      client.pictures.set(frame.taskId, slot);
      const text = JSON.stringify({
        t: "live",
        channel: channelIn("inf:browser:frame", client.spelling),
        payload: frame,
      });
      client.out.send(text, () => {
        if (client.pictures.get(frame.taskId) !== slot) return;
        client.pictures.delete(frame.taskId);
        if (slot.next) showLive(client, slot.next);
      });
    };
    const viewerOf = (client: Client): BrowserViewer => {
      client.viewer ??= {
        show: (frame) => showLive(client, frame),
        onGone: (listener) => client.gone.push(listener),
      };
      return client.viewer;
    };

    /** What a connection's hello says it does: what it says, or what its kind does. */
    const roleOf = (client: Client, hello: Extract<ClientFrame, { t: "hello" }>): DeviceRole =>
      // A Mac that does both runs its work unless it says it controls.
      hello.as ?? (client.device.kind === "view" ? "view" : "work");

    /**
     * What a view's replay would send, or null when its cursor cannot be
     * caught up: only a view is sent pushes, so only a view catches up on them.
     */
    const replayFor = (
      role: DeviceRole,
      hello: Extract<ClientFrame, { t: "hello" }>,
    ): ReplayEntry[] | null => {
      const missed = hello.cursor && role === "view" ? journal.since(hello.cursor) : null;
      return missed ? replayOf(missed) : null;
    };

    /**
     * What a view's reload would read first, weighed from the newest answer
     * to each this home wrote in this run, or the newest whole list it pushed
     * since; undefined while any of them has not been written, and a view
     * then replays (docs/connection.md, "Catching up").
     */
    const reloadBytes = (): number | undefined => {
      let total = 0;
      for (const channel of RELOAD_READS) {
        const bytes = reloadWeights.get(channel);
        if (bytes === undefined) return undefined;
        total += bytes;
      }
      return total;
    };

    const welcome = (client: Client, hello: Extract<ClientFrame, { t: "hello" }>) => {
      const role = roleOf(client, hello);
      if (!deviceMayBe(client.device.kind, role)) {
        cut(client, CONNECTION_CLOSE.protocol, `a ${client.device.kind} device is never a ${role}`);
        return;
      }
      client.role = role;
      // A replay that would weigh more than what a reload reads first reloads instead.
      const replay = replayFor(role, hello);
      const reload = replay ? reloadBytes() : undefined;
      const missed =
        replay && (reload === undefined || replayBytes(replay) <= reload) ? replay : null;
      client.speaks = hello.protocolVersion;
      client.spelling = spellingFor(readSpellings(hello.spellings), speaks);
      client.appVersion = hello.appVersion;
      client.changes = hello.changes;
      client.unreadLook = unreadLook(hello);
      client.cardReads = {
        updates: hello.system === "ios" || readsSeenUpdate(hello.protocolVersion, hello.changes),
        ended: hello.system === "ios" || readsEndedCards(hello.protocolVersion, hello.changes),
        // A view that has typed notes draws them, a phone that lists them included; one without reads plain lines.
        annotations: viewHas(hello, "card-annotations"),
        // An older desktop reads a card strictly; a phone ignores the field and draws no Save.
        files: hello.system === "ios" || viewHas(hello, "card-files"),
        // A view without the command's mark, the phone included, gets the line without it.
        through: viewHas(hello, "from-the-command"),
      };
      client.sharedCards =
        hello.system === "ios" || readsSharedCards(hello.protocolVersion, hello.changes);
      client.actionReads = {
        taskAllow: readsTaskAllow(hello.protocolVersion, hello.changes),
        keepGoing: readsKeepGoing(hello.protocolVersion, hello.changes, hello.system),
      };
      client.streamed = unnumberedFor(hello, STREAMED_EVENTS_LIVE);
      client.readings = unnumberedFor(hello, COMPUTER_READINGS_LIVE);
      // From the welcome on, a long frame goes as parts to a device that reads them.
      client.out.parts = readsFrameParts(hello.protocolVersion, hello.changes);
      // A view changes things across majors its floor allows; work only on this home's own.
      // A computer viewing from before the floor (its hello says none) reads closed lists
      // strictly, so like work it changes things only on this home's major (INF-1649 review
      // R4, the captain's "Keep version-11 views read-only"); a phone reads them as text.
      const floored = role === "view" && (hello.viewFloor !== undefined || hello.system === "ios");
      // A local client is this computer's own build at this computer's own
      // home (docs/connection.md, "The local door"): it changes things,
      // whatever version either says.
      client.access = client.local
        ? "full"
        : contractAccess(
            hello.protocolVersion,
            homeVersion,
            floored ? { clientFloor: hello.viewFloor, homeFloor: viewFloor } : undefined,
          );
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
          // A view from before one rule for every view still waits to hear this
          // before it asks the wider set.
          ...(role === "view" && !viewHas(hello, EVERY_VIEW_ASKS)
            ? { startedByCommand: true }
            : {}),
          spellings: SPELLINGS,
          ...(homeChanges.length ? { changes: homeChanges } : {}),
        }),
      );
      for (const { entry, replaced } of missed ?? [])
        send(
          client,
          replaced
            ? replacedFrame(entry.seq, channelIn(REPLACED_PUSH_CHANNEL, client.spelling))
            : cardPushFor(
                entry,
                client.spelling,
                client.cardReads,
                client.sharedCards,
                client.actionReads,
                client.unreadLook,
              ),
        );
      client.welcomed = true;
      // A client of the local door is no device: pairing hears nothing of it.
      if (client.local) return;
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
        if (outcome.ok && RELOAD_READ_SET.has(frame.channel))
          reloadWeights.set(frame.channel, Buffer.byteLength(text));
        send(client, text);
      };
      if (!CORE_CHANNELS.has(frame.channel)) {
        reply({ ok: false, error: `${frame.channel} is not a request this home answers.` });
        return;
      }
      const channel = frame.channel as CoreInvokeChannel;
      const actor = client.role
        ? askerOf(client.device, client.role, channel, client.changes, client.speaks)
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
      // reads, and changes nothing until it is updated, but a paired view
      // still says plain words to the first mate (`READ_ONLY_ASKS`).
      if (
        client.access === "read" &&
        invokeContract[channel].effect === "change" &&
        !(client.role === "view" && asksWhileReading(channel, frame.args))
      ) {
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
        const answered = await dispatch(
          channel,
          frame.args,
          actor,
          client.role === "view" ? viewerOf(client) : undefined,
        );
        const value = lookFor(
          channel,
          channel.startsWith("inf:cards")
            ? withoutUnreadActions(answered, client.actionReads)
            : answered,
          client.unreadLook,
        );
        reply({
          ok: true,
          value:
            channel === "inf:cards:list"
              ? legacyCardSnapshot(value, client.cardReads)
              : THREAD_CHANNELS.has(channel) &&
                  (!client.sharedCards ||
                    !client.cardReads.annotations ||
                    !client.cardReads.through)
                ? threadLinesFor(value, {
                    sharing: client.sharedCards,
                    annotations: client.cardReads.annotations,
                    through: client.cardReads.through,
                  })
                : value,
        });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    // Leave (docs/devices.md): the device asks to come off the list, and
    // pairing's change cuts it as `unpaired` before this returns.
    const leave = (client: Client) => {
      // A client of the local door is on no list, so it has nothing to leave.
      if (client.local) {
        cut(client, CONNECTION_CLOSE.protocol, "nothing to leave");
        return;
      }
      try {
        devices.leave(client.device.id);
      } catch (error) {
        onProblem(`a device could not leave: ${(error as Error).message}`);
      }
      cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
    };

    const attach = (ws: WebSocket, device: PairedDevice, viaDoor: boolean) => {
      const client: Client = {
        ws,
        device,
        local: viaDoor,
        welcomed: false,
        role: null,
        speaks: "",
        spelling: FIRST_SPELLING,
        appVersion: undefined,
        changes: undefined,
        unreadLook: unreadLook({ protocolVersion: "" }),
        cardReads: {
          updates: false,
          ended: false,
          annotations: false,
          files: false,
          through: false,
        },
        sharedCards: false,
        actionReads: { taskAllow: false, keepGoing: false },
        streamed: "none",
        readings: "none",
        access: "read",
        closing: false,
        out: new Outbox(ws, pacing),
        answeredPing: true,
        waitedForHello: false,
        takesWork: false,
        nameOnly: false,
        gone: [],
        pictures: new Map(),
        asked: new Map(),
      };
      clients.add(client);
      if (!viaDoor && !devices.holds(device.id)) cut(client, CONNECTION_CLOSE.unpaired, "unpaired");
      ws.on("pong", () => {
        client.answeredPing = true;
      });
      ws.on("close", () => {
        clients.delete(client);
        const heard = client.gone;
        client.gone = [];
        client.pictures.clear();
        for (const listener of heard) {
          try {
            listener();
          } catch (error) {
            onProblem(`a watch could not end: ${(error as Error).message}`);
          }
        }
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
            other.device.id === client.device.id &&
            !other.local &&
            other.welcomed &&
            other.role === "view",
        );
        if (client.welcomed && client.role === "view" && !client.local && !stillViewing)
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
        if (!client.local && !devices.holds(client.device.id)) {
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
    // A device's upgrade proves it by pairing; one on the local door's own
    // listener by the door's key alone, and nothing else is answered there.
    const upgrade = async (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      door: { open: OpenLocalDoor | null } | null,
    ) => {
      socket.on("error", () => {});
      // A browser always sends an Origin; no web page reaches the home.
      if (request.headers.origin !== undefined) return refuse(socket, "403 Forbidden");
      if (new URL(request.url ?? "/", "http://home").pathname !== CONNECTION_PATH)
        return refuse(socket, "404 Not Found");
      if (door) {
        // The door's own listener admits by its key alone, never by pairing.
        if (!door.open?.admits(request) || run?.clients !== clients)
          return refuse(socket, "401 Unauthorized");
        sockets.handleUpgrade(request, socket, head, (ws) => attach(ws, LOCAL_DEVICE, true));
        return;
      }
      let device: PairedDevice | null;
      try {
        device = await devices.admit(request);
      } catch {
        device = null;
      }
      if (!device || run?.clients !== clients || !devices.holds(device.id))
        return refuse(socket, "401 Unauthorized");
      const admitted = device;
      sockets.handleUpgrade(request, socket, head, (ws) => attach(ws, admitted, false));
    };

    // The captain's own command on the door's listener: by the door's key
    // alone, as an upgrade is, and never from a web page.
    const command = (
      request: IncomingMessage,
      response: ServerResponse,
      door: { open: OpenLocalDoor | null },
    ) => {
      const refuse = (status: number, words: string) => {
        request.resume();
        response
          .writeHead(status, { "content-type": "text/plain; charset=utf-8", Connection: "close" })
          .end(`1\nerror: ${words}\ncode: NO_CHANNEL\n`);
      };
      if (request.headers.origin !== undefined)
        return refuse(403, "No web page reaches this door.");
      if (request.method !== "POST") return refuse(405, "The command posts its request.");
      if (!door.open?.admits(request) || !run)
        return refuse(
          401,
          "This key opens nothing now: Infinitary started again since it was read.",
        );
      options.command?.(request, response);
    };

    // TLS 1.3 only, with the key it is given - the home's own for devices,
    // the door's own for the local door - on every address including
    // loopback: a device checks the key before it sends anything, and
    // shows its own, which pairing reads. No session is resumed, so every
    // connection shows both keys again.
    const tlsWith = (identity: { key: string; cert: string }) => ({
      key: identity.key,
      cert: identity.cert,
      requestCert: true,
      rejectUnauthorized: false,
      secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
      minVersion: "TLSv1.3" as const,
      handshakeTimeout: 10_000,
      headersTimeout: 10_000,
      requestTimeout: 10_000,
    });
    const bind = async (
      host: string,
      at: number,
      door: { open: OpenLocalDoor | null } | null,
      identity: { key: string; cert: string },
    ): Promise<{ server: Server; port: number }> => {
      const server = createServer(tlsWith(identity), (request, response) => {
        const path = new URL(request.url ?? "/", "https://home").pathname;
        if (door && path === COMMAND_PATH && options.command) command(request, response, door);
        else if (!door && path === PAIR_PATH) void pair(request, response);
        else if (!door && path === FETCH_APP_PATH) void fetchApp(request, response);
        else
          response.writeHead(path === CONNECTION_PATH ? 426 : 404, { Connection: "close" }).end();
      });
      server.on("upgrade", (request, socket, head) => void upgrade(request, socket, head, door));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: at }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const where = server.address();
      return { server, port: where && typeof where === "object" ? where.port : at };
    };

    // The local door: a loopback port the system chooses, so two accounts
    // on one computer each open their own, and its three files.
    let localPart: Run["local"] = null;
    if (local) {
      const held: { open: OpenLocalDoor | null } = { open: null };
      let server: Server | null = null;
      try {
        // A key of its own, kept only in memory and new each run: its pin
        // is in the door's folder, and the home's key stays unwritten until
        // the first link.
        const doorIdentity = createKeyIdentity(LOCAL_DOOR_NAME);
        const bound = await bind("127.0.0.1", 0, held, doorIdentity);
        server = bound.server;
        held.open = openLocalDoor(local, `127.0.0.1:${bound.port}`, doorIdentity.cert);
        localPart = { server, door: held.open };
      } catch (error) {
        server?.close();
        onProblem(`could not open the local door: ${(error as Error).message}`);
      }
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
          client.out.mark();
        }
      }
    }, heartbeatMs);
    heartbeat.unref();

    const started: Run = {
      servers: [],
      chosen: "",
      addresses: [],
      local: localPart,
      clients,
      detach,
      heartbeat,
      listen: async (want) => {
        const was = started.servers;
        started.servers = [];
        started.addresses = [];
        started.chosen = want.key;
        for (const server of was) server.close();
        // A device listened for elsewhere comes back where it is listened for now.
        if (was.length)
          for (const client of clients)
            if (!client.local) cut(client, CONNECTION_CLOSE.closing, "closing");
        const servers: Server[] = [];
        const bound: string[] = [];
        let port = options.port ?? CONNECTION_PORT;
        try {
          for (const address of want.addresses) {
            const made = await bind(address, port, null, ownIdentity());
            servers.push(made.server);
            port = made.port;
            bound.push(`${address.includes(":") ? `[${address}]` : address}:${port}`);
          }
        } catch (error) {
          for (const server of servers) server.close();
          // Tried again at the next change to what is paired.
          started.chosen = "";
          onProblem(`could not listen: ${(error as Error).message}`);
          return;
        }
        started.servers = servers;
        started.addresses = bound;
      },
    };
    await started.listen(listed);
    // Without the local door, a run that could not listen for devices is none.
    if (!localPart && started.servers.length === 0) {
      clearInterval(heartbeat);
      detach();
      sockets.close();
      return null;
    }
    return started;
  }

  /** More than `maxBufferedBytes` waits to reach it, here and in the socket. */
  function behind(client: Client): boolean {
    return client.ws.bufferedAmount + client.out.waiting > maxBufferedBytes;
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
    ending.local?.server.close();
    ending.local?.door.close();
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
    localDoor: () => run?.local?.door.address ?? null,
    runningVersions: () => {
      const versions = new Map<string, RunningDeviceVersion>();
      for (const client of run?.clients ?? []) {
        if (!client.welcomed || client.closing || client.nameOnly || !client.role || client.local)
          continue;
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
          args: invokeArgs(args),
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return new Promise((resolve, reject) => {
        client.asked.set(id, { resolve, reject });
        if (behind(client)) {
          client.asked.delete(id);
          reject(new DeviceOutOfReachError());
          cut(client, CONNECTION_CLOSE.behind, "behind");
          return;
        }
        client.out.send(text, (error) => {
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
