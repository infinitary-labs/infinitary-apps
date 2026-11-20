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
  CONNECTION_CLOSE,
  type ConnectionCursor,
  type HomeFrame,
  homeFrameSchema,
  invokeArgs,
  REPLACED_PUSH_CHANNEL,
} from "@shared/connection";
import type { ContractAccess } from "@shared/contractFeatures";
import { COMPUTER } from "@shared/deviceNames";
import {
  type DeviceChip,
  type DeviceGrant,
  type DeviceRole,
  type DeviceSystem,
  grantRoutes,
  linkAddresses,
  PAIRING_LINK_ALSO_MAX,
} from "@shared/devices";
import { HOME_MOVED_LIVE, type HomeMoved, homeMovedSchema } from "@shared/homeMove";
import { type CoreInvokeChannel, invokeContract, PROTOCOL_VERSION, VIEW_FLOOR } from "@shared/ipc";
import {
  HOME_ROUTES_LIVE,
  homeRoutesSchema,
  type OtherHome,
  STANDBY_TAKE_OVER_CHANGE,
} from "@shared/standby";
import type { WebSocket } from "ws";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { FramePartsReader } from "../connection/frameParts";
import { thisDeviceSystem } from "../platform";
import { dialHome } from "./dial";
import { FIRST_HOME_NUMBER, type HeardTakeOver } from "./homeNumber";

/** A window tells each of two homes with one number of the other (`tellTwoHomes`). */
const STANDBY_OTHER_HOME = "inf:standby:other-home";

/**
 * A device's side of the connection (docs/connection.md, docs/view.md): it
 * dials the home with its grant, says hello with the cursor it holds, asks
 * the home's requests and hands on its pushes, and keeps dialing while the
 * home is out of reach. Written against the wire alone, so the app as a
 * view and the helper share it, and so do the tests.
 *
 * It never queues or resends a change. A request asked while the home is out
 * of reach is refused at once; one in flight when the connection drops is
 * refused and not asked again, whether or not the home had done it. Only a
 * read asked while the device is still reaching the home - at its start, or
 * in the one attempt right after a drop - waits for that attempt.
 *
 * A computer that runs work is the one exception, for its work requests
 * alone (`ask`, src/shared/work.ts): each carries an id the home keeps its
 * answer under, so it waits while the home is out of reach and is asked
 * again on every new connection until the home answers or its caller
 * withdraws it. It also answers what the home asks it (`onInvoke`).
 */

/**
 * Whether the device hears the home: `reaching` before it has heard anything
 * since it started, `in-reach` while it does, `lost` once contact is gone,
 * and `closed` when the home said it was quitting.
 */
export type HomeContact = "reaching" | "in-reach" | "lost" | "closed";

/** The connection a link has open: its welcome's number, and when its dial began (`HomeLink.connection`). */
export type HomeLinkConnection = { welcome: number; dialedAt: number };

export type HomeLinkState = {
  readonly contact: HomeContact;
  /** What the version rule lets this device ask, from the newest welcome. */
  readonly access: ContractAccess | null;
  /** The contract version the home speaks, from the newest welcome. */
  readonly homeVersion: string | null;
  /**
   * The contract changes the home listed by name in the newest welcome
   * (`changes`, src/core/connection/contractChanges.ts): none when it listed
   * nothing, and null before any welcome.
   */
  readonly homeChanges: readonly string[] | null;
  /** The home's own name, from the newest welcome that carried one. */
  readonly name: string | null;
  /**
   * For a computer that runs work: whether the home lets its version take
   * new work, from the newest welcome (docs/helper.md). Null for a view.
   */
  readonly takesWork: boolean | null;
  /**
   * For a computer that runs work: whether the home says it runs on the
   * home's own Mac, from the newest welcome that said it (docs/helper.md,
   * "In the background"). Null until one has.
   */
  readonly onHomeMac: boolean | null;
  /**
   * The last moment the device heard from the home, in ms since the epoch,
   * as of the newest change of contact: what "as of" says once it is gone.
   */
  readonly heardAt: number | null;
  /** The home took this device off its list; it never dials again. */
  readonly removed: boolean;
  /**
   * A second home answered with the number this device heard but another
   * takeover (docs/devices.md, "Two homes with one number"): the device
   * refused it and kept dialing the one it knew; its name when it said one.
   * Absent until one answered.
   */
  readonly twoHomes?: { readonly name: string | null };
};

/** A request the device could not put to the home: it is out of reach, or it went mid-request. */
export class HomeOutOfReachError extends Error {
  constructor(
    message = `The ${COMPUTER.one} this one controls is out of reach, so nothing was sent.`,
  ) {
    super(message);
    this.name = "HomeOutOfReachError";
  }
}

