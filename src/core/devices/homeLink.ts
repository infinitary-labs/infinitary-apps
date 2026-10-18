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
} from "@shared/connection";
import { COMPUTER } from "@shared/deviceNames";
import type { DeviceChip, DeviceGrant, DeviceRole, DeviceSystem } from "@shared/devices";
import {
  type ContractAccess,
  type CoreInvokeChannel,
  invokeContract,
  PROTOCOL_VERSION,
} from "@shared/ipc";
import type { WebSocket } from "ws";
import { thisDeviceSystem } from "../platform";
import { dialHome } from "./dial";

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
 * again on every new connection until the home answers. It also answers
 * what the home asks it (`onInvoke`).
 */

/**
 * Whether the device hears the home: `reaching` before it has heard anything
 * since it started, `in-reach` while it does, `lost` once contact is gone,
 * and `closed` when the home said it was quitting.
 */
export type HomeContact = "reaching" | "in-reach" | "lost" | "closed";

export type HomeLinkState = {
  readonly contact: HomeContact;
  /** What the version rule lets this device ask, from the newest welcome. */
  readonly access: ContractAccess | null;
  /** The contract version the home speaks, from the newest welcome. */
  readonly homeVersion: string | null;
  /** The home's own name, from the newest welcome that carried one. */
  readonly name: string | null;
  /**
   * For a computer that runs work: whether the home lets its version take
   * new work, from the newest welcome (docs/helper.md). Null for a view.
   */
  readonly takesWork: boolean | null;
  /**
   * The last moment the device heard from the home, in ms since the epoch,
   * as of the newest change of contact: what "as of" says once it is gone.
   */
  readonly heardAt: number | null;
  /** The home took this device off its list; it never dials again. */
  readonly removed: boolean;
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

export type HomeLinkOptions = {
  grant: DeviceGrant;
  /** The contract version the device speaks; the version rule reads its major. */
  protocolVersion?: string;
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
  /** Opens the WebSocket; `dialHome` unless a test stands in its own. */
  dial?: (grant: DeviceGrant) => Promise<WebSocket>;
  /** Every push the home numbers, in order, replayed ones included. */
  onPush: (channel: string, payload: unknown) => void;
  /**
   * What the home asks this device (a computer that runs work, its orders):
   * the answer, or a refusal thrown. Absent, every request is refused.
   */
  onInvoke?: (channel: string, args: unknown) => Promise<unknown>;
  /**
   * After each welcome: `replay` when the pushes the device missed follow,
   * `reload` when it must read its state again through ordinary requests.
   */
  onCaughtUp?: (catchUp: "replay" | "reload") => void;
  /** Every change to the state above. */
  onState?: (state: HomeLinkState) => void;
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
};

/** How one attempt ended: whether the home welcomed it, how its upgrade was refused, how it closed. */
type Ending = { welcomed: boolean; refusedStatus?: number; closeCode?: number };

export class HomeLink {
  private readonly grant: DeviceGrant;
  private readonly protocolVersion: string;
  /** The spelling its requests are written in to the home that welcomed it. */
  private spelling: Spelling = FIRST_SPELLING;
  private readonly dial: (grant: DeviceGrant) => Promise<WebSocket>;
  private readonly now: () => number;
  private readonly retryMs: readonly number[];
  private readonly pingMs: number;
  private readonly welcomeTimeoutMs: number;
  private current: HomeLinkState = {
    contact: "reaching",
    access: null,
    homeVersion: null,
    name: null,
    takesWork: null,
    heardAt: null,
    removed: false,
  };
  private lastHeard: number | null = null;
  private socket: WebSocket | null = null;
  /** The socket the home welcomed; requests ride only this. */
  private open: WebSocket | null = null;
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
  private readonly pending = new Map<number, Pending>();
  /** Work requests not yet answered, by the id they went under last. */
  private readonly asked = new Set<Asked>();
  private waiters: (() => void)[] = [];

  constructor(private readonly options: HomeLinkOptions) {
    this.grant = options.grant;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.dial = options.dial ?? ((grant) => dialHome(grant));
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs?.length ? options.retryMs : DEFAULT_RETRY_MS;
    this.pingMs = options.pingMs ?? 10_000;
    this.welcomeTimeoutMs = options.welcomeTimeoutMs ?? HOME_WELCOME_TIMEOUT_MS;
  }

  state(): HomeLinkState {
    return this.current;
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
   * a repeat by. Refused only when this device stops or is removed.
   */
  ask(channel: string, args: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new HomeOutOfReachError(STOPPED));
    return new Promise((resolve, reject) => {
      const asked: Asked = { channel, args, resolve, reject, sentOn: null, wireId: 0 };
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
    try {
      const socket = await this.dial(this.grant);
      if (this.stopped) socket.terminate();
      else {
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
      let refusedStatus: number | undefined;
      let answered = true;
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
        socket.send(
          JSON.stringify({
            t: "hello",
            protocolVersion: this.protocolVersion,
            ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}),
            ...(this.cursor ? { cursor: this.cursor } : {}),
            ...(this.options.nameOnly ? { nameOnly: true } : {}),
            ...(this.options.as && this.grant.kind === "mac" ? { as: this.options.as } : {}),
            ...(this.options.system ?? thisDeviceSystem()),
            spellings: SPELLINGS,
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
        const frame = isBinary ? undefined : parseFrame(raw);
        if (!frame) return;
        heard();
        if (!welcomed) {
          if (frame.t !== "welcome") return;
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
          try {
            this.options.onPush(ownChannel(frame.channel), frame.payload);
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
          else pending.reject(new Error(frame.error));
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
          ...(refusedStatus === undefined ? {} : { refusedStatus }),
          ...(welcomed ? { closeCode: code } : {}),
        });
      });
    });
  }

  private welcome(socket: WebSocket, frame: Extract<HomeFrame, { t: "welcome" }>): void {
    this.cursor = { epoch: frame.epoch, seq: frame.seq };
    this.spelling = spellingFor(
      readSpellings(frame.spellings),
      this.options.speaks ?? OWN_SPELLING,
    );
    this.open = socket;
    this.failures = 0;
    this.refusals = 0;
    this.grace = false;
    this.update({
      contact: "in-reach",
      access: frame.access,
      homeVersion: frame.protocolVersion,
      name: frame.name ?? this.current.name,
      takesWork: frame.takesWork ?? null,
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
    try {
      socket.send(
        JSON.stringify({
          t: "invoke",
          id: asked.wireId,
          channel: channelIn(asked.channel, this.spelling),
          args: asked.args,
        }),
      );
    } catch {
      // Not sent: it goes again on the next connection.
      asked.sentOn = null;
    }
  }

  /** What one attempt ended in decides what the device says and when it dials again. */
  private settle({ welcomed, refusedStatus, closeCode }: Ending): void {
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
          JSON.stringify({ t: "invoke", id, channel: channelIn(channel, this.spelling), args }),
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
      next.name === this.current.name &&
      next.takesWork === this.current.takesWork &&
      next.heardAt === this.current.heardAt &&
      next.removed === this.current.removed
    )
      return;
    this.current = next;
    this.options.onState?.(next);
  }
}

function parseFrame(raw: unknown): HomeFrame | undefined {
  try {
    const parsed = homeFrameSchema.safeParse(JSON.parse(String(raw)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
