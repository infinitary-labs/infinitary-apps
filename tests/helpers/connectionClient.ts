import { FramePartsReader } from "@core/connection/frameParts";
import {
  type DeviceKey,
  type DialOptions,
  dialHome,
  homeSocketUrl,
  pinnedSocket,
} from "@core/devices/dial";
import { ownChannel, SPELLINGS } from "@shared/codeNames";
import {
  CONNECTION_PATH,
  type ConnectionCursor,
  type HomeFrame,
  homeFrameSchema,
} from "@shared/connection";
import type { DeviceGrant, DeviceRole } from "@shared/devices";
import {
  type InvokeChannel,
  type InvokeResponse,
  invokeContract,
  PROTOCOL_VERSION,
  type PushChannel,
  pushContract,
} from "@shared/ipc";
import { WebSocket } from "ws";

/**
 * A device as the connection sees one (docs/connection.md), written against
 * the published wire alone - `src/shared/connection.ts` and the contract's
 * schemas - never against the renderer. It dials with a real grant through
 * the device's own side of pairing (`src/core/devices/dial.ts`). Every frame
 * it reads is parsed with `homeFrameSchema`, every push with its channel's
 * payload schema and every answer with its request's response schema, so a
 * shape that does not survive the wire fails here.
 */

type Welcome = Extract<HomeFrame, { t: "welcome" }>;
export type ReceivedPush = { seq: number; channel: PushChannel; payload: unknown };
/** A `live` frame: for this connection alone, never numbered (docs/connection.md, "Live pushes"). */
export type ReceivedLive = { channel: string; payload: unknown };

export type ConnectionClient = {
  welcome: Welcome;
  /** Every push this connection received, in order, replayed ones first. */
  pushes: ReceivedPush[];
  /** Every `live` frame this connection received, in order. */
  lives: ReceivedLive[];
  /** The cursor to hand back on the next hello. */
  cursor: () => ConnectionCursor;
  /** Resolves with the first push, received or still to come, that matches. */
  push: (match: (push: ReceivedPush) => boolean) => Promise<ReceivedPush>;
  invoke: <C extends InvokeChannel>(channel: C, args: unknown[]) => Promise<InvokeResponse<C>>;
  /** Every request the home asked this device, in order (a computer that runs work's orders). */
  asked: { channel: string; args: unknown }[];
  /** How many frames came in parts (`frame-parts`), each joined once its last part arrived. */
  readonly joined: number;
  /** Sends any text as a frame, for refusal tests. */
  sendRaw: (text: string) => void;
  /** Resolves with the close code once the home closes the connection. */
  closed: Promise<number>;
  close: () => Promise<number>;
};

/**
 * The upgrade a refusal test sends instead of the device's own: the same
 * pinned TLS, with the path, the device's key or a browser's Origin
 * changed. `device: null` shows no key at all.
 */
export type TamperedUpgrade = { path?: string; device?: DeviceKey | null; origin?: string };

async function tamperedSocket(grant: DeviceGrant, tamper: TamperedUpgrade): Promise<WebSocket> {
  const device = tamper.device === undefined ? grant : tamper.device;
  const socket = await pinnedSocket({ address: grant.at }, grant.homeKey, device);
  return new WebSocket(homeSocketUrl(grant.at, tamper.path ?? CONNECTION_PATH), {
    createConnection: () => socket,
    ...(tamper.origin ? { origin: tamper.origin } : {}),
  });
}

