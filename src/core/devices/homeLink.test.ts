import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardSchema } from "@shared/cards";
import type { Spelling } from "@shared/codeNames";
import type { DeviceGrant, DeviceView } from "@shared/devices";
import type { HomeMoved } from "@shared/homeMove";
import { HOME_CAPABILITIES, PROTOCOL_VERSION, parseInvokeRequest } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type HomeConnection,
  startConnection,
  type WorkDeviceVersion,
} from "../connection/connection";
import {
  CONTRACT_CHANGES,
  contractChange,
  listsChange,
  readContractChanges,
} from "../connection/contractChanges";
import { FramePartsReader } from "../connection/frameParts";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { PLACED_REQUEST_WAIT_MS, PLACED_TOOL_WAIT_MS } from "../helper/toolWait";
import { thisDeviceSystem } from "../platform";
import { asDeviceName } from "./computerName";
import { claimLink, dialHome, HOME_DIAL_TIMEOUT_MS } from "./dial";
import {
  HOME_WELCOME_TIMEOUT_MS,
  HomeLink,
  type HomeLinkState,
  HomeOutOfReachError,
} from "./homeLink";
import { type HeardTakeOver, writeHomeNumber } from "./homeNumber";
import { DevicePairing } from "./pairing";

/**
 * The device's side of the connection (docs/view.md) against the real
 * connection, the real pairing over a scratch folder and a stand-in core:
 * what it asks and hears while the home is in reach, what it refuses while
 * the home is out of reach, how it catches up after a drop and after the
 * home restarts, and how Leave and a Remove at the home end it.
 */

function standInCore() {
  const asked: { channel: string; args: unknown }[] = [];
  const dispatch = (async (channel, args) => {
    asked.push({ channel, args });
    // A read the home takes its time over, so a device can go mid-request.
    if (channel === "inf:cards:list") return new Promise(() => {});
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (channel === "inf:cards:close") return { ok: true };
    if (channel === "inf:home-move:start-here")
      return { ok: true, text: "Your first mate starts here again." };
    // A change the home reads against its real contract, as its dispatcher does.
    if (channel === "inf:accounts:add" || channel === "inf:task:run")
      return { added: parseInvokeRequest(channel, args) };
    // A work request the home holds until the test lets it answer.
    if (channel === "inf:work:progress") return held.then(() => ({ text: "Noted." }));
    throw new Error(`Rejected ${channel}: malformed request`);
  }) as CoreDispatch;
  let answer: () => void = () => {};
  let held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return {
    dispatch,
    asked,
    events: new CoreEventBus(),
    /** The held work request answers from now on. */
    answerWork: () => answer(),
    holdWork: () => {
      held = new Promise<void>((resolve) => {
        answer = resolve;
      });
    },
  };
}

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/**
 * A home on a free loopback port that can stop and start listening again,
 * keeping its pairing; `speaks` stands in the spelling of channel names it
 * writes, as a home that moved to Infinitary writes its own, and `changes`
 * the contract changes its welcome lists.
 *
 * Its pairing has no network of its own and names the port it listens on,
 * so its welcome offers only that loopback address. Offering this
 * computer's own addresses at the app's port sent a device whose home had
 * quit to whatever answers there, and a listener that never answered held
 * its dial past every wait for the home to read out of reach.
 */
async function home(
  options: { speaks?: Spelling; changes?: readonly string[]; startedByCommand?: boolean } = {},
) {
  const core = standInCore();
  const left: DeviceView[] = [];
  const dir = join(scratchDir("infinitary-home-link-"), "devices");
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir,
    onProblem: () => {},
    onLeft: (device) => left.push(device),
    interfaces: () => ({}),
    port,
  });
  const at = `127.0.0.1:${port}`;
  let connection: HomeConnection | null = null;
  const listen = async () => {
    connection = startConnection({
      ...core,
      devices: pairing,
      port,
      name: () => "MacBook Pro",
      heartbeatMs: 60_000,
      ...(options.speaks ? { speaks: options.speaks } : {}),
      ...(options.changes ? { changes: options.changes } : {}),
      ...(options.startedByCommand ? { startedByCommand: true } : {}),
    });
    await connection.settled();
  };
  const quit = async () => {
    await connection?.close();
    connection = null;
  };
  stops.push(async () => {
    await quit();
    pairing.dispose();
  });
  await listen();
  return {
    ...core,
    pairing,
    /** The pairing's folder: the home's key and its list of devices. */
    dir,
    at,
    left,
    listen,
    quit,
    /** The home as it is listening now. */
    connection: () => {
      if (!connection) throw new Error("The home is not listening.");
      return connection;
    },
    join: async (name = "MacBook Air"): Promise<DeviceGrant> => {
      const { link } = pairing.invite({ kind: "view", at });
      await connection?.settled();
      return claimLink(link, { kind: "view", name });
    },
    /** Joins as a computer that runs work, as another user on this Mac. */
    joinWork: async (): Promise<DeviceGrant> => {
      const { link } = pairing.invite({ kind: "work", at });
      await connection?.settled();
      return claimLink(link, {
        kind: "work",
        name: "Mac mini",
        user: { name: "builder", uid: (process.getuid?.() ?? 0) + 1 },
      });
    },
  };
}

