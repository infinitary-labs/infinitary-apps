import type { IncomingMessage, ServerResponse } from "node:http";
import type { BuildIdentity } from "@shared/buildIdentity";
import type { Spelling } from "@shared/codeNames";
import type { FetchAppRefusal, PairGrant, PairRefusal } from "@shared/connection";
import type { DeviceChip, DeviceKind, DeviceRole, DeviceSystem } from "@shared/devices";
import type { PhoneStandby } from "@shared/standbyPhone";
import type { FarBuild } from "../devices/farBuilds";
import type { CoreDispatch } from "../dispatcher";
import type { CoreEventBus } from "../events";
import type { PhoneCatchUp } from "./catchUpLog";
import type { LiveToViewArgs } from "./heldAsks";
import type { HomeSource } from "./homeSource";
import type { JournalLimits } from "./journal";
import type { LocalDoorRun } from "./localDoor";

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
  /** What a welcome offers: `offerTargets` and the addresses of each computer that keeps a copy. */
  welcomeTargets?(phone?: boolean): string[];
  /**
   * Which home of its record this one is (`src/core/devices/homeNumber.ts`),
   * said in every welcome so a device refuses a home left behind by a move.
   */
  homeNumber?(): number;
  /** The takeover that made this home, said in every welcome; null for a home a move made. */
  takeOver?(): string | null;
  /** Each computer that keeps a copy, with its key and where it listens, told to a phone (`standby-phone`). */
  phoneStandbys?(): PhoneStandby[];
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

/** A computer that runs work came into reach of this home, or went. */
export type WorkDeviceContact = { deviceId: string; contact: "in-reach" | "gone" };

/** A Mac that controls this Firstmate connected to this home, or its last connection went. */
export type ViewDeviceContact = { deviceId: string; contact: "in-reach" | "gone" };

/** Who the home's connection holds welcomed now, as its listeners were told (`welcomedNow`). */
export type WelcomedNow = {
  /** Each connected computer that runs work, by id, with what it last said of its version. */
  versions: [string, WorkDeviceVersion][];
  /** The computers that run work in reach now: welcomed and taking work. */
  work: string[];
  /** The Macs that control this Firstmate connected now. */
  views: string[];
};

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
  /**
   * It went back to the copy it kept, because one an update brought did not
   * reach this home, which is this home's own version, the one it sent
   * (docs/helper.md, "A copy that does not start").
   */
  failedUpdate?: true;
  /** Which build it runs, when its hello said (docs/devices.md, "Matching the home's build"). */
  build?: BuildIdentity;
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
  /** Hears each phone's catch-up once it ends; logged as one line by default (`describeCatchUp`). */
  onCatchUp?: (catchUp: PhoneCatchUp) => void;
  /**
   * The local door's folder (docs/connection.md, "The local door"): with
   * one, the connection listens on a loopback port of its own for as long
   * as it runs, paired or not, and admits a client on this computer that
   * shows the key it writes there. Absent, it listens only while something
   * is paired.
   */
  localDoor?: string;
  /**
   * The run this connection's process is, by its run record (`run.json`):
   * its process and start, written in the local door's folder so a client
   * knows which run admitted it (docs/connection.md, "The local door").
   * Absent where no command runs it.
   */
  localDoorRun?: LocalDoorRun;
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
  /**
   * The committed source this home runs, for a computer it asks to build it
   * at `FETCH_SOURCE_PATH` (docs/devices.md, "Matching the home's build"):
   * its commit and a gzipped tar of that commit's tree made as it is sent;
   * null when this home runs no source with a commit.
   */
  source?: () => HomeSource | null;
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
   * `anyVersion` - the update, download and source orders alone, whose shapes
   * never change - it reaches one that takes no work too. Refused at
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
   * What the three listeners above were told and still holds: each
   * connected computer's version, the computers in reach and the Macs that
   * control this Firstmate. One that starts listening after devices were
   * welcomed reads it once, so none is missed: the home attaches its
   * connection only once its window opened (`WorkDevices.attach`).
   */
  welcomedNow(): WelcomedNow;
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
  /**
   * The first mate is moving to another computer (docs/devices.md, "Moving
   * the first mate"): from now on work a computer asks is held unanswered
   * and a change a view asks is refused with `why`; null lets both through
   * again. A move that did not finish starts the app again instead.
   */
  hold(why: string | null): void;
  /**
   * The move finished: every welcomed device is told, as a live frame
   * (`inf:home:moved`), where the new home answers and its number.
   * Resolves once each was sent or a short wait passed; the connection ends
   * with the old home's process.
   */
  moved(payload: unknown): Promise<void>;
  /**
   * This computer is going to sleep: every welcomed device is told, as a
   * live frame (`inf:home:goodbye`), so a computer that keeps a copy says so
   * beside Take over (docs/devices.md, "Taking over"). Resolves as `moved` does.
   */
  goodbye(): Promise<void>;
  /**
   * Where this home's copies would answer changed: every welcomed device is
   * told the welcome's addresses again, as a live frame (`inf:home:routes`),
   * so one connected before a copy was kept follows a takeover there
   * (docs/devices.md, "Taking over"). Resolves as `moved` does.
   */
  routes(): Promise<void>;
  /**
   * A live frame to each welcomed window of one Mac (`role` view), such as its
   * Devices row's Fix it (`work-setup`), or only those listing `change`, or with
   * `one` only the newest; false when none is connected.
   */
  liveToView(...args: LiveToViewArgs): boolean;
  /** Resolves once listening reflects the latest change to what is paired. */
  settled(): Promise<void>;
  /** Stops listening and following pairing, then drains device closes with a two-second grace. */
  close(): Promise<void>;
};