/**
 * The home's own refusal of a request it was asked: its words, as its
 * request's error carried them back (`docs/contract.md`, refusals). A
 * computer that controls it tells them apart from its own (`namedHere`,
 * `src/main/view/namedHere.ts`). Its name stays Error's, so a window that
 * shows the message reads what it read before.
 */
export class HomeRefusalError extends Error {}

export type HomeLinkOptions = {
  grant: DeviceGrant;
  /** The contract version the device speaks; the version rule reads its major. */
  protocolVersion?: string;
  /**
   * The oldest home major a view connection can still change things on,
   * which its hello says. Defaults to this build's own (`VIEW_FLOOR`); a
   * test stands in another view's with it.
   */
  viewFloor?: number;
  /**
   * The contract changes its hello lists by name. Defaults to this build's
   * own (`CONTRACT_CHANGES`); a test stands in another device's with it,
   * and an empty list says none, as a device from before names.
   */
  changes?: readonly string[];
  /**
   * The spelling of channel names it writes to a home that reads it
   * (docs/connection.md, "Two spellings"). Defaults to this build's own; a
   * test stands in Infinitary's with it.
   */
  speaks?: Spelling;
  /**
   * The version of Firstmate the device runs, which its hello says so the
   * home can tell it runs another (docs/devices.md, "Another version").
   * Unsaid when absent.
   */
  appVersion?: string;
  /**
   * A computer that went back from a copy that did not start (docs/helper.md,
   * "A copy that does not start"): read at each hello, which then says it.
   * Unsaid when it answers false.
   */
  failedUpdate?: () => boolean;
  /**
   * Opens the WebSocket; `dialHome` unless a test stands in its own. It is
   * told the grant's addresses as they stand, and tells `reached` the
   * address that answered when it is not the grant's `at`.
   */
  dial?: (grant: DeviceGrant, reached: (at: string) => void) => Promise<WebSocket>;
  /**
   * The addresses the home offered and the one that answered, once a welcome
   * makes them differ from the grant's (docs/devices.md, "Finding the home
   * again"): the next dial tries them, and the device keeps them on its grant.
   */
  onRoutes?: (routes: { at: string; also: string[] }) => void;
  /**
   * Every push the home numbers, in order, replayed ones included:
   * `replayed` for one a welcome sent again because the device missed it.
   */
  onPush: (channel: string, payload: unknown, replayed: boolean) => void;
  /**
   * A push for this connection alone, never numbered or replayed, such as a
   * picture of a task's page it watches (docs/connection.md, "Live pushes").
   */
  onLive?: (channel: string, payload: unknown) => void;
  /**
   * What the home asks this device (a computer that runs work, its orders):
   * the answer, or a refusal thrown. Absent, every request is refused.
   */
  onInvoke?: (channel: string, args: unknown) => Promise<unknown>;
  /**
   * At each welcome, before its state says the home is in reach again: how
   * it catches up, and for a replay how many pushes it missed, so a view
   * never shows a moment of live before it starts catching up
   * (docs/view.md, "Live, catching up or out of reach").
   */
  onWelcoming?: (catchUp: "replay" | "reload", missed: number) => void;
  /**
   * After each welcome: `replay` when the pushes the device missed follow,
   * `reload` when it must read its state again through ordinary requests.
   */
  onCaughtUp?: (catchUp: "replay" | "reload") => void;
  /**
   * The moment a welcomed connection closes, before the link dials again
   * and before its state says the home is out of reach: what that
   * connection started ends with it.
   */
  onDropped?: () => void;
  /**
   * After the last push a replaying welcome sent again is handled, so what
   * the device holds is as current as the home (docs/view.md, "Live,
   * catching up or out of reach").
   */
  onReplayed?: () => void;
  /** Every change to the state above. */
  onState?: (state: HomeLinkState) => void;
  /**
   * The highest home number this device has heard (docs/devices.md, "Moving
   * the first mate"): a welcome from a home with a lower one is refused and
   * the device dials its other addresses. 1 when absent.
   */
  homeNumber?: number;
  /** A welcome or a move told a higher home number, which the device keeps. */
  onHomeNumber?: (homeNumber: number) => void;
  /**
   * The takeover heard with the newest home number (`takeOver` in a
   * welcome, docs/devices.md "Taking over"); null before any.
   */
  heardTakeOver?: HeardTakeOver | null;
  /** A welcome said the takeover that made its home, which the device keeps. */
  onTakeOver?: (heard: HeardTakeOver) => void;
  /**
   * The home moved to another computer (`inf:home:moved`): told after its
   * new addresses and number were taken, before the device dials there.
   */
  onMoved?: (moved: HomeMoved) => void;
  now?: () => number;
  /** Waits between attempts while the home is out of reach; the last repeats. */
  retryMs?: readonly number[];
  /** How often the device pings the home; a ping unanswered by the next one drops it. */
  pingMs?: number;
  /** How long the WebSocket upgrade and welcome may take after the pinned TLS dial. */
  welcomeTimeoutMs?: number;
  /**
   * A join's one dial, only to hear the home's name: its hello says so, and
   * the home counts nothing of it as this computer in reach.
   */
  nameOnly?: boolean;
  automaticStartup?: import("@shared/devices").AutomaticStartup;
  /**
   * What this connection does for a Mac that both controls its home and
   * runs its work (docs/connection.md, "Hello"): the app's window is the
   * `view`, its work mode the `work`. Said only by a grant of kind `mac`;
   * every other device does what its kind does.
   */
  as?: DeviceRole;
  /**
   * What this device says it is in each hello (docs/devices.md, "What a
   * device is"); this computer's own system and chip unless a test stands in.
   */
  system?: { system?: DeviceSystem; chip?: DeviceChip };
};

