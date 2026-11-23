import { once } from "node:events";
import { createServer as createPlainServer, connect as plainConnect, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { cardSchema } from "@shared/cards";
import { FETCH_SOURCE_PATH } from "@shared/connection";
import type { DeviceGrant } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import { pausedDevice } from "../../../tests/helpers/pausedDevice";
import { fetchFromHome } from "../devices/dial";
import type { ViewDeviceContact } from "./connection";
import { FRAME_PARTS } from "./frameParts";

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
// was still receiving.
describe("pacing and liveness", () => {
  // This home pings every 100 ms and lets nothing go ahead of an answer (`aheadMs: 0`), so it writes one 1 KiB
  // piece and its ping at a time. The relay passes a little more than that each 20 ms step, so the device answers
  // every step, and the 20 KiB push takes about half a second: over four heartbeats. Were the ping behind the whole
  // push, the device would answer nothing for over two heartbeats and be cut. Letting more go ahead spaces the
  // answers nearly a heartbeat this short apart (INF-2984); the outbox's own tests cover how much goes ahead.
  it("keeps a device that receives a long push slowly, and delivers it whole on one connection", async () => {
    const at = await home({ heartbeatMs: 100, pieceBytes: 1024, aheadMs: 0 });
    const grant = await at.join();
    const link = await slowLink(at.at, 64 * 1024);
    try {
      const heard: ViewDeviceContact[] = [];
      at.connection.onViewDevice((contact) => heard.push(contact));
      const device = await connectClient(grant, { dial: link.dial });
      const card = heavyCard(20 * 1024);
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

  // INF-2832: a phone hears a message only once it has arrived whole, so a long one came to it as one long silence.
  // A piece's length follows the rate the device's answers measure, so this home lets nothing go ahead of an
  // answer (`aheadMs: 0`): every piece stays one `pieceBytes` long on any link, and the push spans 96 of them.
  it("sends a long push in parts to a device that reads them, and as one message to one that does not", async () => {
    const at = await home({ heartbeatMs: 250, pieceBytes: 1024, aheadMs: 0 });
    // INF-3042: current peers need no retired name; older views still negotiate it.
    const reads = await connectClient(await at.join());
    const named = await connectClient(await at.join("view", "Named older view"), {
      protocolVersion: "14.0.0",
      changes: [FRAME_PARTS],
    });
    const older = await connectClient(await at.join("view", "Older Mac"), {
      protocolVersion: "14.0.0",
    });
    const [readsBefore, namedBefore, olderBefore] = [reads.joined, named.joined, older.joined];
    const card = heavyCard(96 * 1024);
    at.events.emit("inf:cards", [card]);
    for (const device of [reads, named, older]) {
      const push = await Promise.race([
        device.push((received) => received.channel === "inf:cards"),
        device.closed.then((code) => {
          throw new Error(`The home cut the device (${code}) before the push arrived`);
        }),
      ]);
      const [received] = push.payload as { id: string; body: string }[];
      expect(received?.body).toBe(card.body);
    }
    expect(reads.joined).toBe(readsBefore + 1);
    expect(named.joined).toBe(namedBefore + 1);
    expect(older.joined).toBe(olderBefore);
    await reads.close();
    await named.close();
    await older.close();
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

// INF-5635's plan, piece 3: Match sends a committed source archive to a computer that runs work,
// committed code only.
describe("this home's source, for a computer it asks to build it", () => {
  const COMMIT = "e".repeat(40);
  const archive = Buffer.from("the committed tree, packed");
  const source = () => ({
    commit: COMMIT,
    archive: () => {
      const stream = Readable.from([archive]);
      return { stream, ended: once(stream, "end").then(() => {}), stop: () => stream.destroy() };
    },
  });
  const fetchSource = (grant: DeviceGrant, commit: string) => {
    const came: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        came.push(chunk);
        done();
      },
    });
    return fetchFromHome(grant, sink, {}, { path: FETCH_SOURCE_PATH, body: { commit } }).then(() =>
      Buffer.concat(came),
    );
  };

  it("sends a computer that runs work the commit this home runs, counted as it is sent", async () => {
    const at = await home({ source });
    const sent: number[] = [];
    at.connection.onAppSent((_deviceId, bytes) => sent.push(bytes));
    const grant = await at.join("work", "Mac mini");
    expect(await fetchSource(grant, COMMIT)).toEqual(archive);
    expect(sent.reduce((total, bytes) => total + bytes, 0)).toBe(archive.length);
  });

  it("refuses another commit, a home that runs no source, and a device that runs no work", async () => {
    const at = await home({ source });
    const grant = await at.join("work", "Mac mini");
    await expect(fetchSource(grant, "f".repeat(40))).rejects.toMatchObject({ refused: "none" });
    const view = await at.join("view", "Laptop");
    await expect(fetchSource(view, COMMIT)).rejects.toMatchObject({ refused: "unknown" });
    const plain = await home();
    await expect(fetchSource(await plain.join("work", "Mac mini"), COMMIT)).rejects.toMatchObject({
      refused: "none",
    });
  });
});
