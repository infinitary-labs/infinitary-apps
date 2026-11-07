import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer as createPlainServer, connect as plainConnect, type Socket } from "node:net";
import { join } from "node:path";
import { connect, createServer as createTlsServer } from "node:tls";
import { cardMessageSchema, cardSchema, cardThreadSchema, pastCardSchema } from "@shared/cards";
import { CONNECTION_CLOSE, PAIR_PATH } from "@shared/connection";
import { PLACED_WORK_SINCE } from "@shared/contractFeatures";
import { HOME } from "@shared/deviceNames";
import { type DeviceGrant, type DeviceKind, parsePairingLink } from "@shared/devices";
import {
  type CoreInvokeChannel,
  HOME_CAPABILITIES,
  isRunViewInvokeChannel,
  PROTOCOL_VERSION,
  RUN_HOME_ONLY_CHANNELS,
} from "@shared/ipc";
import { publishedContract } from "@shared/publishedContract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  claimLink,
  type DeviceKey,
  dialHome,
  HomeKeyMismatchError,
  type PairRefusedError,
  pinnedSocket,
} from "../devices/dial";
import { createKeyIdentity } from "../devices/identity";
import { DevicePairing, type DevicePairingOptions } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import {
  type ConnectionOptions,
  DeviceOutOfReachError,
  type HomeConnection,
  type PairedDevices,
  startConnection,
  type ViewDeviceContact,
  type WorkDeviceContact,
} from "./connection";

/**
 * The connection with the real event bus, the real pairing over a scratch
 * folder, and a stand-in core behind `dispatch`, so each rule is driven on
 * its own: when it listens, how a device joins and proves itself, how pushes
 * are numbered and caught up, which requests reach the core, and what is
 * refused before any frame. src/core/core.connection.test.ts drives the real core.
 */

function standInCore() {
  const asked: { channel: string; args: unknown; actor: unknown }[] = [];
  const dispatch = (async (channel, args, actor) => {
    asked.push({ channel, args, actor });
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (channel === "inf:work:progress") return { text: "Noted." };
    throw new Error(`Rejected ${channel}: malformed request`);
  }) as CoreDispatch;
  return { dispatch, asked, events: new CoreEventBus() };
}

/**
 * A version too old to hold a conversation: one minor before `PLACED_WORK_SINCE` while
 * the home is on that major, otherwise the major before the home's (which takes no new work).
 */
function beforePlacedWork(): string {
  const [major, minor] = PLACED_WORK_SINCE.split(".").map(Number);
  const [homeMajor = 1] = PROTOCOL_VERSION.split(".").map(Number);
  if (homeMajor > (major ?? 1)) return `${homeMajor - 1}.0.0`;
  return minor ? `${major}.${minor - 1}.0` : `${(major ?? 1) - 1}.99.0`;
}

/** Whether anything accepts a connection on loopback at that port. */
function answersAt(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A clock and a timer list the test moves by hand. */
function manualClock() {
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule: ((ms, run) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    }) satisfies DevicePairingOptions["schedule"],
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

const open: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

async function home(
  options: Partial<Omit<ConnectionOptions, "devices">> & {
    pairing?: Omit<DevicePairingOptions, "dir">;
  } = {},
) {
  const { pairing: pairingOptions, ...connectionOptions } = options;
  const core = standInCore();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-connection-"), "devices"),
    onProblem: () => {},
    ...pairingOptions,
  });
  pairings.push(pairing);
  const port = options.port ?? (await claimedPort());
  const connection = startConnection({ ...core, ...connectionOptions, devices: pairing, port });
  open.push(connection);
  const at = `127.0.0.1:${port}`;
  return {
    ...core,
    pairing,
    connection,
    port,
    at,
    link: (kind: DeviceKind = "view") => pairing.invite({ kind, at }).link,
    /** Makes a link, waits for the listener, and joins with it as the device itself would. */
    join: async (kind: DeviceKind = "view", name = "Test Mac"): Promise<DeviceGrant> => {
      const { link } = pairing.invite({ kind, at });
      await connection.settled();
      return claimLink(link, { kind, name, ...(kind === "work" ? { user: ANOTHER_USER } : {}) });
    },
  };
}

// INF-1156: the existing real TLS handshake carries optional authenticated alternatives.
it("refreshes dial alternatives in a welcome without changing the paired identity", async () => {
  const at = await home();
  const grant = await at.join();
  const client = await connectClient(grant);
  try {
    expect(client.welcome).toMatchObject({ addresses: at.pairing.offerTargets(true) });
    expect(at.pairing.list().map((device) => device.id)).toContain(grant.deviceId);
  } finally {
    await client.close();
  }
});

/**
 * A computer that runs work dials these homes from loopback, so it runs as a
 * user other than the one this process runs as, as another user on the
 * home's own Mac would (docs/helper.md).
 */
const ANOTHER_USER = { name: "builder", uid: (process.getuid?.() ?? 0) + 1 };

const changed = (events: CoreEventBus) => events.emit("inf:models:changed", { ok: true });

/**
 * Posts to `/pair` over a pinned socket, the way a device would but with any
 * body or header, showing a fresh key of its own unless told which or none.
 */
async function postPair(
  at: string,
  key: string,
  request: {
    method?: string;
    contentType?: string;
    origin?: string;
    body?: string;
    device?: DeviceKey | null;
    /** Sends the body without a length, in chunks. */
    chunked?: boolean;
  },
): Promise<{ status: number; body: string }> {
  const device = request.device === undefined ? createKeyIdentity("Device") : request.device;
  const socket = await pinnedSocket({ address: at }, key, device);
  const [host, port] = at.split(":");
  return new Promise((resolve, reject) => {
    const asked = httpsRequest(
      {
        host,
        port: Number(port),
        method: request.method ?? "POST",
        path: PAIR_PATH,
        headers: {
          ...(request.contentType === undefined
            ? { "content-type": "application/json" }
            : request.contentType
              ? { "content-type": request.contentType }
              : {}),
          ...(request.origin ? { origin: request.origin } : {}),
        },
        createConnection: () => socket,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    asked.on("error", reject);
    if (request.chunked && request.body) {
      asked.write(request.body);
      asked.end();
    } else asked.end(request.body);
  });
}

/** A real device that stops reading before the home quits, delaying its close reply. */
async function pausedDevice(grant: DeviceGrant, hello = true) {
  const ws = await dialHome(grant);
  const closed = once(ws, "close").then(([code]) => code as number);
  await once(ws, "open");
  if (hello) {
    ws.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION }));
    await once(ws, "message");
  }
  ws.pause();
  return { ws, closed };
}