/** Default wait for the WebSocket upgrade and welcome, after the pinned TLS dial. */
export const HOME_WELCOME_TIMEOUT_MS = 10_000;

const DEFAULT_RETRY_MS = [1_000, 2_000, 3_000, 5_000] as const;
/** Why a work request ended unanswered. */
const STOPPED = `This computer stopped working for the other ${COMPUTER.one}, so the request ended unanswered.`;
/** Two `401` answers in a row mean the home no longer lists this device. */
const REFUSALS_TO_REMOVED = 2;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A work request: asked again on each new connection until the home answers it. */
type Asked = Pending & {
  readonly channel: string;
  readonly args: unknown;
  /** The socket it was last sent on, and the request id it went under there. */
  sentOn: WebSocket | null;
  wireId: number;
  everSent: boolean;
};

/**
 * How one attempt ended: whether the home welcomed it, how its upgrade was
 * refused, how it closed, and whether it was a home left behind by a move.
 */
type Ending = {
  welcomed: boolean;
  refusedStatus?: number;
  closeCode?: number;
  older?: boolean;
  /** A second home with the number heard but another takeover, by the name it said. */
  second?: { name: string | null };
};

export class HomeLink {
  /** The grant it dials with, whose addresses follow each welcome. */
  private grant: DeviceGrant;
  /** Where the newest dial reached the home. */
  private reachedAt: string;
  private readonly protocolVersion: string;
  /** The spelling its requests are written in to the home that welcomed it. */
  private spelling: Spelling = FIRST_SPELLING;
  private readonly dial: (grant: DeviceGrant, reached: (at: string) => void) => Promise<WebSocket>;
  private readonly now: () => number;
  private readonly retryMs: readonly number[];
  private readonly pingMs: number;
  private readonly welcomeTimeoutMs: number;
  private current: HomeLinkState = {
    contact: "reaching",
    access: null,
    homeVersion: null,
    homeChanges: null,
    name: null,
    takesWork: null,
    onHomeMac: null,
    heardAt: null,
    removed: false,
  };
  private lastHeard: number | null = null;
  /** The newest push the latest welcome numbered: one at or before it is a replay. */
  private welcomedAt = 0;
  private socket: WebSocket | null = null;
  /** The socket the home welcomed; requests ride only this. */
  private open: WebSocket | null = null;
  /** How many welcomes this link has heard: the number of the newest connection's. */
  private welcomes = 0;
  /** When the attempt under way began to dial, before it reached anyone. */
  private dialedAt = 0;
  /** When the attempt the newest welcome came on began to dial. */
  private welcomeDialedAt = 0;
  private cursor: ConnectionCursor | undefined;
  private attempting = false;
  /** The one attempt right after a drop, before the device says the home is out of reach. */
  private grace = false;
  private dropReason: "lost" | "closed" = "lost";
  private failures = 0;
  private refusals = 0;
  private stopped = false;
  private leaving = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  /** The highest home number heard; a lower one is a home left behind by a move. */
  private homeNumber: number;
  /** The takeover heard with the newest number; another at the same number is a second home. */
  private heardTakeOver: HeardTakeOver | null;
  private readonly pending = new Map<number, Pending>();
  /** Work requests not yet answered, by the id they went under last. */
  private readonly asked = new Set<Asked>();
  private waiters: (() => void)[] = [];
  /** The second homes this window told of, by takeover, once each for this run. */
  private readonly toldOfTwoHomes = new Set<string>();
  /** The second home the home this window follows is still to hear of. */
  private secondToTell: OtherHome | null = null;

  constructor(private readonly options: HomeLinkOptions) {
    this.grant = options.grant;
    this.reachedAt = options.grant.at;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.dial = options.dial ?? ((grant, reached) => dialHome(grant, { reached }));
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs?.length ? options.retryMs : DEFAULT_RETRY_MS;
    this.pingMs = options.pingMs ?? 10_000;
    this.welcomeTimeoutMs = options.welcomeTimeoutMs ?? HOME_WELCOME_TIMEOUT_MS;
    this.homeNumber = options.homeNumber ?? FIRST_HOME_NUMBER;
    this.heardTakeOver = options.heardTakeOver ?? null;
  }

