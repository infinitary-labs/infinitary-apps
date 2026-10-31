import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type AssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import {
  chatFrame,
  customChatCall,
  customChatText,
  customResponsesCall,
  customResponsesText,
  responseFrame,
  sendCustomStream,
} from "../../../tests/helpers/customApiDialect";
import { customPicture } from "../../../tests/helpers/customPictures";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type CustomConnectionCandidate,
  checkCustomApiModel,
  customModelFingerprint,
  customModelProofMatches,
  listCustomApiModels,
} from "./customApiCheck";
import { CustomApiError } from "./customApiPolicy";
import {
  type CustomApiProtocol,
  type CustomGeneration,
  generateCustomApi,
} from "./customApiProtocol";
import {
  CUSTOM_API_BYTES_PER_TOKEN,
  type CustomApiTransport,
  createCustomApiTransport,
  customApiRequestBytes,
} from "./customApiTransport";

const servers: Server[] = [];
const transports: CustomApiTransport[] = [];
beforeEach(() => {
  const home = scratchDir("custom-profile-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
});
afterEach(async () => {
  for (const client of transports.splice(0)) client.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

async function fixture(handler: (request: IncomingMessage, reply: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}/operator/base`;
}
function client(baseUrl: string) {
  const result = createCustomApiTransport({
    baseUrl,
    mode: "local",
    credential: { kind: "local-no-key" },
  });
  transports.push(result);
  return result;
}
function candidate(baseUrl: string, protocol: CustomApiProtocol): CustomConnectionCandidate {
  return {
    baseUrl,
    protocol,
    mode: "local",
    credential: { kind: "local-no-key" },
    credentialRevision: "revision-1",
    limits: { context: 8192, output: 512 },
    model: "synthetic-model",
    storage: { kind: "no-store" },
  };
}
function generation(protocol: CustomApiProtocol): CustomGeneration {
  return {
    protocol,
    model: "synthetic-model",
    limits: { context: 8192, output: 512 },
    storage: { kind: "no-store" },
    context: normalizeContext({
      systemPrompt: "Synthetic instructions.",
      messages: [{ role: "user", content: "Synthetic request.", timestamp: 0 }],
    }),
  };
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

describe.each(["openai-completions", "openai-responses"] as const)(
  "%s explicit profile on actual sockets",
  (protocol) => {
    const textStream = protocol === "openai-completions" ? customChatText : customResponsesText;
    const callStream = protocol === "openai-completions" ? customChatCall : customResponsesCall;

    it("checks synthetic tools and local replay with bounded text and optional picture requests and unknown usage", async () => {
      const wire: { path?: string; noAuthorization: boolean; payload: Record<string, unknown> }[] =
        [];
      const base = await fixture(async (req, res) => {
        const payload = await bodyOf(req);
        wire.push({
          path: req.url,
          noAuthorization: req.headers.authorization === undefined,
          payload,
        });
        sendCustomStream(
          res,
          wire.length === 1
            ? callStream("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}')
            : textStream("FIRSTMATE_CUSTOM_API_OK"),
        );
      });
      const config = candidate(base, protocol);
      const proof = await checkCustomApiModel(config);
      expect(customModelProofMatches(config, proof)).toBe(true);
      expect(proof.profile).toBe(
        protocol === "openai-completions" ? "pi-capabilities-v4" : "pi-capabilities-v3",
      );
      expect(
        customModelProofMatches(config, {
          ...proof,
          profile: "text-tools-v1" as typeof proof.profile,
        }),
      ).toBe(false);
      expect(wire).toHaveLength(3);
      expect(proof.readsPictures).toBe(false);
      const operation = protocol === "openai-completions" ? "chat/completions" : "responses";
      expect(
        wire.every(
          (request) => request.path === `/operator/base/${operation}` && request.noAuthorization,
        ),
      ).toBe(true);
      for (const request of wire) {
        // An independent oracle asserts the minimal request contract, including
        // fields omitted on every path; it is not a source-string assertion.
        const expected =
          protocol === "openai-completions"
            ? ["max_tokens", "messages", "model", "stream", "stream_options", "tools"]
            : ["input", "max_output_tokens", "model", "store", "stream", "tools"];
        expect(Object.keys(request.payload).sort()).toEqual(expected.sort());
        expect(request.payload.stream).toBe(true);
        if (protocol === "openai-completions")
          expect(request.payload.stream_options).toEqual({ include_usage: true });
        expect(
          request.payload[protocol === "openai-completions" ? "max_tokens" : "max_output_tokens"],
        ).toBe(128);
        if (protocol === "openai-responses") expect(request.payload.store).toBe(false);
      }
      const replay = wire[1]?.payload;
      if (protocol === "openai-completions") {
        expect(replay?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              tool_calls: [expect.objectContaining({ id: "check_call", type: "function" })],
            }),
            { role: "tool", tool_call_id: "check_call", content: "FIRSTMATE_CUSTOM_API_OK" },
          ]),
        );
      } else {
        expect(replay?.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "function_call", call_id: "check_call" }),
            {
              type: "function_call_output",
              call_id: "check_call",
              output: "FIRSTMATE_CUSTOM_API_OK",
            },
          ]),
        );
      }
      const independent = await generateCustomApi(client(base), generation(protocol));
      expect(textOf(independent)).toBe("FIRSTMATE_CUSTOM_API_OK");
      expect(independent.usage.input).toBe(0);
      expect(independent.usage.output).toBe(0);
      expect(independent.usage.cost.total).toBeNaN();
      console.info(
        "CUSTOM_API_PROFILE_WIRE",
        JSON.stringify({
          protocol,
          requests: wire.slice(0, 2),
          proof,
          usageUnpriced: Number.isNaN(independent.usage.cost.total),
        }),
      );
    });

    it.each([
      ["unknown tool", "other_action", '{"text":"FIRSTMATE_CUSTOM_API_OK"}'],
      ["wrong arguments", "firstmate_echo", '{"text":"wrong"}'],
      ["extra arguments", "firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK","path":"ignored"}'],
      ["malformed arguments", "firstmate_echo", '{"text":'],
    ])("cannot grant proof for %s or execute another action", async (_case, name, args) => {
      let calls = 0;
      const base = await fixture((_req, res) => {
        calls++;
        sendCustomStream(res, callStream(name, args));
      });
      await expect(checkCustomApiModel(candidate(base, protocol))).rejects.toHaveProperty(
        "category",
      );
      expect(calls).toBe(1);
    });

    it("cancels an in-flight check without second request or late proof", async () => {
      let notify: () => void = () => {};
      const arrived = new Promise<void>((resolve) => {
        notify = resolve;
      });
      let requests = 0;
      const base = await fixture((_req, res) => {
        requests++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": synthetic waiting\n\n");
        notify();
      });
      const abort = new AbortController();
      const checked = checkCustomApiModel(candidate(base, protocol), abort.signal);
      const failure = expect(checked).rejects.toMatchObject({ category: "cancelled" });
      await arrived;
      abort.abort("untrusted cancellation detail");
      await failure;
      expect(requests).toBe(1);
    });

    it("refuses unknown limits and unpaired tool history before any request, and sends a long message", async () => {
      let requests = 0;
      const base = await fixture((_req, res) => {
        requests++;
        sendCustomStream(res, textStream("unused"));
      });
      const config = candidate(base, protocol);
      await expect(
        checkCustomApiModel({ ...config, limits: { context: 0, output: 0 } }),
      ).rejects.toMatchObject({ category: "limits" });
      await expect(
        checkCustomApiModel({ ...config, limits: { context: 100, output: 100 } }),
      ).rejects.toMatchObject({ category: "limits" });
      expect(requests).toBe(0);
      // INF-202: a message the old bytes-per-token check refused is sent.
      expect(
        textOf(
          await generateCustomApi(client(base), {
            ...generation(protocol),
            context: normalizeContext({
              messages: [{ role: "user", content: "x".repeat(30000), timestamp: 0 }],
            }),
          }),
        ),
      ).toBe("unused");
      expect(requests).toBe(1);
      await expect(
        generateCustomApi(client(base), {
          ...generation(protocol),
          context: normalizeContext({
            messages: [
              {
                role: "toolResult",
                toolCallId: "missing",
                toolName: "missing",
                content: [{ type: "text", text: "unexpected" }],
                isError: false,
                timestamp: 0,
              },
            ],
          }),
        }),
      ).rejects.toMatchObject({ category: "incompatible" });
      expect(requests).toBe(1);
    });

    it("invalidates proof for each relevant revision but not canonical outer whitespace", async () => {
      let requests = 0;
      const base = await fixture((_req, res) => {
        requests++;
        sendCustomStream(
          res,
          requests % 2
            ? callStream("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}')
            : textStream("FIRSTMATE_CUSTOM_API_OK"),
        );
      });
      const config = candidate(base, protocol);
      const proof = await checkCustomApiModel(config);
      const changes: Partial<CustomConnectionCandidate>[] = [
        { baseUrl: `${base}/new` },
        { mode: "private" },
        { credentialRevision: "revision-2" },
        { credential: { kind: "bearer", key: "synthetic-only" } },
        { model: "another-model" },
        { limits: { context: 16384, output: 512 } },
        { limits: { context: 8192, output: 256 } },
        { protocol: protocol === "openai-completions" ? "openai-responses" : "openai-completions" },
        { storage: { kind: "server-default", consentRevision: "consent-2" } },
        { headers: [{ name: "X-Org-Id", value: "eng", secret: false }] },
      ];
      for (const change of changes)
        expect(customModelProofMatches({ ...config, ...change }, proof)).toBe(false);
      expect(customModelProofMatches({ ...config, baseUrl: ` ${base}/ ` }, proof)).toBe(true);
      // A connection saved before extra headers existed keeps its proof.
      expect(customModelProofMatches({ ...config, headers: [] }, proof)).toBe(true);
      expect(
        customModelProofMatches(config, {
          ...proof,
          profile: "old-profile" as typeof proof.profile,
        }),
      ).toBe(false);
      expect(requests).toBe(3);
    });

    it.each(["47", "unknown", "refused"])(
      "saves text proof when the picture check answers %s",
      async (answer) => {
        const wire: Record<string, unknown>[] = [];
        const base = await fixture(async (req, res) => {
          const payload = await bodyOf(req);
          wire.push(payload);
          if (wire.length === 3 && answer === "refused") {
            res.writeHead(400);
            res.end();
            return;
          }
          sendCustomStream(
            res,
            wire.length === 1
              ? callStream("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}')
              : textStream(wire.length === 2 ? "FIRSTMATE_CUSTOM_API_OK" : answer),
          );
        });
        const config = candidate(base, protocol);
        const proof = await checkCustomApiModel(config);
        expect(customModelProofMatches(config, proof)).toBe(true);
        expect(proof.readsPictures).toBe(answer === "47");
        const sent = JSON.stringify(wire[2]);
        expect(sent).toContain("data:image/png;base64,");
        expect(sent).not.toContain('"47"');
        expect(sent).toContain(protocol === "openai-completions" ? '"image_url"' : '"input_image"');
      },
    );

    it("cancellation during the optional picture request cannot activate a late proof", async () => {
      const abort = new AbortController();
      let requests = 0;
      const base = await fixture((_req, res) => {
        requests++;
        if (requests === 3) abort.abort();
        sendCustomStream(
          res,
          requests === 1
            ? callStream("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}')
            : textStream(requests === 2 ? "FIRSTMATE_CUSTOM_API_OK" : "47"),
        );
      });
      await expect(
        checkCustomApiModel(candidate(base, protocol), abort.signal),
      ).rejects.toMatchObject({ category: "cancelled" });
      expect(requests).toBe(3);
    });

    it("a timed-out optional picture request keeps the valid text proof", async () => {
      let requests = 0;
      const base = await fixture((_req, res) => {
        requests++;
        sendCustomStream(
          res,
          requests === 1
            ? callStream("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}')
            : textStream("FIRSTMATE_CUSTOM_API_OK"),
        );
      });
      const proof = await checkCustomApiModel(candidate(base, protocol), undefined, (options) => {
        const transport = createCustomApiTransport(options);
        let calls = 0;
        return {
          ...transport,
          request: (...args) =>
            ++calls === 3
              ? Promise.reject(new CustomApiError("timeout"))
              : transport.request(...args),
        };
      });
      expect(proof.readsPictures).toBe(false);
      expect(customModelProofMatches(candidate(base, protocol), proof)).toBe(true);
      expect(requests).toBe(2);
    });

    it("binds a header's name, visibility and visible value, and a secret value only through its revision", () => {
      const config = candidate("http://127.0.0.1:9/v1", protocol);
      const header = { name: "X-Org-Id", value: "eng", secret: false };
      const fingerprint = customModelFingerprint({ ...config, headers: [header] });
      for (const changed of [
        { ...header, value: "research" },
        { ...header, name: "X-Team" },
        { ...header, secret: true },
      ])
        expect(customModelFingerprint({ ...config, headers: [changed] })).not.toBe(fingerprint);
      expect(
        customModelFingerprint({ ...config, headers: [{ ...header, name: "x-org-id" }] }),
      ).toBe(fingerprint);
      const secret = (value: string) => ({
        ...config,
        headers: [{ ...header, secret: true, value }],
      });
      expect(customModelFingerprint(secret("synthetic-a"))).toBe(
        customModelFingerprint(secret("synthetic-b")),
      );
      expect(
        customModelFingerprint({ ...secret("synthetic-a"), credentialRevision: "revision-2" }),
      ).not.toBe(customModelFingerprint(secret("synthetic-a")));
    });
  },
);

it("requires connection-specific storage consent and never automatically omits store:false after rejection", async () => {
  const payloads: Record<string, unknown>[] = [];
  const base = await fixture(async (req, res) => {
    const payload = await bodyOf(req);
    payloads.push(payload);
    if (payload.store === false) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"omit store to work"}');
    } else sendCustomStream(res, customResponsesText("Synthetic answer."));
  });
  const request = generation("openai-responses");
  await expect(generateCustomApi(client(base), request)).rejects.toMatchObject({
    category: "server",
  });
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.store).toBe(false);
  await expect(
    generateCustomApi(client(base), {
      ...request,
      storage: { kind: "server-default", consentRevision: "" },
    }),
  ).rejects.toMatchObject({ category: "incompatible" });
  expect(payloads).toHaveLength(1);
  const result = await generateCustomApi(client(base), {
    ...request,
    storage: { kind: "server-default", consentRevision: "connection-1-approved-revision-2" },
  });
  expect(textOf(result)).toBe("Synthetic answer.");
  expect(payloads[1]).not.toHaveProperty("store");
  // A new connection has no approval; do not infer it from a shared address.
  await expect(generateCustomApi(client(base), request)).rejects.toMatchObject({
    category: "server",
  });
  expect(payloads[2]?.store).toBe(false);
  console.info("CUSTOM_API_RETENTION_WIRE", JSON.stringify(payloads));
});

it.each([
  ["a finish without a DONE marker", chatFrame({ content: "partial" }, "stop")],
  [
    "a reply cut off at its output limit",
    `${chatFrame({ content: "partial" }, "length")}data: [DONE]\n\n`,
  ],
])("Chat keeps %s the way other subscriptions do", async (_case, stream) => {
  const base = await fixture((_req, res) => sendCustomStream(res, stream));
  const reply = await generateCustomApi(client(base), generation("openai-completions"));
  expect(textOf(reply)).toBe("partial");
  expect(reply.stopReason).toBe(stream.includes('"length"') ? "length" : "stop");
});

it("keeps a finished Chat reply when a later chunk arrives, as Pi does", async () => {
  const base = await fixture((_req, res) =>
    sendCustomStream(res, customChatText("okay") + chatFrame({ content: "late" })),
  );
  const reply = await generateCustomApi(client(base), generation("openai-completions"));
  expect(textOf(reply)).toBe("okay");
  expect(reply.stopReason).toBe("stop");
});

it.each([
  ["missing finish", `${chatFrame({ content: "partial" })}data: [DONE]\n\n`],
  ["malformed JSON", "data: {not json}\n\n"],
  ["partial SSE", customChatText("okay").replace(/\n\n$/, "")],
  ["invalid UTF-8", "data: \ud800\n\n"],
])("Chat refuses %s without a successful answer", async (_case, stream) => {
  const base = await fixture((_req, res) => sendCustomStream(res, stream));
  await expect(
    generateCustomApi(client(base), generation("openai-completions")),
  ).rejects.toHaveProperty("category");
});

it.each([
  [
    "missing completed",
    customResponsesText("partial").replace(/data: [^\n]*response.completed[^\n]*\n\n/, ""),
  ],
  ["queued", responseFrame({ type: "response.created", response: { status: "queued" } })],
  [
    "failed",
    responseFrame({ type: "response.created", response: { status: "in_progress" } }) +
      responseFrame({
        type: "response.failed",
        response: { status: "failed", error: { message: "opaque-synthetic-secret" } },
      }),
  ],
  [
    "truncated",
    customResponsesText("partial").replace(
      '"status":"completed","output"',
      '"status":"incomplete","output"',
    ),
  ],
])("Responses refuses %s and discards raw parsing/provider errors", async (_case, stream) => {
  const base = await fixture((_req, res) => sendCustomStream(res, stream));
  const result = await generateCustomApi(client(base), {
    ...generation("openai-responses"),
    context: normalizeContext({
      messages: [],
      tools: [
        { name: "firstmate_echo", description: "Synthetic tool", parameters: Type.Object({}) },
      ],
    }),
  }).catch((error: unknown) => error);
  expect(result).toHaveProperty("category");
  expect(String(result)).not.toContain("opaque-synthetic-secret");
  expect(result).not.toHaveProperty("cause");
});

it.each(["arguments", "name"] as const)(
  "Responses keeps the streamed tool call when the finalized %s disagrees",
  async (kind) => {
    const original = customResponsesCall("firstmate_echo", '{"text":"safe"}');
    const stream =
      kind === "arguments"
        ? original.replace(
            '"arguments":"{\\"text\\":\\"safe\\"}","status":"completed"}]}"',
            '"arguments":"{\\"text\\":\\"changed\\"}","status":"completed"}]}"',
          )
        : original.replace(
            '"name":"firstmate_echo","' +
              '"arguments":"{\\"text\\":\\"safe\\"}","status":"completed"}]}"',
            '"name":"different","arguments":"{\\"text\\":\\"safe\\"}","status":"completed"}]}"',
          );
    const base = await fixture((_req, res) => sendCustomStream(res, stream));
    const reply = await generateCustomApi(client(base), {
      ...generation("openai-responses"),
      context: normalizeContext({
        messages: [],
        tools: [
          { name: "firstmate_echo", description: "Synthetic tool", parameters: Type.Object({}) },
        ],
      }),
    });
    expect(callsOf(reply)).toEqual([
      { id: "check_call|fc_1", name: "firstmate_echo", arguments: { text: "safe" } },
    ]);
  },
);

it("bounds model discovery, keeps stated limits and discards executable settings and capability claims", async () => {
  let calls = 0;
  const base = await fixture((_req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data:
          calls === 1
            ? [
                {
                  id: "<model-id>",
                  endpoint: "https://unsafe.invalid",
                  apiKey: "opaque-synthetic-secret",
                  context: 0,
                  context_length: 0,
                  max_completion_tokens: "4096",
                  price: 0,
                },
                { id: "<model-id>", context_length: 8192 },
                { id: "manual model" },
              ]
            : Array.from({ length: 1001 }, (_, index) => ({ id: `model-${index}` })),
      }),
    );
  });
  expect(await listCustomApiModels(client(base))).toEqual([
    { id: "<model-id>" },
    { id: "manual model" },
  ]);
  await expect(listCustomApiModels(client(base))).rejects.toMatchObject({ category: "oversized" });
});

it("reads the context and output limits common model lists state", async () => {
  let reply: unknown;
  const base = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  reply = {
    object: "list",
    data: [
      // OpenRouter: the entry's own window, the top provider's output cap.
      {
        id: "openrouter/model",
        context_length: 200000,
        top_provider: { context_length: 100000, max_completion_tokens: 8192 },
        pricing: { prompt: "0" },
      },
      { id: "groq-model", context_window: 131072, max_completion_tokens: 32768 },
      { id: "mistral-model", max_context_length: 32768, capabilities: { tools: true } },
      { id: "vllm-model", max_model_len: 65536 },
      { id: "deepinfra-model", metadata: { context_length: 128000, max_tokens: 128000 } },
      { id: "gateway-model", max_input_tokens: 400000, max_output_tokens: 128000 },
      // No room for input: the output limit is unknown, never trusted as stated.
      { id: "whole-window", context_length: 16384, max_completion_tokens: 16384 },
      { id: "output-only", max_output_tokens: 4096 },
      // Anthropic's model list: max_tokens is the output beside max_input_tokens.
      { id: "claude-haiku-5-5", type: "model", max_input_tokens: 1000000, max_tokens: 128000 },
      { id: "bare-max-tokens", max_tokens: 4096 },
      { id: "fractional", context_length: 1000.5, max_completion_tokens: -1 },
    ],
  };
  expect(await listCustomApiModels(client(base))).toEqual([
    { id: "openrouter/model", context: 200000, output: 8192 },
    { id: "groq-model", context: 131072, output: 32768 },
    { id: "mistral-model", context: 32768 },
    { id: "vllm-model", context: 65536 },
    { id: "deepinfra-model", context: 128000 },
    { id: "gateway-model", context: 400000, output: 128000 },
    { id: "whole-window", context: 16384 },
    { id: "output-only", output: 4096 },
    { id: "claude-haiku-5-5", context: 1000000, output: 128000 },
    { id: "bare-max-tokens" },
    { id: "fractional" },
  ]);
  // Some servers answer the list itself rather than wrapping it in `data`.
  reply = [{ id: "together-model", context_length: 32768 }];
  expect(await listCustomApiModels(client(base))).toEqual([
    { id: "together-model", context: 32768 },
  ]);
  reply = { models: [{ id: "elsewhere" }] };
  await expect(listCustomApiModels(client(base))).rejects.toMatchObject({ category: "malformed" });
});

describe.each(["openai-completions", "openai-responses"] as const)(
  "%s safe publication",
  (protocol) => {
    const text = protocol === "openai-completions" ? customChatText : customResponsesText;
    it("refuses literal/escaped credential echoes before publishing text or tools", async () => {
      const key = 'opaque-"synthetic"\\credential';
      let reply = text(key);
      const base = await fixture((_req, res) => sendCustomStream(res, reply));
      const transport = createCustomApiTransport({
        baseUrl: base,
        mode: "local",
        credential: { kind: "bearer", key },
      });
      transports.push(transport);
      for (const value of [key, JSON.stringify(key).slice(1, -1)]) {
        reply = text(value);
        const deltas: string[] = [];
        await expect(
          generateCustomApi(
            transport,
            generation(protocol),
            undefined,
            (delta) => delta.type === "text_delta" && deltas.push(delta.delta),
          ),
        ).rejects.toMatchObject({ category: "incompatible" });
        expect(deltas).toEqual([]);
      }
      reply = (protocol === "openai-completions" ? customChatCall : customResponsesCall)(
        "echo",
        JSON.stringify({ text: key }),
      );
      await expect(
        generateCustomApi(transport, {
          ...generation(protocol),
          context: normalizeContext({
            messages: [],
            tools: [{ name: "echo", description: "Synthetic", parameters: Type.Object({}) }],
          }),
        }),
      ).rejects.toMatchObject({ category: "incompatible" });
    });
    it("never publishes a partial reply when the terminal is malformed or failed", async () => {
      const stream =
        protocol === "openai-completions"
          ? `${chatFrame({ content: "Synthetic partial reply" })}data: [DONE]\n\n`
          : customResponsesText("Synthetic partial reply").replace(
              /data: \{"type":"response.completed"[^\n]+\n\n$/,
              responseFrame({
                type: "response.failed",
                response: { status: "failed", error: { message: "opaque-synthetic-error" } },
              }),
            );
      const base = await fixture((_req, res) => sendCustomStream(res, stream));
      const deltas: string[] = [];
      await expect(
        generateCustomApi(
          client(base),
          generation(protocol),
          undefined,
          (delta) => delta.type === "text_delta" && deltas.push(delta.delta),
        ),
      ).rejects.toThrow();
      expect(deltas).toEqual([]);
    });
  },
);

/** The real transport interface, answering with exactly these chunks. */
function scripted(chunks: readonly Uint8Array[]): CustomApiTransport {
  return {
    request: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    assertSafeOutput: () => undefined,
    close: () => undefined,
  };
}

it("reassembles frames split anywhere: inside CRLF, the blank line or a character", async () => {
  const stream = Buffer.from(customChatText(["héllo ", "wörld"]).replace(/\n/g, "\r\n"));
  const bytes = [...stream].map((byte) => Uint8Array.of(byte));
  const reply = await generateCustomApi(scripted(bytes), generation("openai-completions"));
  expect(textOf(reply)).toBe("héllo wörld");
  const whole = await generateCustomApi(scripted([stream]), generation("openai-completions"));
  expect(textOf(whole)).toBe("héllo wörld");
  const unfinished = Buffer.from(chatFrame({ content: "partial" }).trimEnd());
  await expect(
    generateCustomApi(scripted([unfinished]), generation("openai-completions")),
  ).rejects.toMatchObject({ category: "malformed" });
});

it("takes a file-sized tool call in one frame, as a buffering gateway sends it", async () => {
  const content = "line of a large file\n".repeat(400_000);
  const args = JSON.stringify({ content });
  const stream = Buffer.from(
    chatFrame({
      tool_calls: [
        {
          index: 0,
          id: "write_call",
          type: "function",
          function: { name: "write", arguments: args },
        },
      ],
    }) +
      chatFrame({}, "tool_calls") +
      "data: [DONE]\n\n",
  );
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < stream.length; offset += 16 * 1024)
    chunks.push(stream.subarray(offset, offset + 16 * 1024));
  const reply = await generateCustomApi(scripted(chunks), {
    ...generation("openai-completions"),
    context: normalizeContext({
      messages: [],
      tools: [{ name: "write", description: "Synthetic", parameters: Type.Object({}) }],
    }),
  });
  expect(callsOf(reply)).toEqual([{ id: "write_call", name: "write", arguments: { content } }]);
});

it("lets a turn's reply run to as many frames as the output it asked for, and no further", async () => {
  const frames = 20_000;
  const base = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(customChatText(Array.from({ length: frames }, () => "w")));
  });
  const turn = createCustomApiTransport({
    baseUrl: base,
    mode: "local",
    credential: { kind: "local-no-key" },
    generation: "turn",
  });
  transports.push(turn);
  const long = { ...generation("openai-completions"), limits: { context: 131072, output: 32768 } };
  // More frames than the fixed allowance alone, and more bytes than a check's 1 MiB.
  expect(textOf(await generateCustomApi(turn, long))).toBe("w".repeat(frames));
  await expect(generateCustomApi(turn, { ...long, maxOutput: 512 })).rejects.toMatchObject({
    category: "oversized",
  });
  await expect(generateCustomApi(client(base), long)).rejects.toMatchObject({
    category: "oversized",
  });
});

it.each(["openai-completions", "openai-responses"] as const)(
  "sends a %s conversation as large as its model's documented context admits, past 1 MiB",
  async (protocol) => {
    const received: number[] = [];
    const base = await fixture(async (req, res) => {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      received.push(bytes);
      sendCustomStream(
        res,
        (protocol === "openai-completions" ? customChatText : customResponsesText)("read"),
      );
    });
    const turn = createCustomApiTransport({
      baseUrl: base,
      mode: "local",
      credential: { kind: "local-no-key" },
      generation: "turn",
    });
    transports.push(turn);
    const limits = { context: 1_048_576, output: 32_768 };
    // The wire's worst case: tool arguments travel as JSON text inside JSON, so
    // each quote in them is escaped twice and the request nearly doubles.
    const write = { name: "write", description: "Synthetic", parameters: Type.Object({}) };
    const quotes = '"'.repeat(4096);
    const history: Message[] = [];
    for (let index = 0; index < 360; index++) {
      const id = `write_${index}`;
      history.push(
        { role: "user", content: "Write it.", timestamp: 0 },
        assistant(protocol, [{ type: "toolCall", id, name: "write", arguments: { quotes } }]),
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "write",
          content: [{ type: "text", text: "" }],
          timestamp: 0,
          isError: false,
        },
      );
    }
    const room = CUSTOM_API_BYTES_PER_TOKEN * (limits.context - limits.output);
    const conversation = (padding: number): CustomGeneration => ({
      protocol,
      model: "synthetic-model",
      limits,
      storage: { kind: "no-store" },
      context: normalizeContext({
        systemPrompt: "Synthetic instructions.",
        tools: [write],
        messages: [...history, { role: "user", content: "x".repeat(padding), timestamp: 0 }],
      }),
    });
    const fill =
      room -
      Buffer.byteLength(
        JSON.stringify(
          conversation(0).context.messages.map(({ timestamp: _, ...message }) =>
            message.role === "assistant"
              ? { role: message.role, content: message.content }
              : message,
          ),
        ),
      );
    expect(fill).toBeGreaterThan(0);
    expect(textOf(await generateCustomApi(turn, conversation(fill)))).toBe("read");
    const [sent = 0] = received;
    expect(sent).toBeGreaterThan(1.9 * room);
    expect(sent).toBeLessThanOrEqual(customApiRequestBytes(limits.context));
    // INF-202: a byte past the old admission estimate is still sent. The wire
    // cap, not a token estimate, is what refuses before anything leaves.
    expect(textOf(await generateCustomApi(turn, conversation(fill + 1)))).toBe("read");
    expect(received).toHaveLength(2);
  },
);

it("does not expose a credential echoed as a discovered model ID", async () => {
  const key = "opaque-synthetic-list-key";
  const base = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: key }] }));
  });
  const transport = createCustomApiTransport({
    baseUrl: base,
    mode: "local",
    credential: { kind: "bearer", key },
  });
  transports.push(transport);
  await expect(listCustomApiModels(transport)).rejects.toMatchObject({ category: "incompatible" });
});

it("a server rejecting the Chat usage request fails its check without a fallback", async () => {
  const wire: Record<string, unknown>[] = [];
  const base = await fixture(async (req, res) => {
    const body = await bodyOf(req);
    wire.push(body);
    if (body.stream_options) {
      res.writeHead(400);
      res.end("unsupported field");
    } else sendCustomStream(res, customChatText("should never fall back"));
  });
  await expect(checkCustomApiModel(candidate(base, "openai-completions"))).rejects.toHaveProperty(
    "category",
  );
  expect(wire).toHaveLength(1);
  expect(wire[0]?.stream_options).toEqual({ include_usage: true });
});

/** The DeepSeek-V4.1-Flash proxy ending: a choice after the finish, and no [DONE]. */
function proxyEnding(body: string, usage = { input: 20, output: 8 }): string {
  return (
    body.replace(/data: \[DONE\]\n\n$/, "") +
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {} }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
    })}\n\n`
  );
}

it("treats a streamed context overflow as the refusal, and discards the server text", async () => {
  // INF-202: an overflow reported inside the reply, not as an error status.
  const base = await fixture((_req, res) => {
    sendCustomStream(
      res,
      chatFrame({ content: "secret overflow wording" }) +
        chatFrame({}, "model_context_window_exceeded") +
        "data: [DONE]\n\n",
    );
  });
  const error = await generateCustomApi(client(base), generation("openai-completions")).catch(
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ category: "context-limit" });
  expect(error).toBeInstanceOf(CustomApiError);
  expect((error as CustomApiError).message).toBe(new CustomApiError("context-limit").message);
  expect(String(error)).not.toContain("secret overflow wording");
  expect(String(error)).not.toContain("model_context_window_exceeded");
});

it("keeps a reply that used its full output allowance and stopped there", async () => {
  // INF-202: a reply that used the allowance it was given is kept.
  const base = await fixture(async (req, res) => {
    const body = await bodyOf(req);
    const asked = Number(body.max_completion_tokens ?? body.max_tokens);
    sendCustomStream(
      res,
      chatFrame({ content: "Shortened." }) +
        chatFrame({}, "length") +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: asked } })}\n\n` +
        "data: [DONE]\n\n",
    );
  });
  const reply = await generateCustomApi(client(base), generation("openai-completions"));
  expect(reply.stopReason).toBe("length");
  expect(textOf(reply)).toBe("Shortened.");
});

it("accepts a working proxy ending on the connection check and reads its usage", async () => {
  let requests = 0;
  const base = await fixture((_req, res) => {
    requests++;
    sendCustomStream(
      res,
      requests === 1
        ? proxyEnding(customChatCall("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}'))
        : proxyEnding(customChatText("FIRSTMATE_CUSTOM_API_OK")),
    );
  });
  const proof = await checkCustomApiModel(candidate(base, "openai-completions"));
  expect(proof.profile).toBe("pi-capabilities-v4");
  expect(requests).toBe(3);
  const reply = await generateCustomApi(client(base), generation("openai-completions"));
  expect(textOf(reply)).toBe("FIRSTMATE_CUSTOM_API_OK");
  expect(reply.usage).toMatchObject({ input: 20, output: 8 });
  expect(reply.stopReason).toBe("stop");
});

it.each(["openai-completions", "openai-responses"] as const)(
  "%s sends a picture by its pixels, including one the old context check refused",
  async (protocol) => {
    let requests = 0;
    const base = await fixture(async (req, res) => {
      await bodyOf(req);
      requests++;
      sendCustomStream(
        res,
        (protocol === "openai-completions" ? customChatText : customResponsesText)(
          "Read the screenshot.",
        ),
      );
    });
    const png = { type: "image" as const, data: customPicture(), mimeType: "image/png" };
    const input: CustomGeneration = {
      ...generation(protocol),
      readsPictures: true,
      context: normalizeContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read the screenshot." }, png],
            timestamp: 0,
          },
        ],
      }),
    };
    expect(png.data.length / 3).toBeGreaterThan(input.limits.context);
    expect((await generateCustomApi(client(base), input)).stopReason).toBe("stop");
    expect(requests).toBe(1);
    // INF-202: pixel size no longer refuses before the request is sent.
    expect(
      (
        await generateCustomApi(client(base), {
          ...input,
          limits: { context: 3000, output: 512 },
        })
      ).stopReason,
    ).toBe("stop");
    expect(requests).toBe(2);
  },
);

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
function callsOf(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "toolCall")
    .map(({ type: _, ...call }) => call);
}
function assistant(
  protocol: CustomApiProtocol,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    api: protocol,
    provider: "firstmate-custom",
    model: "synthetic-model",
    content,
    timestamp: 0,
    stopReason: "toolUse",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

// INF-1996, accepted pictures=keep: three-picture comparisons must not rewrite prior requests.
it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
  "%s retains pictures and the serialized history across interleaved rereads",
  async (protocol) => {
    const payloads: Record<string, unknown>[] = [];
    const base = await fixture(async (req, res) => {
      payloads.push(await bodyOf(req));
      if (protocol === "anthropic-messages") {
        beginAnthropicStream(res, 30, payloads.length);
        writeAnthropicText(res, 0, "Compare the retained pictures.");
        finishAnthropicStream(res, "end_turn", 8);
      } else {
        sendCustomStream(
          res,
          (protocol === "openai-completions" ? customChatText : customResponsesText)(
            "Compare the retained pictures.",
          ),
        );
      }
    });
    const transport = client(base);
    const images = [customPicture(24, 16), customPicture(32, 20), customPicture(40, 24)].map(
      (data) => ({ type: "image" as const, data, mimeType: "image/png" }),
    );
    const picture = (index: number) => {
      const content = images[index];
      if (!content) throw new Error("Picture fixture is missing");
      return content;
    };
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Compare these three crops." }, picture(0)],
        timestamp: 0,
      },
    ];
    let prior: unknown[] = [];
    for (const [round, crop] of [0, 1, 2, 0, 2, 1].entries()) {
      const id = `read_${round}`;
      messages.push(
        assistant(protocol, [
          { type: "toolCall", id, name: "read", arguments: { path: `crop-${crop}.png` } },
        ]),
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [
            { type: "text", text: `Crop ${crop}` },
            picture(crop),
            picture((crop + 1) % images.length),
          ],
          isError: false,
          timestamp: round,
        },
      );
      const original = JSON.stringify(messages);
      const reply = await generateCustomApi(transport, {
        ...generation(protocol),
        readsPictures: true,
        context: normalizeContext({ messages }),
      });
      expect(reply.stopReason).toBe("stop");
      expect(JSON.stringify(messages)).toBe(original);
      const payload = payloads.at(-1);
      if (!payload) throw new Error("Outgoing picture payload is missing");
      // Pi moves Anthropic's cache-control marker; content preceding it must not change.
      const history = JSON.parse(
        JSON.stringify(payload.messages ?? payload.input, (key, value) =>
          key === "cache_control" ? undefined : value,
        ),
      ) as unknown[];
      const serialized = JSON.stringify(history);
      const pictures =
        protocol === "anthropic-messages"
          ? serialized.split('"type":"image"').length - 1
          : serialized.split("data:image/png;base64,").length - 1;
      console.info(
        "CUSTOM_PICTURE_HISTORY",
        JSON.stringify({
          protocol,
          round: round + 1,
          pictures,
          expected: 1 + 2 * (round + 1),
          priorStable: JSON.stringify(history.slice(0, prior.length)) === JSON.stringify(prior),
          digest: createHash("sha256").update(serialized).digest("hex"),
        }),
      );
      expect(pictures).toBe(1 + 2 * (round + 1));
      expect(serialized).not.toContain("tool image omitted");
      expect(history.slice(0, prior.length)).toEqual(prior);
      prior = history;
    }
  },
);
