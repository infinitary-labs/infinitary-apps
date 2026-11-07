import { join } from "node:path";
import { Writable } from "node:stream";
import {
  createServer as createTlsServer,
  type TLSSocket,
  type Server as TlsServer,
} from "node:tls";
import { FETCH_APP_TYPES } from "@shared/connection";
import { deviceGrantSchema } from "@shared/devices";
import { afterEach, describe, expect, it } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { fetchFirstmate } from "./dial";
import { createKeyIdentity } from "./identity";
import { DevicePairing } from "./pairing";

/**
 * A Firstmate fetch reads the home's answer to its end whatever its sink
 * does (docs/devices.md, "Getting Infinitary by its own key"). The Mac's tar
 * stops reading once it has the whole app - at the archive's end marker,
 * before the zero padding that fills the archive's last block - and its
 * input closes when it exits, while the rest of the answer may still be on
 * its way. A home's key on loopback answers in two pieces, the second only
 * once the sink has closed, as tar's input does.
 */

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

/** A home's key on loopback that answers each request with `answer` once its head has come. */
async function home(answer: (socket: TLSSocket) => void) {
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-answer-end-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
  });
  pairings.push(pairing);
  const { key, cert, pin } = pairing.identity();
  const server = createTlsServer({ key, cert, minVersion: "TLSv1.3" }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let heard = "";
    socket.on("data", (chunk: Buffer) => {
      const before = heard;
      heard += chunk.toString("latin1");
      if (!before.includes("\r\n\r\n") && heard.includes("\r\n\r\n")) answer(socket);
    });
  });
  servers.push(server);
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const device = createKeyIdentity("Firstmate device");
  const grant = deviceGrantSchema.parse({
    at: `127.0.0.1:${port}`,
    homeKey: pin,
    deviceId: "answer-end-device",
    kind: "work",
    key: device.key,
    cert: device.cert,
  });
  return { grant };
}

describe("a Firstmate fetch reads the home's answer to its end", () => {
  it("resolves once all of the answer came, though its sink closed after the first piece", async () => {
    const app = Buffer.alloc(16, 7);
    const padding = Buffer.alloc(48);
    let sinkClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      sinkClosed = resolve;
    });
    let rest = "unsent";
    const { grant } = await home((socket) => {
      socket.write(
        `HTTP/1.1 200 OK\r\ncontent-type: ${FETCH_APP_TYPES.bundle}\r\n` +
          `content-length: ${app.length + padding.length}\r\nconnection: close\r\n\r\n`,
      );
      socket.write(app);
      void closed.then(() => {
        rest = "sent";
        socket.end(padding);
      });
    });
    // As tar's input: it takes the app, then closes, as tar exits with it whole.
    const came: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        came.push(chunk);
        done();
        this.destroy();
      },
    });
    sink.once("close", sinkClosed);

    await expect(fetchFirstmate(grant, sink)).resolves.toBeUndefined();
    expect(rest).toBe("sent");
    expect(Buffer.concat(came)).toEqual(app);
  });
});
