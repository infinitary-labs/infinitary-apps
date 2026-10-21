import { join } from "node:path";
import type { Spelling } from "@shared/codeNames";
import type { DeviceGrant, DeviceView } from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
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
 */
async function home(options: { speaks?: Spelling; changes?: readonly string[] } = {}) {
  const core = standInCore();
  const left: DeviceView[] = [];
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-home-link-"), "devices"),
    onProblem: () => {},
    onLeft: (device) => left.push(device),
  });
  const port = await claimedPort();
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
    /** The contract changes its hello lists. */
    changes?: readonly string[];
  } = {},
) {
  const states: HomeLinkState[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  const catchUps: ("replay" | "reload")[] = [];
  const sockets: WebSocket[] = [];
  /** Every frame on the wire, as the device wrote it and as it heard it. */
  const wire: { sent: Record<string, unknown>[]; heard: Record<string, unknown>[] } = {
    sent: [],
    heard: [],
  };
  const link = new HomeLink({
    grant,
    dial: async (dialing) => {
      const socket = await dialHome(dialing);
      sockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = ((data: string, ...rest: never[]) => {
        wire.sent.push(JSON.parse(String(data)));
        return send(data, ...rest);
      }) as typeof socket.send;
      socket.on("message", (raw) => wire.heard.push(JSON.parse(String(raw))));
      return socket;
    },
    ...(options.speaks ? { speaks: options.speaks } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    onPush: (channel, payload) => pushes.push({ channel, payload }),
    onCaughtUp: (catchUp) => catchUps.push(catchUp),
    onState: (state) => states.push(state),
    ...(options.onInvoke ? { onInvoke: options.onInvoke } : {}),
    retryMs: options.retryMs ?? [20],
    pingMs: options.pingMs ?? 60_000,
  });
  stops.push(() => link.close());
  const until = async (check: () => boolean) => {
    await expect.poll(check, { timeout: 4_000, interval: 10 }).toBe(true);
  };
  return { link, states, pushes, catchUps, sockets, wire, until };
}

/**
 * Runs `body` with setTimeout and clearTimeout faked, only while the test
 * whose signal it takes still runs (INF-722). Vitest moves on from a test
 * past its budget but lets its body go on, and a late body on the fake clock
 * fires the next tests' timers and fails each of them. So a late body fakes
 * nothing, a timeout during `body` hands real timers back before the next
 * test starts, and the body goes no further.
 */
async function withFakeTimers(signal: AbortSignal, body: () => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const restore = () => vi.useRealTimers();
  signal.addEventListener("abort", restore, { once: true });
  try {
    await body();
  } finally {
    signal.removeEventListener("abort", restore);
    // Once aborted, real timers are back already, and the next test may have faked its own.
    if (!signal.aborted) restore();
  }
  signal.throwIfAborted();
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
    // It never said the home was out of reach: the drop was mended at once.
    expect(air.states.some((state) => state.contact === "lost")).toBe(false);
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
      await withFakeTimers(signal, async () => {
        setTimeout(() => controller.abort(reason), PLACED_REQUEST_WAIT_MS);
        await vi.advanceTimersByTimeAsync(PLACED_REQUEST_WAIT_MS);
        expect(await outcome).toMatchObject([
          { status: "rejected", reason: { name: "Error", everSent: sent, cause: reason } },
        ]);
      });
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
