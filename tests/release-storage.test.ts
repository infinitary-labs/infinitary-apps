import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePointer,
  publicDigest,
  publishSnapshot,
  READ_PATIENCE,
  ReleaseStorage,
} from "../scripts/release-storage.mjs";
import { releaseStorageFixture } from "./helpers/releaseStorage";

// INF-1613/INF-1620: immutable public downloads precede one conditional feed switch.
// Real project picture bytes stand in only for artifact identity, never for a signed installer.
const picture = fileURLToPath(new URL("../packaging/build/icon.png", import.meta.url));
const bytes = readFileSync(picture);
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("R2 release object interface", () => {
  // INI-22's producer contract treats the account-bearing endpoint as a secret.
  it("keeps the secret endpoint out of invalid-configuration and transport errors", async () => {
    const configuration = {
      bucket: "installers",
      accessKeyId: "disposable",
      secretAccessKey: "disposable-not-a-secret",
    };
    const marker = "account-identifier-must-stay-private";
    try {
      new ReleaseStorage({ ...configuration, endpoint: marker });
      throw new Error("Invalid endpoint was accepted");
    } catch (error) {
      expect(String(error)).toBe("Error: Invalid R2 endpoint");
      expect(String(error)).not.toContain(marker);
    }
    // Both a read and an upload wait out a lost connection, and neither may name the endpoint.
    for (const use of [
      (storage: ReleaseStorage) => storage.read("feeds/current.json"),
      (storage: ReleaseStorage) =>
        storage.immutable("releases/v0.6.1/Infinitary-0.6.1-universal.zip.sha256", bytes),
    ]) {
      // A stand-in clock that moves only when the request pauses, so its whole patience passes at once.
      let clock = 0;
      const logged: string[] = [];
      const storage = new ReleaseStorage({
        ...configuration,
        endpoint: "https://r2.example.test",
        request: async () => {
          throw new Error(marker);
        },
        waiting: {
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          log: (line) => void logged.push(line),
        },
      });
      const error = await use(storage).catch((error: unknown) => error);
      expect(String(error)).toContain("R2 request failed");
      expect(String(error)).not.toContain(marker);
      expect(error).not.toHaveProperty("cause");
      expect(clock).toBe(READ_PATIENCE.patienceMs);
      expect(logged).toHaveLength(READ_PATIENCE.patienceMs / READ_PATIENCE.pauseMs);
      expect(logged.join("\n")).not.toContain(marker);
    }
  });

  // Alpha run 44369876869 stopped before any feed moved: R2 answered 500 to the universal zip's
  // first upload and held no copy of it, while the record and both taps took every file.
  it("waits out a server error R2 answers to an upload it did not take", async () => {
    const waits: number[] = [];
    const logged: string[] = [];
    const f = releaseStorageFixture({
      unavailableWrites: 1,
      waiting: { pause: async (ms) => void waits.push(ms), log: (line) => void logged.push(line) },
    });
    const key = "releases/v0.6.1/Infinitary-0.6.1-universal.zip";
    expect(await f.storage.immutableFile(key, picture)).toBe(sha256);
    expect(f.calls.map((call) => [call.method, call.condition])).toEqual([
      ["PUT", "*"],
      ["PUT", "*"],
    ]);
    expect(f.objects.get(key)?.bytes.equals(bytes)).toBe(true);
    expect(waits).toEqual([READ_PATIENCE.pauseMs]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(key);
    expect(logged[0]).toContain("500");
  });

  // R2 can keep a write and still answer 500, so the upload's next try finds the copy and must
  // accept it only when its bytes are the same, never overwrite it.
  it("accepts the copy R2 kept from an upload it answered with a server error", async () => {
    const waits: number[] = [];
    const f = releaseStorageFixture({
      unavailableWrites: 1,
      keptBeforeError: true,
      waiting: { pause: async (ms) => void waits.push(ms), log: () => {} },
    });
    const key = "releases/v0.6.1/Infinitary-0.6.1-universal.zip";
    expect(await f.storage.immutableFile(key, picture)).toBe(sha256);
    expect(f.calls.map((call) => call.method)).toEqual(["PUT", "PUT", "GET"]);
    expect(f.calls[1]?.condition).toBe("*");
    expect(f.objects.get(key)?.bytes.equals(bytes)).toBe(true);
    expect(waits).toEqual([READ_PATIENCE.pauseMs]);
  });

  // Alpha run 44149094759 failed after both casks moved: during an R2 incident the read-back of an
  // already-written feed snapshot file answered 500 instead of the bytes.
  it("waits out a server error when reading an object back", async () => {
    const waits: number[] = [];
    const logged: string[] = [];
    const f = releaseStorageFixture({
      unavailableReads: 1,
      waiting: { pause: async (ms) => void waits.push(ms), log: (line) => void logged.push(line) },
    });
    const key = `feed-snapshots/${sha256}/alpha-mac.yml`;
    f.objects.set(key, { bytes, etag: `"${sha256}"` });
    await f.storage.immutable(key, bytes);
    expect(f.calls.map((call) => call.method)).toEqual(["PUT", "GET", "GET"]);
    expect(waits).toEqual([READ_PATIENCE.pauseMs]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(key);
  });
  it("accepts identical retries, refuses changed published bytes, and signs the content digest", async () => {
    const f = releaseStorageFixture();
    const key = "releases/v0.6.1/Infinitary-0.6.1-universal.zip";
    await f.storage.immutable(key, bytes);
    await f.storage.immutable(key, bytes);
    await expect(
      f.storage.immutable(key, Buffer.concat([bytes, Buffer.from("changed")])),
    ).rejects.toThrow("Published bytes never change");
    const stored = f.objects.get(key);
    if (!stored) throw new Error("The uploaded object is missing");
    expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(sha256);
    expect(
      f.calls.filter((call) => call.method === "PUT").every((call) => call.condition === "*"),
    ).toBe(true);
  });

  // INI-17 observed a weak R2 GET validator during the accepted plan's live storage proof.
  it("requests identity encoding and refuses a weak pointer ETag without stripping or sending it", async () => {
    const f = releaseStorageFixture();
    const pointer = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        prefix: `feed-snapshots/${sha256}/`,
        files: ["alpha-mac.yml"],
      }),
    );
    f.objects.set("feeds/current.json", { bytes: pointer, etag: `W/"${sha256}"` });
    const previous = await f.storage.read("feeds/current.json");
    expect(f.calls.at(-1)?.encoding).toBe("identity");
    expect(previous?.etag).toBe(`W/"${sha256}"`);
    await expect(f.storage.replacePointer(Buffer.from("next pointer"), previous)).rejects.toThrow(
      "no strong ETag",
    );
    expect(f.calls.filter((call) => call.method === "PUT")).toEqual([]);
    expect(f.objects.get("feeds/current.json")?.etag).toBe(`W/"${sha256}"`);
  });

  it("keeps the pointer unchanged when public verification fails", async () => {
    const f = releaseStorageFixture();
    await expect(
      publishSnapshot(f.storage, { "alpha-mac.yml": "{}" }, null, async () => {
        throw new Error("Unsigned fetch failed");
      }),
    ).rejects.toThrow("Unsigned fetch failed");
    expect(f.objects.has("feeds/current.json")).toBe(false);
  });

  it("switches only after every immutable object verifies, and refuses a concurrent writer", async () => {
    const f = releaseStorageFixture();
    const verified: string[] = [];
    await publishSnapshot(
      f.storage,
      { "alpha-mac.yml": "{}", "versions/0.6.1.json": "{}" },
      null,
      async (key, expected) => {
        expect(f.objects.has("feeds/current.json")).toBe(false);
        await f.verify(key, expected);
        verified.push(key);
      },
    );
    expect(verified).toHaveLength(2);
    const previous = await f.storage.read("feeds/current.json");
    if (!previous) throw new Error("The initial pointer is missing");
    const pointer = parsePointer(previous.bytes);
    expect(pointer.files).toEqual(["alpha-mac.yml", "versions/0.6.1.json"]);
    expect(f.calls.at(-2)?.key).toBe("feeds/current.json");
    await publishSnapshot(
      f.storage,
      { "alpha-mac.yml": '{"version":"0.6.2"}' },
      previous,
      f.verify,
    );
    const newer = await f.storage.read("feeds/current.json");
    await expect(
      publishSnapshot(f.storage, { "alpha-mac.yml": '{"version":"0.6.3"}' }, previous, f.verify),
    ).rejects.toThrow("Concurrent publication refused");
    expect((await f.storage.read("feeds/current.json"))?.etag).toBe(newer?.etag);
    expect(f.calls.some((call) => call.method === "PUT" && call.condition === previous?.etag)).toBe(
      true,
    );
  });

  it("refuses unsafe snapshot paths before reading objects", () => {
    for (const pointer of [
      null,
      { schemaVersion: 1, prefix: `feed-snapshots/${sha256}/`, files: [".."] },
      { schemaVersion: 1, prefix: "../", files: ["alpha-mac.yml"] },
      { schemaVersion: 1, prefix: `feed-snapshots/${sha256}/`, files: ["../secret"] },
      {
        schemaVersion: 1,
        prefix: `feed-snapshots/${sha256}/`,
        files: ["alpha-mac.yml", "alpha-mac.yml"],
      },
    ])
      expect(() => parsePointer(Buffer.from(JSON.stringify(pointer)))).toThrow(
        "Invalid current feed snapshot",
      );
  });
});

