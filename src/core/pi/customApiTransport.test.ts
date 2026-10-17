import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CustomApiError } from "./customApiPolicy";
import {
  CUSTOM_API_CHECK_LIMITS,
  CUSTOM_API_TURN_LIMITS,
  type CustomApiTransport,
  createCustomApiTransport,
  customApiRequestBytes,
  readCustomApiDestination,
} from "./customApiTransport";

const transports: CustomApiTransport[] = [];
const servers: Server[] = [];
beforeEach(() => {
  const home = scratchDir("custom-api-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
});
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(handler: (request: IncomingMessage, reply: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}/proxy/v1`;
}
function transport(baseUrl: string, key?: string, generation?: "check" | "turn") {
  const result = createCustomApiTransport({
    baseUrl,
    mode: "local",
    credential: key === undefined ? { kind: "local-no-key" } : { kind: "bearer", key },
    ...(generation ? { generation } : {}),
  });
  transports.push(result);
  return result;
}

/** A server whose streamed reply the test writes, one piece at a time. */
async function heldStream() {
  let opened: (reply: ServerResponse) => void = () => undefined;
  const reply = new Promise<ServerResponse>((resolve) => {
    opened = resolve;
  });
  const base = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    opened(res);
  });
  return { base, reply };
}

/** Reads until `count` more bytes arrived, so the clock moves only after the client has them. */
async function received(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  let total = 0;
  while (total < count) {
    const next = await reader.read();
    if (next.done) throw new Error("The reply ended early");
    total += next.value.length;
  }
  return total;
}

const MINUTE = 60_000;

describe("opt-in custom transport on actual sockets", () => {
  it("reaches a named local site without changing Host and refuses DNS leaving loopback", async () => {
    const hostname = "claude.local.dev.bla.net";
    const seen: string[] = [];
    const base = await fixture((req, res) => {
      seen.push(`${req.method} ${req.url} Host: ${req.headers.host}`);
      const correctSite = req.headers.host === new URL(base).host.replace("127.0.0.1", hostname);
      res.writeHead(correctSite ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    const resolve = vi.fn(async () => ["127.0.0.1", "::1"]);
    const client = createCustomApiTransport(
      {
        baseUrl: base.replace("127.0.0.1", hostname),
        mode: "local",
        credential: { kind: "local-no-key" },
      },
      resolve,
    );
    transports.push(client);
    expect(await (await client.request("models")).json()).toEqual({
      data: [{ id: "local-model" }],
    });
    expect(seen).toEqual([
      `GET /proxy/v1/models Host: ${new URL(base).host.replace("127.0.0.1", hostname)}`,
    ]);
    for (const addresses of [["127.0.0.1", "8.8.8.8"], ["10.0.0.1"], []]) {
      resolve.mockResolvedValueOnce(addresses);
      await expect(client.request("models")).rejects.toMatchObject({ category: "destination" });
    }
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(seen).toHaveLength(1);
    console.info("LOCAL_HOSTNAME_WIRE", JSON.stringify({ seen, refusedNonlocalRequests: 3 }));
  });
  it("reaches localhost on 127.0.0.1 when its first checked answer, ::1, refuses", async () => {
    const seen: string[] = [];
    const base = await fixture((req, res) => {
      seen.push(`${req.method} ${req.url} Host: ${req.headers.host}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    // A Mac may answer ::1 first for localhost; the fixture listens on 127.0.0.1 alone.
    const resolve = vi.fn(async () => ["::1", "127.0.0.1"]);
    const client = createCustomApiTransport(
      {
        baseUrl: base.replace("127.0.0.1", "localhost"),
        mode: "local",
        credential: { kind: "local-no-key" },
      },
      resolve,
    );
    transports.push(client);
    expect(await (await client.request("models")).json()).toEqual({
      data: [{ id: "local-model" }],
    });
    expect(seen).toEqual([
      `GET /proxy/v1/models Host: ${new URL(base).host.replace("127.0.0.1", "localhost")}`,
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("sends literal keys only to the exact approved operation and strips response headers", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Exercise literal credentials, never evaluate this synthetic key.
    const key = "$(not-a-command) ${NOT_AN_ENV_REFERENCE}";
    const wire: { method?: string; path?: string; credentialMatches: boolean; body: string }[] = [];
    const base = await fixture(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      wire.push({
        method: req.method,
        path: req.url,
        credentialMatches: req.headers.authorization === `Bearer ${key}`,
        body,
      });
      res.writeHead(200, {
        "Content-Type": req.method === "GET" ? "application/json" : "text/event-stream",
        "X-Untrusted": key,
      });
      res.end(
        req.method === "GET"
          ? '{"data":[{"id":"operator-model"}]}'
          : 'data: {"text":"synthetic reply"}\n\n',
      );
    });
    const client = transport(base, key);
    const list = await client.request("models");
    expect(await list.json()).toEqual({ data: [{ id: "operator-model" }] });
    expect(list.headers.get("x-untrusted")).toBeNull();
    const stream = await client.request(
      "chat/completions",
      '{"model":"operator-model","stream":true}',
    );
    expect(await stream.text()).toContain("synthetic reply");
    expect(wire).toEqual([
      { method: "GET", path: "/proxy/v1/models", credentialMatches: true, body: "" },
      {
        method: "POST",
        path: "/proxy/v1/chat/completions",
        credentialMatches: true,
        body: '{"model":"operator-model","stream":true}',
      },
    ]);
    // Product evidence captures actual wire facts, never the synthetic credential.
    console.info("CUSTOM_API_WIRE", JSON.stringify(wire));
  });

  it("keyless requests send no Authorization, including Responses", async () => {
    let authorization: string | undefined;
    let path: string | undefined;
    const base = await fixture((req, res) => {
      authorization = req.headers.authorization;
      path = req.url;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: synthetic\n\n");
    });
    const response = await transport(base).request("responses", '{"store":false,"stream":true}');
    await response.text();
    expect(authorization).toBeUndefined();
    expect(path).toBe("/proxy/v1/responses");
    console.info(
      "CUSTOM_API_KEYLESS",
      JSON.stringify({ path, authorizationAbsent: authorization === undefined }),
    );
    // An unknown credential kind is still refused.
    expect(() =>
      createCustomApiTransport({
        baseUrl: "https://example.com",
        mode: "public",
        credential: { kind: "ambient" } as unknown as { kind: "local-no-key" },
      }),
    ).toThrow(CustomApiError);
  });

  it("sends the person's extra headers on every operation and guards secret values like the key", async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const base = await fixture((req, res) => {
      seen.push({ ...req.headers });
      res.writeHead(200, {
        "Content-Type": req.method === "GET" ? "application/json" : "text/event-stream",
      });
      res.end(req.method === "GET" ? '{"data":[]}' : "data: synthetic\n\n");
    });
    const client = createCustomApiTransport({
      baseUrl: base,
      mode: "local",
      credential: { kind: "bearer", key: "synthetic-key" },
      headers: [
        { name: "X-Org-Id", value: "eng", secret: false },
        { name: "X-Gateway-Token", value: "synthetic-gateway-secret", secret: true },
      ],
    });
    transports.push(client);
    await (await client.request("models")).text();
    await (await client.request("chat/completions", '{"stream":true}')).text();
    await (await client.request("responses", '{"store":false,"stream":true}')).text();
    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(headers["x-org-id"]).toBe("eng");
      expect(headers["x-gateway-token"]).toBe("synthetic-gateway-secret");
      expect(headers.authorization).toBe("Bearer synthetic-key");
    }
    // A visible value such as a team name never blocks an ordinary reply.
    expect(() => client.assertSafeOutput({ text: "engineering notes" })).not.toThrow();
    for (const echo of ["synthetic-gateway-secret", JSON.stringify("synthetic-gateway-secret")])
      expect(() => client.assertSafeOutput({ text: `leak ${echo}` })).toThrow(CustomApiError);
    client.close();
    expect(() => client.assertSafeOutput("anything")).toThrow(CustomApiError);
  });

  it("sends no key to a public server that needs none, or lets its own header carry one", async () => {
    const options = {
      baseUrl: "https://gateway.example.test/v1",
      mode: "public" as const,
      credential: { kind: "local-no-key" as const },
    };
    transports.push(createCustomApiTransport(options));
    const keyless = createCustomApiTransport({
      ...options,
      headers: [{ name: "Authorization", value: "Basic c3ludGhldGlj", secret: true }],
    });
    transports.push(keyless);
    expect(() =>
      createCustomApiTransport({
        ...options,
        credential: { kind: "bearer", key: "synthetic-key" },
        headers: [{ name: "Authorization", value: "Basic c3ludGhldGlj", secret: true }],
      }),
    ).toThrow(CustomApiError);
    expect(() =>
      createCustomApiTransport({
        ...options,
        credential: { kind: "bearer", key: "synthetic-key" },
        headers: [{ name: "Host", value: "elsewhere.example.test", secret: false }],
      }),
    ).toThrow(CustomApiError);
  });

  it("reads an address's network from every DNS answer, or from the address itself", async () => {
    const at = (answers: string[] | Error) =>
      vi.fn(async () => {
        if (answers instanceof Error) throw answers;
        return answers;
      });
    const read = (address: string, answers: string[] | Error = []) =>
      readCustomApiDestination(address, at(answers));
    await expect(read("http://localhost:11434/v1/", ["127.0.0.1", "::1"])).resolves.toEqual({
      baseUrl: "http://localhost:11434/v1",
      hostname: "localhost",
      mode: "local",
    });
    await expect(read("https://llm.corp.example/v1", ["10.20.30.40"])).resolves.toMatchObject({
      mode: "private",
    });
    await expect(read("https://api.example.com/v1", ["93.184.216.34"])).resolves.toMatchObject({
      mode: "public",
    });
    // A literal address needs no lookup.
    const unused = at(["127.0.0.1"]);
    await expect(
      readCustomApiDestination("http://10.0.0.2:4000/v1", unused),
    ).resolves.toMatchObject({ mode: "private" });
    expect(unused).not.toHaveBeenCalled();
    // Two classes at once, a forbidden range, or no answer at all is refused.
    for (const answers of [["10.20.30.40", "93.184.216.34"], ["169.254.169.254"], []])
      await expect(read("https://mixed.example/v1", answers)).rejects.toMatchObject({
        category: "destination",
      });
    await expect(read("https://missing.example/v1", new Error("ENOTFOUND"))).rejects.toMatchObject({
      category: "network",
    });
    await expect(
      read("https://api.example.com/v1/chat/completions", ["93.184.216.34"]),
    ).rejects.toMatchObject({ category: "address", baseSuggestion: "https://api.example.com/v1" });
  });

  it.each(["public", "private"] as const)(
    "HTTP %s rechecks every DNS answer before sending",
    async (mode) => {
      const resolver = vi.fn(async () => ["169.254.169.254"]);
      const result = createCustomApiTransport(
        {
          baseUrl: "http://gateway.example.test/v1",
          mode,
          credential:
            mode === "private"
              ? { kind: "local-no-key" }
              : { kind: "bearer", key: "synthetic-key" },
        },
        resolver,
      );
      transports.push(result);
      await expect(result.request("models")).rejects.toMatchObject({ category: "destination" });
      resolver.mockResolvedValueOnce(
        mode === "private" ? ["10.1.2.3", "8.8.8.8"] : ["8.8.8.8", "10.1.2.3"],
      );
      await expect(result.request("models")).rejects.toMatchObject({ category: "destination" });
      expect(resolver).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [301, "redirect"],
    [307, "redirect"],
    [401, "key-rejected"],
    [403, "access-refused"],
    [404, "not-found"],
    [429, "rate-limit"],
    [500, "server"],
  ])("discards hostile %s errors without redirect, echo or raw cause", async (status, category) => {
    const key = "opaque-synthetic-secret";
    let destinationCalls = 0;
    const alternate = await fixture((_req, res) => {
      destinationCalls++;
      res.end("must not arrive");
    });
    let approvedCalls = 0;
    const base = await fixture((_req, res) => {
      approvedCalls++;
      res.writeHead(Number(status), { Location: `${alternate}/models`, "X-Secret": key });
      res.end(
        JSON.stringify({
          error: { message: `${key} ${encodeURIComponent(key)} https://hostile.invalid` },
        }),
      );
    });
    const error = await transport(base, key)
      .request("models")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ category, status });
    expect(String(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("hostile.invalid");
    expect(destinationCalls).toBe(0);
    expect(approvedCalls).toBe(1);
    console.info(
      "CUSTOM_API_SAFE_FAILURE",
      JSON.stringify({
        status,
        category,
        approvedCalls,
        destinationCalls,
        credentialEchoAbsent: !String(error).includes(key),
      }),
    );
  });

  it("recognizes a generation overflow from the error reply and discards the text", async () => {
    const key = "opaque-synthetic-secret";
    const overflow = `This model's maximum context length is 20000 tokens. However, you requested 90000 tokens. Please reduce the length of the messages or completion. ${key}`;
    const base = await fixture((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: overflow } }));
    });
    const error = await transport(base, key)
      .request("chat/completions", "{}")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ category: "context-limit", status: 400 });
    expect(JSON.stringify(error)).not.toContain(key);
    expect(String(error)).not.toContain("90000");
    expect(error).not.toHaveProperty("cause");

    const other = await fixture((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: `${key} quota is exhausted for this account` } }));
    });
    const plain = await transport(other, key)
      .request("chat/completions", "{}")
      .catch((e: unknown) => e);
    expect(plain).toMatchObject({ category: "server", status: 400 });
    expect(JSON.stringify(plain)).not.toContain(key);

    const late = await fixture((_req, res) => {
      res.writeHead(400);
      res.end(`${"x".repeat(16 * 1024)} exceeds the context window`);
    });
    const missed = await transport(late)
      .request("chat/completions", "{}")
      .catch((e: unknown) => e);
    expect(missed).toMatchObject({ category: "server", status: 400 });
    expect(String(missed)).not.toContain("exceeds the context window");
  });

  it("bounds chunked replies and refuses unsupported content types", async () => {
    const large = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("x".repeat(1024 * 1024 + 1));
    });
    const reply = await transport(large).request("models");
    await expect(reply.text()).rejects.toMatchObject({ category: "oversized" });
    const wrongType = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<a>untrusted page</a>");
    });
    await expect(transport(wrongType).request("models")).rejects.toMatchObject({
      category: "malformed",
    });
  });

  it.each([204, 205])(
    "refuses no-content success %s instead of constructing an invalid stream",
    async (status) => {
      const base = await fixture((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end();
      });
      await expect(transport(base).request("models")).rejects.toMatchObject({
        category: "malformed",
      });
    },
  );

  it("aborts and permanently closes streaming requests", async () => {
    const base = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: partial\n\n");
    });
    const client = transport(base);
    const response = await client.request("responses", "{}");
    const text = response.text();
    client.close();
    await expect(text).rejects.toMatchObject({ category: "closed" });
    await expect(client.request("models")).rejects.toMatchObject({ category: "closed" });
    const controller = new AbortController();
    const second = transport(base);
    const streamed = await second.request("responses", "{}", controller.signal);
    const consume = streamed.text();
    controller.abort("untrusted reason must not surface");
    await expect(consume).rejects.toMatchObject({ category: "cancelled" });
  });

  it("checks every DNS result again and cancels unresolved DNS without late requests", async () => {
    const resolve = vi.fn().mockResolvedValue(["8.8.8.8", "127.0.0.1"]);
    const client = createCustomApiTransport(
      {
        baseUrl: "https://api.example.com/v1",
        mode: "public",
        credential: { kind: "bearer", key: "synthetic" },
      },
      resolve,
    );
    transports.push(client);
    await expect(client.request("models")).rejects.toMatchObject({ category: "destination" });
    resolve.mockResolvedValue(["10.0.0.1"]);
    await expect(client.request("models")).rejects.toMatchObject({ category: "destination" });
    expect(resolve).toHaveBeenCalledTimes(2);
    let finish: (addresses: string[]) => void = () => undefined;
    const blocked = createCustomApiTransport(
      {
        baseUrl: "https://api.example.com",
        mode: "public",
        credential: { kind: "bearer", key: "synthetic" },
      },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    transports.push(blocked);
    const pending = blocked.request("models");
    blocked.close();
    await expect(pending).rejects.toMatchObject({ category: "closed" });
    finish(["8.8.8.8"]);
  });

  it("lets a turn finish a reply that keeps streaming past the check's minute and 1 MiB", async () => {
    // Only the transport's own clock is faked; the sockets stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { base, reply } = await heldStream();
    const response = await transport(base, undefined, "turn").request("chat/completions", "{}");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing reply body");
    const server = await reply;
    const piece = `data: ${"x".repeat(80 * 1024)}\n\n`;
    const gap = (CUSTOM_API_TURN_LIMITS.idleMs ?? 0) - MINUTE;
    let bytes = 0;
    let elapsed = 0;
    // A slow server: a piece, then a silence just short of the idle limit.
    while (elapsed + gap < CUSTOM_API_TURN_LIMITS.totalMs) {
      server.write(piece);
      bytes += await received(reader, piece.length);
      await vi.advanceTimersByTimeAsync(gap);
      elapsed += gap;
    }
    server.end();
    expect(await reader.read()).toMatchObject({ done: true });
    expect(elapsed).toBeGreaterThan(CUSTOM_API_CHECK_LIMITS.totalMs);
    expect(bytes).toBeGreaterThan(CUSTOM_API_CHECK_LIMITS.replyBytes);
  });

  it("cuts off a turn whose server goes silent, before or during its reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idle = CUSTOM_API_TURN_LIMITS.idleMs ?? 0;
    const silent = await fixture(() => undefined);
    const waiting = expect(
      transport(silent, undefined, "turn").request("chat/completions", "{}"),
    ).rejects.toMatchObject({ category: "stalled" });
    await vi.advanceTimersByTimeAsync(idle);
    await waiting;

    const { base, reply } = await heldStream();
    const response = await transport(base, undefined, "turn").request("responses", "{}");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing reply body");
    (await reply).write("data: started\n\n");
    await received(reader, "data: started\n\n".length);
    const stalled = expect(reader.read()).rejects.toMatchObject({ category: "stalled" });
    await vi.advanceTimersByTimeAsync(idle);
    await stalled;
  });

  it("cuts off a turn whose server never stops, by time or by size", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { base, reply } = await heldStream();
    const response = await transport(base, undefined, "turn").request("chat/completions", "{}");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing reply body");
    const server = await reply;
    const gap = (CUSTOM_API_TURN_LIMITS.idleMs ?? 0) - MINUTE;
    for (let elapsed = 0; elapsed + gap < CUSTOM_API_TURN_LIMITS.totalMs; elapsed += gap) {
      server.write("data: more\n\n");
      await received(reader, "data: more\n\n".length);
      await vi.advanceTimersByTimeAsync(gap);
    }
    server.write("data: more\n\n");
    await received(reader, "data: more\n\n".length);
    const ended = expect(reader.read()).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(gap);
    await ended;
    vi.useRealTimers();

    const declared = await fixture((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Content-Length": CUSTOM_API_TURN_LIMITS.replyBytes + 1,
      });
      res.flushHeaders();
    });
    await expect(
      transport(declared, undefined, "turn").request("chat/completions", "{}"),
    ).rejects.toMatchObject({ category: "oversized" });
    const flood = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const piece = Buffer.alloc(1024 * 1024, "x");
      let sent = 0;
      const pump = () => {
        while (sent <= CUSTOM_API_TURN_LIMITS.replyBytes && !res.destroyed) {
          sent += piece.length;
          if (!res.write(piece)) return void res.once("drain", pump);
        }
      };
      pump();
    });
    const flooded = await transport(flood, undefined, "turn").request("chat/completions", "{}");
    await expect(flooded.text()).rejects.toMatchObject({ category: "oversized" });
  });

  it("keeps the connection check to its minute and 1 MiB however steadily it streams", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { base, reply } = await heldStream();
    const response = await transport(base).request("chat/completions", "{}");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing reply body");
    const server = await reply;
    const gap = 10_000;
    for (let elapsed = gap; elapsed < CUSTOM_API_CHECK_LIMITS.totalMs; elapsed += gap) {
      server.write("data: steady\n\n");
      await received(reader, "data: steady\n\n".length);
      await vi.advanceTimersByTimeAsync(gap);
    }
    server.write("data: steady\n\n");
    await received(reader, "data: steady\n\n".length);
    const ended = expect(reader.read()).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(gap);
    await ended;
    vi.useRealTimers();

    const large = await fixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${"x".repeat(CUSTOM_API_CHECK_LIMITS.replyBytes)}\n\n`);
    });
    const check = await transport(large, undefined, "check").request("responses", "{}");
    await expect(check.text()).rejects.toMatchObject({ category: "oversized" });
  });

  it("sizes a generation request by its model's documented context and sends nothing past it", async () => {
    const received: number[] = [];
    const base = await fixture(async (req, res) => {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      received.push(bytes);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: synthetic\n\n");
    });
    const client = transport(base, undefined, "turn");
    const context = 1_048_576;
    const limit = customApiRequestBytes(context);
    const largest = JSON.stringify({ text: "x".repeat(limit - '{"text":""}'.length) });
    expect(Buffer.byteLength(largest)).toBe(limit);
    await (await client.request("chat/completions", largest, undefined, context)).text();
    await (await client.request("responses", largest, undefined, context)).text();
    expect(received).toEqual([limit, limit]);
    // One byte more, or the same request for a smaller model or none, never leaves this Mac.
    for (const [body, size] of [
      [`${largest} `, context],
      [largest, 131_072],
      [largest, undefined],
    ] as const) {
      await expect(client.request("chat/completions", body, undefined, size)).rejects.toMatchObject(
        { category: "context-limit" },
      );
    }
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client.request("responses", "{}", undefined, size)).rejects.toMatchObject({
        category: "limits",
      });
    }
    expect(received).toEqual([limit, limit]);
  });

  it("bounds DNS time and ignores its late result", async () => {
    vi.useFakeTimers();
    const client = createCustomApiTransport(
      {
        baseUrl: "https://api.example.com",
        mode: "public",
        credential: { kind: "bearer", key: "synthetic" },
      },
      () => new Promise(() => undefined),
    );
    transports.push(client);
    const pending = expect(client.request("models")).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  });
});
