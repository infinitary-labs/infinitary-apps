import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES, createQuotaHttp, QuotaTransportError } from "./http";

function fetchAnswering(response: Response) {
  return vi.fn<typeof fetch>(async () => response);
}

/** A JSON answer one byte past `size`, valid all the way through. */
function jsonOf(size: number): string {
  const head = '{"ok":true,"pad":"';
  const tail = '"}';
  return `${head}${"x".repeat(size + 1 - head.length - tail.length)}${tail}`;
}

/**
 * A local endpoint that answers as `respond` says, and reports when a
 * request's connection closes - the proof that a cancel stopped the request
 * itself rather than only the wait for it.
 */
async function localEndpoint(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
) {
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let dropped!: () => void;
  const closed = new Promise<void>((resolve) => {
    dropped = resolve;
  });
  const server = createServer((request, response) => {
    response.on("close", dropped);
    arrived();
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/usage`,
    requested,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("createQuotaHttp", () => {
  it("parses a JSON answer and carries its headers lower-cased", async () => {
    const fetchImpl = fetchAnswering(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Retry-After": "12" },
      }),
    );
    const result = await createQuotaHttp(fetchImpl)("https://vendor.test/usage", {
      headers: { Authorization: "Bearer t" },
    });
    expect(result).toMatchObject({
      status: 200,
      json: { ok: true },
      retryAfter: "12",
      headers: { "content-type": "application/json", "retry-after": "12" },
    });
    expect(result.bytes).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://vendor.test/usage",
      expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer t" } }),
    );
  });

  it("sends a binary POST body and returns the raw answer for a bytes request", async () => {
    const answer = Uint8Array.from([0, 0, 0, 0, 2, 8, 1]);
    const fetchImpl = fetchAnswering(
      new Response(answer, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto", "grpc-status": "0" },
      }),
    );
    const result = await createQuotaHttp(fetchImpl)("https://vendor.test/meter", {
      method: "POST",
      body: Uint8Array.from([0, 0, 0, 0, 0]),
      responseType: "bytes",
    });
    expect(Array.from(result.bytes ?? [])).toEqual(Array.from(answer));
    expect(result.json).toBeUndefined();
    expect(result.headers?.["grpc-status"]).toBe("0");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(Array.from(init?.body as Uint8Array)).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses an oversized declared body before reading it", async () => {
    const fetchImpl = fetchAnswering(
      new Response(new Uint8Array(8), {
        status: 200,
        headers: { "content-length": String(BODY_LIMIT_BYTES + 1) },
      }),
    );
    await expect(
      createQuotaHttp(fetchImpl)("https://vendor.test/meter", { responseType: "bytes" }),
    ).rejects.toMatchObject({ failure: "oversized" });
  });

  it("stops a stream that runs past the body limit and never buffers the rest", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(BODY_LIMIT_BYTES / 2 + 1));
      },
    });
    const fetchImpl = fetchAnswering(new Response(stream, { status: 200 }));
    await expect(
      createQuotaHttp(fetchImpl)("https://vendor.test/meter", { responseType: "bytes" }),
    ).rejects.toBeInstanceOf(QuotaTransportError);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("refuses a JSON answer past 64 KB before parsing any of it", async () => {
    const declared = vi.fn<typeof fetch>(
      async () =>
        new Response(jsonOf(BODY_LIMIT_BYTES), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(createQuotaHttp(declared)("https://vendor.test/usage", {})).rejects.toMatchObject({
      failure: "oversized",
    });

    // No declared length: the stream is cut where it crosses the limit,
    // though what came before it was well-formed JSON.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true,"pad":"'));
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(BODY_LIMIT_BYTES / 2)));
      },
    });
    await expect(
      createQuotaHttp(fetchAnswering(new Response(stream, { status: 200 })))(
        "https://vendor.test/usage",
        {},
      ),
    ).rejects.toMatchObject({ failure: "oversized" });
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("reads a JSON answer up to the limit, or a reader's own wider one", async () => {
    const atLimit = jsonOf(BODY_LIMIT_BYTES - 1);
    expect(new TextEncoder().encode(atLimit).length).toBe(BODY_LIMIT_BYTES);
    const fits = await createQuotaHttp(fetchAnswering(new Response(atLimit, { status: 200 })))(
      "https://vendor.test/usage",
      {},
    );
    expect(fits.json).toMatchObject({ ok: true });

    const list = await createQuotaHttp(
      fetchAnswering(new Response(jsonOf(BODY_LIMIT_BYTES * 4), { status: 200 })),
    )("https://vendor.test/models", { limitBytes: BODY_LIMIT_BYTES * 8 });
    expect(list.json).toMatchObject({ ok: true });
  });

  it("stops the request itself when its caller cancels, and names it apart from a timeout", async () => {
    // The endpoint never answers: only the cancel can end this request.
    const endpoint = await localEndpoint(() => {});
    try {
      const controller = new AbortController();
      const pending = createQuotaHttp()(endpoint.url, { signal: controller.signal });
      await endpoint.requested;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ failure: "aborted" });
      await endpoint.closed;
    } finally {
      await endpoint.close();
    }

    const deadline = await localEndpoint(() => {});
    try {
      const caller = new AbortController();
      const pending = createQuotaHttp()(deadline.url, { signal: caller.signal });
      await deadline.requested;
      // A caller whose signal is its own deadline timed out; it did not cancel.
      caller.abort(new DOMException("Caller deadline", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({ failure: "timeout" });
      await deadline.closed;
    } finally {
      await deadline.close();
    }
  });

  it("stops reading a body when its caller cancels part way through", async () => {
    const endpoint = await localEndpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Half an answer, then nothing more.
      response.write('{"ok":');
    });
    try {
      const controller = new AbortController();
      const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
        const response = await fetch(input, init);
        // The headers are in; the body never finishes.
        queueMicrotask(() => controller.abort());
        return response;
      });
      await expect(
        createQuotaHttp(fetchSpy)(endpoint.url, { signal: controller.signal }),
      ).rejects.toMatchObject({ failure: "aborted" });
      await endpoint.closed;
    } finally {
      await endpoint.close();
    }
  });

  it("turns a thrown request into its own transport failure", async () => {
    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createQuotaHttp(network)("https://vendor.test/meter", { responseType: "bytes" }),
    ).rejects.toMatchObject({ failure: "network" });
  });
});
