import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  createServer as createTlsServer,
  type TLSSocket,
  type Server as TlsServer,
} from "node:tls";
import { FETCH_APP_PATH, PAIR_PATH } from "@shared/connection";
import { HOME } from "@shared/deviceNames";
import { deviceGrantSchema } from "@shared/devices";
import { afterEach, describe, expect, it } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeInstalled } from "../helper/background";
import { updateHere } from "../helper/update";
import { claimLink, fetchFirstmate } from "./dial";
import { createKeyIdentity } from "./identity";
import { DevicePairing } from "./pairing";

/**
 * A home that goes quiet once the pinned TLS is up: the dial is answered
 * with the home's own key, so the device writes its request, and then the
 * home says nothing more. The request on that socket ends after its own
 * quiet stretch (`timeoutMs`) with its own words, rather than waiting for an
 * answer that never comes.
 */

/** How long a quiet stretch may last here: the dial's limit and the request's alike. */
const QUIET = 1_000;

const pairings: DevicePairing[] = [];
const servers: TlsServer[] = [];
const sockets: TLSSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * A home's key on loopback that answers each request with `answer` once its
 * head has come, then says nothing; `heard` is everything each connection sent.
 */
async function quietHome(answer: (socket: TLSSocket) => void = () => {}) {
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-quiet-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
  });
  pairings.push(pairing);
  const { key, cert, pin } = pairing.identity();
  const heard: string[] = [];
  const server = createTlsServer({ key, cert, minVersion: "TLSv1.3" }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const index = heard.push("") - 1;
    socket.on("data", (chunk: Buffer) => {
      const before = heard[index] ?? "";
      heard[index] = before + chunk.toString("latin1");
      if (!before.includes("\r\n\r\n") && heard[index].includes("\r\n\r\n")) answer(socket);
    });
  });
  servers.push(server);
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { pairing, pin, heard, at: `127.0.0.1:${port}` };
}

describe("a request to a home that goes quiet ends after its quiet stretch", () => {
  it("ends a pairing whose home never answers, saying it did not answer", async () => {
    const { pairing, heard, at } = await quietHome();
    const { link } = pairing.invite({ kind: "work", at });

    await expect(
      claimLink(link, { kind: "work", name: "Mac mini" }, { timeoutMs: QUIET }),
    ).rejects.toThrow(`${HOME.The} did not answer.`);
    // The dial was answered with the home's key and the link was used: it
    // was the answer the device waited for, not the dial.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(new RegExp(`^POST ${PAIR_PATH} HTTP/1\\.1\\r\\n`));
  });

  it("ends a Firstmate fetch whose home stops sending, leaving what came unfinished", async () => {
    const part = Buffer.alloc(16, 7);
    const { pin, heard, at } = await quietHome((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\ncontent-type: application/zip\r\ncontent-length: 1024\r\n\r\n",
      );
      socket.write(part);
    });
    const device = createKeyIdentity("Firstmate device");
    const grant = deviceGrantSchema.parse({
      at,
      homeKey: pin,
      deviceId: "quiet-device",
      kind: "work",
      key: device.key,
      cert: device.cert,
    });
    const came: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        came.push(chunk);
        done();
      },
    });

    await expect(fetchFirstmate(grant, sink, { timeoutMs: QUIET })).rejects.toThrow(
      `${HOME.The} stopped sending Infinitary.`,
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(new RegExp(`^POST ${FETCH_APP_PATH} HTTP/1\\.1\\r\\n`));
    // What came is in the sink, which stays open: nothing reads part of an app as whole.
    expect(Buffer.concat(came)).toEqual(part);
    expect(sink.writableEnded).toBe(false);
  });
});

// INF-3307 audit: a stop during a work computer's update can leave its
// temporary folder behind - the run that stops lets its fetch go at once,
// rather than waiting out the quiet stretch, so its folder can be taken away.
describe("a Firstmate fetch the computer stops", () => {
  it("ends at once with its own words, long before its quiet stretch, leaving what came unfinished (INF-3307 audit)", async () => {
    const part = Buffer.alloc(16, 7);
    const { pin, at } = await quietHome((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\ncontent-type: application/zip\r\ncontent-length: 1024\r\n\r\n",
      );
      socket.write(part);
    });
    const device = createKeyIdentity("Firstmate device");
    const grant = deviceGrantSchema.parse({
      at,
      homeKey: pin,
      deviceId: "stopped-device",
      kind: "work",
      key: device.key,
      cert: device.cert,
    });
    const came: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        came.push(chunk);
        done();
      },
    });
    const stopping = new AbortController();

    // A quiet stretch far past this test's own limit: only the stop can end it.
    const fetched = fetchFirstmate(grant, sink, { timeoutMs: 600_000, signal: stopping.signal });
    fetched.catch(() => undefined);
    await expect.poll(() => Buffer.concat(came)).toEqual(part);
    stopping.abort();

    await expect(fetched).rejects.toThrow("Infinitary stopped here before all of it came.");
    expect(sink.writableEnded).toBe(false);
  });
});

// INF-3307 review: a stop during a Linux work computer's update must end the
// update, not leave it waiting on the AppImage file the cut-short fetch left open.
describe("a Linux work computer's update the computer stops", () => {
  it("ends and takes its temporary folder away when stopped part way through the AppImage (INF-3307 review)", async () => {
    let sent = false;
    const { pin, at } = await quietHome((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: 1024\r\n\r\n",
      );
      socket.write(Buffer.alloc(16, 7), () => {
        sent = true;
      });
    });
    const device = createKeyIdentity("Firstmate device");
    const grant = deviceGrantSchema.parse({
      at,
      homeKey: pin,
      deviceId: "stopped-linux-device",
      kind: "work",
      key: device.key,
      cert: device.cert,
    });
    const dataDir = scratchDir("infinitary-stopped-update-");
    writeInstalled(dataDir, { service: null, app: join(dataDir, "app", "infinitary.AppImage") });
    const stopping = new AbortController();

    // A quiet stretch far past this test's own limit: only the stop can end it.
    const updating = updateHere({ dataDir, grant, timeoutMs: 600_000, signal: stopping.signal });
    updating.catch(() => undefined);
    await expect.poll(() => sent).toBe(true);
    await expect
      .poll(() => readdirSync(dataDir).some((name) => name.startsWith("update-")))
      .toBe(true);
    stopping.abort();

    await expect(updating).rejects.toThrow("Infinitary stopped here before all of it came.");
    expect(readdirSync(dataDir).filter((name) => name.startsWith("update-"))).toEqual([]);
  });
});