/** Dials with a grant and says hello; resolves after the home's welcome. */
export async function connectClient(
  grant: DeviceGrant,
  options: {
    cursor?: ConnectionCursor;
    hello?: boolean;
    /** Additive capabilities this client knows how to read. */
    changes?: readonly string[];
    /** The contract version the hello speaks; this app's own by default. */
    protocolVersion?: string;
    /** The version of Firstmate the hello says it runs; unsaid by default. */
    appVersion?: string;
    /** A join's one dial, only to hear the home's name (docs/helper.md, "Joining"). */
    nameOnly?: boolean;
    /** What this connection of a Mac does: its window's `view`, or its `work`. */
    as?: DeviceRole;
    /** The oldest home major its hello says it can change things on (a view's `viewFloor`); unsaid by default. */
    viewFloor?: number;
    /** The system and chip its hello says it runs (docs/devices.md, "What a device is"); unsaid by default. */
    system?: { system?: string; chip?: string };
    /**
     * The spellings of channel names its hello says it reads (docs/connection.md,
     * "Two spellings"): this app's own by default; null says none, as a
     * device from before the Infinitary rename does.
     */
    spellings?: readonly string[] | null;
    tamper?: TamperedUpgrade;
    /**
     * How it dials: through a private socket, say (`DialTarget`), or a relay
     * program (`src/core/devices/relay.ts`).
     */
    dial?: DialOptions;
    /**
     * How the device answers what the home asks it: a value, or a refusal
     * thrown. Absent, it never answers.
     */
    answer?: (channel: string, args: unknown) => unknown;
    /**
     * Opens the socket some other way than the grant's dial: through the
     * local door, say (`src/core/connection/localDoor.ts`), whose clients
     * hold no grant.
     */
    open?: () => Promise<WebSocket>;
  } = {},
): Promise<ConnectionClient> {
  const socket = options.open
    ? await options.open()
    : options.tamper
      ? await tamperedSocket(grant, options.tamper)
      : await dialHome(grant, options.dial);
  const pushes: ReceivedPush[] = [];
  const lives: ReceivedLive[] = [];
  const asked: { channel: string; args: unknown }[] = [];
  const answers = new Map<number, (frame: HomeFrame) => void>();
  const watchers = new Set<() => void>();
  let welcome: Welcome | undefined;
  let welcomed: (frame: Welcome) => void = () => {};
  const firstWelcome = new Promise<Welcome>((resolve) => {
    welcomed = resolve;
  });
  let nextId = 0;
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  const parts = new FramePartsReader();
  socket.on("message", (raw) => {
    const text = parts.read(Buffer.isBuffer(raw) ? raw : String(raw));
    if (text === undefined) return;
    const frame = homeFrameSchema.parse(JSON.parse(text));
    if (frame.t === "welcome") {
      welcome = frame;
      welcomed(frame);
    } else if (frame.t === "push") {
      // Kept as the wire spelled it; checked against the contract by its own name.
      const channel = frame.channel as PushChannel;
      pushContract[ownChannel(channel) as PushChannel].payload.parse(frame.payload);
      pushes.push({ seq: frame.seq, channel, payload: frame.payload });
      for (const watcher of watchers) watcher();
    } else if (frame.t === "live") {
      // A push channel's payload is checked against the contract; a picture rides its own channel.
      const own = ownChannel(frame.channel) as PushChannel;
      if (own in pushContract) pushContract[own].payload.parse(frame.payload);
      lives.push({ channel: frame.channel, payload: frame.payload });
      for (const watcher of watchers) watcher();
    } else if (frame.t === "invoke") {
      asked.push({ channel: frame.channel, args: frame.args });
      const answer = options.answer;
      if (!answer) return;
      const reply = (outcome: { ok: true; value: unknown } | { ok: false; error: string }) =>
        socket.send(JSON.stringify({ t: "result", id: frame.id, ...outcome }));
      Promise.resolve()
        .then(() => answer(frame.channel, frame.args))
        .then(
          (value) => reply({ ok: true, value }),
          (error: unknown) =>
            reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
    } else if (frame.t === "result" && typeof frame.id === "number") {
      answers.get(frame.id)?.(frame);
      answers.delete(frame.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`refused: ${response.statusCode}`)),
    );
  });
  if (options.hello !== false) {
    socket.send(
      JSON.stringify({
        t: "hello",
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        ...(options.changes ? { changes: options.changes } : {}),
        ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        ...(options.nameOnly ? { nameOnly: true } : {}),
        ...(options.as ? { as: options.as } : {}),
        ...(options.viewFloor !== undefined ? { viewFloor: options.viewFloor } : {}),
        ...options.system,
        ...(options.spellings === null ? {} : { spellings: options.spellings ?? SPELLINGS }),
        cursor: options.cursor,
      }),
    );
    // Caught up means holding every push up to the welcome's number: after
    // a replay, the missed pushes follow the welcome on the wire.
    const { catchUp, seq } = await firstWelcome;
    if (catchUp === "replay" && seq > (options.cursor?.seq ?? 0))
      await new Promise<void>((resolve) => {
        const look = () => {
          if ((pushes.at(-1)?.seq ?? 0) < seq) return;
          watchers.delete(look);
          resolve();
        };
        watchers.add(look);
        look();
      });
  }
  const welcomeFrame = () => {
    if (!welcome) throw new Error("the home has not welcomed this client");
    return welcome;
  };
  return {
    get welcome() {
      return welcomeFrame();
    },
    pushes,
    lives,
    cursor: () => ({
      epoch: welcomeFrame().epoch,
      seq: pushes.at(-1)?.seq ?? welcomeFrame().seq,
    }),
    push: (match) =>
      new Promise((resolve) => {
        const look = () => {
          const found = pushes.find(match);
          if (!found) return;
          watchers.delete(look);
          resolve(found);
        };
        watchers.add(look);
        look();
      }),
    invoke: (channel, args) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        answers.set(id, (frame) => {
          if (frame.t !== "result") return;
          if (!frame.ok) return reject(new Error(frame.error));
          resolve(invokeContract[channel].response.parse(frame.value) as never);
        });
        socket.send(JSON.stringify({ t: "invoke", id, channel, args }));
      }),
    asked,
    get joined() {
      return parts.joined;
    },
    sendRaw: (text) => socket.send(text),
    closed,
    close: () => {
      socket.close();
      return closed;
    },
  };
}