/** A link from a grant that keeps every state it reports and every push it hears. */
function follow(
  grant: DeviceGrant,
  options: {
    retryMs?: number[];
    pingMs?: number;
    onInvoke?: (channel: string, args: unknown) => Promise<unknown>;
    /** The spelling of channel names it writes, as a device that moved to Infinitary writes its own. */
    speaks?: Spelling;
    /** The contract version its hello advertises, independent of named additions. */
    protocolVersion?: string;
    /** The contract changes its hello lists. */
    changes?: readonly string[];
    /** The highest home number it heard, and what it hears of a move. */
    homeNumber?: number;
    onHomeNumber?: (homeNumber: number) => void;
    onMoved?: (moved: HomeMoved) => void;
    /** The takeover it heard with that number, and what it hears of one. */
    heardTakeOver?: HeardTakeOver;
    onTakeOver?: (heard: HeardTakeOver) => void;
  } = {},
) {
  const states: HomeLinkState[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  /** Each push's place: sent again by a welcome, or new. */
  const replays: boolean[] = [];
  /** Each `live` frame, for this connection alone and never numbered. */
  const lives: { channel: string; payload: unknown }[] = [];
  const catchUps: ("replay" | "reload")[] = [];
  /** Each welcome's count of missed pushes, and the contact it was said under. */
  const welcomes: { missed: number; contact: string }[] = [];
  /** How many pushes had been handled each time a replay ended. */
  const replayed: number[] = [];
  const sockets: WebSocket[] = [];
  /** Every frame on the wire, as the device wrote it and as it heard it. */
  const wire: { sent: Record<string, unknown>[]; heard: Record<string, unknown>[] } = {
    sent: [],
    heard: [],
  };
  /** The frames it heard, a long one joined from its parts (`frame-parts`). */
  const heardParts = new FramePartsReader();
  const link = new HomeLink({
    grant,
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    dial: async (dialing) => {
      const socket = await dialHome(dialing);
      sockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = ((data: string, ...rest: never[]) => {
        wire.sent.push(JSON.parse(String(data)));
        return send(data, ...rest);
      }) as typeof socket.send;
      socket.on("message", (raw) => {
        const text = heardParts.read(raw as Buffer);
        if (text !== undefined) wire.heard.push(JSON.parse(text));
      });
      return socket;
    },
    ...(options.speaks ? { speaks: options.speaks } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    onPush: (channel, payload, replayed) => {
      pushes.push({ channel, payload });
      replays.push(replayed);
    },
    onLive: (channel, payload) => lives.push({ channel, payload }),
    onWelcoming: (_catchUp, missed) => welcomes.push({ missed, contact: link.state().contact }),
    onCaughtUp: (catchUp) => catchUps.push(catchUp),
    onReplayed: () => replayed.push(pushes.length),
    onState: (state) => states.push(state),
    ...(options.onInvoke ? { onInvoke: options.onInvoke } : {}),
    ...(options.homeNumber ? { homeNumber: options.homeNumber } : {}),
    ...(options.onHomeNumber ? { onHomeNumber: options.onHomeNumber } : {}),
    ...(options.onMoved ? { onMoved: options.onMoved } : {}),
    ...(options.heardTakeOver ? { heardTakeOver: options.heardTakeOver } : {}),
    ...(options.onTakeOver ? { onTakeOver: options.onTakeOver } : {}),
    retryMs: options.retryMs ?? [20],
    pingMs: options.pingMs ?? 60_000,
  });
  stops.push(() => link.close());
  const until = async (check: () => boolean) => {
    await expect.poll(check, { timeout: 4_000, interval: 10 }).toBe(true);
  };
  return {
    link,
    states,
    pushes,
    replays,
    lives,
    catchUps,
    welcomes,
    replayed,
    sockets,
    wire,
    until,
    /** How many frames came in parts. */
    joined: () => heardParts.joined,
  };
}

/**
 * Runs `body` with setTimeout and clearTimeout faked, in one go: it is
 * synchronous (its type refuses an async body), so no other code runs while
 * the fake clock is installed, and only the timers `body` sets land on it
 * (INF-761). A link's own retry, due on
 * the real clock, would otherwise fire inside the section on a loaded Mac and
 * leave its next dial and retry on the fake clock, where an advance spins
 * through them or real timers drop them. A body past its test's budget fakes
 * nothing (INF-722): Vitest moves on from such a test but lets its body go on,
 * and a late body would fake the clock under the next test.
 */
function withFakeTimers(signal: AbortSignal, body: () => undefined): void {
  signal.throwIfAborted();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
}

describe("the device's side of the connection", () => {
  // INF-335: the journey's 5 s poll expired while a first attempt was still
  // valid. Drive the two sequential phases on a fake clock, not runner load.
  it.each(["welcome", "timeout"] as const)(
    "keeps a slow first dial reaching until its separate welcome limit: %s",
    async (outcome) => {
      const at = await home();
      const grant = await at.joinWork();
      let socket: WebSocket | undefined;
      let opened: () => void = () => {};
      const opening = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let settled: () => void = () => {};
      const settling = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const states: HomeLinkState["contact"][] = [];
      const link = new HomeLink({
        grant,
        onPush: () => {},
        onState: (state) => {
          states.push(state.contact);
          if (state.contact !== "reaching") settled();
        },
        dial: async (dialing) => {
          // A pending dial, then the real pinned TLS and WebSocket. Pause
          // incoming frames at open so the real home's welcome waits too.
          await new Promise((resolve) => setTimeout(resolve, HOME_DIAL_TIMEOUT_MS - 1));
          socket = await dialHome(dialing);
          socket.once("open", () => {
            socket?.pause();
            opened();
          });
          return socket;
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        link.start();
        await vi.advanceTimersByTimeAsync(HOME_DIAL_TIMEOUT_MS - 1);
        await opening;
        expect(link.state().contact).toBe("reaching");
        // More than the old poll's entire allowance, after a slow dial.
        await vi.advanceTimersByTimeAsync(5_001);
        expect(link.state().contact).toBe("reaching");
        expect(states).toEqual([]);
        const welcomeWait = HOME_WELCOME_TIMEOUT_MS - (outcome === "welcome" ? 1 : 0);
        await vi.advanceTimersByTimeAsync(welcomeWait - 5_001);
        if (outcome === "welcome") {
          expect(link.state().contact).toBe("reaching");
          socket?.resume();
          await settling;
          expect(link.state()).toMatchObject({ contact: "in-reach", takesWork: true });
          expect(states).toEqual(["in-reach"]);
        } else {
          await settling;
          expect(link.state().contact).toBe("lost");
          expect(states).toEqual(["lost"]);
        }
        console.info(
          `[first-contact] dial wait=${HOME_DIAL_TIMEOUT_MS - 1}ms; welcome wait=${welcomeWait}ms; contact=${link.state().contact}`,
        );
      } finally {
        socket?.resume();
        link.close();
        vi.useRealTimers();
      }
    },
  );

  it("is welcomed with the home's name, asks what a view may, and hears every push", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    expect(air.link.state()).toMatchObject({ name: "MacBook Pro", access: "full", removed: false });
    expect(air.catchUps).toEqual(["reload"]);
    await expect(air.link.invoke("inf:app:healthcheck", [])).resolves.toMatchObject({ ok: true });
    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.length === 1);
    expect(air.pushes[0]).toEqual({ channel: "inf:models:changed", payload: { ok: true } });
    // Its hello said what this computer is, and the home keeps it beside its kind.
    expect(at.pairing.list()[0]).toMatchObject({ kind: "view", ...thisDeviceSystem() });
  });

  // INF-3153: Subscriptions asks `accounts.add(id, type, undefined)` with no
  // enterprise host, and JSON wrote the empty argument as null, which the home refused.
  it("sends a request whose last arguments are empty as the home's contract reads it", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await expect(
      air.link.invoke("inf:accounts:add", ["claude", "oauth", undefined]),
    ).resolves.toEqual({ added: ["claude", "oauth"] });
  });

  // INF-3159: a panel's move names its panel after an empty review, which no
  // JSON array can leave off, so the home reads that null as no review.
  it("sends a panel's task move with no review as the home's contract reads it", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await expect(
      air.link.invoke("inf:task:run", ["INF-1", "start-task", undefined, { panel: "Board" }]),
    ).resolves.toEqual({ added: ["INF-1", "start-task", null, { panel: "Board" }] });
  });

  // docs/connection.md: current peers read frame parts without a named addition;
  // a view from before major 15 that never listed the addition still receives one whole frame.
  it("reads a long push the home sends in parts as one push, and one sent whole as before", async () => {
    const at = await home();
    const grant = await at.join();
    const line = "<p>High water at the outer mark, and the pilot boat waiting.</p>";
    const card = cardSchema.parse({
      id: "card-tide-table",
      title: "The season's tide table",
      author: "firstmate",
      priority: 15,
      meta: "First mate",
      body: line.repeat(1_000),
      actions: [],
      status: "ready",
      createdAt: 1000,
      seen: true,
    });
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    at.events.emit("inf:cards", [card]);
    await air.until(() => air.pushes.length === 1);
    expect(air.pushes[0]).toEqual({ channel: "inf:cards", payload: [card] });
    expect(air.joined()).toBe(1);
    air.link.close();

    // Empty names alone do not make a current-major peer older.
    const older = follow(grant, { protocolVersion: "14.0.0", changes: [] });
    older.link.start();
    await older.until(() => older.link.state().contact === "in-reach");
    at.events.emit("inf:cards", [card]);
    await older.until(() => older.pushes.length === 1);
    expect(older.pushes[0]).toEqual({ channel: "inf:cards", payload: [card] });
    expect(older.joined()).toBe(0);
  });

  // A home on major 15 that does not name `every-view-asks` still says a command started it, and a view reads on.
  it("reads the welcome of an older home that still says a command started it", async () => {
    const run = follow(await (await home({ startedByCommand: true })).join());
    run.link.start();
    await run.until(() => run.link.state().contact === "in-reach");
    await expect(
      run.link.invoke("inf:accounts:add", ["claude", "oauth", undefined]),
    ).resolves.toEqual({ added: ["claude", "oauth"] });
  });

  it("holds a read asked while it is still reaching the home, and sends it once welcomed", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    const answer = air.link.invoke("inf:app:healthcheck", []);
    await expect(answer).resolves.toMatchObject({ ok: true });
  });

  it("refuses a change at once while the home is out of reach, and never sends it later", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await at.quit();
    await air.until(() => air.link.state().contact === "closed");
    // As of the last moment it heard the home.
    expect(air.link.state().heardAt).not.toBeNull();
    await expect(air.link.invoke("inf:cards:close", ["card-1"])).rejects.toBeInstanceOf(
      HomeOutOfReachError,
    );
    // So is a read: nothing is on its way to the home.
    await expect(air.link.invoke("inf:app:healthcheck", [])).rejects.toBeInstanceOf(
      HomeOutOfReachError,
    );
    await at.listen();
    await air.until(() => air.link.state().contact === "in-reach");
    // A home that started listening again is a new run: the device reads everything again.
    expect(air.catchUps).toEqual(["reload", "reload"]);
    expect(at.asked.filter((asked) => asked.channel === "inf:cards:close")).toEqual([]);
  });

  it("catches up exactly what it missed after a drop, in order", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.length === 1);
    // The device's own socket goes; the home keeps numbering what it misses.
    air.sockets.at(-1)?.terminate();
    at.events.emit("inf:cards", []);
    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.catchUps.length === 2);
    await air.until(() => air.pushes.length === 3);
    expect(air.catchUps).toEqual(["reload", "replay"]);
    expect(air.pushes.map((push) => push.channel)).toEqual([
      "inf:models:changed",
      "inf:cards",
      "inf:models:changed",
    ]);
    // INF-4207 piece 2: the welcome says how many it missed before the state turns in reach, and
    // the replay's end is said once its last push is handled, so a view says live only then.
    expect(air.welcomes.map((welcome) => welcome.missed)).toEqual([0, 2]);
    expect(air.welcomes[0]?.contact).toBe("reaching");
    expect(air.replayed).toEqual([3]);
    // The two it missed came again with the welcome, and it can tell them
    // from a new push: a page to open is opened only as it arrives.
    at.events.emit("inf:cards", []);
    await air.until(() => air.pushes.length === 4);
    expect(air.replays).toEqual([false, true, true, false]);
    // It never said the home was out of reach: the drop was mended at once.
    expect(air.states.some((state) => state.contact === "lost")).toBe(false);
  });

  // INF-3750's option D: streamed reply pieces filled the journal, so a short drop read everything again.
  it("hears a streamed reply live, catches up past it after a drop, and an older view still hears it", async () => {
    const at = await home();
    const air = follow(await at.join());
    const older = follow(await at.join(), { protocolVersion: "15.0.0", changes: [] });
    for (const view of [air, older]) view.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await older.until(() => older.link.state().contact === "in-reach");
    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.length === 1);
    air.sockets.at(-1)?.terminate();
    const piece = {
      type: "assistant_delta",
      taskId: "t1",
      text: "The harbour opens at six.",
    } as const;
    at.events.emit("inf:event", piece);
    at.events.emit("inf:cards", []);
    await air.until(() => air.catchUps.length === 2);
    await air.until(() => air.pushes.length === 2);
    // Missed while away, never replayed: the drop still catches up push by push.
    expect(air.catchUps).toEqual(["reload", "replay"]);
    expect(air.pushes.map((push) => push.channel)).toEqual(["inf:models:changed", "inf:cards"]);
    at.events.emit("inf:event", piece);
    await air.until(() => air.lives.length === 1);
    expect(air.lives).toEqual([{ channel: "inf:event", payload: piece }]);
    // A view from before the change hears both as pushes under the newest number, as before.
    await older.until(() => older.pushes.length === 4);
    expect(older.lives).toEqual([]);
    expect(older.pushes.map((push) => push.channel)).toEqual([
      "inf:models:changed",
      "inf:event",
      "inf:cards",
      "inf:event",
    ]);
    expect(older.link.state().contact).toBe("in-reach");
  });

  it("refuses a request in flight when the connection goes, and does not ask it again", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    const asked = air.link.invoke("inf:cards:list", []);
    await air.until(() => at.asked.some((entry) => entry.channel === "inf:cards:list"));
    air.sockets.at(-1)?.terminate();
    await expect(asked).rejects.toBeInstanceOf(HomeOutOfReachError);
    await air.until(() => air.catchUps.length === 2);
    expect(at.asked.filter((entry) => entry.channel === "inf:cards:list")).toHaveLength(1);
  });

  it("is told when the home removes it, and stops dialing", async () => {
    const at = await home();
    const grant = await at.join();
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    at.pairing.remove(grant.deviceId);
    await air.until(() => air.link.state().removed);
    await expect(air.link.invoke("inf:app:healthcheck", [])).rejects.toBeInstanceOf(
      HomeOutOfReachError,
    );
  });

  it("learns it was removed while it was away from the home refusing it twice", async () => {
    const at = await home();
    // Another Mac keeps the home listening once this one is gone.
    await at.join("Mac mini");
    const grant = await at.join();
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await at.quit();
    await air.until(() => air.link.state().contact === "closed");
    at.pairing.remove(grant.deviceId);
    await at.listen();
    await air.until(() => air.link.state().removed);
  });

  it("leaves: the home takes it off its list and says so by its name", async () => {
    const at = await home();
    const grant = await at.join();
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await expect(air.link.leave()).resolves.toBe(true);
    expect(at.pairing.list()).toEqual([]);
    expect(at.left.map((device) => device.name)).toEqual(["MacBook Air"]);
    // Leaving is not being removed.
    expect(air.link.state().removed).toBe(false);
  });

  it("answers false to Leave while the home is out of reach, which still lists it", async () => {
    const at = await home();
    const grant = await at.join();
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await at.quit();
    await air.until(() => air.link.state().contact === "closed");
    await expect(air.link.leave()).resolves.toBe(false);
    expect(at.pairing.list().map((device) => device.id)).toEqual([grant.deviceId]);
  });

  it("says the home is out of reach when it never reached it", async () => {
    const at = await home();
    const grant = await at.join();
    await at.quit();
    const air = follow(grant);
    air.link.start();
    await air.until(() => air.link.state().contact === "lost");
    expect(air.link.state().heardAt).toBeNull();
  });

  // Main's check failed on two uncaught "WebSocket was closed before the
  // connection was established" errors: a computer's restart closed its link
  // while a dial was under way, and the link ended the socket that dial
  // handed back with nothing listening for the error its unfinished
  // handshake raises, which would end the process that holds the link.
  it("ends the socket a dial hands back after the link was closed, raising nothing", async () => {
    const at = await home();
    const grant = await at.join();
    let letDial: () => void = () => {};
    const dialing = new Promise<void>((resolve) => {
      letDial = resolve;
    });
    let ended: (socket: WebSocket) => void = () => {};
    const closed = new Promise<WebSocket>((resolve) => {
      ended = resolve;
    });
    const link = new HomeLink({
      grant,
      onPush: () => {},
      dial: async (dialed) => {
        await dialing;
        const socket = await dialHome(dialed);
        // Heard here, so the close cannot pass before anyone listens; never
        // through `events.once`, whose own error listener would hide the bug.
        socket.once("close", () => ended(socket));
        return socket;
      },
    });
    link.start();
    link.close();
    letDial();
    const socket = await closed;
    expect(socket.readyState).toBe(socket.CLOSED);
  });
});