describe("the home's connection", () => {
  it("waits for every device to hear closing before quit resolves, including a repeated close", async () => {
    const at = await home();
    const fast = await connectClient(await at.join());
    const slow = await pausedDevice(await at.join());
    const workGrant = await at.join("work");
    const work = await pausedDevice(workGrant);
    const quiet = await pausedDevice(await at.join(), false);
    const gone: WorkDeviceContact[] = [];
    at.connection.onWorkDevice((contact) => gone.push(contact));
    const asked = at.connection.ask(workGrant.deviceId, "inf:session:roster", []);
    void asked.catch(() => {});
    let finished = false;
    let repeatedFinished = false;
    const closing = at.connection.close().then(() => {
      finished = true;
    });
    const repeated = at.connection.close().then(() => {
      repeatedFinished = true;
    });
    try {
      expect(await fast.closed).toBe(CONNECTION_CLOSE.closing);
      expect(at.connection.listening()).toEqual([]);
      expect(await answersAt(at.port)).toBe(false);
      expect(finished).toBe(false);
      expect(repeatedFinished).toBe(false);
      // One slow view does not delay sending closing to the others, and
      // hearing just one device is not enough to finish quitting.
      slow.ws.resume();
      expect(await slow.closed).toBe(CONNECTION_CLOSE.closing);
      work.ws.resume();
      expect(await work.closed).toBe(CONNECTION_CLOSE.closing);
      expect(finished).toBe(false);
      quiet.ws.resume();
      expect(await quiet.closed).toBe(CONNECTION_CLOSE.closing);
      await Promise.all([closing, repeated]);
      await expect(asked).rejects.toThrow(DeviceOutOfReachError);
      expect(gone).toEqual([{ deviceId: workGrant.deviceId, contact: "gone" }]);
    } finally {
      for (const device of [slow, work, quiet]) device.ws.resume();
      await Promise.all([closing, repeated, slow.closed, work.closed, quiet.closed]);
    }
  });

  it("ends unresponsive devices after one shared two-second grace, rather than holding quit open", async () => {
    const at = await home();
    const fast = await connectClient(await at.join());
    const slow = await pausedDevice(await at.join());
    const work = await pausedDevice(await at.join("work"));
    // Only the shutdown timers are virtual; the TLS sockets remain real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finished = false;
    const closing = at.connection.close().then(() => {
      finished = true;
    });
    try {
      expect(await fast.closed).toBe(CONNECTION_CLOSE.closing);
      await vi.advanceTimersByTimeAsync(1999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(finished).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      slow.ws.resume();
      work.ws.resume();
      await Promise.all([closing, slow.closed, work.closed]);
    }
  });

  it("listens while a link is open or something is paired, and stops when the last pairing goes", async () => {
    const at = await home();
    await at.connection.settled();
    expect(at.connection.listening()).toEqual([]);
    expect(await answersAt(at.port)).toBe(false);

    const grant = await at.join();
    expect(at.connection.listening()).toEqual([`127.0.0.1:${at.port}`]);
    const a = await connectClient(grant);
    expect(a.welcome.protocolVersion).toBe(PROTOCOL_VERSION);

    at.pairing.remove(grant.deviceId);
    expect(await a.closed).toBe(CONNECTION_CLOSE.unpaired);
    await at.connection.settled();
    expect(at.connection.listening()).toEqual([]);
    expect(await answersAt(at.port)).toBe(false);
  });

  it("stops listening when an unused link expires with nothing paired", async () => {
    const clock = manualClock();
    const at = await home({ pairing: clock });
    at.link();
    await at.connection.settled();
    expect(at.connection.listening()).toHaveLength(1);

    clock.advance(10 * 60 * 1000);
    await at.connection.settled();
    expect(at.connection.listening()).toEqual([]);
    expect(await answersAt(at.port)).toBe(false);
  });

  it("joins once with a link, and refuses a wrong, used or expired link", async () => {
    const clock = manualClock();
    const at = await home({ pairing: clock });
    const link = at.link("view");
    await at.connection.settled();
    const grant = await claimLink(link, { kind: "view", name: "Studio Mac" });
    expect(grant).toMatchObject({ at: at.at, kind: "view", homeKey: parsePairingLink(link).key });
    expect(at.pairing.list()).toEqual([
      // It dialed loopback, so the home saw it join from this Mac.
      {
        id: grant.deviceId,
        kind: "view",
        name: "Studio Mac",
        pairedAt: clock.now(),
        onThisMac: true,
      },
    ]);

    const refusal = (text: string) =>
      claimLink(text, { kind: "view", name: "Another Mac" }).then(
        () => "joined",
        (error: PairRefusedError) => error.refused,
      );
    expect(await refusal(link)).toBe("used");
    const wrong = link.replace(/code=[^&]+/, `code=${"A".repeat(43)}`);
    expect(await refusal(wrong)).toBe("unknown");
    const late = at.link("view");
    clock.advance(10 * 60 * 1000 - 1);
    const stillOpen = at.link("view");
    clock.advance(1);
    expect(await refusal(late)).toBe("expired");
    expect(await refusal(stillOpen)).toBe("joined");
    expect(at.pairing.list().map((device) => device.name)).toEqual(["Studio Mac", "Another Mac"]);
  });

  it("refuses a link for the other kind without spending it", async () => {
    const at = await home();
    const link = at.link("work");
    await at.connection.settled();
    // The device refuses before it dials...
    await expect(claimLink(link, { kind: "view", name: "Laptop" })).rejects.toMatchObject({
      refused: "kind",
    });
    // ...and the home refuses a device that says it is the other kind.
    const { key, code } = parsePairingLink(link);
    const asked = await postPair(at.at, key, {
      body: JSON.stringify({ code, kind: "view", name: "Laptop" }),
    });
    expect(asked.status).toBe(409);
    expect(JSON.parse(asked.body)).toMatchObject({ refused: "kind" });
    expect(asked.body).not.toContain(code);
    // The link is still good for the computer it was made for.
    await expect(
      claimLink(link, { kind: "work", name: "Mini", user: ANOTHER_USER }),
    ).resolves.toMatchObject({ kind: "work" });
  });

  it("refuses work run as the home's own user on its own Mac, and keeps the link", async () => {
    const at = await home();
    const link = at.link("work");
    await at.connection.settled();
    const asHome = { name: "sam", uid: process.getuid?.() ?? 0 };
    await expect(
      claimLink(link, { kind: "work", name: "MacBook Pro", user: asHome }),
    ).rejects.toMatchObject({ refused: "same-user" });
    expect(at.pairing.list()).toEqual([]);
    const grant = await claimLink(link, { kind: "work", name: "MacBook Pro", user: ANOTHER_USER });
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({ id: grant.deviceId, user: "builder", onThisMac: true }),
    ]);
  });

  it("keeps /pair to one bounded JSON post from a device showing a key of its own, never from a browser", async () => {
    const at = await home();
    const link = at.link();
    await at.connection.settled();
    const { key, code } = parsePairingLink(link);
    const body = JSON.stringify({ code, kind: "view", name: "Laptop" });
    const statuses = [
      (await postPair(at.at, key, { body, device: null })).status,
      (await postPair(at.at, key, { body, origin: "https://example.com" })).status,
      (await postPair(at.at, key, { method: "GET" })).status,
      (await postPair(at.at, key, { body, contentType: "text/plain" })).status,
      (await postPair(at.at, key, { body: JSON.stringify({ code, pad: "x".repeat(5000) }) }))
        .status,
      (
        await postPair(at.at, key, {
          body: JSON.stringify({ code, pad: "x".repeat(5000) }),
          chunked: true,
        })
      ).status,
      (await postPair(at.at, key, { body: "{not json" })).status,
      (await postPair(at.at, key, { body: JSON.stringify({ code, kind: "view" }) })).status,
    ];
    expect(statuses).toEqual([401, 403, 405, 415, 413, 413, 400, 400]);
    expect(at.pairing.list()).toEqual([]);
    // None of those spent the link.
    const device = createKeyIdentity("Laptop");
    const joined = await postPair(at.at, key, { body, device });
    expect(joined.status).toBe(201);
    expect(Object.keys(JSON.parse(joined.body)).sort()).toEqual(["deviceId", "kind"]);
    // The same key cannot join twice, so Remove always cuts it off.
    const again = parsePairingLink(at.link());
    const twice = await postPair(at.at, again.key, {
      body: JSON.stringify({ code: again.code, kind: "view", name: "Laptop again" }),
      device,
    });
    expect([twice.status, JSON.parse(twice.body).refused]).toEqual([409, "paired"]);
  });

  it("sends nothing to a computer that answers with another key", async () => {
    const at = await home();
    const link = at.link();
    await at.connection.settled();
    // An impostor with a key of its own, holding a port as another macOS
    // user could while the home is not listening.
    const impostor = new DevicePairing({
      dir: join(scratchDir("infinitary-impostor-"), "devices"),
    });
    const heard: Buffer[] = [];
    const ended: Promise<void>[] = [];
    const server = createTlsServer({ ...impostor.identity(), minVersion: "TLSv1.3" }, (socket) => {
      socket.on("data", (chunk: Buffer) => heard.push(chunk));
      ended.push(new Promise((resolve) => socket.once("close", () => resolve())));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const pointedAway = link.replace(/at=[^&]+/, `at=127.0.0.1%3A${port}`);
    await expect(claimLink(pointedAway, { kind: "view", name: "Laptop" })).rejects.toBeInstanceOf(
      HomeKeyMismatchError,
    );
    await Promise.all(ended);
    expect(Buffer.concat(heard).length).toBe(0);
    await new Promise((resolve) => server.close(resolve));
    // The real home's link is untouched.
    await expect(claimLink(link, { kind: "view", name: "Laptop" })).resolves.toMatchObject({
      kind: "view",
    });
  });

  it("speaks only TLS, even on loopback", async () => {
    const at = await home();
    at.link();
    await at.connection.settled();
    const answer = await new Promise<string>((resolve) => {
      let text = "";
      const socket = plainConnect(at.port, "127.0.0.1", () =>
        socket.write(
          "GET /connection HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        ),
      );
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
      });
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    expect(answer).not.toContain("HTTP/1.1 101");
    expect(answer).not.toContain("HTTP/1.1 401");
  });

  it("resumes no session, so every connection shows both keys again", async () => {
    const at = await home();
    const grant = await at.join();
    const handshake = (session?: Buffer) =>
      new Promise<{ reused: boolean; session?: Buffer }>((resolve, reject) => {
        let offered: Buffer | undefined;
        const socket = connect(
          {
            port: at.port,
            host: "127.0.0.1",
            servername: "",
            rejectUnauthorized: false,
            key: grant.key,
            cert: grant.cert,
            session,
          },
          // A TLS 1.3 ticket comes right after the handshake, so once an
          // answer to a request is back, any ticket the home sent is here.
          () => socket.write("GET /elsewhere HTTP/1.1\r\nHost: home\r\n\r\n"),
        );
        socket.on("session", (next: Buffer) => {
          offered = next;
        });
        socket.once("data", () => {
          resolve({ reused: socket.isSessionReused(), session: offered });
          socket.destroy();
        });
        socket.once("error", reject);
      });
    const first = await handshake();
    expect(first.session).toBeDefined();
    const second = await handshake(first.session);
    expect(second.reused).toBe(false);
  });

  it("cuts a device in the same call that removes it, and only that device", async () => {
    const at = await home();
    const gone = await at.join("view", "Old Mac");
    const kept = await at.join("view", "New Mac");
    const a = await connectClient(gone);
    const b = await connectClient(kept);

    // A request already on its way when the device is removed is never answered.
    void a.invoke("inf:app:healthcheck", []).catch(() => {});
    at.pairing.remove(gone.deviceId);
    // A push made right after Remove returns reaches only the device that stays.
    changed(at.events);
    await b.push((push) => push.channel === "inf:models:changed");
    expect(await a.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(a.pushes).toEqual([]);
    expect(at.asked).toEqual([]);
    await expect(connectClient(gone)).rejects.toThrow("refused: 401");
  });

  it("refuses a device removed while its connection was being admitted", async () => {
    const at = await home();
    const kept = await at.join("view", "Kept Mac");
    const gone = await at.join("view", "Old Mac");
    // The same pairing behind a seam whose admission removes the device it
    // has just admitted.
    const pairing = at.pairing;
    const seam: PairedDevices = {
      any: () => pairing.any(),
      subscribe: (listener) => pairing.subscribe(listener),
      identity: () => pairing.identity(),
      holds: (id) => pairing.holds(id),
      claim: (body, request) => pairing.claim(body, request),
      leave: (id) => pairing.leave(id),
      admit: (request) => {
        const device = pairing.admit(request);
        if (device?.id === gone.deviceId) pairing.remove(gone.deviceId);
        return device;
      },
    };
    await at.connection.close();
    const connection = startConnection({
      dispatch: at.dispatch,
      events: at.events,
      devices: seam,
      port: at.port,
    });
    open.push(connection);
    await connection.settled();
    await expect(connectClient(gone)).rejects.toThrow("refused: 401");
    await expect(connectClient(kept)).resolves.toMatchObject({ welcome: { catchUp: "reload" } });
  });

  it("numbers each push once, so two devices see the same push under the same number", async () => {
    const at = await home();
    const a = await connectClient(await at.join());
    const b = await connectClient(await at.join());
    expect(a.welcome.epoch).toBe(b.welcome.epoch);
    expect(a.welcome.catchUp).toBe("reload");

    changed(at.events);
    at.events.emit("inf:cards", []);
    const seen = (push: { channel: string }) => push.channel === "inf:cards";
    const [fromA, fromB] = await Promise.all([a.push(seen), b.push(seen)]);
    expect(fromA).toEqual(fromB);
    expect(a.pushes.map((push) => push.seq)).toEqual([1, 2]);
    expect(b.pushes).toEqual(a.pushes);
  });

  it("hands a returning device exactly the pushes it missed, then carries on", async () => {
    const at = await home();
    const grant = await at.join();
    const first = await connectClient(grant);
    changed(at.events);
    await first.push(() => true);
    const cursor = first.cursor();
    await first.close();

    changed(at.events);
    at.events.emit("inf:cards", []);
    const back = await connectClient(grant, { cursor, protocolVersion: "12.0.0", viewFloor: 11 });
    expect(back.welcome.catchUp).toBe("replay");
    expect(back.welcome.seq).toBe(cursor.seq + 2);
    expect(back.pushes.map((push) => [push.seq, push.channel])).toEqual([
      [cursor.seq + 1, "inf:models:changed"],
      [cursor.seq + 2, "inf:cards"],
    ]);
    changed(at.events);
    await back.push((push) => push.seq === cursor.seq + 3);
    expect(back.pushes).toHaveLength(3);
  });

  // INF-2022: the previous desktop card decoder is strict, so capability projection applies to
  // list, live pushes and replay; the phone's extensible reader can receive the optional fields.
  it("keeps old desktop card decoding and actions compatible across lists, pushes and reconnect replay", async () => {
    const card = cardSchema.parse({
      id: "card-findings",
      title: "Latency findings",
      author: "firstmate",
      priority: 15,
      meta: "First mate",
      body: "<p>The sampler has finished.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
      lifecycleId: "findings-life",
      offerId: "findings-offer",
      seen: true,
      currentUpdateId: "released-answer",
      currentUpdateSeen: false,
    });
    const at = await home({
      dispatch: (async (channel) => {
        if (channel === "inf:cards:list") return [card];
        if (channel === "inf:cards:minimize") return { ok: true };
        throw new Error("Unexpected request");
      }) as CoreDispatch,
    });
    const grant = await at.join();
    // A desktop on major 12 without the change still reads cards (it changes nothing below the
    // view floor); one on major 12 naming it, and every client on this major, read the update.
    const old = await connectClient(grant, { protocolVersion: "12.0.0", viewFloor: 11 });
    const newer = await connectClient(grant, {
      protocolVersion: "12.0.0",
      viewFloor: 11,
      changes: ["card-current-update-seen"],
    });
    const current = await connectClient(grant);
    const phone = await connectClient(grant, { system: { system: "ios" } });
    const legacyDecoder = cardSchema.omit({ currentUpdateId: true, currentUpdateSeen: true });
    expect(old.welcome.access).toBe("read");
    const listed = await old.invoke("inf:cards:list", []);
    expect(legacyDecoder.parse(listed[0])).toMatchObject({ id: card.id, seen: true });
    expect(listed[0]?.currentUpdateId).toBeUndefined();
    expect((await newer.invoke("inf:cards:list", []))[0]?.currentUpdateId).toBe(
      card.currentUpdateId,
    );
    expect((await current.invoke("inf:cards:list", []))[0]?.currentUpdateId).toBe(
      card.currentUpdateId,
    );
    expect((await phone.invoke("inf:cards:list", []))[0]?.currentUpdateId).toBe(
      card.currentUpdateId,
    );
    expect(await current.invoke("inf:cards:minimize", [card.id, true])).toEqual({ ok: true });
    expect(await phone.invoke("inf:cards:minimize", [card.id, false])).toEqual({ ok: true });
    at.events.emit("inf:cards", [card]);
    const oldPush = await old.push((push) => push.channel === "inf:cards");
    expect(legacyDecoder.parse((oldPush.payload as unknown[])[0])).toMatchObject({ id: card.id });
    expect((await newer.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
    const cursor = old.cursor();
    await old.close();
    at.events.emit("inf:cards", [{ ...card, currentUpdateSeen: true }]);
    const back = await connectClient(grant, { cursor, protocolVersion: "12.0.0", viewFloor: 11 });
    expect(back.welcome.catchUp).toBe("replay");
    const replay = await back.push((push) => push.seq > cursor.seq);
    expect(legacyDecoder.parse((replay.payload as unknown[])[0])).toMatchObject({ id: card.id });
    expect((replay.payload as { currentUpdateId?: string }[])[0]?.currentUpdateId).toBeUndefined();
    await back.close();
    await newer.close();
    await current.close();
    await phone.close();
  });

  // INF-2225, INF-2214's approved shared cards: a desktop from before shared
  // cards decodes thread lines strictly, so its copy leaves out who
  // contributed a line, what it answers and whether it is a clarification;
  // a current desktop and the phone read them.
  it("keeps an older desktop's thread decoding while current views read who wrote each line", async () => {
    // INF-2555: every answer or push a view reads that carries card lines,
    // read from the published contract, so a channel added later that
    // carries them fails here until an older desktop gets them translated.
    const contract = publishedContract();
    const carriesLines = (schema: unknown) => JSON.stringify(schema).includes('"answersMessage"');
    const asked = Object.entries(contract.requests)
      .filter(
        ([channel, declared]) =>
          isRunViewInvokeChannel(channel as CoreInvokeChannel) && carriesLines(declared.response),
      )
      .map(([channel]) => channel)
      .sort();
    const heard = Object.entries(contract.pushes)
      .filter(([, declared]) => carriesLines(declared.payload))
      .map(([channel]) => channel);

    const contributor = { actor: "crewmate", taskId: "dop208", label: "the crewmate on DOP-208" };
    const thread = cardThreadSchema.parse({
      cardId: "card-fm-required-action-op1",
      messages: [
        {
          id: 1,
          cardId: "card-fm-required-action-op1",
          who: "captain",
          text: "Where is it?",
          at: 1,
        },
        {
          id: 2,
          cardId: "card-fm-required-action-op1",
          who: "crewmate",
          text: "It is at C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd.",
          at: 2,
          contributor,
          answersMessage: 1,
        },
      ],
    });
    const past = pastCardSchema.parse({
      id: "card-fm-old",
      author: "firstmate",
      title: "Remove the job host",
      meta: "First mate",
      body: "<p>Done.</p>",
      actions: [],
      ending: { how: "dismissed", at: 3 },
      answers: [],
      messages: [{ ...thread.messages[1], id: 3, cardId: "card-fm-old", clarification: true }],
    });
    // What each channel answers, with the arguments a view sends it: a
    // reply answers the card's thread, and showing a closed card its past.
    const answers: Record<string, { args: unknown[]; value: unknown }> = {
      "inf:cards:past": { args: [past.id], value: past },
      "inf:cards:reply": { args: [thread.cardId, "Thanks."], value: thread },
      "inf:cards:show": { args: [past.id], value: past },
      "inf:cards:show-past": { args: [past.id], value: past },
      "inf:cards:thread": { args: [thread.cardId], value: thread },
    };
    expect(asked).toEqual(Object.keys(answers).sort());
    expect(heard).toEqual(["inf:cards:thread"]);

    const at = await home({
      dispatch: (async (channel) => {
        const answer = answers[channel];
        if (!answer) throw new Error("Unexpected request");
        return answer.value;
      }) as CoreDispatch,
    });
    const grant = await at.join();
    // A desktop on major 13 without the change reads lines strictly; one that
    // named `shared-cards`, and every view from major 14 on, reads who wrote
    // each line (`SHARED_CARDS_SINCE`).
    const old = await connectClient(grant, { protocolVersion: "13.0.0" });
    const named = await connectClient(grant, {
      protocolVersion: "13.0.0",
      changes: ["shared-cards"],
    });
    const newer = await connectClient(grant);
    const phone = await connectClient(grant, { system: { system: "ios" } });
    // The line an older desktop parses: strict, without who wrote it.
    const legacyLine = cardMessageSchema.omit({
      contributor: true,
      answersMessage: true,
      clarification: true,
    });
    const linesOf = (value: unknown) => (value as { messages: unknown[] }).messages;
    for (const [name, { args, value }] of Object.entries(answers)) {
      const channel = name as CoreInvokeChannel;
      expect(await newer.invoke(channel, args), channel).toEqual(value);
      expect(await phone.invoke(channel, args), channel).toEqual(value);
      // Below the view floor a desktop only reads (major 14): it asks no change.
      if (contract.requests[channel]?.effect === "change") continue;
      const oldLines = linesOf(await old.invoke(channel, args));
      expect(
        oldLines.map((line) => legacyLine.parse(line).text),
        channel,
      ).toEqual(linesOf(value).map((line) => (line as { text: string }).text));
      expect(await named.invoke(channel, args), channel).toEqual(value);
    }
    for (const channel of heard) {
      at.events.emit(channel as "inf:cards:thread", thread);
      const pushed = await old.push((push) => push.channel === channel);
      expect(linesOf(pushed.payload).map((line) => legacyLine.parse(line).id)).toEqual([1, 2]);
      expect((await newer.push((push) => push.channel === channel)).payload).toEqual(thread);
    }
    await old.close();
    await named.close();
    await newer.close();
    await phone.close();
  });

  it("tells a device to reload when its cursor cannot be caught up", async () => {
    const at = await home({ journal: { entries: 2, bytes: 1_000_000 } });
    const grant = await at.join();
    const first = await connectClient(grant);
    const { epoch } = first.welcome;
    for (let i = 0; i < 4; i++) changed(at.events);
    await first.push((push) => push.seq === 4);

    // Too old: only pushes 3 and 4 are kept.
    const old = await connectClient(grant, { cursor: { epoch, seq: 1 } });
    expect(old.welcome).toMatchObject({ catchUp: "reload", epoch, seq: 4 });
    expect(old.pushes).toEqual([]);
    // Kept: pushes 3 and 4 come back.
    const recent = await connectClient(grant, { cursor: { epoch, seq: 2 } });
    expect(recent.welcome.catchUp).toBe("replay");
    expect(recent.pushes.map((push) => push.seq)).toEqual([3, 4]);
    // Another run of the home, or a number it never wrote.
    for (const cursor of [
      { epoch: "an-earlier-run", seq: 4 },
      { epoch, seq: 9 },
    ]) {
      const stale = await connectClient(grant, { cursor });
      expect(stale.welcome.catchUp).toBe("reload");
    }
  });

  it("forwards what a view may ask as the captain, and refuses the rest without asking the core", async () => {
    const at = await home();
    const grant = await at.join("view");
    const a = await connectClient(grant);

    const health = await a.invoke("inf:app:healthcheck", []);
    expect(health.capabilities).toEqual(["connection"]);
    // INF-2631: the captain, naming the view that asked, so a phone's own
    // usage events go under that phone's install ID.
    expect(at.asked).toEqual([
      {
        channel: "inf:app:healthcheck",
        args: [],
        actor: { kind: "captain", view: grant.deviceId },
      },
    ]);
    // The core's own refusal comes back as the answer.
    await expect(a.invoke("inf:cards:act", ["card-1"])).rejects.toThrow("malformed request");

    for (const channel of [
      "inf:settings:routing:set",
      "inf:devices:invite",
      "inf:devices:remove",
      "inf:devices:list",
    ])
      await expect(a.invoke(channel as never, [{}])).rejects.toThrow(
        `answered only on ${HOME.the}`,
      );
    for (const channel of ["inf:app:open-external", "inf:not-a-channel", "__proto__", "toString"])
      await expect(a.invoke(channel as never, [])).rejects.toThrow(
        "not a request this home answers",
      );
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:app:healthcheck", "inf:cards:act"]);
  });

  // INF-1228, the captain's answer control=all: a computer that controls a
  // first mate started by a command, which has no window, does everything
  // that window would; a home with its window keeps the rule above.
  it("answers a view of a first mate started by a command every home request but those that stay there", async () => {
    const run = await home({ startedByCommand: true });
    const grant = await run.join("view");
    const a = await connectClient(grant);
    expect(a.welcome.startedByCommand).toBe(true);

    await expect(a.invoke("inf:settings:routing:set", [{}])).rejects.toThrow("malformed request");
    for (const channel of RUN_HOME_ONLY_CHANNELS)
      await expect(a.invoke(channel, [{}])).rejects.toThrow(`answered only on ${HOME.the}`);
    await expect(a.invoke("inf:work:progress", [{}])).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(run.asked.map((ask) => ask.channel)).toEqual(["inf:settings:routing:set"]);
    expect(run.asked[0]?.actor).toEqual({ kind: "captain", view: grant.deviceId });

    // Only a view hears it, and only from a home a command started.
    const builder = await connectClient(await run.join("work", "Builder"));
    expect(builder.welcome.startedByCommand).toBeUndefined();
    const windowed = await home();
    const b = await connectClient(await windowed.join("view"));
    expect(b.welcome.startedByCommand).toBeUndefined();
  });

  it("answers a device on the home's major in full, and only the reads of any other", async () => {
    // A home two majors past this app's, so a device further behind than the
    // window exists; the rule only reads the two versions.
    const at = await home({ protocolVersion: "3.2.0" });
    const grant = await at.join("view");
    const speaking = (protocolVersion: string) => connectClient(grant, { protocolVersion });
    const current = await speaking("3.0.1");
    const behind = await speaking("2.9.0");
    const older = await speaking("1.56.0");
    const newer = await speaking("4.0.0");
    expect(current.welcome).toMatchObject({ protocolVersion: "3.2.0", access: "full" });
    expect([behind, older, newer].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "read",
    ]);

    // In the window a change reaches the core, whose stand-in refuses it.
    for (const device of [current])
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "malformed request",
      );
    // Outside it a device still reads and is sent every push, and changes nothing.
    for (const device of [behind, older, newer]) {
      expect(await device.invoke("inf:app:healthcheck", [])).toMatchObject({ ok: true });
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "only reads from a home on 3.2.0 until it is updated",
      );
    }
    changed(at.events);
    await Promise.all(
      [behind, older, newer].map((device) =>
        device.push((push) => push.channel === "inf:models:changed"),
      ),
    );
    expect(at.asked.map((ask) => ask.channel)).toEqual([
      "inf:cards:close",
      "inf:app:healthcheck",
      "inf:app:healthcheck",
      "inf:app:healthcheck",
    ]);
  });

  // INF-1649, the captain's direction A: a floor for every view, while work computers stay strict.
  it("lets a view change things from the home's floor and an older home its own floor reaches, and work only on its own major", async () => {
    const at = await home({ protocolVersion: "3.2.0", viewFloor: 2 });
    const viewGrant = await at.join("view");
    const behind = await connectClient(viewGrant, { protocolVersion: "2.9.0", viewFloor: 2 });
    const below = await connectClient(viewGrant, { protocolVersion: "1.56.0", viewFloor: 1 });
    const newer = await connectClient(viewGrant, { protocolVersion: "4.0.0", viewFloor: 3 });
    const beyond = await connectClient(viewGrant, { protocolVersion: "4.0.0", viewFloor: 4 });
    const work = await connectClient(await at.join("work", "Mini"), { protocolVersion: "2.9.0" });
    expect(behind.welcome.access).toBe("full");
    expect(newer.welcome.access).toBe("full");
    expect([below, beyond, work].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "read",
    ]);
    // In the window a view's change reaches the core, whose stand-in refuses it.
    for (const device of [behind, newer])
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "malformed request",
      );
    await expect(below.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
      "only reads from a home on 3.2.0 until it is updated",
    );
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:cards:close", "inf:cards:close"]);
  });

  // INF-1649 review R4, the captain's "Keep version-11 views read-only": a computer viewing from
  // before the floor reads closed lists strictly, so it changes things only on the home's major,
  // while a phone from before the floor reads them as text and keeps changing things.
  it("keeps a computer viewing from before the floor on reads, and lets a phone from before it change things", async () => {
    const at = await home({ protocolVersion: "3.2.0", viewFloor: 2 });
    const viewGrant = await at.join("view");
    const computer = await connectClient(viewGrant, {
      protocolVersion: "2.9.0",
      system: { system: "macos" },
    });
    const unsaid = await connectClient(viewGrant, { protocolVersion: "2.9.0" });
    const phone = await connectClient(viewGrant, {
      protocolVersion: "2.9.0",
      system: { system: "ios" },
    });
    expect([computer, unsaid, phone].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "full",
    ]);
    await expect(computer.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
      "only reads from a home on 3.2.0 until it is updated",
    );
    await expect(phone.invoke("inf:cards:close", ["card-1"])).rejects.toThrow("malformed request");
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:cards:close"]);
  });

  it("lets a computer that runs work take new work only on the home's own major", async () => {
    const at = await home({ protocolVersion: "3.2.0" });
    const grant = await at.join("work", "Mini");
    const speaking = (protocolVersion: string) => connectClient(grant, { protocolVersion });
    const [current, behind, newer] = await Promise.all(
      ["3.0.1", "2.9.0", "4.0.0"].map((version) => speaking(version)),
    );
    expect(current?.welcome).toMatchObject({ access: "full", takesWork: true });
    // A previous-major client reads only and takes no work.
    expect(behind?.welcome).toMatchObject({ access: "read", takesWork: false });
    expect(newer?.welcome).toMatchObject({ access: "read", takesWork: false });
    const view = await connectClient(await at.join("view"), { protocolVersion: "3.0.1" });
    expect(view.welcome.takesWork).toBeUndefined();
  });

  // INF-463, the captain's pick on INF-460: "Carry the separate-Mac fact from
  // your Mac on the work grant as a typed field". The home's list knows where
  // a computer joined from; its welcome says it to that computer's work.
  it("tells a computer that runs work whether it runs on the home's own Mac, and tells a view nothing", async () => {
    const here = await home();
    const user = await connectClient(await here.join("work", "Builder"));
    expect(user.welcome.onHomeMac).toBe(true);
    const view = await connectClient(await here.join("view"));
    expect(view.welcome.onHomeMac).toBeUndefined();

    const elsewhere = await home({ pairing: { joinsFromAnotherMac: true } });
    const { link } = elsewhere.pairing.invite({ kind: "mac", at: elsewhere.at });
    await elsewhere.connection.settled();
    const mini = await claimLink(link, { kind: "mac", name: "Mini", user: ANOTHER_USER });
    expect((await connectClient(mini, { as: "work" })).welcome.onHomeMac).toBe(false);
    // The same Mac's window, controlling the home, is told nothing of it.
    expect((await connectClient(mini, { as: "view" })).welcome.onHomeMac).toBeUndefined();
  });

  it("gives work only to a computer whose version can hold a conversation", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const older = await connectClient(grant, { protocolVersion: beforePlacedWork() });
    expect(older.welcome).toMatchObject({ access: "read", takesWork: false });
    // It stays in reach, and is asked nothing and answered no work.
    await expect(at.connection.ask(grant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    await expect(
      older.invoke("inf:work:progress", [{ task: "t1", callId: "c1", text: "Hi." }]),
    ).rejects.toThrow("takes no work from a home");
    expect(at.asked).toEqual([]);
    const current = await connectClient(grant);
    expect(current.welcome).toMatchObject({ takesWork: true });
  });

  it("hears what each connected computer says of its version, taking work or not, and reaches one that takes none only with anyVersion", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const heard: unknown[] = [];
    at.connection.onWorkVersion((deviceId, version) => heard.push({ deviceId, version }));
    // Too old to take work: connected, said, and asked only the update order.
    const older = await connectClient(grant, {
      protocolVersion: beforePlacedWork(),
      appVersion: "0.1.12",
      answer: (channel) => ({ asked: channel }),
    });
    await expect
      .poll(() => heard)
      .toEqual([
        {
          deviceId: grant.deviceId,
          version: { contract: beforePlacedWork(), app: "0.1.12", takesWork: false },
        },
      ]);
    await expect(at.connection.ask(grant.deviceId, "fm:firstmate:update", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    expect(
      await at.connection.ask(grant.deviceId, "fm:firstmate:update", [], { anyVersion: true }),
    ).toEqual({ asked: "fm:firstmate:update" });
    await older.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, version: null });

    // One too old to say its version is told by its contract alone.
    const unsaid = await connectClient(grant);
    await expect
      .poll(() => heard.at(-1))
      .toEqual({
        deviceId: grant.deviceId,
        version: { contract: PROTOCOL_VERSION, takesWork: true },
      });
    // One connection going while another is up says nothing; a view's
    // version is never told; the last going is the next word heard.
    const second = await connectClient(grant, { appVersion: "0.1.30" });
    await expect.poll(() => heard.length).toBe(4);
    await unsaid.close();
    await connectClient(await at.join("view"), { appVersion: "0.1.30" });
    await second.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, version: null });
    expect(heard).toHaveLength(5);
  });

  it("exposes running versions for views and work without confusing a name lookup or a disconnect with a running app (INF-1607)", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const viewGrant = await at.join("view", "Laptop");
    const old = await connectClient(grant, {
      protocolVersion: beforePlacedWork(),
      appVersion: "0.1.12",
    });
    const view = await connectClient(viewGrant, { appVersion: "0.1.30" });
    const observed = [
      { state: "work and view connected", versions: at.connection.runningVersions() },
    ];
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: "0.1.12" },
      { deviceId: viewGrant.deviceId, role: "view", version: "0.1.30" },
    ]);
    const lookup = await connectClient(await at.join("work", "Lookup"), {
      nameOnly: true,
      appVersion: "0.1.30",
    });
    expect(at.connection.runningVersions()).toHaveLength(2);
    observed.push({ state: "name lookup excluded", versions: at.connection.runningVersions() });
    await view.close();
    await expect
      .poll(() => at.connection.runningVersions())
      .toEqual([{ deviceId: grant.deviceId, role: "work", version: "0.1.12" }]);
    await old.close();
    await expect.poll(() => at.connection.runningVersions()).toEqual([]);
    const unsaid = await connectClient(grant);
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: null },
    ]);
    const updated = await connectClient(grant, { appVersion: "0.1.30" });
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: null },
      { deviceId: grant.deviceId, role: "work", version: "0.1.30" },
    ]);
    observed.push({
      state: "two running versions on one computer",
      versions: at.connection.runningVersions(),
    });
    await updated.close();
    await expect
      .poll(() => at.connection.runningVersions())
      .toEqual([{ deviceId: grant.deviceId, role: "work", version: null }]);
    observed.push({
      state: "only unsaid version remains",
      versions: at.connection.runningVersions(),
    });
    await unsaid.close();
    await expect.poll(() => at.connection.runningVersions()).toEqual([]);
    observed.push({ state: "disconnected", versions: at.connection.runningVersions() });
    await lookup.close();
    const evidenceDir = process.env.INFINITARY_VERSION_EVIDENCE_DIR;
    if (evidenceDir)
      writeFileSync(
        join(evidenceDir, "live-connection-versions.json"),
        JSON.stringify(observed, null, 2),
      );
  });

  it("keeps what a device says it is in its hello beside its kind", async () => {
    const at = await home();
    const grant = await at.join("view", "Pocket");
    const phone = await connectClient(grant, { system: { system: "ios", chip: "arm64" } });
    await expect
      .poll(() => at.pairing.list().find((device) => device.id === grant.deviceId))
      .toMatchObject({ kind: "view", system: "ios", chip: "arm64" });
    await phone.close();
    // A device too old to say keeps what it said before.
    await (await connectClient(grant)).close();
    expect(at.pairing.list().find((device) => device.id === grant.deviceId)).toMatchObject({
      system: "ios",
    });
  });

  it("welcomes a join that dials only to hear the home's name, and hears nothing of it as that computer", async () => {
    const at = await home({ name: () => "MacBook Pro" });
    const grant = await at.join("work", "Mini");
    const contacts: WorkDeviceContact[] = [];
    const versions: unknown[] = [];
    at.connection.onWorkDevice((contact) => contacts.push(contact));
    at.connection.onWorkVersion((deviceId, version) => versions.push({ deviceId, version }));
    // The join hears the name and whether its version takes work, as any connection does.
    const join = await connectClient(grant, { appVersion: "0.1.30", nameOnly: true });
    expect(join.welcome).toMatchObject({ name: "MacBook Pro", takesWork: true });
    // Never that computer in reach, its version, or asked anything, while open or once gone.
    await expect(at.connection.ask(grant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    await expect(
      at.connection.ask(grant.deviceId, "fm:firstmate:update", [], { anyVersion: true }),
    ).rejects.toThrow(DeviceOutOfReachError);
    await join.close();
    // Its work's own connection is that computer in reach, as ever.
    const work = await connectClient(grant, { appVersion: "0.1.30" });
    await expect.poll(() => contacts).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
    expect(versions).toEqual([
      {
        deviceId: grant.deviceId,
        version: { contract: PROTOCOL_VERSION, app: "0.1.30", takesWork: true },
      },
    ]);
    // A join hearing the name while its work is connected changes nothing either.
    const again = await connectClient(grant, { nameOnly: true });
    await again.close();
    await work.close();
    await expect.poll(() => contacts.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
    expect(contacts).toHaveLength(2);
    expect(versions).toHaveLength(2);
  });

  it("ignores a frame's fields this version does not know, so adding one is a minor change", async () => {
    const at = await home();
    const grant = await at.join("view");
    const device = await connectClient(grant, { hello: false });
    device.sendRaw(
      JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, later: { field: 1 } }),
    );
    device.sendRaw(
      JSON.stringify({ t: "invoke", id: 1, channel: "inf:app:healthcheck", args: [], later: 2 }),
    );
    await expect.poll(() => at.asked.length).toBe(1);
    expect(at.asked).toEqual([
      {
        channel: "inf:app:healthcheck",
        args: [],
        actor: { kind: "captain", view: grant.deviceId },
      },
    ]);
    await device.close();
  });

  it("sends a computer that runs work no push, and answers it only the work requests", async () => {
    const at = await home();
    const view = await connectClient(await at.join("view"));
    const work = await connectClient(await at.join("work", "Mini"));

    changed(at.events);
    await view.push((push) => push.channel === "inf:models:changed");
    // A request's answer follows any push already sent on the same socket.
    await expect(work.invoke("inf:app:healthcheck", [])).rejects.toThrow(
      `answered only on ${HOME.the}`,
    );
    expect(work.pushes).toEqual([]);
    expect(at.asked).toEqual([]);
  });

  it("lets a Mac hold its window's view and its work at once, each by what its hello says", async () => {
    const at = await home({ pairing: { joinsFromAnotherMac: true } });
    const { link } = at.pairing.invite({ kind: "mac", at: at.at });
    await at.connection.settled();
    const grant = await claimLink(link, { kind: "mac", name: "Mini", user: ANOTHER_USER });
    expect(grant.kind).toBe("mac");
    const views: ViewDeviceContact[] = [];
    const works: WorkDeviceContact[] = [];
    at.connection.onViewDevice((contact) => views.push(contact));
    at.connection.onWorkDevice((contact) => works.push(contact));

    const work = await connectClient(grant, { as: "work" });
    const view = await connectClient(grant, { as: "view" });
    await expect.poll(() => works).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
    await expect.poll(() => views).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);

    // The view is sent pushes and asks as the captain; the work is sent none
    // and asks only the work requests, as the computer it is.
    changed(at.events);
    await view.push((push) => push.channel === "inf:models:changed");
    expect(await view.invoke("inf:app:healthcheck", [])).toMatchObject({ ok: true });
    await expect(work.invoke("inf:app:healthcheck", [])).rejects.toThrow(
      `answered only on ${HOME.the}`,
    );
    const request = [{ task: "t1", callId: "c1", text: "Started." }];
    expect(await work.invoke("inf:work:progress", request)).toEqual({ text: "Noted." });
    await expect(view.invoke("inf:work:progress", request)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(work.pushes).toEqual([]);
    expect(at.asked.map(({ channel, actor }) => ({ channel, actor }))).toEqual([
      { channel: "inf:app:healthcheck", actor: { kind: "captain", view: grant.deviceId } },
      { channel: "inf:work:progress", actor: { kind: "device", deviceId: grant.deviceId } },
    ]);

    // Closing its window leaves its work in reach, and the other way round.
    await view.close();
    await expect.poll(() => views.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
    expect(works).toHaveLength(1);
    await work.close();
    await expect.poll(() => works.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
  });

  it("cuts a device whose hello says it does what its kind never does", async () => {
    const at = await home();
    const said = async (grant: DeviceGrant, as: "view" | "work") => {
      const ws = await dialHome(grant);
      const closed = once(ws, "close").then(([code]) => code as number);
      await once(ws, "open");
      ws.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, as }));
      return closed;
    };
    // A Mac saved when it could only control never runs work, and one saved
    // when it could only run work never controls: each until added again.
    expect(await said(await at.join("view"), "work")).toBe(CONNECTION_CLOSE.protocol);
    expect(await said(await at.join("work", "Mini"), "view")).toBe(CONNECTION_CLOSE.protocol);
    expect(at.asked).toEqual([]);
  });

  it("forwards a work request as the computer that asked it, and refuses it from a view", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const work = await connectClient(grant);
    const view = await connectClient(await at.join("view"));
    const request = [{ task: "t1", callId: "c1", text: "Started." }];

    expect(await work.invoke("inf:work:progress", request)).toEqual({ text: "Noted." });
    await expect(view.invoke("inf:work:progress", request)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(at.asked).toEqual([
      {
        channel: "inf:work:progress",
        args: request,
        actor: { kind: "device", deviceId: grant.deviceId },
      },
    ]);
  });

  it("asks a computer that runs work, hears it come and go, and refuses at once what cannot reach it", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const heard: WorkDeviceContact[] = [];
    at.connection.onWorkDevice((contact) => heard.push(contact));
    // Not connected: refused at once, nothing queued.
    await expect(at.connection.ask(grant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );

    const answering = await connectClient(grant, {
      answer: (channel) => {
        if (channel === "inf:session:roster") return { tasksDir: "/w/tasks", tasks: [] };
        throw new Error(`${channel} is not a request this computer answers.`);
      },
    });
    await expect.poll(() => heard).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
    expect(await at.connection.ask(grant.deviceId, "inf:session:roster", [])).toEqual({
      tasksDir: "/w/tasks",
      tasks: [],
    });
    // The device's refusal is the answer.
    await expect(at.connection.ask(grant.deviceId, "inf:session:launch", [])).rejects.toThrow(
      "not a request this computer answers",
    );
    expect(answering.asked.map((ask) => ask.channel)).toEqual([
      "inf:session:roster",
      "inf:session:launch",
    ]);
    await answering.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });

    // One that goes before it answers: refused, and never asked again here.
    const silent = await connectClient(grant);
    const waiting = at.connection.ask(grant.deviceId, "inf:session:roster", []);
    // Observe rejection when the ask is created, before either socket can close.
    // Keep the original promise rejected for the refusal assertion below.
    void waiting.catch(() => {});
    await expect.poll(() => silent.asked.length).toBe(1);
    await silent.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
    // Let the disconnect rejection cross an event-loop turn before asserting it.
    // Handling it must not depend on which end observes the socket close first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(waiting).rejects.toThrow(DeviceOutOfReachError);
    expect(silent.asked).toEqual([{ channel: "inf:session:roster", args: [] }]);

    // A view is never asked anything.
    const viewGrant = await at.join("view");
    const view = await connectClient(viewGrant);
    await expect(at.connection.ask(viewGrant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    expect(view.asked).toEqual([]);
  });

  it("hears a Mac that controls this Firstmate connect, and go only once its last connection goes", async () => {
    const at = await home();
    const air = await at.join("view", "MacBook Air");
    const heard: ViewDeviceContact[] = [];
    const work: WorkDeviceContact[] = [];
    at.connection.onViewDevice((contact) => heard.push(contact));
    at.connection.onWorkDevice((contact) => work.push(contact));

    // A connection that never says hello controls nothing, so its going says nothing.
    const silent = await connectClient(air, { hello: false });
    await silent.close();
    const first = await connectClient(air);
    await expect.poll(() => heard).toEqual([{ deviceId: air.deviceId, contact: "in-reach" }]);
    // A second connection of the same Mac, then the first goes: it is still here until both are gone.
    const second = await connectClient(air);
    await expect.poll(() => heard.length).toBe(2);
    await first.close();
    await second.close();
    await expect.poll(() => heard.at(-1)?.contact).toBe("gone");
    expect(heard.map((contact) => contact.contact)).toEqual(["in-reach", "in-reach", "gone"]);

    // Removed while connected: cut, and gone.
    const again = await connectClient(air);
    await expect.poll(() => heard.at(-1)?.contact).toBe("in-reach");
    at.pairing.remove(air.deviceId);
    expect(await again.closed).toBe(CONNECTION_CLOSE.unpaired);
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: air.deviceId, contact: "gone" });
    // A view is never a computer that runs work.
    expect(work).toEqual([]);
  });

  it("closes a connection that breaks the protocol", async () => {
    const at = await home();
    const grant = await at.join();

    const early = await connectClient(grant, { hello: false });
    early.sendRaw(JSON.stringify({ t: "invoke", id: 1, channel: "inf:app:healthcheck", args: [] }));
    expect(await early.closed).toBe(CONNECTION_CLOSE.protocol);

    const garbled = await connectClient(grant);
    garbled.sendRaw("{not json");
    expect(await garbled.closed).toBe(CONNECTION_CLOSE.protocol);

    const twice = await connectClient(grant);
    twice.sendRaw(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION }));
    expect(await twice.closed).toBe(CONNECTION_CLOSE.protocol);
    expect(at.asked).toEqual([]);
  });

  it("refuses before any frame a device without its key, a browser, or another path", async () => {
    const at = await home();
    const grant = await at.join();
    const refused = (tamper: Parameters<typeof connectClient>[1]) =>
      connectClient(grant, tamper).then(
        () => "accepted",
        (error: Error) => error.message,
      );

    // Loopback is no shortcut: another macOS user on this Mac reaches the
    // same port and must show a key the home paired.
    expect(await refused({ tamper: { device: null } })).toBe("refused: 401");
    expect(await refused({ tamper: { device: createKeyIdentity("Stranger") } })).toBe(
      "refused: 401",
    );
    expect(await refused({ tamper: { origin: "https://example.com" } })).toBe("refused: 403");
    expect(await refused({ tamper: { path: "/elsewhere" } })).toBe("refused: 404");
    expect(await refused({})).toBe("accepted");
  });

  it("does not cut a device when the named address still binds the same set", async () => {
    // Loopback named as 127.0.0.1 binds the same set as no address. The
    // connection restarts only when the set itself changes.
    let chosen: string | undefined;
    const at = await home({ address: () => chosen });
    const grant = await at.join();
    const a = await connectClient(grant);
    expect(at.connection.listening()).toEqual([`127.0.0.1:${at.port}`]);

    chosen = "127.0.0.1";
    at.link();
    await at.connection.settled();
    expect(at.connection.listening()).toEqual([`127.0.0.1:${at.port}`]);
    expect(await a.invoke("inf:app:healthcheck", [])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("says where it listens each time that changes, and only then", async () => {
    let chosen: string | undefined;
    const at = await home({ address: () => chosen });
    const heard: string[][] = [];
    at.connection.onListening((listening) => heard.push(listening));
    const first = at.pairing.invite({ kind: "view", at: at.at });
    await at.connection.settled();
    expect(heard).toEqual([[`127.0.0.1:${at.port}`]]);
    // Another link, or a new run where it listened before, moves nothing.
    const second = at.pairing.invite({ kind: "view", at: at.at });
    chosen = "127.0.0.1";
    at.pairing.stop(second.id);
    await at.connection.settled();
    expect(heard).toEqual([[`127.0.0.1:${at.port}`]]);
    // No link open and nothing paired: it listens nowhere, and says so.
    at.pairing.stop(first.id);
    await at.connection.settled();
    expect(heard).toEqual([[`127.0.0.1:${at.port}`], []]);
  });

  it("names a refused address and stays off", async () => {
    const problems: string[] = [];
    const at = await home({ address: "0.0.0.0", onProblem: (text) => problems.push(text) });
    await at.join().catch(() => {});
    await at.connection.settled();
    expect(at.connection.listening()).toEqual([]);
    expect(problems[0]).toBe(
      "not listening: The connection never listens on every address at once. Choose one.",
    );
  });
});

/**
 * A link from a device to the home that carries the home's bytes down at
 * `bytesPerSec` and the device's up at once. It reads what the home writes as
 * fast as it comes, as a slow mobile link's carrier does, so the home's
 * writes wait here rather than in its own socket (docs/connection.md,
 * "Pacing and liveness").
 */
async function slowLink(home: string, bytesPerSec: number) {
  const [host, port] = home.split(":");
  const ends = new Set<() => void>();
  const server = createPlainServer((device: Socket) => {
    const upstream = plainConnect({ host, port: Number(port) });
    const held: Buffer[] = [];
    device.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => held.push(chunk));
    const step = 20;
    const tick = setInterval(() => {
      let budget = Math.ceil((bytesPerSec * step) / 1000);
      while (budget > 0 && held.length) {
        const chunk = held[0] as Buffer;
        const part = chunk.subarray(0, budget);
        device.write(part);
        budget -= part.length;
        if (part.length === chunk.length) held.shift();
        else held[0] = chunk.subarray(part.length);
      }
    }, step);
    const end = () => {
      clearInterval(tick);
      device.destroy();
      upstream.destroy();
      ends.delete(end);
    };
    ends.add(end);
    for (const socket of [device, upstream]) {
      socket.on("close", end);
      socket.on("error", end);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The slow link did not listen");
  return {
    dial: { target: { address: `127.0.0.1:${address.port}` }, relay: null },
    close: async () => {
      for (const end of [...ends]) end();
      server.close();
      await once(server, "close");
    },
  };
}

/** A card whose body is about `bytes` long, as a long-running computer's grown record holds. */
function heavyCard(bytes: number) {
  const line = "<p>The harbour log kept every tide, mooring and pilot boat of the season.</p>";
  return cardSchema.parse({
    id: "card-harbour-log",
    title: "The season's harbour log",
    author: "firstmate",
    priority: 15,
    meta: "First mate",
    body: line.repeat(Math.ceil(bytes / line.length)),
    actions: [],
    status: "ready",
    createdAt: 1000,
    lifecycleId: "harbour-life",
    offerId: "harbour-offer",
    seen: true,
  });
}

// INF-2669: the home's ping waited behind everything it was sending, so a device on a slow link was cut while it
// was still receiving. Each home here pings every 250 ms, so a push that takes two seconds to arrive spans eight.
describe("pacing and liveness", () => {
  it("keeps a device that receives a long push slowly, and delivers it whole on one connection", async () => {
    const at = await home({ heartbeatMs: 250, pieceBytes: 1024, aheadMs: 50 });
    const grant = await at.join();
    const link = await slowLink(at.at, 48 * 1024);
    try {
      const heard: ViewDeviceContact[] = [];
      at.connection.onViewDevice((contact) => heard.push(contact));
      const device = await connectClient(grant, { dial: link.dial });
      const card = heavyCard(96 * 1024);
      at.events.emit("inf:cards", [card]);
      const push = await Promise.race([
        device.push((received) => received.channel === "inf:cards"),
        device.closed.then((code) => {
          throw new Error(`The home cut the device (${code}) before the push arrived`);
        }),
      ]);
      const [received] = push.payload as { id: string; body: string }[];
      expect(received?.id).toBe(card.id);
      expect(received?.body).toBe(card.body);
      expect(heard).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
      await device.close();
    } finally {
      await link.close();
    }
  });

  it("still cuts a device that stops reading, though the home has more to send it", async () => {
    const at = await home({ heartbeatMs: 100, pieceBytes: 1024, aheadMs: 50 });
    const grant = await at.join();
    const heard: ViewDeviceContact[] = [];
    at.connection.onViewDevice((contact) => heard.push(contact));
    const frozen = await pausedDevice(grant);
    await expect.poll(() => heard.at(-1)?.contact).toBe("in-reach");
    at.events.emit("inf:cards", [heavyCard(96 * 1024)]);
    await expect.poll(() => heard.at(-1)?.contact, { timeout: 2_000 }).toBe("gone");
    frozen.ws.resume();
    await frozen.closed;
  });
});