  state(): HomeLinkState {
    return this.current;
  }

  /**
   * The connection open now, or null while none is open: the number of its
   * welcome, and when its dial began, before anyone answered it. A drop the
   * link dials through at once leaves the contact in reach, and still ends
   * that number. Whoever welcomed a connection was listening once its dial
   * began, so a process that started after that moment could not have.
   */
  connection(): HomeLinkConnection | null {
    return this.open ? { welcome: this.welcomes, dialedAt: this.welcomeDialedAt } : null;
  }

  /** Starts dialing; it keeps dialing until it is closed or the home removes the device. */
  start(): void {
    if (this.stopped || this.attempting || this.open) return;
    void this.attempt();
  }

  /**
   * Asks the home one request. A change is put only while the home is in
   * reach; a read also waits for an attempt already under way while the
   * device is still reaching the home. Never queued, never asked twice.
   */
  invoke(channel: string, args: unknown): Promise<unknown> {
    if (this.open) return this.send(this.open, channel, args);
    const reaching = this.attempting && (this.current.contact === "reaching" || this.grace);
    const declared = invokeContract[channel as CoreInvokeChannel];
    if (!this.stopped && reaching && declared?.effect === "read") {
      return new Promise((resolve, reject) => {
        this.waiters.push(() => {
          if (this.open) this.send(this.open, channel, args).then(resolve, reject);
          else reject(new HomeOutOfReachError());
        });
      });
    }
    return Promise.reject(new HomeOutOfReachError());
  }

  /**
   * Asks the home one work request (src/shared/work.ts) and resolves with
   * its answer, or rejects with its refusal. Unlike `invoke` it waits while
   * the home is out of reach and is asked again on every new connection
   * until the home answers, so its arguments carry the id the home answers
   * a repeat by. An optional signal withdraws it, including from future retries.
   */
  ask(channel: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) return Promise.reject(new HomeOutOfReachError(STOPPED));
    if (signal?.aborted) return Promise.reject(new WorkRequestAbortedError(false, signal.reason));
    return new Promise((resolve, reject) => {
      const finish = (action: () => void) => {
        signal?.removeEventListener("abort", abort);
        action();
      };
      const abort = () => {
        this.asked.delete(asked);
        finish(() => reject(new WorkRequestAbortedError(asked.everSent, signal?.reason)));
      };
      const asked: Asked = {
        channel,
        args,
        sentOn: null,
        wireId: 0,
        everSent: false,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.asked.add(asked);
      if (this.open) this.sendAsked(this.open, asked);
    });
  }

  /** Work requests the home has not answered yet. */
  waiting(): number {
    return this.asked.size;
  }