describe("a device when the first mate moves to another computer", () => {
  /**
   * The same record at number 2 on another computer: a move's destination,
   * or with `takeOver`, a computer that kept a copy and took over by that id.
   */
  async function movedHome(
    from: Awaited<ReturnType<typeof home>>,
    { takeOver, name = "Mac mini" }: { takeOver?: string; name?: string } = {},
  ) {
    const dir = join(scratchDir("infinitary-home-link-moved-"), "devices");
    cpSync(from.dir, dir, { recursive: true });
    writeHomeNumber(dir, 2);
    // As the takeover writes it in the record it starts from (src/core/standby/takeOver.ts).
    if (takeOver)
      writeFileSync(
        join(dir, "take-over.json"),
        JSON.stringify({
          version: 1,
          id: takeOver,
          at: Date.now(),
          homeNumber: 2,
          deviceId: name === "Mac mini" ? "mini" : "studio",
          name,
          stream: "c3f0e2a4-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
          seq: 41,
        }),
      );
    // Only its own loopback address, as `home` offers.
    const port = await claimedPort();
    const pairing = new DevicePairing({ dir, onProblem: () => {}, interfaces: () => ({}), port });
    const core = standInCore();
    const connection = startConnection({
      ...core,
      devices: pairing,
      port,
      name: () => name,
      heartbeatMs: 60_000,
    });
    await connection.settled();
    stops.push(async () => {
      await connection.close();
      pairing.dispose();
    });
    return { ...core, at: `127.0.0.1:${port}`, connection, pairing };
  }

  // Intent: the plan's journey "two homes with one number stop and ask" (docs/devices.md,
  // "Two homes with one number"): two copies that each took over reach the same number.
  it("keeps the takeover it heard with a number, and refuses a second home that says that number with another takeover", async () => {
    const pro = await home();
    const grant = await pro.join();
    await pro.quit();
    const first = "6f1c1a52-8d1e-4d7a-9a51-2f0d7c1e4b11";
    const second = "0b8e3f7a-4c2d-4e5f-8a9b-1c2d3e4f5a6b";
    const mini = await movedHome(pro, { takeOver: first });
    const studio = await movedHome(pro, { takeOver: second, name: "Mac Studio" });

    const heard: HeardTakeOver[] = [];
    const air = follow({ ...grant, at: mini.at }, { onTakeOver: (each) => heard.push(each) });
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    expect(heard).toEqual([{ number: 2, id: first }]);
    expect(air.link.state().twoHomes).toBeUndefined();

    // Kept across a restart, it dials the other copy that took over at the same number.
    const stray = follow({ ...grant, at: studio.at }, { homeNumber: 2, heardTakeOver: heard[0] });
    stray.link.start();
    await stray.until(() => stray.link.state().twoHomes !== undefined);
    expect(stray.link.state().twoHomes).toEqual({ name: "Mac Studio" });
    expect(stray.states.map((state) => state.contact)).not.toContain("in-reach");

    // A device that never heard which takeover made its home takes either, as one from before did.
    const before = follow({ ...grant, at: studio.at }, { homeNumber: 2 });
    before.link.start();
    await before.until(() => before.link.state().contact === "in-reach");
    expect(before.link.state().twoHomes).toBeUndefined();
  });

  // Intent: the captain's choice for two homes that cannot reach each other: "The window
  // tells both computers; each pauses and asks" (docs/devices.md, "Two homes with one number").
  it("a window that hears a second home tells it of the home it follows, and that home of the second", async () => {
    const pro = await home();
    const grant = await pro.join();
    await pro.quit();
    const first = "6f1c1a52-8d1e-4d7a-9a51-2f0d7c1e4b11";
    const second = "0b8e3f7a-4c2d-4e5f-8a9b-1c2d3e4f5a6b";
    const mini = await movedHome(pro, { takeOver: first });
    const studio = await movedHome(pro, { takeOver: second, name: "Mac Studio" });
    // Each keeps the other as a copy, so each welcome lists the other's address too.
    mini.pairing.offerCopies(() => [[studio.at]]);
    studio.pairing.offerCopies(() => [[mini.at]]);
    const told = (at: { asked: { channel: string; args: unknown }[] }) =>
      at.asked.filter((each) => each.channel === "inf:standby:other-home");

    // The window followed Mac mini's home 2, and dials Mac Studio first after a restart.
    const window = follow(
      { ...grant, at: studio.at, also: [mini.at] },
      { homeNumber: 2, heardTakeOver: { number: 2, id: first } },
    );
    window.link.start();
    await window.until(() => window.link.state().contact === "in-reach");
    expect(window.link.state().twoHomes).toEqual({ name: "Mac Studio" });
    // Mac Studio heard of the home the window follows, where it answers.
    await vi.waitFor(() => expect(told(studio)).toHaveLength(1));
    expect(told(studio)[0]?.args).toEqual([
      { name: null, homeNumber: 2, takeOver: first, addresses: [mini.at] },
    ]);
    // Mac mini heard of Mac Studio on its welcome, where Mac Studio answered first.
    await vi.waitFor(() => expect(told(mini)).toHaveLength(1));
    const [ofStudio] = (told(mini)[0]?.args ?? []) as [{ addresses: string[] }];
    expect(ofStudio).toMatchObject({ name: "Mac Studio", homeNumber: 2, takeOver: second });
    expect(ofStudio.addresses[0]).toBe(studio.at);
  });

  it("follows the move frame to the new home and keeps its number, then refuses the home the move left behind", async () => {
    const pro = await home();
    const grant = await pro.join();
    const mini = await movedHome(pro);
    const numbers: number[] = [];
    const moves: HomeMoved[] = [];
    const air = follow(grant, {
      onHomeNumber: (number) => numbers.push(number),
      onMoved: (moved) => moves.push(moved),
    });
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    expect(air.link.state().name).toBe("MacBook Pro");

    const moved = { homeNumber: 2, addresses: [mini.at], to: "mini", name: "Mac mini" };
    await pro.connection().moved(moved);
    await air.until(
      () => air.link.state().contact === "in-reach" && air.link.state().name === "Mac mini",
    );
    expect(numbers).toEqual([2]);
    expect(moves).toEqual([moved]);

    // A device that heard number 2 dials the old address, where number 1 answers again: it never takes it.
    await pro.listen();
    const old = follow({ ...grant, at: pro.at }, { homeNumber: 2 });
    old.link.start();
    await old.until(() => old.link.state().contact === "lost");
    expect(old.states.map((state) => state.contact)).not.toContain("in-reach");
  });

  it("follows the old home that started the first mate again above the move's number, and refuses the destination if it comes back", async () => {
    const pro = await home();
    const grant = await pro.join();
    // The destination took the record at number 2 and never answered the old home.
    const mini = await movedHome(pro);
    const numbers: number[] = [];
    const air = follow(grant, { onHomeNumber: (number) => numbers.push(number) });
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    // The captain starts the first mate on the old home again: it takes number 3, never lower.
    pro.pairing.raiseHomeNumber(3);
    pro.pairing.raiseHomeNumber(2);
    await pro.quit();
    await air.until(() => air.link.state().contact !== "in-reach");
    await pro.listen();
    await air.until(() => air.link.state().contact === "in-reach" && numbers.includes(3));
    expect(air.link.state().name).toBe("MacBook Pro");

    // A device that heard number 3 reaching the destination, at number 2, never takes it.
    const stray = follow({ ...grant, at: mini.at }, { homeNumber: 3 });
    stray.link.start();
    await stray.until(() => stray.link.state().contact === "lost");
    expect(stray.states.map((state) => state.contact)).not.toContain("in-reach");
  });

  it("refuses a view's change while the first mate moves, but lets Start my first mate here again through", async () => {
    const pro = await home();
    const air = follow(await pro.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    const holding = "Your first mate is moving to Mac mini. Try again once it has.";
    pro.connection().hold(holding);
    await expect(air.link.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(holding);
    await expect(air.link.invoke("inf:home-move:start-here", [])).resolves.toEqual({
      ok: true,
      text: "Your first mate starts here again.",
    });
    expect(pro.asked.map((asked) => asked.channel)).toContain("inf:home-move:start-here");
    expect(pro.asked.map((asked) => asked.channel)).not.toContain("inf:cards:close");
  });

  it("leaves a work request unanswered while the home moves, and the new home answers it once", async () => {
    const pro = await home();
    const grant = await pro.joinWork();
    const mini = await movedHome(pro);
    const { link, states, until } = follow(grant);
    link.start();
    await until(() => states.at(-1)?.contact === "in-reach");

    pro.connection().hold("Your first mate is moving to Mac mini. Try again once it has.");
    const request = [{ task: "t1", callId: "call-1", text: "While it moves." }];
    const answered = link.ask("inf:work:progress", request);
    await pro.connection().moved({ homeNumber: 2, addresses: [mini.at], to: "mini" });
    await until(() => mini.asked.length === 1);
    mini.answerWork();
    expect(await answered).toEqual({ text: "Noted." });
    // The old home never ran it: the move's record carries nothing it did after the stop.
    expect(pro.asked.filter((each) => each.channel === "inf:work:progress")).toEqual([]);
    expect(mini.asked).toEqual([{ channel: "inf:work:progress", args: request }]);
    expect(link.waiting()).toBe(0);
  });
});

describe("a computer that runs work, on its side of the connection", () => {
  // Intent: INF-311's accepted window 3 guard withdraws both never-sent and previously-sent calls.
  it.for([false, true])(
    "withdraws an expired request permanently (sent before drop: %s) (INF-312)",
    async (sent, { signal }) => {
      expect(PLACED_REQUEST_WAIT_MS).toBeLessThan(PLACED_TOOL_WAIT_MS);
      const at = await home();
      const grant = await at.joinWork();
      const { link, states, until } = follow(grant);
      link.start();
      await until(() => states.at(-1)?.contact === "in-reach");
      const controller = new AbortController();
      if (!sent) {
        await at.quit();
        await until(() => states.at(-1)?.contact !== "in-reach");
      }
      const answer = link.ask(
        "inf:work:progress",
        [{ task: "t1", callId: "expired", text: "Hi." }],
        controller.signal,
      );
      const reason = new Error("Caller withdrew its request");
      // Settled, never rejected: a test abandoned past its budget leaves no
      // rejection unhandled for a later test to be blamed for (INF-722).
      const outcome = Promise.allSettled([answer]);
      if (sent) {
        await until(() => at.asked.length === 1);
        await at.quit();
        await until(() => states.at(-1)?.contact !== "in-reach");
      }
      withFakeTimers(signal, () => {
        setTimeout(() => controller.abort(reason), PLACED_REQUEST_WAIT_MS);
        vi.advanceTimersByTime(PLACED_REQUEST_WAIT_MS);
      });
      expect(await outcome).toMatchObject([
        { status: "rejected", reason: { name: "Error", everSent: sent, cause: reason } },
      ]);
      expect(link.waiting()).toBe(0);
      const requests = at.asked.length;
      await at.listen();
      await until(() => states.at(-1)?.contact === "in-reach");
      expect(at.asked).toHaveLength(requests);
      console.info("Window 3 recovery:", {
        sent,
        waiting: link.waiting(),
        requestsAfterReturn: at.asked.length,
      });
    },
  );

  it("asks a work request again on each new connection until the home answers it, and then once", async () => {
    const at = await home();
    const { link, states, until } = follow(await at.joinWork());
    link.start();
    await until(() => states.at(-1)?.contact === "in-reach");
    const request = [{ task: "t1", callId: "call-1", text: "Across a quit." }];
    const answered = link.ask("inf:work:progress", request);
    await until(() => at.asked.length === 1);

    // Firstmate quits at the home mid-request, and opens again.
    await at.quit();
    await until(() => states.at(-1)?.contact !== "in-reach");
    expect(link.waiting()).toBe(1);
    await at.listen();
    await until(() => at.asked.length === 2);
    at.answerWork();
    expect(await answered).toEqual({ text: "Noted." });
    expect(at.asked).toEqual([
      { channel: "inf:work:progress", args: request },
      { channel: "inf:work:progress", args: request },
    ]);
    expect(link.waiting()).toBe(0);
  });

  it("answers what the home asks it on the connection it was asked on, refusals included", async () => {
    const at = await home();
    const grant = await at.joinWork();
    const { link, states, until } = follow(grant, {
      onInvoke: async (channel) => {
        if (channel === "inf:session:roster") return { tasksDir: "/w/tasks", tasks: [] };
        throw new Error(`${channel} is not a request this computer answers.`);
      },
    });
    link.start();
    await until(() => states.at(-1)?.contact === "in-reach");
    expect(await at.connection().ask(grant.deviceId, "inf:session:roster", [])).toEqual({
      tasksDir: "/w/tasks",
      tasks: [],
    });
    await expect(at.connection().ask(grant.deviceId, "inf:session:launch", [])).rejects.toThrow(
      "not a request this computer answers",
    );
    // A device that answers nothing refuses every request.
    const plain = await at.joinWork();
    const silent = follow(plain);
    silent.link.start();
    await silent.until(() => silent.states.at(-1)?.contact === "in-reach");
    await expect(at.connection().ask(plain.deviceId, "inf:session:roster", [])).rejects.toThrow(
      "not a request this device answers",
    );
  });

  it("ends a work request unanswered only when it stops", async () => {
    const at = await home();
    const { link, states, until } = follow(await at.joinWork());
    link.start();
    await until(() => states.at(-1)?.contact === "in-reach");
    at.holdWork();
    const asked = link.ask("inf:work:progress", [{ task: "t1", callId: "call-2", text: "Hi." }]);
    await until(() => at.asked.length === 1);
    link.close();
    await expect(asked).rejects.toThrow(HomeOutOfReachError);
    await expect(link.ask("inf:work:progress", [])).rejects.toThrow(HomeOutOfReachError);
  });
});

/**
 * Two spellings of channel names (the Infinitary rename, FI3-1780 step 2;
 * docs/connection.md "Two spellings"): each side writes its own spelling to
 * a side that says it reads it, and Firstmate 3000's otherwise, and reads
 * either as its own. The update order keeps its one name. A home and a
 * device stand in Infinitary's side with `speaks`.
 */
describe("a home and a device on two sides of the Infinitary rename", () => {
  const channelsOf = (frames: Record<string, unknown>[], t: string) =>
    frames.filter((frame) => frame.t === t).map((frame) => frame.channel);

  it("reads a Firstmate 3000 home's pushes and orders as its own, and the update order keeps its one name", async () => {
    // A home that writes Firstmate 3000's names and reads both, as the bridge does.
    const at = await home({ speaks: "fm" });
    const grant = await at.joinWork();
    const asked: string[] = [];
    const mini = follow(grant, {
      onInvoke: async (channel) => {
        asked.push(channel);
        return { restarts: true };
      },
    });
    mini.link.start();
    await mini.until(() => mini.link.state().contact === "in-reach");
    // Its hello said it reads both, and the home's welcome said so too.
    expect(mini.wire.sent[0]).toMatchObject({ t: "hello", spellings: ["fm", "inf"] });
    expect(mini.wire.heard[0]).toMatchObject({ t: "welcome", spellings: ["fm", "inf"] });

    await at.connection().ask(grant.deviceId, "inf:session:open", []);
    await at.connection().ask(grant.deviceId, "fm:firstmate:update", [], { anyVersion: true });
    expect(channelsOf(mini.wire.heard, "invoke")).toEqual([
      "fm:session:open",
      "fm:firstmate:update",
    ]);
    expect(asked).toEqual(["inf:session:open", "fm:firstmate:update"]);
    // What it asks goes in its own spelling, which the home said it reads.
    at.answerWork();
    await expect(mini.link.ask("inf:work:progress", { id: "a" })).resolves.toEqual({
      text: "Noted.",
    });
    expect(channelsOf(mini.wire.sent, "invoke")).toEqual(["inf:work:progress"]);
  });

  it("writes its pushes in Infinitary's names, and Firstmate 3000's to a device from before the rename", async () => {
    const at = await home();
    const air = follow(await at.join());
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    // A device whose hello says nothing of spellings, as one from before the rename.
    const old = await connectClient(await at.join("Old Mac"), { spellings: null });
    expect(old.welcome).toMatchObject({ spellings: ["fm", "inf"] });

    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.length === 1);
    expect(air.pushes[0]).toEqual({ channel: "inf:models:changed", payload: { ok: true } });
    expect(channelsOf(air.wire.heard, "push")).toEqual(["inf:models:changed"]);
    const heard = await old.push((push) => (push.channel as string) === "fm:models:changed");
    // Both were sent the same push under the same number.
    expect(heard.seq).toBe(air.wire.heard.find((frame) => frame.t === "push")?.seq);
    await old.close();
  });

  it("answers a device that writes Firstmate 3000's names, as the bridge does", async () => {
    const at = await home();
    const air = follow(await at.join(), { speaks: "fm" });
    air.link.start();
    await air.until(() => air.link.state().contact === "in-reach");
    await expect(air.link.invoke("inf:app:healthcheck", [])).resolves.toMatchObject({ ok: true });
    await expect(air.link.invoke("inf:cards:close", ["card-1"])).resolves.toEqual({ ok: true });
    expect(channelsOf(air.wire.sent, "invoke")).toEqual(["fm:app:healthcheck", "fm:cards:close"]);
    // The home's core heard them by its own names.
    expect(at.asked.map(({ channel }) => channel)).toEqual([
      "inf:app:healthcheck",
      "inf:cards:close",
    ]);
    // It said it reads both, so it is written Infinitary's.
    at.events.emit("inf:models:changed", { ok: true });
    await air.until(() => air.pushes.length === 1);
    expect(channelsOf(air.wire.heard, "push")).toEqual(["inf:models:changed"]);
  });
});

/**
 * Contract changes by name (INF-519, the captain's choice that a feature
 * waits for the other computer by name: each computer lists its changes when
 * it connects): a computer's hello and its home's welcome list this build's
 * changes, each side keeps what the other listed, and a side from before
 * names lists nothing, so it has no change.
 */
describe("a home and a computer that list their contract changes", () => {
  // A change at the next minor, which a feature would wait for.
  const limits = contractChange(
    "plan-label-limits",
    readContractChanges([`major-${CONTRACT_CHANGES.major}.md`, "plan-label-limits.md"]),
  );

  it("lists this build's changes in the hello and the welcome, and each side keeps the other's", async () => {
    const at = await home();
    const heard: (WorkDeviceVersion | null)[] = [];
    at.connection().onWorkVersion((_device, version) => heard.push(version));
    const mini = follow(await at.joinWork());
    expect(mini.link.state().homeChanges).toBeNull();
    mini.link.start();
    await mini.until(() => mini.link.state().contact === "in-reach");
    const [hello] = mini.wire.sent;
    const [welcome] = mini.wire.heard;
    expect(hello?.changes ?? []).toEqual(CONTRACT_CHANGES.names);
    expect(welcome?.changes ?? []).toEqual(CONTRACT_CHANGES.names);
    expect(mini.link.state().homeChanges).toEqual(CONTRACT_CHANGES.names);
    await expect.poll(() => heard.at(-1)?.changes ?? []).toEqual(CONTRACT_CHANGES.names);
  });

  it("has a change only from a side that listed it", async () => {
    const at = await home({ changes: ["plan-label-limits"] });
    const heard: (WorkDeviceVersion | null)[] = [];
    at.connection().onWorkVersion((_device, version) => heard.push(version));
    const grant = await at.joinWork();
    const mini = follow(grant, { changes: ["plan-label-limits"] });
    mini.link.start();
    await mini.until(() => mini.link.state().contact === "in-reach");
    expect(listsChange(mini.link.state().homeChanges, limits)).toBe(true);
    await expect.poll(() => listsChange(heard.at(-1)?.changes, limits)).toBe(true);
    mini.link.close();
    await expect.poll(() => heard.at(-1)).toBeNull();

    // A computer from before names says none, so its home gives it no change.
    const older = follow(grant, { changes: [] });
    older.link.start();
    await older.until(() => older.link.state().contact === "in-reach");
    expect(older.wire.sent[0]).not.toHaveProperty("changes");
    await expect.poll(() => heard.at(-1)).toMatchObject({ takesWork: true });
    expect(heard.at(-1)).not.toHaveProperty("changes");
    expect(listsChange(heard.at(-1)?.changes, limits)).toBe(false);
  });

  it("gives a home from before names no change", async () => {
    const at = await home({ changes: [] });
    const mini = follow(await at.joinWork(), { changes: ["plan-label-limits"] });
    mini.link.start();
    await mini.until(() => mini.link.state().contact === "in-reach");
    expect(mini.wire.heard[0]).not.toHaveProperty("changes");
    expect(mini.link.state().homeChanges).toEqual([]);
    expect(listsChange(mini.link.state().homeChanges, limits)).toBe(false);
  });
});

describe("a device's own name", () => {
  it("keeps what a device may carry and cuts it to length", () => {
    expect(asDeviceName("  Sam's MacBook Air \n")).toBe("Sam's MacBook Air");
    expect(asDeviceName("x".repeat(80))).toBe("x".repeat(64));
    expect(asDeviceName("")).toBeNull();
    expect(asDeviceName("bad‮name")).toBeNull();
  });
});