/**
 * A loopback download site serving the real bytes, with byte ranges as the download site does.
 * Its first answer stops half way and resets the connection once the reader holds bytes, so the
 * reset lands part way through the file on every run.
 */
async function resettingSite(continued: (response: ServerResponse, start: number) => void) {
  let firstBytesRead = () => {};
  const read = new Promise<void>((resolve) => {
    firstBytesRead = resolve;
  });
  const ranges: (string | undefined)[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    ranges.push(request.headers.range);
    if (ranges.length === 1) {
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, bytes.length / 2));
      await read;
      response.socket?.resetAndDestroy();
      return;
    }
    continued(response, Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The real fetch, read one chunk at a time so the site knows the reader holds bytes.
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const reader = response.body?.getReader();
    if (!reader) return response;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          controller.enqueue(value);
          firstBytesRead();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return {
    url: new URL(`http://127.0.0.1:${port}/releases/v0.6.1/icon.png`),
    ranges,
    request,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("unsigned public read-back", () => {
  // Alpha run 42729835126 failed after its uploads landed: the download site reset the
  // connection while the release read its own Linux package back to check the bytes.
  it("continues a download the network resets part way from the byte it reached", async () => {
    const site = await resettingSite((response, start) => {
      response.writeHead(206, {
        "content-length": bytes.length - start,
        "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
      });
      response.end(bytes.subarray(start));
    });
    try {
      const read = await publicDigest(site.url, site.request);
      expect(read.sha256).toBe(sha256);
      expect(read.bytes).toBe(bytes.length);
      expect(read.resumedAt).toHaveLength(1);
      expect(site.ranges).toEqual([undefined, `bytes=${read.resumedAt[0]}-`]);
    } finally {
      await site.close();
    }
  });

  // Alpha run 44149094759 failed after both casks moved: the download site reset the connection
  // before the first byte while the release read a new feed snapshot file back.
  it("waits out a connection the download site resets before the first byte", async () => {
    const ranges: (string | undefined)[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) return request.socket.resetAndDestroy();
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const waits: number[] = [];
    const logged: string[] = [];
    try {
      const read = await publicDigest(
        new URL(`http://127.0.0.1:${port}/feed-snapshots/${sha256}/alpha-mac.yml`),
        fetch,
        { pause: async (ms) => void waits.push(ms), log: (line) => void logged.push(line) },
      );
      expect(read.sha256).toBe(sha256);
      expect(read.resumedAt).toEqual([]);
      expect(ranges).toEqual([undefined, undefined]);
      expect(waits).toEqual([READ_PATIENCE.pauseMs]);
      expect(logged).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Alpha run 44253811550 failed after its uploads landed: the download site answered 503 for
  // the release's SHA256SUMS, then served the same bytes two minutes later.
  it("waits out a server error the download site answers before the bytes", async () => {
    const ranges: (string | undefined)[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      ranges.push(request.headers.range);
      if (ranges.length === 1) {
        response.writeHead(503, { "content-type": "text/plain" });
        return response.end("Service Unavailable");
      }
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const waits: number[] = [];
    const logged: string[] = [];
    try {
      const read = await publicDigest(
        new URL(`http://127.0.0.1:${port}/releases/v0.6.1/SHA256SUMS`),
        fetch,
        {
          pause: async (ms) => void waits.push(ms),
          log: (line) => void logged.push(line),
        },
      );
      expect(read.sha256).toBe(sha256);
      expect(ranges).toEqual([undefined, undefined]);
      expect(waits).toEqual([READ_PATIENCE.pauseMs]);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("503");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // A site that drops every continued connection before any byte must end the read once its
  // patience runs out, not hold the release forever.
  it("ends the read when continued connections bring no more bytes for the whole patience", async () => {
    const site = await resettingSite((response, start) => {
      response.writeHead(206, {
        "content-length": bytes.length - start,
        "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
      });
      response.flushHeaders();
      response.socket?.resetAndDestroy();
    });
    // A stand-in clock that moves only when the read pauses, so the whole patience passes at once.
    let clock = 0;
    try {
      await expect(
        publicDigest(site.url, site.request, {
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          log: () => {},
        }),
      ).rejects.toThrow("not answering");
      const continued = site.ranges.slice(1);
      expect(continued).toHaveLength(READ_PATIENCE.patienceMs / READ_PATIENCE.pauseMs + 1);
      expect(new Set(continued).size).toBe(1);
      expect(clock).toBe(READ_PATIENCE.patienceMs);
    } finally {
      await site.close();
    }
  });
});