  /**
   * Leave (docs/devices.md): asks the home to take this device off its list,
   * then stops. True when the home heard it and cut the device; false when
   * it was out of reach, so it still lists this device until it is removed
   * there.
   */
  async leave(timeoutMs = 5_000): Promise<boolean> {
    const socket = this.open;
    if (!socket) {
      this.close();
      return false;
    }
    this.leaving = true;
    const heard = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      socket.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code === CONNECTION_CLOSE.unpaired);
      });
      try {
        socket.send(JSON.stringify({ t: "leave" }));
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
    this.close();
    return heard;
  }

  /** Stops dialing and closes the connection; every request still waiting is refused. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    this.open = null;
    try {
      socket?.close(1000, "closing");
    } catch {
      socket?.terminate();
    }
    this.refuseAll();
  }

  private async attempt(): Promise<void> {
    this.attempting = true;
    let ending: Ending = { welcomed: false };
    this.dialedAt = this.now();
    try {
      this.reachedAt = this.grant.at;
      const socket = await this.dial(this.grant, (at) => {
        this.reachedAt = at;
      });
      if (this.stopped) {
        // Closed while the dial was under way: nobody reads this socket. Its
        // handshake is not finished, so ending it raises an error event, and
        // one with no listener would be uncaught and end this process.
        socket.on("error", () => {});
        socket.terminate();
      } else {
        this.socket = socket;
        ending = await this.run(socket);
      }
    } catch {
      // Unreachable, refused, or another computer answered at the address:
      // the home is out of reach from here.
    } finally {
      this.attempting = false;
      this.socket = null;
      this.open = null;
    }
    if (this.stopped) {
      this.refuseAll();
      return;
    }
    this.settle(ending);
  }

  /**
   * One socket, whole: hello once it opens, the welcome, then every push and
   * result in arrival order, until it closes. One listener reads every frame,
   * so the pushes a welcome replays are handled in the same turn it is.
   */
  private run(socket: WebSocket): Promise<Ending> {
    return new Promise((resolve) => {
      let welcomed = false;
      let older = false;
      let second: Ending["second"];
      let refusedStatus: number | undefined;
      let answered = true;
      // A long frame comes as parts when this hello listed `frame-parts`.
      const parts = new FramePartsReader();
      let heartbeat: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        if (!welcomed) socket.terminate();
      }, this.welcomeTimeoutMs);
      // The close that follows an error is what ends the attempt.
      socket.on("error", () => {});
      socket.once("unexpected-response", (_request, response) => {
        refusedStatus = response.statusCode ?? 0;
        socket.terminate();
      });
      socket.once("open", () => {
        const changes = this.options.changes ?? CONTRACT_CHANGES.names;
        socket.send(
          JSON.stringify({
            t: "hello",
            protocolVersion: this.protocolVersion,
            ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}),
            ...failedUpdateOf(this.options.failedUpdate),
            ...(this.cursor ? { cursor: this.cursor } : {}),
            ...(this.options.nameOnly ? { nameOnly: true } : {}),
            ...(this.options.automaticStartup
              ? { automaticStartup: this.options.automaticStartup }
              : {}),
            ...(this.options.as && this.grant.kind === "mac" ? { as: this.options.as } : {}),
            // A view says how old a home it can still change things on.
            ...(this.options.as === "view" || this.grant.kind === "view"
              ? { viewFloor: this.options.viewFloor ?? VIEW_FLOOR }
              : {}),
            ...(this.options.system ?? thisDeviceSystem()),
            spellings: SPELLINGS,
            ...(changes.length ? { changes } : {}),
          }),
        );
      });
      const heard = () => {
        this.lastHeard = this.now();
      };
      socket.on("pong", () => {
        answered = true;
        heard();
      });
      socket.on("ping", heard);
      socket.on("message", (raw: unknown, isBinary: boolean) => {
        if (isBinary) return;
        let text: string | undefined;
        try {
          text = parts.read(Buffer.isBuffer(raw) ? raw : String(raw));
        } catch {
          socket.terminate();
          return;
        }
        if (text === undefined) {
          heard();
          return;
        }
        const frame = parseFrame(text);
        if (!frame) return;
        heard();
        if (!welcomed) {
          if (frame.t !== "welcome") return;
          // A home left behind by a move: never this device's home again.
          if ((frame.homeNumber ?? FIRST_HOME_NUMBER) < this.homeNumber) {
            older = true;
            socket.terminate();
            return;
          }
          // Another home with the same number but another takeover: two homes, neither followed.
          if (this.secondHome(frame)) {
            second = { name: frame.name ?? null };
            // A window tells this home of the one it follows, and lets the frame go before it closes.
            if (this.tellTwoHomes(socket, frame)) socket.close();
            else socket.terminate();
            return;
          }
          welcomed = true;
          clearTimeout(timer);
          this.welcome(socket, frame);
          heartbeat = setInterval(() => {
            if (!answered) {
              socket.terminate();
              return;
            }
            answered = false;
            try {
              socket.ping();
            } catch {
              socket.terminate();
            }
          }, this.pingMs);
          heartbeat.unref?.();
          return;
        }
        if (frame.t === "push") {
          if (this.cursor) this.cursor = { epoch: this.cursor.epoch, seq: frame.seq };
          // A replayed push a later whole list replaced moves the cursor and carries nothing.
          if (ownChannel(frame.channel) !== REPLACED_PUSH_CHANNEL) {
            try {
              this.options.onPush(
                ownChannel(frame.channel),
                frame.payload,
                frame.seq <= this.welcomedAt,
              );
            } catch {
              // One listener's failure is not the connection's.
            }
          }
          if (frame.seq === this.welcomedAt) {
            try {
              this.options.onReplayed?.();
            } catch {
              // As for a push.
            }
          }
        } else if (frame.t === "live" && ownChannel(frame.channel) === HOME_MOVED_LIVE) {
          if (this.moved(frame.payload)) socket.close(CONNECTION_CLOSE.closing);
        } else if (frame.t === "live" && ownChannel(frame.channel) === HOME_ROUTES_LIVE) {
          // Where the home's copies would answer, as its welcome would say now.
          const routes = homeRoutesSchema.safeParse(frame.payload);
          if (routes.success && this.open === socket) this.followRoutes(routes.data.addresses);
        } else if (frame.t === "live") {
          try {
            this.options.onLive?.(ownChannel(frame.channel), frame.payload);
          } catch {
            // One listener's failure is not the connection's.
          }
        } else if (frame.t === "result") {
          const id = Number(frame.id);
          const asked = [...this.asked].find(
            (entry) => entry.sentOn === socket && entry.wireId === id,
          );
          if (asked) this.asked.delete(asked);
          const pending = asked ?? this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          if (frame.ok) pending.resolve(frame.value);
          else pending.reject(new HomeRefusalError(frame.error));
        } else if (frame.t === "invoke") {
          void this.answer(socket, { ...frame, channel: ownChannel(frame.channel) });
        }
      });
      socket.once("close", (code: number) => {
        clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        if (this.open === socket) this.open = null;
        // A work request waits for the next connection; anything else is refused.
        for (const asked of this.asked) if (asked.sentOn === socket) asked.sentOn = null;
        this.refusePending();
        resolve({
          welcomed,
          ...(older ? { older } : {}),
          ...(second ? { second } : {}),
          ...(refusedStatus === undefined ? {} : { refusedStatus }),
          ...(welcomed ? { closeCode: code } : {}),
        });
      });
    });
  }

  private welcome(socket: WebSocket, frame: Extract<HomeFrame, { t: "welcome" }>): void {
    const missed =
      frame.catchUp === "replay" && this.cursor?.epoch === frame.epoch
        ? Math.max(0, frame.seq - this.cursor.seq)
        : 0;
    this.cursor = { epoch: frame.epoch, seq: frame.seq };
    this.welcomedAt = frame.seq;
    this.spelling = spellingFor(
      readSpellings(frame.spellings),
      this.options.speaks ?? OWN_SPELLING,
    );
    this.open = socket;
    this.welcomes += 1;
    this.welcomeDialedAt = this.dialedAt;
    this.heardNumber(frame.homeNumber ?? FIRST_HOME_NUMBER);
    this.heardTakeOverOf(frame);
    this.followRoutes(frame.addresses);
    const second = this.secondToTell;
    if (second && (frame.changes ?? []).includes(STANDBY_TAKE_OVER_CHANGE)) {
      this.secondToTell = null;
      void this.send(socket, STANDBY_OTHER_HOME, [second]).catch(() => {});
    }
    this.failures = 0;
    this.refusals = 0;
    this.grace = false;
    try {
      this.options.onWelcoming?.(frame.catchUp, missed);
    } catch {
      // As for a push.
    }
    this.update({
      contact: "in-reach",
      access: frame.access,
      homeVersion: frame.protocolVersion,
      homeChanges: sameNames(frame.changes ?? [], this.current.homeChanges),
      name: frame.name ?? this.current.name,
      takesWork: frame.takesWork ?? null,
      onHomeMac: frame.onHomeMac ?? this.current.onHomeMac,
    });
    try {
      this.options.onCaughtUp?.(frame.catchUp);
    } catch {
      // As for a push.
    }
    // Every work request the home has not answered goes again, on this connection.
    for (const asked of this.asked) if (!asked.sentOn) this.sendAsked(socket, asked);
    this.wake();
  }

  /**
   * Keeps every address the home offers in this welcome, after the one that
   * answered, so the next dial finds it wherever it is still listening.
   */
  private followRoutes(offered: readonly string[] | undefined): void {
    const routes = grantRoutes(this.grant, this.reachedAt, offered);
    if (!routes) return;
    this.grant = { ...this.grant, at: routes.at, also: routes.also };
    try {
      this.options.onRoutes?.(routes);
    } catch {
      // Kept for this run all the same; the next welcome tells it again.
    }
  }

  /**
   * Whether this welcome is from a second home: the number this device
   * heard, with a takeover other than the one it heard with that number.
   * A device that heard no takeover with it, as one from before, takes it.
   */
  private secondHome(frame: Extract<HomeFrame, { t: "welcome" }>): boolean {
    const said = frame.homeNumber ?? FIRST_HOME_NUMBER;
    const heard = this.heardTakeOver;
    return heard !== null && said === heard.number && (frame.takeOver ?? null) !== heard.id;
  }

  /**
   * A window that hears a second home tells each home of the other
   * (docs/devices.md, "Two homes with one number"), once each for this run:
   * the second at once, on its own connection, and the one it follows on its
   * next welcome. Each holds every act that cannot be undone and asks the
   * captain, even when the two cannot reach each other. A home from before,
   * and a link that is no window, tells nothing. True when it told the
   * second now.
   */
  private tellTwoHomes(socket: WebSocket, frame: Extract<HomeFrame, { t: "welcome" }>): boolean {
    if (this.options.as !== "view" && this.grant.kind !== "view") return false;
    const key = frame.takeOver ?? "";
    if (this.toldOfTwoHomes.has(key)) return false;
    this.toldOfTwoHomes.add(key);
    const homeNumber = frame.homeNumber ?? FIRST_HOME_NUMBER;
    const secondAt = this.reachedAt;
    const secondAddresses = linkAddresses({ at: secondAt, also: frame.addresses ?? [] }).slice(
      0,
      1 + PAIRING_LINK_ALSO_MAX,
    );
    this.secondToTell = {
      name: frame.name?.slice(0, 160) ?? null,
      homeNumber,
      takeOver: frame.takeOver ?? null,
      addresses: secondAddresses,
    };
    // Each home's welcome lists the other's addresses too, as a copy it
    // keeps, so only where the second answered is left out; the address
    // the followed home last answered at goes first, which a home told
    // this matches against its copies.
    const followed = linkAddresses(this.grant)
      .filter((at) => at !== secondAt)
      .slice(0, 1 + PAIRING_LINK_ALSO_MAX);
    if (!(frame.changes ?? []).includes(STANDBY_TAKE_OVER_CHANGE) || followed.length === 0)
      return false;
    const told: OtherHome = {
      name: this.current.name?.slice(0, 160) ?? null,
      homeNumber,
      takeOver: this.heardTakeOver?.id ?? null,
      addresses: followed,
    };
    try {
      socket.send(
        JSON.stringify({
          t: "invoke",
          id: this.nextId++,
          channel: channelIn(
            STANDBY_OTHER_HOME,
            spellingFor(readSpellings(frame.spellings), this.options.speaks ?? OWN_SPELLING),
          ),
          args: invokeArgs([told]),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps the takeover a welcome said with a number no lower than any heard. */
  private heardTakeOverOf(frame: Extract<HomeFrame, { t: "welcome" }>): void {
    const number = frame.homeNumber ?? FIRST_HOME_NUMBER;
    if (!frame.takeOver || number < this.homeNumber) return;
    if (this.heardTakeOver?.number === number && this.heardTakeOver.id === frame.takeOver) return;
    this.heardTakeOver = { number, id: frame.takeOver };
    try {
      this.options.onTakeOver?.(this.heardTakeOver);
    } catch {
      // Kept for this run all the same; the next welcome tells it again.
    }
  }

  /** Keeps a higher home number than any heard before. */
  private heardNumber(homeNumber: number): void {
    if (homeNumber <= this.homeNumber) return;
    this.homeNumber = homeNumber;
    try {
      this.options.onHomeNumber?.(homeNumber);
    } catch {
      // Kept for this run all the same; the next welcome tells it again.
    }
  }

  /**
   * This computer took over as the home (docs/devices.md, "Taking over"):
   * its own work dials the first mate here at `at`, with the number it took,
   * from now on, and dials at once if it was waiting to try again. Nothing
   * changes for a grant that reaches its home through the home's SSH.
   */
  tookOver(at: string, homeNumber: number): void {
    if (this.stopped || this.grant.via === "ssh") return;
    this.heardNumber(homeNumber);
    this.grant = { ...this.grant, at, also: [] };
    this.reachedAt = at;
    if (this.open || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.failures = 0;
    void this.attempt();
  }

  /**
   * The home moved to another computer (`inf:home:moved`): its number and
   * addresses are kept, and true says to close and dial there. A frame that
   * names no higher number than this device heard changes nothing.
   */
  private moved(payload: unknown): boolean {
    const read = homeMovedSchema.safeParse(payload);
    if (!read.success || read.data.homeNumber <= this.homeNumber) return false;
    const moved = read.data;
    this.heardNumber(moved.homeNumber);
    const [at, ...also] = moved.addresses;
    if (at && this.grant.via !== "ssh") {
      this.grant = { ...this.grant, at, also };
      this.reachedAt = at;
      try {
        this.options.onRoutes?.({ at, also });
      } catch {
        // As for a welcome's routes.
      }
    }
    try {
      this.options.onMoved?.(moved);
    } catch {
      // One listener's failure is not the connection's.
    }
    return true;
  }

  /**
   * A home left behind by a move answered at the address dialed: the next
   * dial tries the others first, and that one last.
   */
  private passOver(at: string): void {
    const all = [this.grant.at, ...(this.grant.also ?? [])];
    const rest = all.filter((each) => each !== at);
    if (rest.length === 0 || rest.length === all.length) return;
    const [first, ...others] = rest;
    if (first) this.grant = { ...this.grant, at: first, also: [...others, at] };
  }

  /** One request the home asked: the answer, or why there is none, on the socket it came on. */
  private async answer(
    socket: WebSocket,
    frame: Extract<HomeFrame, { t: "invoke" }>,
  ): Promise<void> {
    let outcome: { ok: true; value: unknown } | { ok: false; error: string };
    try {
      if (!this.options.onInvoke)
        throw new Error(`${frame.channel} is not a request this device answers.`);
      outcome = { ok: true, value: await this.options.onInvoke(frame.channel, frame.args) };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // An answer for a connection that went is dropped: the home asks again.
    if (socket.readyState !== socket.OPEN) return;
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
    try {
      socket.send(text);
    } catch {
      // The close that follows ends the attempt.
    }
  }

  private sendAsked(socket: WebSocket, asked: Asked): void {
    asked.wireId = this.nextId++;
    asked.sentOn = socket;
    asked.everSent = true;
    try {
      socket.send(
        JSON.stringify({
          t: "invoke",
          id: asked.wireId,
          channel: channelIn(asked.channel, this.spelling),
          args: invokeArgs(asked.args),
        }),
      );
    } catch {
      // Not sent: it goes again on the next connection.
      asked.sentOn = null;
    }
  }

  /** What one attempt ended in decides what the device says and when it dials again. */
  private settle({ welcomed, refusedStatus, closeCode, older, second }: Ending): void {
    if (welcomed) this.options.onDropped?.();
    if (older) this.passOver(this.reachedAt);
    if (second) {
      this.passOver(this.reachedAt);
      this.update({ twoHomes: second });
    }
    if (closeCode === CONNECTION_CLOSE.unpaired) {
      if (this.leaving) this.close();
      else this.removeDevice();
      return;
    }
    if (refusedStatus === 401) {
      this.refusals += 1;
      if (this.refusals >= REFUSALS_TO_REMOVED) {
        this.removeDevice();
        return;
      }
    } else {
      this.refusals = 0;
    }
    if (welcomed) {
      // The home was in reach and the connection dropped: dial once at
      // once, and only then say it is out of reach.
      this.dropReason = closeCode === CONNECTION_CLOSE.closing ? "closed" : "lost";
      this.grace = true;
      void this.attempt();
      return;
    }
    if (this.grace) this.update({ contact: this.dropReason });
    else if (this.current.contact === "reaching") this.update({ contact: "lost" });
    this.grace = false;
    this.wake();
    const wait = this.retryMs[Math.min(this.failures, this.retryMs.length - 1)] ?? 1_000;
    this.failures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) void this.attempt();
    }, wait);
    this.retryTimer.unref?.();
  }

  private removeDevice(): void {
    this.stopped = true;
    this.open = null;
    this.refuseAll();
    this.update({ removed: true, contact: "lost" });
  }

  private send(socket: WebSocket, channel: string, args: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        socket.send(
          JSON.stringify({
            t: "invoke",
            id,
            channel: channelIn(channel, this.spelling),
            args: invokeArgs(args),
          }),
        );
      } catch {
        this.pending.delete(id);
        reject(new HomeOutOfReachError());
      }
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private refusePending(): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending)
      entry.reject(
        new HomeOutOfReachError(`The connection to the other ${COMPUTER.one} went mid-request.`),
      );
  }

  private refuseAll(): void {
    this.refusePending();
    // Only stopping, or the home's Remove, ends a work request unanswered.
    if (this.stopped) {
      const asked = [...this.asked];
      this.asked.clear();
      for (const entry of asked) entry.reject(new HomeOutOfReachError(STOPPED));
    }
    this.wake();
  }

  /** A change of contact also records when the home was last heard. */
  private update(change: Partial<HomeLinkState>): void {
    const contactChanged = change.contact !== undefined && change.contact !== this.current.contact;
    const next: HomeLinkState = {
      ...this.current,
      ...change,
      ...(contactChanged ? { heardAt: this.lastHeard } : {}),
    };
    if (
      next.contact === this.current.contact &&
      next.access === this.current.access &&
      next.homeVersion === this.current.homeVersion &&
      next.homeChanges === this.current.homeChanges &&
      next.name === this.current.name &&
      next.takesWork === this.current.takesWork &&
      next.onHomeMac === this.current.onHomeMac &&
      next.heardAt === this.current.heardAt &&
      next.removed === this.current.removed &&
      next.twoHomes?.name === this.current.twoHomes?.name &&
      (next.twoHomes === undefined) === (this.current.twoHomes === undefined)
    )
      return;
    this.current = next;
    this.options.onState?.(next);
  }
}

/**
 * The names a welcome listed, as the list already held when they are the
 * same, so an unchanged list is no change of state.
 */
function sameNames(listed: readonly string[], held: readonly string[] | null): readonly string[] {
  return held && held.length === listed.length && held.every((name, at) => name === listed[at])
    ? held
    : listed;
}

function parseFrame(text: string): HomeFrame | undefined {
  try {
    const parsed = homeFrameSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Cancellation reports transport facts, leaving the caller to explain its own deadline. */
export class WorkRequestAbortedError extends Error {
  constructor(
    readonly everSent: boolean,
    reason: unknown,
  ) {
    super("Work request withdrawn.", { cause: reason });
  }
}

/** What a hello says of a copy that did not start: nothing when none went back, or it cannot be read. */
function failedUpdateOf(read: HomeLinkOptions["failedUpdate"]): { failedUpdate?: true } {
  try {
    return read?.() ? { failedUpdate: true } : {};
  } catch {
    return {};
  }
}
