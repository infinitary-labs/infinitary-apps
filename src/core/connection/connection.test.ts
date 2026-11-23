import { connect as plainConnect } from "node:net";
import { join } from "node:path";
import { connect, createServer as createTlsServer } from "node:tls";
import { cardMessageSchema, cardSchema, cardThreadSchema, pastCardSchema } from "@shared/cards";
import { ownChannel } from "@shared/codeNames";
import { CONNECTION_CLOSE, REPLACED_PUSH_CHANNEL } from "@shared/connection";
import { SHARED_CARDS_SINCE } from "@shared/contractFeatures";
import { parsePairingLink } from "@shared/devices";
import { ENDED_CLOSE, ENDED_CORNER, endedLineWords } from "@shared/endedCard";
import { type CoreInvokeChannel, isViewInvokeChannel, PROTOCOL_VERSION } from "@shared/ipc";
import { publishedContract } from "@shared/publishedContract";
import { describe, expect, it, vi } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import {
  ANOTHER_USER,
  answersAt,
  changed,
  home,
  open,
  postPair,
} from "../../../tests/helpers/connectionHome";
import { pausedDevice } from "../../../tests/helpers/pausedDevice";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { claimLink, HomeKeyMismatchError, type PairRefusedError } from "../devices/dial";
import { createKeyIdentity } from "../devices/identity";
import { DevicePairing, type DevicePairingOptions } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import {
  DeviceOutOfReachError,
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

  // INF-3750's option C, the captain's "Start all four": a returning view is sent only the
  // newest whole card list, or reads everything again when that weighs less than the replay.
  describe("catching up on what a whole list replaces", () => {
    const card = (id: string, title: string) =>
      cardSchema.parse({
        id,
        title,
        author: "firstmate",
        priority: 15,
        meta: "First mate",
        body: `<p>${title}: the sampler has finished.</p>`,
        actions: [],
        status: "ready",
        createdAt: 1000,
        lifecycleId: `${id}-life`,
        offerId: `${id}-offer`,
        seen: false,
      });
    const findings = card("card-findings", "Latency findings");
    const plan = card("card-plan", "Plan for the reconnect");
    const review = card("card-review", "Review of the catch-up");
    /** What a view reads first on a reload, as a home with these three cards answers it. */
    const reloads = [
      "inf:cards:list",
      "inf:feed:recent",
      "inf:tasks:board",
      "inf:conversation:last-turn",
      "inf:conversation:state",
      "inf:computers:presence",
    ] as const;
    const reloadReads = (async (channel) => {
      if (channel === "inf:cards:list") return [findings, plan, review];
      if (channel === "inf:feed:recent")
        return [{ kind: "info", text: "INF-3750 reported the catch-up findings", at: 2000 }];
      if (channel === "inf:tasks:board")
        return { seq: 7, at: 2000, projects: [], tasks: [], links: [] };
      if (channel === "inf:conversation:last-turn") return null;
      if (channel === "inf:conversation:state") return { busy: false };
      if (channel === "inf:computers:presence") return [];
      throw new Error(`Unexpected request ${channel}`);
    }) as CoreDispatch;

    it("sends only the newest card list, each earlier one as an empty push under its number", async () => {
      const at = await home({ dispatch: reloadReads });
      const grant = await at.join();
      const first = await connectClient(grant);
      for (const channel of reloads) await first.invoke(channel, []);
      changed(at.events);
      await first.push(() => true);
      const cursor = first.cursor();
      await first.close();

      at.events.emit("inf:cards", [findings]);
      at.events.emit("inf:cards", [findings, plan]);
      changed(at.events);
      at.events.emit("inf:cards", [findings, plan, review]);
      const back = await connectClient(grant, { cursor });
      expect(back.welcome.catchUp).toBe("replay");
      expect(back.pushes.map((push) => [push.seq - cursor.seq, push.channel])).toEqual([
        [1, REPLACED_PUSH_CHANNEL],
        [2, REPLACED_PUSH_CHANNEL],
        [3, "inf:models:changed"],
        [4, "inf:cards"],
      ]);
      expect(back.pushes.at(-1)?.payload).toEqual([findings, plan, review]);
      // A device on the old spelling hears the empty push in its own.
      const old = await connectClient(grant, { cursor, spellings: null });
      expect(old.pushes[0]?.channel).not.toBe(REPLACED_PUSH_CHANNEL);
      expect(ownChannel(old.pushes[0]?.channel ?? "")).toBe(REPLACED_PUSH_CHANNEL);
      await back.close();
      await old.close();
    });

    it("reads everything again when the replay would weigh more than a reload", async () => {
      const at = await home({ dispatch: reloadReads });
      const grant = await at.join();
      const first = await connectClient(grant);
      for (const channel of reloads) await first.invoke(channel, []);
      changed(at.events);
      await first.push(() => true);
      const cursor = first.cursor();
      await first.close();

      // A short gap, one reply line, is lighter than a reload. Streamed pieces of a reply take no number at all
      // (docs/connection.md, "Live pushes"), so the missed pushes here are the first mate's reply lines.
      const reply = (text: string) =>
        at.events.emit("inf:event", { type: "firstmate_reply", text });
      reply("The board is most of the wait.");
      const short = await connectClient(grant, { cursor });
      expect(short.welcome.catchUp).toBe("replay");
      expect(short.pushes.map((push) => push.channel)).toEqual(["inf:event"]);
      await short.close();

      // Many reply lines outweigh reading the three cards, Activity and the board again.
      for (const word of "Most of the catch-up wait is the task board, read whole".split(" "))
        for (let i = 0; i < 4; i++) reply(`${word} is part of the answer.`);
      const long = await connectClient(grant, { cursor });
      expect(long.welcome.catchUp).toBe("reload");
      expect(long.pushes).toEqual([]);
      await long.close();
    });
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

  // INF-3071's ended cards: a major-14 desktop from before them decodes a
  // card strictly, so it gets an ended card without `ended`, as the note
  // whose one Close closes it; a desktop listing the change and the phone read it.
  // INF-3206: the Secrets major absorbs the name; its desktops read ended cards without it.
  it.each([
    { protocolVersion: PROTOCOL_VERSION, changes: [] },
    { protocolVersion: "14.0.0", changes: ["ended-cards"] },
  ])(
    "keeps ended-card decoding across lists, pushes and replay ($protocolVersion)",
    async (peer) => {
      const card = cardSchema.parse({
        id: "card-program-starts-plan",
        taskId: "inf3020",
        title: "Plan: how a program starts its crewmates",
        author: "crewmate",
        priority: 15,
        meta: "Crewmate",
        body: "<p>I recommend a program start each crewmate through the first mate.</p>",
        actions: [],
        status: "ready",
        createdAt: 1000,
        lifecycleId: "plan-life",
        offerId: "plan-offer",
        seen: true,
        noteDone: ENDED_CLOSE,
        corner: ENDED_CORNER,
        ended: {
          by: "crewmate",
          reason: "Your words went to the first mate, who starts planning crewmates.",
          at: 2000,
          line: endedLineWords(
            "crewmate",
            "Your words went to the first mate, who starts planning crewmates.",
          ),
        },
      });
      const at = await home({
        dispatch: (async (channel) => {
          if (channel === "inf:cards:list") return [card];
          throw new Error("Unexpected request");
        }) as CoreDispatch,
      });
      const grant = await at.join();
      const old = await connectClient(grant, { protocolVersion: "14.0.0", changes: [] });
      const current = await connectClient(grant, peer);
      const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
      const legacyDecoder = cardSchema.omit({ ended: true });
      const listed = await old.invoke("inf:cards:list", []);
      expect(legacyDecoder.parse(listed[0])).toMatchObject({ id: card.id, noteDone: ENDED_CLOSE });
      expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
      expect((await phone.invoke("inf:cards:list", []))[0]).toEqual(card);
      at.events.emit("inf:cards", [card]);
      const oldPush = await old.push((push) => push.channel === "inf:cards");
      expect(legacyDecoder.parse((oldPush.payload as unknown[])[0])).toMatchObject({ id: card.id });
      expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
      expect((await phone.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
      const cursor = old.cursor();
      await old.close();
      at.events.emit("inf:cards", [{ ...card, seen: true }]);
      const back = await connectClient(grant, { cursor, protocolVersion: "14.0.0", changes: [] });
      expect(back.welcome.catchUp).toBe("replay");
      const replay = await back.push((push) => push.seq > cursor.seq);
      expect(legacyDecoder.parse((replay.payload as unknown[])[0])).toMatchObject({ id: card.id });
      await back.close();
      await current.close();
      await phone.close();
    },
  );

  // INF-3757's files for the captain: a desktop from before them decodes a
  // card strictly, so its copy leaves out `files`; a desktop listing the
  // change saves them, and the phone, which ignores a field it does not
  // know, gets them as they are. The card carries only the reference.
  it("keeps an older desktop's card decoding while a desktop listing card files reads them", async () => {
    const card = cardSchema.parse({
      id: "card-inf3753-letter",
      taskId: "inf3753",
      title: "The letter is ready",
      author: "crewmate",
      priority: 30,
      meta: "Crewmate",
      body: "<p>The letter to the landlord is ready to send.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000,
      files: [
        {
          id: `inf3753-${"a".repeat(32)}`,
          name: "letter to the landlord.docx",
          bytes: 18_432,
          sha256: "a".repeat(64),
          path: `/work/tasks/inf3753/cards/inf3753-${"a".repeat(32)}.file`,
          computer: "device-mac-mini",
        },
      ],
    });
    const at = await home({
      dispatch: (async (channel) => {
        if (channel === "inf:cards:list") return [card];
        throw new Error("Unexpected request");
      }) as CoreDispatch,
    });
    const grant = await at.join();
    // A desktop on major 15 reads the files only when it names them; every desktop from major 16 on reads them.
    const old = await connectClient(grant, { protocolVersion: "15.0.0", changes: [] });
    const named = await connectClient(grant, {
      protocolVersion: "15.0.0",
      changes: ["card-files"],
    });
    const current = await connectClient(grant, { protocolVersion: PROTOCOL_VERSION, changes: [] });
    const phone = await connectClient(grant, { system: { system: "ios" }, changes: [] });
    const legacyDecoder = cardSchema.omit({ files: true }).strict();
    expect(legacyDecoder.parse((await old.invoke("inf:cards:list", []))[0])).toMatchObject({
      id: card.id,
    });
    expect((await named.invoke("inf:cards:list", []))[0]).toEqual(card);
    expect((await current.invoke("inf:cards:list", []))[0]).toEqual(card);
    expect((await phone.invoke("inf:cards:list", []))[0]).toEqual(card);
    at.events.emit("inf:cards", [card]);
    const oldPush = await old.push((push) => push.channel === "inf:cards");
    expect(legacyDecoder.parse((oldPush.payload as unknown[])[0])).toMatchObject({ id: card.id });
    expect((await named.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
    expect((await current.push((push) => push.channel === "inf:cards")).payload).toEqual([card]);
    await old.close();
    await named.close();
    await current.close();
    await phone.close();
  });

  // INF-2225, INF-2214's approved shared cards: a desktop from before shared
  // cards decodes thread lines strictly, so its copy leaves out who
  // contributed a line, what it answers and whether it is a clarification;
  // a current desktop and the phone read them.
  // Preserve both dialects across the Secrets major: an older home still
  // answers its own clients' changes, while a current home keeps them read-only.
  it.each([false, true])(
    "keeps an older desktop's thread decoding while supported views read who wrote each line (historical home: %s)",
    async (historical) => {
      // INF-2555: every answer or push a view reads that carries card lines,
      // read from the published contract, so a channel added later that
      // carries them fails here until an older desktop gets them translated.
      const contract = publishedContract();
      const carriesLines = (schema: unknown) => JSON.stringify(schema).includes('"answersMessage"');
      const asked = Object.entries(contract.requests)
        .filter(
          ([channel, declared]) =>
            isViewInvokeChannel(channel as CoreInvokeChannel) && carriesLines(declared.response),
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

      const prior = `${Number(SHARED_CARDS_SINCE.split(".")[0]) - 1}.0.0`;
      const at = await home({
        ...(historical ? { protocolVersion: prior, viewFloor: Number(prior.split(".")[0]) } : {}),
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
      const old = await connectClient(grant, { protocolVersion: prior });
      const named = await connectClient(grant, {
        protocolVersion: prior,
        changes: ["shared-cards"],
      });
      const newer = await connectClient(
        grant,
        historical ? { protocolVersion: prior, changes: ["shared-cards"] } : {},
      );
      const phone = await connectClient(grant, {
        ...(historical ? { protocolVersion: prior } : {}),
        system: { system: "ios" },
      });
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
        if (!historical && contract.requests[channel]?.effect === "change") continue;
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
    },
  );

  // Protected Secrets retains shared-card fields without advertising the retired name.
  it("sends contributor fields to a current desktop with no capability names", async () => {
    const thread = cardThreadSchema.parse({
      cardId: "card-required-action",
      messages: [
        {
          id: 1,
          cardId: "card-required-action",
          who: "crewmate",
          text: "The remover is in the setup folder.",
          at: 1,
          contributor: { actor: "crewmate", taskId: "remover", label: "the crewmate" },
          answersMessage: 1,
        },
      ],
    });
    const at = await home({ dispatch: (async () => thread) as CoreDispatch });
    const grant = await at.join();
    const current = await connectClient(grant, { changes: [] });
    expect(await current.invoke("inf:cards:thread", [thread.cardId])).toEqual(thread);
    at.events.emit("inf:cards:thread", thread);
    expect((await current.push((push) => push.channel === "inf:cards:thread")).payload).toEqual(
      thread,
    );
    await current.close();
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
