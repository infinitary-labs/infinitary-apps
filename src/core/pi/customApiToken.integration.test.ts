import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CustomApiAccountOwner } from "./customApiAccounts";
import {
  CUSTOM_TOKEN_RECENT_LIMIT,
  CUSTOM_TOKEN_RECENT_MS,
  CustomApiTokenError,
  customApiToken,
} from "./customApiToken";
import { type CustomApiTransport, createCustomApiTransport } from "./customApiTransport";

// Intent: the accepted enterprise access plan’s Custom connection piece: arbitrary shell command,
// expiring tokens, one refusal retry, dual Claude headers, no stored token or fallback.
// Real disposable token helper and HTTP gateway; every reading is from the wire or owner.
let home: string;
const servers: Server[] = [];
const transports: CustomApiTransport[] = [];
beforeEach(() => {
  home = scratchDir("custom-token-");
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function gateway(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway port");
  return `http://127.0.0.1:${address.port}/v1`;
}
function helper() {
  const script = join(home, "company-token.cjs");
  const count = join(home, "calls");
  // A realistic corporate helper's only output is its short-lived token.
  writeFileSync(
    script,
    `const fs = require('node:fs'); const file = ${JSON.stringify(count)};
let n=0; try { n=Number(fs.readFileSync(file,'utf8')); } catch {}
fs.writeFileSync(file,String(++n)); process.stdout.write('disposable-gateway-token-'+n);`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return {
    command: `${quote(process.execPath)} ${quote(script)} | cat`,
    calls: () => Number(readFileSync(count, "utf8")),
  };
}
function connection(
  baseUrl: string,
  command: string,
  extra: Partial<Parameters<typeof createCustomApiTransport>[0]> = {},
) {
  const transport = createCustomApiTransport({
    baseUrl,
    mode: "local",
    anthropic: true,
    credential: { kind: "command", settings: { command, refreshSeconds: 300 } },
    ...extra,
  });
  transports.push(transport);
  return transport;
}
async function list(transport: CustomApiTransport) {
  const response = await transport.request("models");
  return await response.json();
}

describe("Settings-approved token commands (accepted enterprise access plan)", () => {
  it("runs shell syntax, renews once on a 401 and sends both Claude credential headers without publishing either token", async () => {
    const command = helper();
    const requests: string[] = [];
    const base = await gateway((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${req.headers["x-api-key"]}`);
      requests.push(String(req.headers["x-api-key"]));
      res.writeHead(requests.length === 1 ? 401 : 200, { "Content-Type": "text/event-stream" });
      res.end(requests.length === 1 ? "refused" : "data: completed\n\n");
    });
    const transport = connection(base, command.command);
    const response = await transport.request(
      "messages",
      JSON.stringify({ model: "claude-sonnet", messages: [] }),
    );
    expect(await response.text()).toBe("data: completed\n\n");
    expect(requests).toEqual(["disposable-gateway-token-1", "disposable-gateway-token-2"]);
    expect(command.calls()).toBe(2);
    for (const token of requests)
      expect(() => transport.assertSafeOutput({ text: token })).toThrow();
  });

  it("shares renewal across simultaneous requests and refreshes before the first request after expiry", async () => {
    const command = helper();
    const requests: string[] = [];
    const base = await gateway((req, res) => {
      requests.push(String(req.headers["x-api-key"]));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":[]}');
    });
    const transport = connection(base, command.command);
    await Promise.all([list(transport), list(transport)]);
    expect(command.calls()).toBe(1);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
    await list(transport);
    expect(command.calls()).toBe(2);
    expect(requests).toEqual([
      "disposable-gateway-token-1",
      "disposable-gateway-token-1",
      "disposable-gateway-token-2",
    ]);
  });

  it("stops after a second refusal, never renews for 403, and reports only a safe command failure", async () => {
    const command = helper();
    let requests = 0;
    let status = 401;
    const base = await gateway((_req, res) => {
      requests++;
      res.writeHead(status);
      res.end("private gateway diagnostic");
    });
    const transport = connection(base, command.command);
    await expect(list(transport)).rejects.toBeInstanceOf(CustomApiTokenError);
    expect(requests).toBe(2);
    expect(command.calls()).toBe(2);
    status = 403;
    await expect(list(transport)).rejects.toMatchObject({ category: "access-refused" });
    expect(requests).toBe(3);
    // A refused token is never kept as a fallback for another request.
    expect(command.calls()).toBe(3);
  });

  it("discards failed, empty, oversized and multiline output without reaching the gateway or falling back", async () => {
    let requests = 0;
    const base = await gateway((_req, res) => {
      requests++;
      res.end();
    });
    for (const command of [
      "printf private-output; exit 1",
      "printf ''",
      "printf 'one\\ntwo'",
      "printf '%09000d' 0",
    ]) {
      const transport = connection(base, command);
      const error = await list(transport).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CustomApiTokenError);
      expect(String(error)).not.toContain("private-output");
    }
    expect(requests).toBe(0);
  });

  it("cancels a waiting request and terminal close stops an in-flight command without a late request", async () => {
    let requests = 0;
    const base = await gateway((_req, res) => {
      requests++;
      res.end();
    });
    let started!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      started = resolve;
    });
    const startup = await gateway((req, res) => {
      started(Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("pid")));
      res.end();
    });
    const script = join(home, "waiting-helper.cjs");
    writeFileSync(
      script,
      `require('node:http').get(${JSON.stringify(startup)} + '/ready?pid=' + process.pid); setInterval(() => {}, 1000);`,
    );
    // exec makes this real blocked helper the shell's process-group leader.
    const transport = connection(base, `exec '${process.execPath}' '${script}'`);
    const abort = new AbortController();
    const result = transport.request("models", undefined, abort.signal);
    const pid = await ready;
    expect(() => process.kill(-pid, 0)).not.toThrow();
    abort.abort();
    await expect(result).rejects.toMatchObject({ category: "cancelled" });
    transport.close();
    // Waiting for the shared renewal's rejection also observes child close, not just kill dispatch.
    await expect(list(transport)).rejects.toMatchObject({ category: "closed" });
    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow());
    expect(requests).toBe(0);
  });

  // Captain’s token-review answer: current, in-flight, and only the last few briefly.
  it("bounds retired tokens by count and time while preserving current and active tokens", async () => {
    const command = helper();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = customApiToken({ command: command.command, refreshSeconds: 300 });
    try {
      const first = await owner.get();
      const release = owner.retain(first);
      let current = first;
      for (let i = 0; i < CUSTOM_TOKEN_RECENT_LIMIT * 4; i++) {
        current = await owner.get(undefined, current);
        expect(owner.secrets()).toContain(first);
        expect(owner.secrets()).toContain(current);
        expect(owner.secrets().length).toBeLessThanOrEqual(CUSTOM_TOKEN_RECENT_LIMIT + 2);
      }
      const newest = owner.secrets();
      expect(newest).toHaveLength(CUSTOM_TOKEN_RECENT_LIMIT + 2);
      // The real helper produces the tokens; only retention and command-budget clocks are controlled.
      await vi.advanceTimersByTimeAsync(CUSTOM_TOKEN_RECENT_MS);
      expect(vi.getTimerCount()).toBe(0);
      expect(owner.secrets()).toEqual([current, first]);
      release();
      expect(owner.secrets()).toContain(first);
      await vi.advanceTimersByTimeAsync(CUSTOM_TOKEN_RECENT_MS);
      expect(owner.secrets()).toEqual([current]);
      owner.close();
      expect(owner.secrets()).toEqual([]);
    } finally {
      owner.close();
    }
  });

  it("guards an old token until its actual response is cancelled even after history expires", async () => {
    const command = helper();
    const received: string[] = [];
    const base = await gateway((req, res) => {
      received.push(String(req.headers["x-api-key"]));
      res.writeHead(200, {
        "Content-Type": req.url?.endsWith("messages") ? "text/event-stream" : "application/json",
      });
      if (req.url?.endsWith("messages")) res.write("data: waiting\n\n");
      else res.end('{"data":[]}');
    });
    const transport = connection(base, command.command);
    const response = await transport.request("messages", "{}");
    const first = received[0];
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let i = 1; i <= CUSTOM_TOKEN_RECENT_LIMIT + 2; i++) {
      clock.mockReturnValue(now + i * 301_000);
      await list(transport);
    }
    expect(() => transport.assertSafeOutput(first)).toThrow();
    await response.body?.cancel();
    clock.mockReturnValue(Date.now() + CUSTOM_TOKEN_RECENT_MS + 1);
    expect(() => transport.assertSafeOutput(first)).not.toThrow();
    expect(() => transport.assertSafeOutput(received.at(-1))).toThrow();
  });

  it("keeps a fixed Messages key on x-api-key alone and does not retry it", async () => {
    let requests = 0;
    const base = await gateway((req, res) => {
      requests++;
      expect(req.headers["x-api-key"]).toBe("disposable-fixed-key");
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(401);
      res.end();
    });
    const transport = connection(base, "unused", {
      credential: { kind: "bearer", key: "disposable-fixed-key" },
    });
    await expect(list(transport)).rejects.toMatchObject({ category: "key-rejected" });
    expect(requests).toBe(1);
  });

  it("checks with the produced token but saves only command settings, and rejects mixing a command with a fixed key", async () => {
    const command = helper();
    const base = await gateway((req, res) => {
      expect(req.headers["x-api-key"]).toBe("disposable-gateway-token-1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":[{"id":"claude-sonnet","context_length":200000,"max_output_tokens":8192}]}');
    });
    const owner = new CustomApiAccountOwner();
    const input = {
      label: "Company gateway",
      baseUrl: base,
      protocol: "anthropic-messages" as const,
      key: "",
      noKey: false,
      headers: [],
      tokenCommand: { command: command.command, refreshSeconds: 300 },
      approvedDestination: base,
      unencryptedLocalApproved: true,
      allowStorageDefault: false,
      storageApproved: false,
      models: [{ id: "claude-sonnet", context: 200000, output: 8192 }],
    };
    const result = await owner.connect(input);
    expect(result.failure).toBeUndefined();
    expect(result.listed?.[0]?.id).toBe("claude-sonnet");
    expect(result.view?.tokenCommand).toEqual(input.tokenCommand);
    const dir = join(home, "account");
    mkdirSync(dir);
    await owner.save(
      result.view?.draftId ?? "",
      { accountId: "custom", providerId: "fm-custom-0123456789abcdef", dir },
      true,
    );
    const saved = readFileSync(join(dir, "custom-auth.json"), "utf8");
    expect(saved).toContain("company-token.cjs");
    expect(saved).not.toContain("disposable-gateway-token");
    expect(JSON.stringify(result)).not.toContain("disposable-gateway-token");
    expect((await owner.connect({ ...input, key: "disposable-fixed-key" })).failure?.category).toBe(
      "credential",
    );
  });
});
